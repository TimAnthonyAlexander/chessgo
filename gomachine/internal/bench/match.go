package bench

import (
	"context"
	"sync"
	"time"

	"github.com/timanthonyalexander/gomachine/internal/book"
	"github.com/timanthonyalexander/gomachine/internal/chess"
	"github.com/timanthonyalexander/gomachine/internal/engine"
	"github.com/timanthonyalexander/gomachine/internal/search"
	"github.com/timanthonyalexander/gomachine/internal/syzygy"
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
	// Asymmetric time control: when Nodes==0 and one of these is >0, that side
	// uses its own per-move budget instead of the shared MoveTime. Lets us measure
	// the Elo value of a time edge (e.g. new=100ms vs old=200ms). 0 → fall back to
	// MoveTime. Ignored when Nodes>0 (fixed-nodes is hardware-independent already).
	NewMoveTime time.Duration
	OldMoveTime time.Duration
	// Per-side max search depth (0 → unbounded, time/nodes limited). Lets us A/B a
	// depth cap against an uncapped search at the same budget (e.g. is level 10's
	// Depth:14 cap leaving Elo on the table at its 1900ms?).
	NewDepth int
	OldDepth int
	TTMB     int // transposition table size per engine

	Elo0, Elo1  float64 // SPRT hypotheses (H0: ≤Elo0, H1: ≥Elo1)
	Alpha, Beta float64 // error rates
	Concurrency int     // parallel game-pair workers
	MaxPairs    int     // hard cap on pairs before giving up
	Book        []Opening

	// EngineBook is the precomputed opening book attached to BOTH engines; whether
	// a side consults it is governed solely by its Params.UseBook flag, so it's a
	// clean controlled A/B (--new "book=on" vs --old "book=off"). nil → no book.
	EngineBook *book.Book

	// Tablebase is the Syzygy endgame tablebase attached to BOTH engines; whether a
	// side probes it is governed solely by its Params.UseTablebase flag, so it's a
	// clean controlled A/B (--new "tb=on" vs --old "tb=off"). nil → no tablebase.
	Tablebase *syzygy.Tablebase

	NewThreads int // Lazy SMP threads for the patch engine (default 1)
	OldThreads int // Lazy SMP threads for the baseline engine (default 1)

	// Difficulty level per side, or <0 for full strength. Calibration sets these
	// to play the weakened BestMove path; SPRT/strength runs leave them <0.
	NewLevel int
	OldLevel int
}

// player pairs an engine with its Lazy SMP thread count and its own per-move
// search budget (so the two sides can run different time controls). When level
// >= 0 the player plays the WEAKENED level path (BestMove: the level's own
// depth/movetime + noise/blunder) instead of full strength — used by calibration
// to measure each difficulty level's Elo. level < 0 means full strength.
type player struct {
	eng     *engine.Engine
	threads int
	lim     search.Limits
	level   int
}

func (p player) play(pos *chess.Position, history []uint64) engine.BestResult {
	if p.level >= 0 {
		return p.eng.BestMove(pos, p.level, history)
	}
	return p.eng.PlayThreads(pos, p.lim, history, p.threads)
}

// gameOutcome is a single game's result from White's perspective.
type gameOutcome float64

const (
	whiteWin gameOutcome = 1.0
	drawn    gameOutcome = 0.5
	blackWin gameOutcome = 0.0
)

// limitsFor returns the per-move search limits for one side. Fixed nodes (when
// set) are shared and hardware-independent; otherwise each side uses its own
// movetime if given (asymmetric TC), falling back to the shared MoveTime. sideDepth
// (0 = unbounded) caps the iterative-deepening loop on top of the time/node budget.
func (c *Config) limitsFor(sideMoveTime time.Duration, sideDepth int) search.Limits {
	lim := search.Limits{Depth: sideDepth}
	switch {
	case c.Nodes > 0:
		lim.Nodes = c.Nodes
	case sideMoveTime > 0:
		lim.MoveTime = sideMoveTime
	default:
		lim.MoveTime = c.MoveTime
	}
	return lim
}

// playGame plays one game from the opening FEN and returns the result from
// White's perspective. white and black are reused across games — NewGame() (TT
// clear) is called here so no game biases the next; killers/history reset per
// search already. ctx cancellation ends the game as a draw (run is stopping).
func playGame(ctx context.Context, white, black player, openFEN string) gameOutcome {
	white.eng.NewGame()
	black.eng.NewGame()

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
		res := mover.play(pos, history)
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
	newLim := cfg.limitsFor(cfg.NewMoveTime, cfg.NewDepth)
	oldLim := cfg.limitsFor(cfg.OldMoveTime, cfg.OldDepth)
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
			newP := player{engine.NewWithParams(cfg.TTMB, cfg.NewParams), maxThreads(cfg.NewThreads), newLim, cfg.NewLevel}
			oldP := player{engine.NewWithParams(cfg.TTMB, cfg.OldParams), maxThreads(cfg.OldThreads), oldLim, cfg.OldLevel}
			newP.eng.SetBook(cfg.EngineBook)
			oldP.eng.SetBook(cfg.EngineBook)
			newP.eng.SetTablebase(cfg.Tablebase)
			oldP.eng.SetTablebase(cfg.Tablebase)
			for open := range jobs {
				r1 := playGame(ctx, newP, oldP, open.FEN)
				r2 := playGame(ctx, oldP, newP, open.FEN)
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

// maxThreads normalizes a thread count (0/negative → 1).
func maxThreads(n int) int {
	if n < 1 {
		return 1
	}
	return n
}
