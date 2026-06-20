// Package engine is the high-level orchestration layer over the chess rules and
// the search. It exposes the operations the CLI and HTTP service need: applying
// moves, listing legal moves, adjudicating game status, and producing AI moves
// at difficulty levels 0..10 (SPEC §4, §6, §7).
package engine

import (
	"math/rand/v2"
	"sort"
	"time"

	"github.com/timanthonyalexander/gomachine/internal/book"
	"github.com/timanthonyalexander/gomachine/internal/chess"
	"github.com/timanthonyalexander/gomachine/internal/search"
	"github.com/timanthonyalexander/gomachine/internal/syzygy"
)

// Engine wraps a Searcher (which owns the transposition table). It is safe to
// reuse across positions but NOT safe for concurrent searches — use one Engine
// per worker, or guard with a mutex (the HTTP server pools them).
//
// threads is the Lazy SMP worker count for full-strength searches (BestMove's
// full-strength branch and SearchDirect). threads<=1 routes to the serial path,
// which is byte-identical to single-threaded search; >1 trades cores for depth at
// a fixed time budget, so it only helps under a MoveTime limit. Weakened levels
// (which rank root moves at shallow depth) always run serial.
type Engine struct {
	searcher *search.Searcher
	threads  int

	// book, when set AND useBook is true, is consulted before every full-strength
	// search (PlayThreads / SearchDirect). A hit returns the book's precomputed
	// (3s-deep) move for ~zero cost — strictly deeper than the real-time search
	// would reach in the opening. useBook mirrors search.Params.UseBook captured at
	// construction, so the SPRT harness can A/B it as a normal param flag.
	book    *book.Book
	useBook bool

	// tb, when set AND useTablebase is true, is probed before every full-strength
	// search (PlayThreads / SearchDirect) for ≤MaxPieces endgames. A hit returns a
	// provably-optimal DTZ move for ~zero cost. useTablebase mirrors
	// search.Params.UseTablebase captured at construction, so the SPRT harness can
	// A/B it as a normal param flag (see internal/engine/tablebase.go).
	tb           *syzygy.Tablebase
	useTablebase bool
}

// SetBook attaches a precomputed opening book. It's consulted only when the
// engine's params have UseBook set (otherwise it's inert). Pass nil to detach.
func (e *Engine) SetBook(b *book.Book) { e.book = b }

// New creates a full-strength, single-threaded Engine with a transposition table
// of ttSizeMB megabytes.
func New(ttSizeMB int) *Engine {
	return NewWithThreads(ttSizeMB, 1)
}

// NewWithThreads creates a full-strength Engine whose full-strength searches run
// across `threads` Lazy SMP workers (sharing one transposition table). threads<=1
// is single-threaded (byte-identical to serial). Use >1 only when searches are
// time-bounded; size it against the host's cores and any per-request pooling so
// the box isn't oversubscribed.
func NewWithThreads(ttSizeMB, threads int) *Engine {
	if threads < 1 {
		threads = 1
	}
	return &Engine{searcher: search.New(ttSizeMB), threads: threads}
}

// NewWithParams creates an Engine whose search is configured by params. The
// self-play harness uses this to instantiate the "old" and "new" engines from
// one binary (see internal/bench).
func NewWithParams(ttSizeMB int, params search.Params) *Engine {
	return &Engine{searcher: search.NewWithParams(ttSizeMB, params), threads: 1, useBook: params.UseBook, useTablebase: params.UseTablebase}
}

// bookMove returns the opening book's precomputed best move for pos, if the book
// is enabled (UseBook) and holds an exact, still-legal entry. The stored move was
// searched offline at a far larger budget than any real-time control, so a hit is
// a strict upgrade over searching the opening live. Nodes=0 marks the hit; the
// score/mate/depth are the book's (side-to-move-relative, as SearchDirect returns).
func (e *Engine) bookMove(pos *chess.Position) (BestResult, bool) {
	if !e.useBook || e.book == nil {
		return BestResult{}, false
	}
	ent, ok := e.book.Lookup(pos.Key())
	if !ok || len(ent.PV) == 0 {
		return BestResult{}, false
	}
	m, legal := pos.ParseUCIMove(ent.PV[0])
	if !legal {
		return BestResult{}, false
	}
	return BestResult{
		Move: m, Score: ent.Score, Depth: ent.Depth, MateIn: ent.Mate,
		Nodes: 0, PV: []chess.Move{m}, Level: -1,
	}, true
}

// NewGame clears the transposition table so a prior game can't bias the next.
func (e *Engine) NewGame() { e.searcher.ClearTT() }

// Play runs a full-strength search under the given limits (depth/movetime/nodes)
// and returns the result. Used by the match driver with a fixed Nodes budget for
// reproducible, hardware-independent games.
func (e *Engine) Play(pos *chess.Position, limits search.Limits, history []uint64) BestResult {
	return e.PlayThreads(pos, limits, history, 1)
}

// PlayThreads runs a full-strength search using Lazy SMP across `threads` workers
// (threads<=1 is single-threaded). More threads → deeper search at a fixed time
// budget; use with a MoveTime limit (fixed Nodes does not parallelize meaningfully).
func (e *Engine) PlayThreads(pos *chess.Position, limits search.Limits, history []uint64, threads int) BestResult {
	if r, ok := e.tablebaseMove(pos); ok {
		return r
	}
	if r, ok := e.bookMove(pos); ok {
		return r
	}
	r := e.searcher.SearchParallel(pos, limits, history, threads)
	return BestResult{
		Move: r.BestMove, Score: r.Score, Depth: r.Depth,
		Nodes: r.Nodes, PV: r.PV, MateIn: r.MateIn, Level: -1,
	}
}

// BestResult is the outcome of a best-move computation.
type BestResult struct {
	Move   chess.Move
	Score  int
	Depth  int
	Nodes  uint64
	PV     []chess.Move
	MateIn int
	Level  int
}

// BestMove computes a move at the given difficulty level (0..10). history holds
// Zobrist keys of prior game positions for repetition awareness.
func (e *Engine) BestMove(pos *chess.Position, level int, history []uint64) BestResult {
	cfg := configForLevel(level)
	limits := search.Limits{Depth: cfg.Depth, MoveTime: cfg.MoveTime}

	// Full-strength levels: just return the search's best move (Lazy SMP across
	// e.threads workers; threads<=1 is the serial path).
	if cfg.NoiseCp == 0 && cfg.Blunder == 0 {
		r := e.searcher.SearchParallel(pos, limits, history, e.threads)
		return BestResult{
			Move: r.BestMove, Score: r.Score, Depth: r.Depth,
			Nodes: r.Nodes, PV: r.PV, MateIn: r.MateIn, Level: level,
		}
	}

	// Weakened levels: rank all root moves at a bounded depth (≤6 for the 0..10
	// levels), jitter the scores, and occasionally pick a deliberately worse move.
	rankDepth := cfg.Depth
	if rankDepth > 6 {
		rankDepth = 6
	}
	roots := e.searcher.RootScores(pos, search.Limits{Depth: rankDepth}, history)
	r := e.pickWeakened(roots, cfg, rankDepth)
	r.Level = level
	return r
}

// BestMoveConfig plays one move under an explicit weakening config. Unlike
// BestMove(level) it honours cfg.Depth for the root ranking directly (no ≤6 cap),
// so it can span the full rating ladder. NoiseCp==0 && Blunder==0 → full-strength
// search capped by cfg.Depth/MoveTime; otherwise root-rank + noise + blunder.
func (e *Engine) BestMoveConfig(pos *chess.Position, cfg LevelConfig, history []uint64) BestResult {
	if cfg.NoiseCp == 0 && cfg.Blunder == 0 {
		limits := search.Limits{Depth: cfg.Depth, MoveTime: cfg.MoveTime}
		r := e.searcher.SearchParallel(pos, limits, history, e.threads)
		return BestResult{Move: r.BestMove, Score: r.Score, Depth: r.Depth,
			Nodes: r.Nodes, PV: r.PV, MateIn: r.MateIn}
	}
	rankDepth := cfg.Depth
	if rankDepth < 1 {
		rankDepth = 1
	}
	roots := e.searcher.RootScores(pos, search.Limits{Depth: rankDepth}, history)
	return e.pickWeakened(roots, cfg, rankDepth)
}

// BestMoveForRating plays at a target Elo (clamped to RatingMin..RatingMax) — the
// rating-first entry point used by bot games and matchmaking bot-fill (fixed
// 100ms budget, so it plays the strength it advertises).
func (e *Engine) BestMoveForRating(pos *chess.Position, rating int, history []uint64) BestResult {
	return e.BestMoveForRatingTimed(pos, rating, 0, history)
}

// BestMoveForRatingTimed is BestMoveForRating with an explicit per-move budget
// override (movetime>0) — used by the admin engine-vs-engine view so the watcher
// can let the engines think longer. NOTE: above the strong floor the budget,
// not the rating, then bounds depth, so more time => stronger than the nominal
// rating; below it the move is depth-bounded and the budget has no effect.
func (e *Engine) BestMoveForRatingTimed(pos *chess.Position, rating int, movetime time.Duration, history []uint64) BestResult {
	cfg := configForRating(rating)
	if movetime > 0 {
		cfg.MoveTime = movetime
	}
	return e.BestMoveConfig(pos, cfg, history)
}

// pickWeakened applies eval noise + occasional blunders to a root-move ranking.
func (e *Engine) pickWeakened(roots []search.RootMove, cfg LevelConfig, rankDepth int) BestResult {
	if len(roots) == 0 {
		return BestResult{Move: chess.NullMove}
	}
	if len(roots) == 1 {
		return BestResult{Move: roots[0].Move, Score: roots[0].Score, Depth: rankDepth,
			Nodes: e.searcher.Nodes()}
	}

	noisy := make([]search.RootMove, len(roots))
	copy(noisy, roots)
	for i := range noisy {
		noisy[i].Score += rand.IntN(2*cfg.NoiseCp+1) - cfg.NoiseCp
	}
	sort.SliceStable(noisy, func(i, j int) bool { return noisy[i].Score > noisy[j].Score })

	pick := 0
	if rand.Float64() < cfg.Blunder {
		// Pick a random move from the weaker half (a clear-but-legal blunder).
		lo := len(noisy) / 2
		pick = lo + rand.IntN(len(noisy)-lo)
	}
	chosen := noisy[pick].Move

	// Report the chosen move's true (pre-noise) score for display.
	trueScore := 0
	for _, rm := range roots {
		if rm.Move == chosen {
			trueScore = rm.Score
			break
		}
	}
	return BestResult{Move: chosen, Score: trueScore, Depth: rankDepth,
		Nodes: e.searcher.Nodes(), PV: []chess.Move{chosen}}
}

// SearchDirect runs a full-strength search to an explicit depth and/or time
// budget (depth<=0 means unbounded depth, relying on the time budget).
func (e *Engine) SearchDirect(pos *chess.Position, depth int, movetime time.Duration, history []uint64) BestResult {
	if r, ok := e.tablebaseMove(pos); ok {
		return r
	}
	if r, ok := e.bookMove(pos); ok {
		return r
	}
	r := e.searcher.SearchParallel(pos, search.Limits{Depth: depth, MoveTime: movetime}, history, e.threads)
	return BestResult{
		Move: r.BestMove, Score: r.Score, Depth: r.Depth,
		Nodes: r.Nodes, PV: r.PV, MateIn: r.MateIn, Level: -1,
	}
}

// --- Rules operations (delegate to the chess core) ---

// Status classifies the position per FIDE rules (SPEC §5.4). history holds the
// Zobrist keys of all prior positions in the game (including the current one is
// optional; this function counts the current key too).
type Status struct {
	State          string   // see SPEC: ongoing | checkmate | stalemate | draw-*
	SideToMove     string   // "w" | "b"
	Check          bool     // side to move is in check
	ClaimableDraws []string // e.g. ["threefold","fifty"] — non-automatic
	Result         string   // "1-0" | "0-1" | "1/2-1/2" | "" (ongoing)
}

// repetitionCount returns how many times the current position's key appears in
// history (the slice should contain prior-position keys; the current key is
// counted as one occurrence).
func repetitionCount(key uint64, history []uint64) int {
	count := 1 // the current position
	for _, k := range history {
		if k == key {
			count++
		}
	}
	return count
}

// Adjudicate returns the game status of pos given prior-position keys (history
// should NOT include the current position's key).
func Adjudicate(pos *chess.Position, history []uint64) Status {
	st := Status{State: "ongoing", Check: pos.InCheck()}
	if pos.SideToMove() == chess.White {
		st.SideToMove = "w"
	} else {
		st.SideToMove = "b"
	}

	var ml chess.MoveList
	pos.GenerateLegal(&ml)
	if ml.Len() == 0 {
		if pos.InCheck() {
			st.State = "checkmate"
			if pos.SideToMove() == chess.White {
				st.Result = "0-1"
			} else {
				st.Result = "1-0"
			}
		} else {
			st.State = "stalemate"
			st.Result = "1/2-1/2"
		}
		return st
	}

	if pos.InsufficientMaterial() {
		st.State = "draw-insufficient-material"
		st.Result = "1/2-1/2"
		return st
	}

	reps := repetitionCount(pos.Key(), history)
	if reps >= 5 {
		st.State = "draw-fivefold"
		st.Result = "1/2-1/2"
		return st
	}
	if pos.HalfmoveClock() >= 150 {
		st.State = "draw-seventyfive"
		st.Result = "1/2-1/2"
		return st
	}

	// Claimable (non-automatic) draws.
	if reps >= 3 {
		st.ClaimableDraws = append(st.ClaimableDraws, "threefold")
	}
	if pos.HalfmoveClock() >= 100 {
		st.ClaimableDraws = append(st.ClaimableDraws, "fifty")
	}
	return st
}
