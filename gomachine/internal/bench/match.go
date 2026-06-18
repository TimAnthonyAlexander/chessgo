package bench

import (
	"context"
	"sync"
	"time"

	"github.com/timanthonyalexander/gomachine/internal/chess"
	"github.com/timanthonyalexander/gomachine/internal/engine"
	"github.com/timanthonyalexander/gomachine/internal/search"
)

// maxPlies caps a game so a pathological version can never hang the run (the
// 50-move rule normally ends games far sooner). Reaching it scores a draw.
const maxPlies = 600

// Config fully specifies an SPRT run.
type Config struct {
	NewParams search.Params // the patch under test ("A")
	OldParams search.Params // the baseline
	NewName   string
	OldName   string

	Nodes    uint64        // fixed nodes per move (primary, reproducible)
	MoveTime time.Duration // alternative budget (used only if Nodes == 0)
	TTMB     int           // transposition table size per engine

	Elo0, Elo1  float64 // SPRT hypotheses (H0: ≤Elo0, H1: ≥Elo1)
	Alpha, Beta float64 // error rates
	Concurrency int     // parallel game-pair workers
	MaxPairs    int     // hard cap on pairs before giving up
	Book        []Opening
}

// gameOutcome is a single game's result from White's perspective.
type gameOutcome float64

const (
	whiteWin gameOutcome = 1.0
	drawn    gameOutcome = 0.5
	blackWin gameOutcome = 0.0
)

// limits returns the search limits for one move.
func (c *Config) limits() search.Limits {
	if c.Nodes > 0 {
		return search.Limits{Nodes: c.Nodes}
	}
	return search.Limits{MoveTime: c.MoveTime}
}

// playGame plays one game from the opening FEN and returns the result from
// White's perspective. white and black are reused across games — NewGame() (TT
// clear) is called here so no game biases the next; killers/history reset per
// search already. ctx cancellation ends the game as a draw (run is stopping).
func playGame(ctx context.Context, white, black *engine.Engine, openFEN string, lim search.Limits) gameOutcome {
	white.NewGame()
	black.NewGame()

	pos, err := chess.ParseFEN(openFEN)
	if err != nil {
		return drawn
	}

	// history holds the Zobrist keys of all positions BEFORE the current one,
	// for both repetition detection (arbiter) and the engines' own awareness.
	history := make([]uint64, 0, 128)

	for ply := 0; ply < maxPlies; ply++ {
		// Arbiter: classify the current position before moving.
		st := engine.Adjudicate(pos, history)
		if st.State != "ongoing" {
			return resultToWhite(st.Result)
		}
		// Testing convention: auto-claim threefold / fifty-move as draws.
		if containsAny(st.ClaimableDraws, "threefold", "fifty") {
			return drawn
		}

		select {
		case <-ctx.Done():
			return drawn
		default:
		}

		mover := white
		if pos.SideToMove() == chess.Black {
			mover = black
		}
		res := mover.Play(pos, lim, history)
		if res.Move == chess.NullMove {
			// No move returned though Adjudicate said ongoing — treat as draw
			// rather than crash the run (should not happen).
			return drawn
		}

		history = append(history, pos.Key())
		var u chess.Undo
		pos.DoMove(res.Move, &u)
	}
	return drawn // ply cap reached
}

// Progress is a snapshot pushed to a reporter after each pair.
type Progress struct {
	Penta   Pentanomial
	LLR     float64
	Lower   float64
	Upper   float64
	Elo     float64
	Err95   float64
	Pairs   int
	Games   int
	WNew    int // games won by the patch
	WOld    int // games won by the baseline
	Draws   int
	Elapsed time.Duration
	Done    Decision
}

// Summary is the final outcome of a run.
type Summary struct {
	Progress
}

// RunSPRT plays game pairs concurrently until the SPRT reaches a decision or
// MaxPairs is hit, pushing a Progress snapshot to onProgress after each pair.
func RunSPRT(ctx context.Context, cfg Config, onProgress func(Progress)) Summary {
	if cfg.Concurrency < 1 {
		cfg.Concurrency = 1
	}
	lim := cfg.limits()
	lower, upper := Bounds(cfg.Alpha, cfg.Beta)

	type pairOut struct {
		score float64
		r1w   gameOutcome // game1 from White's (=new's) perspective
		r2w   gameOutcome // game2 from White's (=old's) perspective
	}

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	jobs := make(chan Opening)
	results := make(chan pairOut, cfg.Concurrency)

	// Workers: each owns its own pair of engines (full state isolation).
	var wg sync.WaitGroup
	for w := 0; w < cfg.Concurrency; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			newEng := engine.NewWithParams(cfg.TTMB, cfg.NewParams)
			oldEng := engine.NewWithParams(cfg.TTMB, cfg.OldParams)
			for open := range jobs {
				r1 := playGame(ctx, newEng, oldEng, open.FEN, lim)
				r2 := playGame(ctx, oldEng, newEng, open.FEN, lim)
				score := float64(r1) + (1 - float64(r2))
				select {
				case results <- pairOut{score: score, r1w: r1, r2w: r2}:
				case <-ctx.Done():
					return
				}
			}
		}()
	}

	// Feeder: cycles the book until cancelled or MaxPairs queued.
	go func() {
		defer close(jobs)
		n := len(cfg.Book)
		for i := 0; i < cfg.MaxPairs; i++ {
			select {
			case jobs <- cfg.Book[i%n]:
			case <-ctx.Done():
				return
			}
		}
	}()

	// Aggregator (this goroutine): consume results, update stats, decide.
	var penta Pentanomial
	var wNew, wOld, draws int
	start := time.Now()
	final := Summary{}

	for i := 0; i < cfg.MaxPairs; i++ {
		var out pairOut
		select {
		case out = <-results:
		case <-ctx.Done():
			i--
			continue
		}
		penta.Add(out.score)
		// Per-game W/L/D from the patch's perspective.
		wNew += boolToInt(out.r1w == whiteWin) + boolToInt(out.r2w == blackWin)
		wOld += boolToInt(out.r1w == blackWin) + boolToInt(out.r2w == whiteWin)
		draws += boolToInt(out.r1w == drawn) + boolToInt(out.r2w == drawn)

		llr := penta.LLR(cfg.Elo0, cfg.Elo1)
		elo, err95 := penta.Elo()
		decision := Continue
		if penta.Pairs() >= MinPairs {
			if llr >= upper {
				decision = AcceptH1
			} else if llr <= lower {
				decision = AcceptH0
			}
		}

		p := Progress{
			Penta: penta, LLR: llr, Lower: lower, Upper: upper,
			Elo: elo, Err95: err95,
			Pairs: penta.Pairs(), Games: penta.Pairs() * 2,
			WNew: wNew, WOld: wOld, Draws: draws,
			Elapsed: time.Since(start), Done: decision,
		}
		final.Progress = p
		if onProgress != nil {
			onProgress(p)
		}
		if decision != Continue {
			cancel()
			break
		}
	}

	cancel()
	wg.Wait()
	return final
}

func resultToWhite(result string) gameOutcome {
	switch result {
	case "1-0":
		return whiteWin
	case "0-1":
		return blackWin
	default:
		return drawn
	}
}

func containsAny(s []string, targets ...string) bool {
	for _, v := range s {
		for _, t := range targets {
			if v == t {
				return true
			}
		}
	}
	return false
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
