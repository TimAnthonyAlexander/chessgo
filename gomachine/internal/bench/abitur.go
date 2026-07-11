package bench

import (
	"context"
	"fmt"
	"sort"
	"sync"
	"time"

	"github.com/timanthonyalexander/gomachine/internal/chess"
	"github.com/timanthonyalexander/gomachine/internal/engine"
)

// Abitur is gomachine's own miniature "fishtest": a round-robin / gauntlet that
// pits UCI engines against each other, using our perft-verified rules as the
// arbiter. EVERY participant is an external UCI process — Stockfish, Stormphrax,
// Reckless, and gomachine itself (run as `gomachine uci`, its net selected via the
// KB_NET_PATH env). That uniformity is the whole point: old-net vs new-net is just
// two gomachine processes with different KB_NET_PATH, and there is one code path
// for all matchups.
//
// Per-participant time budgets mean TIME ODDS are free (give gomachine 150ms vs an
// opponent's 100ms). The design rationale (from the engine owner): once we are ~100
// Elo below an opponent we essentially never win, and a 0%-win score makes the Elo
// estimate garbage. Starting with a time-odds advantage lands us in a band where we
// actually win games, so the estimate is meaningful; we then dial the odds down.

// Participant is one engine in an Abitur run.
type Participant struct {
	Name    string            // label in the crosstable
	Path    string            // binary path
	Args    []string          // extra CLI args (gomachine needs ["uci"])
	Env     []string          // extra env, e.g. []string{"KB_NET_PATH=/nets/lean.bin"}
	Dir     string            // working dir (gomachine must run from gomachine/)
	Options map[string]string // UCI setoption pairs (Hash, Threads, …)
	Budget  UCIBudget         // per-move search budget (movetime/nodes/depth)
	Elo     int               // nominal Elo anchor; 0 = unknown (no anchor from this one)
}

func (p Participant) spec() UCISpec {
	return UCISpec{Path: p.Path, Args: p.Args, Env: p.Env, Dir: p.Dir, Options: p.Options}
}

// PairResult is the head-to-head outcome of one match, from A's perspective.
type PairResult struct {
	A, B     string
	WinsA    int // games A won
	Draws    int
	WinsB    int // games B won
	Games    int
	Pairs    Pentanomial // color-swapped game pairs, A's perspective (0..2 per pair)
	ScoreA   float64     // A's score fraction
	EloDiff  float64     // A relative to B (+ => A stronger), pentanomial
	Err95    float64
	Elapsed  time.Duration
}

// MatchProgress is a running snapshot of one in-flight match, emitted as each
// color-swapped pair completes so a long match streams a live tally + Elo estimate
// instead of going silent until all N games finish.
type MatchProgress struct {
	A, B        string
	PairsDone   int // color-swapped pairs completed so far
	PairsTotal  int
	WinsA       int // A's game-level W/D/L so far
	Draws       int
	WinsB       int
	ScoreA      float64 // A's running score fraction
	EloDiff     float64 // running pentanomial Elo (A−B); may be ±Inf near 0%/100%
	Err95       float64
	Elapsed     time.Duration
}

// AbiturConfig specifies a whole run.
type AbiturConfig struct {
	Participants []Participant
	Games        int        // games per pair (rounded up to whole color-swapped pairs)
	Concurrency  int        // concurrent games per match
	Book         []Opening  // opening positions (color-swapped within each pair)
	Gauntlet     string     // if set, only play matches involving this participant name
}

// StandingRow is one participant's aggregated performance across the whole run.
type StandingRow struct {
	Name       string
	Games      int
	Score      float64 // total score fraction across all its games
	Wins       int
	Draws      int
	Losses     int
	AnchorElo  float64 // estimated absolute Elo (opp.Elo + headToHeadDiff, averaged over known-Elo opponents); NaN if no anchored opponent
	HasAnchor  bool
}

// RunAbitur plays every scheduled match and returns the per-pair results plus the
// aggregated standings. onPair (optional) fires as each match finishes; onProgress
// (optional) fires as each color-swapped pair completes within a match, for live
// streaming of a long match.
func RunAbitur(ctx context.Context, cfg AbiturConfig, onPair func(PairResult), onProgress func(MatchProgress)) ([]PairResult, []StandingRow, error) {
	if cfg.Concurrency < 1 {
		cfg.Concurrency = 1
	}
	if len(cfg.Book) == 0 {
		eb, err := EmbeddedBook()
		if err != nil {
			return nil, nil, fmt.Errorf("embedded book: %w", err)
		}
		cfg.Book = eb
	}
	matches := scheduleMatches(cfg.Participants, cfg.Gauntlet)
	results := make([]PairResult, 0, len(matches))
	for _, m := range matches {
		a, b := cfg.Participants[m[0]], cfg.Participants[m[1]]
		pr, err := runUCIMatch(ctx, a, b, cfg.Games, cfg.Concurrency, cfg.Book, onProgress)
		if err != nil {
			return results, nil, fmt.Errorf("%s vs %s: %w", a.Name, b.Name, err)
		}
		results = append(results, pr)
		if onPair != nil {
			onPair(pr)
		}
		if ctx.Err() != nil {
			return results, nil, ctx.Err()
		}
	}
	return results, standings(cfg.Participants, results), nil
}

// scheduleMatches returns the unordered participant-index pairs to play. With a
// gauntlet name set, only pairs that include that participant are scheduled.
func scheduleMatches(ps []Participant, gauntlet string) [][2]int {
	var out [][2]int
	for i := 0; i < len(ps); i++ {
		for j := i + 1; j < len(ps); j++ {
			if gauntlet != "" && ps[i].Name != gauntlet && ps[j].Name != gauntlet {
				continue
			}
			out = append(out, [2]int{i, j})
		}
	}
	return out
}

// runUCIMatch plays A vs B over color-swapped game pairs with a worker pool. Each
// worker owns one persistent UCI process per side (started once, reused across
// pairs). Results are accumulated as a Pentanomial (A's perspective) plus W/D/L.
func runUCIMatch(ctx context.Context, a, b Participant, games, concurrency int, book []Opening, onProgress func(MatchProgress)) (PairResult, error) {
	pairs := (games + 1) / 2
	if pairs < 1 {
		pairs = 1
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	type pairOut struct {
		scoreA     float64 // A's score over the 2-game pair (0..2), for pentanomial Elo
		w, d, l    int     // A's exact game-level W/D/L over the pair
	}
	jobs := make(chan int)
	out := make(chan pairOut, concurrency*2)
	errCh := make(chan error, concurrency)

	var wg sync.WaitGroup
	for w := 0; w < concurrency; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ea, err := StartUCISpec(a.spec())
			if err != nil {
				sendErr(errCh, fmt.Errorf("start %s: %w", a.Name, err))
				cancel()
				return
			}
			defer ea.Close()
			eb, err := StartUCISpec(b.spec())
			if err != nil {
				sendErr(errCh, fmt.Errorf("start %s: %w", b.Name, err))
				cancel()
				return
			}
			defer eb.Close()

			for idx := range jobs {
				open := book[idx%len(book)]
				// Game 1: A is White. Game 2: A is Black (same opening).
				s1, err := playUCIvsUCI(ctx, ea, eb, a.Budget, b.Budget, open.FEN)
				if err != nil {
					sendErr(errCh, err)
					cancel()
					return
				}
				s2, err := playUCIvsUCI(ctx, eb, ea, b.Budget, a.Budget, open.FEN)
				if err != nil {
					sendErr(errCh, err)
					cancel()
					return
				}
				// s1 is white-POV (A=white); s2 is white-POV (B=white) → A's share is 1-s2.
				g1, g2 := s1, 1-s2
				po := pairOut{scoreA: g1 + g2}
				for _, sc := range []float64{g1, g2} {
					switch sc {
					case 1:
						po.w++
					case 0:
						po.l++
					default:
						po.d++
					}
				}
				select {
				case out <- po:
				case <-ctx.Done():
					return
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

	var pr PairResult
	pr.A, pr.B = a.Name, b.Name
	start := time.Now()
	for i := 0; i < pairs; i++ {
		var po pairOut
		select {
		case po = <-out:
		case <-ctx.Done():
			select {
			case err := <-errCh:
				return pr, err
			default:
				return pr, ctx.Err()
			}
		}
		pr.Pairs.Add(po.scoreA)
		pr.WinsA += po.w
		pr.Draws += po.d
		pr.WinsB += po.l
		if onProgress != nil {
			done := i + 1
			games := done * 2
			elo, err95 := pr.Pairs.Elo()
			onProgress(MatchProgress{
				A: a.Name, B: b.Name, PairsDone: done, PairsTotal: pairs,
				WinsA: pr.WinsA, Draws: pr.Draws, WinsB: pr.WinsB,
				ScoreA:  (float64(pr.WinsA) + 0.5*float64(pr.Draws)) / float64(games),
				EloDiff: elo, Err95: err95, Elapsed: time.Since(start),
			})
		}
	}
	cancel()
	wg.Wait()
	select {
	case err := <-errCh:
		return pr, err
	default:
	}

	pr.Games = pairs * 2
	pr.ScoreA = (float64(pr.WinsA) + 0.5*float64(pr.Draws)) / float64(pr.Games)
	pr.EloDiff, pr.Err95 = pr.Pairs.Elo()
	pr.Elapsed = time.Since(start)
	return pr, nil
}

// playUCIvsUCI plays one game from openFEN between two UCI engines, `white` and
// `black`, under their respective per-move budgets. Our rules (engine.Adjudicate)
// are the arbiter; an illegal move by either engine loses it the game. Returns the
// WHITE-perspective score (1 white win, 0.5 draw, 0 black win).
func playUCIvsUCI(ctx context.Context, white, black *UCIEngine, whiteBudget, blackBudget UCIBudget, openFEN string) (float64, error) {
	if err := white.NewGame(); err != nil {
		return 0, err
	}
	if err := black.NewGame(); err != nil {
		return 0, err
	}
	pos, err := chess.ParseFEN(openFEN)
	if err != nil {
		return 0, err
	}
	history := make([]uint64, 0, 128)
	moves := make([]string, 0, 128)

	for ply := 0; ply < maxPlies; ply++ {
		st := engine.Adjudicate(pos, history)
		if st.State != "ongoing" {
			return float64(resultToWhite(st.Result)), nil
		}
		if containsAny(st.ClaimableDraws, "threefold", "fifty") {
			return 0.5, nil
		}
		select {
		case <-ctx.Done():
			return 0.5, ctx.Err()
		default:
		}

		var mover *UCIEngine
		var budget UCIBudget
		if pos.SideToMove() == chess.White {
			mover, budget = white, whiteBudget
		} else {
			mover, budget = black, blackBudget
		}
		uci, err := mover.BestMove(openFEN, moves, budget)
		if err != nil {
			return 0, fmt.Errorf("%s: %w", mover.name, err)
		}
		m, ok := pos.ParseUCIMove(uci)
		if !ok {
			// Illegal move (per our rules) loses. Mover is White → Black wins (0), else White wins (1).
			if pos.SideToMove() == chess.White {
				return 0, nil
			}
			return 1, nil
		}
		history = append(history, pos.Key())
		var u chess.Undo
		pos.DoMove(m, &u)
		moves = append(moves, uci)
	}
	return 0.5, nil // ply cap → draw
}

// standings aggregates per-participant Games/Score/W-D-L and an anchored Elo (the
// mean over opponents-with-known-Elo of opp.Elo + head-to-head diff).
func standings(ps []Participant, results []PairResult) []StandingRow {
	byName := map[string]*StandingRow{}
	elo := map[string]int{}
	order := []string{}
	for _, p := range ps {
		byName[p.Name] = &StandingRow{Name: p.Name}
		elo[p.Name] = p.Elo
		order = append(order, p.Name)
	}
	// anchor accumulators: sum of (opp.Elo + diff) and count, per participant.
	anchSum := map[string]float64{}
	anchN := map[string]int{}

	for _, r := range results {
		a, b := byName[r.A], byName[r.B]
		a.Games += r.Games
		b.Games += r.Games
		a.Wins += r.WinsA
		a.Draws += r.Draws
		a.Losses += r.WinsB
		b.Wins += r.WinsB
		b.Draws += r.Draws
		b.Losses += r.WinsA
		// Anchor A off B's Elo and vice-versa.
		if eb := elo[r.B]; eb > 0 {
			anchSum[r.A] += float64(eb) + r.EloDiff
			anchN[r.A]++
		}
		if ea := elo[r.A]; ea > 0 {
			anchSum[r.B] += float64(ea) - r.EloDiff
			anchN[r.B]++
		}
	}
	rows := make([]StandingRow, 0, len(order))
	for _, name := range order {
		row := byName[name]
		total := row.Wins + row.Draws + row.Losses
		if total > 0 {
			row.Score = (float64(row.Wins) + 0.5*float64(row.Draws)) / float64(total)
		}
		if anchN[name] > 0 {
			row.AnchorElo = anchSum[name] / float64(anchN[name])
			row.HasAnchor = true
		}
		rows = append(rows, *row)
	}
	sort.SliceStable(rows, func(i, j int) bool { return rows[i].Score > rows[j].Score })
	return rows
}

func sendErr(ch chan<- error, err error) {
	select {
	case ch <- err:
	default:
	}
}
