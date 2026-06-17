// Package engine is the high-level orchestration layer over the chess rules and
// the search. It exposes the operations the CLI and HTTP service need: applying
// moves, listing legal moves, adjudicating game status, and producing AI moves
// at difficulty levels 0..10 (SPEC §4, §6, §7).
package engine

import (
	"math/rand/v2"
	"sort"
	"time"

	"github.com/timanthonyalexander/gomachine/internal/chess"
	"github.com/timanthonyalexander/gomachine/internal/search"
)

// Engine wraps a Searcher (which owns the transposition table). It is safe to
// reuse across positions but NOT safe for concurrent searches — use one Engine
// per worker, or guard with a mutex (the HTTP server pools them).
type Engine struct {
	searcher *search.Searcher
}

// New creates an Engine with a transposition table of ttSizeMB megabytes.
func New(ttSizeMB int) *Engine {
	return &Engine{searcher: search.New(ttSizeMB)}
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

	// Full-strength levels: just return the search's best move.
	if cfg.NoiseCp == 0 && cfg.Blunder == 0 {
		r := e.searcher.Search(pos, limits, history)
		return BestResult{
			Move: r.BestMove, Score: r.Score, Depth: r.Depth,
			Nodes: r.Nodes, PV: r.PV, MateIn: r.MateIn, Level: level,
		}
	}

	// Weakened levels: rank all root moves at a bounded depth, jitter the scores,
	// and occasionally pick a deliberately worse move.
	rankDepth := cfg.Depth
	if rankDepth > 6 {
		rankDepth = 6
	}
	roots := e.searcher.RootScores(pos, search.Limits{Depth: rankDepth}, history)
	if len(roots) == 0 {
		return BestResult{Move: chess.NullMove, Level: level}
	}
	if len(roots) == 1 {
		return BestResult{Move: roots[0].Move, Score: roots[0].Score, Depth: rankDepth,
			Nodes: e.searcher.Nodes(), Level: level}
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
		Nodes: e.searcher.Nodes(), PV: []chess.Move{chosen}, Level: level}
}

// SearchDirect runs a full-strength search to an explicit depth and/or time
// budget (depth<=0 means unbounded depth, relying on the time budget).
func (e *Engine) SearchDirect(pos *chess.Position, depth int, movetime time.Duration, history []uint64) BestResult {
	r := e.searcher.Search(pos, search.Limits{Depth: depth, MoveTime: movetime}, history)
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
