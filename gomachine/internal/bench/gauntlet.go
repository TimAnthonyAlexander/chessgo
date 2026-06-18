package bench

import (
	"context"
	"fmt"
	"math"
	"sync"
	"time"

	"github.com/timanthonyalexander/gomachine/internal/chess"
	"github.com/timanthonyalexander/gomachine/internal/engine"
	"github.com/timanthonyalexander/gomachine/internal/search"
)

// GauntletConfig specifies a match of our engine vs an external UCI engine
// (Stockfish). Unlike self-play SPRT, this anchors ABSOLUTE strength: our Elo is
// estimated as the opponent's known Elo plus the head-to-head Elo difference.
type GauntletConfig struct {
	OurParams   search.Params
	OurNodes    uint64        // our per-move budget (nodes; 0 → use OurMoveTime)
	OurMoveTime time.Duration // our per-move budget (time; if OurNodes == 0)
	OurThreads  int           // Lazy SMP threads for our engine (default 1)
	TTMB        int

	SFPath    string            // path to the stockfish binary
	SFOptions map[string]string // UCI options (UCI_LimitStrength, UCI_Elo, Skill Level, …)
	SFElo     int               // opponent's nominal Elo (the anchor for our estimate)
	SFBudget  UCIBudget         // opponent's per-move budget

	Games       int // total games (rounded up to whole color-swapped pairs)
	Concurrency int
	Book        []Opening
}

func (c *GauntletConfig) ourLimits() search.Limits {
	if c.OurNodes > 0 {
		return search.Limits{Nodes: c.OurNodes}
	}
	return search.Limits{MoveTime: c.OurMoveTime}
}

// GauntletProgress is a snapshot after each finished game.
type GauntletProgress struct {
	Wins, Draws, Losses int // from OUR perspective
	Games               int
	Score               float64 // our score fraction
	OurElo              float64 // estimated absolute Elo
	Err95               float64
	EloDiff             float64 // head-to-head Elo vs the opponent
	Elapsed             time.Duration
}

// GauntletSummary is the final outcome.
type GauntletSummary struct {
	GauntletProgress
	SFElo int
}

// RunGauntlet plays our engine against Stockfish over color-swapped game pairs,
// using our perft-verified rules as the arbiter (so Stockfish never needs to be
// trusted on legality — an illegal SF move is caught and scored a loss for it).
func RunGauntlet(ctx context.Context, cfg GauntletConfig, onProgress func(GauntletProgress)) (GauntletSummary, error) {
	if cfg.Concurrency < 1 {
		cfg.Concurrency = 1
	}
	pairs := (cfg.Games + 1) / 2
	ourLim := cfg.ourLimits()

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	type gameRes struct{ ourScore float64 }
	jobs := make(chan int) // pair index
	results := make(chan gameRes, cfg.Concurrency*2)
	errCh := make(chan error, cfg.Concurrency)

	var wg sync.WaitGroup
	for w := 0; w < cfg.Concurrency; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ours := engine.NewWithParams(cfg.TTMB, cfg.OurParams)
			sf, err := StartUCI(cfg.SFPath, cfg.SFOptions)
			if err != nil {
				select {
				case errCh <- err:
				default:
				}
				cancel()
				return
			}
			defer sf.Close()

			for idx := range jobs {
				open := cfg.Book[idx%len(cfg.Book)]
				// Game A: we are White. Game B: we are Black (same opening).
				for _, ourColor := range []chess.Color{chess.White, chess.Black} {
					s, err := playVsUCI(ctx, ours, maxThreads(cfg.OurThreads), sf, open.FEN, ourColor, ourLim, cfg.SFBudget)
					if err != nil {
						select {
						case errCh <- err:
						default:
						}
						cancel()
						return
					}
					select {
					case results <- gameRes{ourScore: s}:
					case <-ctx.Done():
						return
					}
				}
			}
		}()
	}

	go func() {
		defer close(jobs)
		for i := 0; i < pairs; i++ {
			select {
			case jobs <- i:
			case <-ctx.Done():
				return
			}
		}
	}()

	var wins, draws, losses int
	start := time.Now()
	var final GauntletSummary
	final.SFElo = cfg.SFElo
	total := pairs * 2

	for i := 0; i < total; i++ {
		var r gameRes
		select {
		case r = <-results:
		case <-ctx.Done():
			// Drain any reported error.
			select {
			case err := <-errCh:
				return final, err
			default:
				return final, ctx.Err()
			}
		}
		switch r.ourScore {
		case 1:
			wins++
		case 0:
			losses++
		default:
			draws++
		}

		games := wins + draws + losses
		score := (float64(wins) + 0.5*float64(draws)) / float64(games)
		eloDiff, err95 := gauntletElo(wins, draws, losses)
		p := GauntletProgress{
			Wins: wins, Draws: draws, Losses: losses, Games: games,
			Score: score, EloDiff: eloDiff, OurElo: float64(cfg.SFElo) + eloDiff,
			Err95: err95, Elapsed: time.Since(start),
		}
		final.GauntletProgress = p
		if onProgress != nil {
			onProgress(p)
		}
	}

	cancel()
	wg.Wait()
	select {
	case err := <-errCh:
		return final, err
	default:
	}
	return final, nil
}

// playVsUCI plays one game from openFEN. ourColor is the side our engine plays;
// the opponent (sf) plays the other side. Returns our score (1, 0.5, 0).
func playVsUCI(ctx context.Context, ours *engine.Engine, ourThreads int, sf *UCIEngine, openFEN string, ourColor chess.Color, ourLim search.Limits, sfBudget UCIBudget) (float64, error) {
	ours.NewGame()
	if err := sf.NewGame(); err != nil {
		return 0, err
	}
	pos, err := chess.ParseFEN(openFEN)
	if err != nil {
		return 0, err
	}
	history := make([]uint64, 0, 128)
	moves := make([]string, 0, 128) // UCI moves since openFEN (for SF's position cmd)

	for ply := 0; ply < maxPlies; ply++ {
		st := engine.Adjudicate(pos, history)
		if st.State != "ongoing" {
			return scoreFor(resultToWhite(st.Result), ourColor), nil
		}
		if containsAny(st.ClaimableDraws, "threefold", "fifty") {
			return 0.5, nil
		}
		select {
		case <-ctx.Done():
			return 0.5, ctx.Err()
		default:
		}

		var uci string
		if pos.SideToMove() == ourColor {
			res := ours.PlayThreads(pos, ourLim, history, ourThreads)
			if res.Move == chess.NullMove {
				return 0.5, nil
			}
			uci = res.Move.String()
		} else {
			mv, err := sf.BestMove(openFEN, moves, sfBudget)
			if err != nil {
				return 0, fmt.Errorf("stockfish: %w", err)
			}
			uci = mv
		}

		m, ok := pos.ParseUCIMove(uci)
		if !ok {
			// Whoever produced an illegal move (per OUR rules) loses. In practice
			// this only ever flags an engine bug or a desync.
			if pos.SideToMove() == ourColor {
				return 0.5, fmt.Errorf("our engine produced illegal move %q at %s", uci, pos.FEN())
			}
			return scoreFor(resultFor(ourColor), ourColor), nil // SF illegal → we win
		}
		history = append(history, pos.Key())
		var u chess.Undo
		pos.DoMove(m, &u)
		moves = append(moves, uci)
	}
	return 0.5, nil // ply cap → draw
}

// scoreFor converts a White-perspective outcome to our-perspective score.
func scoreFor(white gameOutcome, ourColor chess.Color) float64 {
	if ourColor == chess.White {
		return float64(white)
	}
	return 1 - float64(white)
}

// resultFor returns the White-perspective outcome that means "ourColor wins".
func resultFor(ourColor chess.Color) gameOutcome {
	if ourColor == chess.White {
		return whiteWin
	}
	return blackWin
}

// gauntletElo estimates the head-to-head Elo difference (and 95% half-width) from
// a trinomial W/D/L record, our perspective.
func gauntletElo(wins, draws, losses int) (elo, err95 float64) {
	n := wins + draws + losses
	if n == 0 {
		return 0, math.NaN()
	}
	mu := (float64(wins) + 0.5*float64(draws)) / float64(n)
	if mu <= 0 || mu >= 1 {
		return ScoreToElo(mu), math.NaN()
	}
	elo = ScoreToElo(mu)
	// Variance of the per-game score around mu.
	var variance float64
	variance += float64(wins) * (1 - mu) * (1 - mu)
	variance += float64(draws) * (0.5 - mu) * (0.5 - mu)
	variance += float64(losses) * (0 - mu) * (0 - mu)
	variance /= float64(n)
	seMu := math.Sqrt(variance / float64(n))
	dEloDMu := 400 / (math.Ln10 * mu * (1 - mu))
	err95 = 1.959963985 * dEloDMu * seMu
	return elo, err95
}
