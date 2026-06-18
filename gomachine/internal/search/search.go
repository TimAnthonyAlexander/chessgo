// Package search implements iterative-deepening negamax with alpha-beta,
// a transposition table, move ordering, quiescence, null-move pruning, and late
// move reductions (SPEC §4.5–§4.7). Scores are centipawns; mate scores are
// encoded near ±mateScore.
package search

import (
	"sync"
	"time"

	"github.com/timanthonyalexander/gomachine/internal/chess"
	"github.com/timanthonyalexander/gomachine/internal/eval"
)

const (
	maxPly        = 128
	infinity      = 30000
	mateScore     = 29000
	mateThreshold = mateScore - maxPly
	// deltaMargin is the safety cushion (centipawns) for quiescence delta pruning.
	deltaMargin = 200
	// Reverse futility pruning: margin per depth and the max depth it applies at.
	rfpMargin   = 75
	rfpMaxDepth = 8
	// Late move pruning: max depth it applies at. The move-count limit is
	// 3 + depth² (so depth 1→4, 2→7, 3→12, …).
	lmpMaxDepth = 8
)

// pieceOrderVal is a coarse piece value used by MVV-LVA move ordering.
var pieceOrderVal = [6]int{100, 320, 330, 500, 900, 20000}

// Limits bounds a search.
type Limits struct {
	Depth    int           // max depth (<=0 → use maxPly)
	MoveTime time.Duration // soft time budget (0 → none)
	Nodes    uint64        // optional node cap (0 → none)
}

// Result is the outcome of a search.
type Result struct {
	BestMove chess.Move
	Score    int
	Depth    int
	Nodes    uint64
	PV       []chess.Move
	MateIn   int // signed mate distance in moves (0 = none)
	Elapsed  time.Duration
}

// Searcher holds reusable search state (TT, killers, history).
type Searcher struct {
	tt       *TT
	params   Params
	killers  [maxPly][2]chess.Move
	history  [12][64]int
	nodes    uint64
	stop     bool
	deadline time.Time
	useTime  bool
	nodeCap  uint64
	keyStack []uint64

	rootBest  chess.Move
	rootScore int
}

// New returns a full-strength Searcher with a transposition table of ttSizeMB
// megabytes.
func New(ttSizeMB int) *Searcher { return NewWithParams(ttSizeMB, DefaultParams()) }

// NewWithParams returns a Searcher configured by params — used by the self-play
// harness to build the "old" and "new" engines from the same code.
func NewWithParams(ttSizeMB int, params Params) *Searcher {
	return &Searcher{
		tt:       NewTT(ttSizeMB),
		params:   params,
		keyStack: make([]uint64, 0, 1024),
	}
}

// newWithSharedTT returns a helper Searcher that shares tt with others (Lazy SMP
// worker). It has its own killers/history/stack/node counter; only the TT is
// shared. It must NOT bump the TT age — the coordinator does that once.
func newWithSharedTT(tt *TT, params Params) *Searcher {
	return &Searcher{
		tt:       tt,
		params:   params,
		keyStack: make([]uint64, 0, 1024),
	}
}

// ClearTT empties the transposition table. The match driver calls this between
// games so a finished game's entries never bias the next one.
func (s *Searcher) ClearTT() { s.tt.Clear() }

func (s *Searcher) reset(limits Limits, gameHistory []uint64) {
	s.nodes = 0
	s.stop = false
	s.killers = [maxPly][2]chess.Move{}
	s.history = [12][64]int{}
	s.useTime = limits.MoveTime > 0
	if s.useTime {
		s.deadline = time.Now().Add(limits.MoveTime)
	}
	s.nodeCap = limits.Nodes
	s.keyStack = append(s.keyStack[:0], gameHistory...)
	s.rootBest = chess.NullMove
	s.rootScore = 0
}

func (s *Searcher) pushKey(k uint64) { s.keyStack = append(s.keyStack, k) }
func (s *Searcher) popKey()          { s.keyStack = s.keyStack[:len(s.keyStack)-1] }

func (s *Searcher) checkStop() {
	if s.stop {
		return
	}
	if s.useTime && s.nodes&2047 == 0 && time.Now().After(s.deadline) {
		s.stop = true
	}
	if s.nodeCap > 0 && s.nodes >= s.nodeCap {
		s.stop = true
	}
}

// isRepetition reports whether the current position (top of keyStack) has
// occurred earlier within the halfmove window.
func (s *Searcher) isRepetition(pos *chess.Position) bool {
	key := pos.Key()
	last := len(s.keyStack) - 1
	start := last - int(pos.HalfmoveClock())
	if start < 0 {
		start = 0
	}
	for i := last - 2; i >= start; i -= 2 {
		if s.keyStack[i] == key {
			return true
		}
	}
	return false
}

// Search runs iterative deepening and returns the best line. gameHistory holds
// Zobrist keys of positions that occurred before the root (for repetition).
func (s *Searcher) Search(pos *chess.Position, limits Limits, gameHistory []uint64) Result {
	s.tt.NewSearchAge()
	return s.runID(pos, limits, gameHistory)
}

// SearchParallel runs Lazy SMP: `threads` workers search the same position
// concurrently, sharing this Searcher's transposition table (each worker keeps
// its own killers/history/stack). They diverge via timing and cross-pollinate
// through the shared TT; the result is taken from the worker that reached the
// greatest completed depth. threads<=1 is exactly the single-threaded Search.
func (s *Searcher) SearchParallel(pos *chess.Position, limits Limits, gameHistory []uint64, threads int) Result {
	if threads <= 1 {
		return s.Search(pos, limits, gameHistory)
	}
	s.tt.NewSearchAge() // once, before any worker — TT age is then read-only

	results := make([]Result, threads)
	var wg sync.WaitGroup
	for i := 0; i < threads; i++ {
		wg.Add(1)
		worker := s
		if i > 0 {
			worker = newWithSharedTT(s.tt, s.params)
		}
		go func(i int, w *Searcher) {
			defer wg.Done()
			p := *pos // value copy: each worker mutates its own board
			results[i] = w.runID(&p, limits, gameHistory)
		}(i, worker)
	}
	wg.Wait()

	best := results[0]
	for i := 1; i < threads; i++ {
		if results[i].Depth > best.Depth ||
			(results[i].Depth == best.Depth && results[i].Score > best.Score) {
			best = results[i]
		}
	}
	return best
}

// runID is the iterative-deepening loop for one worker (no TT-age bump — the
// caller owns that so parallel workers don't all bump the shared counter).
func (s *Searcher) runID(pos *chess.Position, limits Limits, gameHistory []uint64) Result {
	s.reset(limits, gameHistory)
	s.pushKey(pos.Key())

	maxDepth := limits.Depth
	if maxDepth <= 0 || maxDepth >= maxPly {
		maxDepth = maxPly - 1
	}

	start := time.Now()
	var result Result
	for d := 1; d <= maxDepth; d++ {
		s.searchRoot(pos, d, result.Score)
		if s.stop && d > 1 {
			break // discard incomplete iteration
		}
		result.BestMove = s.rootBest
		result.Score = s.rootScore
		result.Depth = d
		result.Nodes = s.nodes
		result.PV = s.extractPV(pos, d)
		result.MateIn = mateDistance(s.rootScore)
		if result.MateIn != 0 {
			break // mate found; no need to search deeper
		}
		if s.useTime && time.Now().After(s.deadline) {
			break
		}
	}
	result.Elapsed = time.Since(start)
	return result
}

// Aspiration-window constants (SPEC §4.5). Around the previous iteration's
// score we open a narrow window and only re-search wider on a fail.
const (
	aspMinDepth  = 4    // full window for shallower iterations
	aspInitDelta = 25   // initial half-window (centipawns)
	aspMaxDelta  = 1500 // beyond this, fall back to a full window
)

// searchRoot runs one iterative-deepening iteration at the given depth. With
// aspiration enabled (and past the warmup depth) it searches a narrow window
// around prevScore, widening only the bound that fails until the score lands
// inside — fewer root nodes than a full -inf/+inf window. rootBest/rootScore are
// set by negamax at ply 0; on a fail-low the root move is not trusted (we
// re-search), and the caller discards the whole iteration if the clock expires.
func (s *Searcher) searchRoot(pos *chess.Position, depth, prevScore int) {
	if !s.params.Aspiration || depth < aspMinDepth || absInt(prevScore) >= mateThreshold {
		s.negamax(pos, depth, 0, -infinity, infinity)
		return
	}
	delta := aspInitDelta
	alpha := maxInt(prevScore-delta, -infinity)
	beta := minInt(prevScore+delta, infinity)
	for {
		score := s.negamax(pos, depth, 0, alpha, beta)
		if s.stop {
			return
		}
		switch {
		case score <= alpha: // fail low: lower alpha, pull beta toward center
			beta = (alpha + beta) / 2
			alpha = maxInt(score-delta, -infinity)
		case score >= beta: // fail high: raise beta
			beta = minInt(score+delta, infinity)
		default:
			return // score inside the window
		}
		delta += delta
		if delta >= aspMaxDelta {
			alpha, beta = -infinity, infinity
		}
	}
}

func absInt(x int) int {
	if x < 0 {
		return -x
	}
	return x
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

// RootMove pairs a root move with its searched score.
type RootMove struct {
	Move  chess.Move
	Score int
}

// Nodes returns the node count of the most recent search.
func (s *Searcher) Nodes() uint64 { return s.nodes }

// RootScores searches every legal root move independently to limits.Depth and
// returns their scores (MultiPV-style), used by the engine's level-based
// weakening. Scores are from the root side-to-move's perspective.
func (s *Searcher) RootScores(pos *chess.Position, limits Limits, gameHistory []uint64) []RootMove {
	s.tt.NewSearchAge()
	s.reset(limits, gameHistory)
	s.pushKey(pos.Key())

	depth := limits.Depth
	if depth < 1 {
		depth = 1
	}

	var ml chess.MoveList
	pos.GenerateLegal(&ml)
	out := make([]RootMove, 0, ml.Len())
	for i := 0; i < ml.Len(); i++ {
		m := ml.Get(i)
		var u chess.Undo
		pos.DoMove(m, &u)
		s.pushKey(pos.Key())
		score := -s.negamax(pos, depth-1, 1, -infinity, infinity)
		s.popKey()
		pos.UndoMove(m, &u)
		out = append(out, RootMove{Move: m, Score: score})
	}
	return out
}

func mateDistance(score int) int {
	if score > mateThreshold {
		return (mateScore - score + 1) / 2
	}
	if score < -mateThreshold {
		return -((mateScore + score + 1) / 2)
	}
	return 0
}

func (s *Searcher) negamax(pos *chess.Position, depth, ply, alpha, beta int) int {
	s.nodes++
	s.checkStop()
	if s.stop {
		return 0
	}
	if ply >= maxPly-1 {
		return eval.Evaluate(pos)
	}
	if ply > 0 && (pos.HalfmoveClock() >= 100 || s.isRepetition(pos)) {
		return 0
	}

	inCheck := pos.InCheck()
	if inCheck && s.params.CheckExtension {
		depth++ // check extension
	}
	if depth <= 0 {
		return s.quiescence(pos, ply, alpha, beta)
	}

	// Transposition table probe.
	ttMove := chess.NullMove
	if e, ok := s.tt.probe(pos.Key()); s.params.UseTT && ok {
		ttMove = e.move
		if ply > 0 && int(e.depth) >= depth {
			sc := e.scoreFromTT(ply)
			switch e.flag {
			case ttExact:
				return sc
			case ttLower:
				if sc >= beta {
					return sc
				}
			case ttUpper:
				if sc <= alpha {
					return sc
				}
			}
		}
	}

	isPV := beta-alpha > 1

	// Static evaluation at this node (meaningless while in check); used by
	// reverse futility pruning, and later by other heuristics.
	var staticEval int
	if !inCheck {
		staticEval = eval.Evaluate(pos)
	}

	// Reverse futility pruning (static null move): at a non-PV node near the
	// leaves, if the static eval beats beta by a depth-scaled margin even after
	// conceding that margin, fail high without searching.
	if s.params.RFP && !inCheck && !isPV && ply > 0 && depth <= rfpMaxDepth &&
		absInt(beta) < mateThreshold && staticEval-rfpMargin*depth >= beta {
		return staticEval - rfpMargin*depth
	}

	// Null-move pruning.
	if s.params.NullMove && !inCheck && depth >= 3 && ply > 0 && beta < mateThreshold &&
		pos.NonPawnMaterial(pos.SideToMove()) {
		var u chess.Undo
		pos.DoNullMove(&u)
		s.pushKey(pos.Key())
		r := s.params.NullMoveR + depth/4
		sc := -s.negamax(pos, depth-1-r, ply+1, -beta, -beta+1)
		s.popKey()
		pos.UndoNullMove(&u)
		if s.stop {
			return 0
		}
		if sc >= beta {
			return beta
		}
	}

	var ml chess.MoveList
	pos.GenerateLegal(&ml)
	if ml.Len() == 0 {
		if inCheck {
			return -mateScore + ply // checkmated
		}
		return 0 // stalemate
	}

	var scores [256]int
	s.scoreMoves(pos, &ml, ttMove, ply, &scores)

	bestScore := -infinity
	bestMove := chess.NullMove
	origAlpha := alpha
	searched := 0

	for i := 0; i < ml.Len(); i++ {
		selectMove(&ml, &scores, i)
		m := ml.Get(i)
		quiet := !isCapture(pos, m) && m.Type() != chess.Promotion

		// Late move pruning: at a non-PV node near the leaves, once enough quiet
		// moves have been searched, skip the remaining late quiets (move ordering
		// puts them last, so they are almost never the best move). Never when in
		// check or when escaping a mate.
		if s.params.LMP && quiet && !isPV && !inCheck && searched > 0 &&
			depth <= lmpMaxDepth && bestScore > -mateThreshold &&
			searched >= 3+depth*depth {
			continue
		}

		var u chess.Undo
		pos.DoMove(m, &u)
		s.pushKey(pos.Key())
		givesCheck := pos.InCheck()

		var sc int
		if searched == 0 {
			sc = -s.negamax(pos, depth-1, ply+1, -beta, -alpha)
		} else {
			reduction := 0
			if s.params.LMR && depth >= 3 && searched >= 4 && quiet && !inCheck && !givesCheck {
				reduction = 1
				if searched >= 8 {
					reduction = 2
				}
			}
			sc = -s.negamax(pos, depth-1-reduction, ply+1, -alpha-1, -alpha)
			if sc > alpha && reduction > 0 {
				sc = -s.negamax(pos, depth-1, ply+1, -alpha-1, -alpha)
			}
			if sc > alpha && sc < beta {
				sc = -s.negamax(pos, depth-1, ply+1, -beta, -alpha)
			}
		}

		s.popKey()
		pos.UndoMove(m, &u)
		if s.stop {
			return 0
		}
		searched++

		if sc > bestScore {
			bestScore = sc
			bestMove = m
			if ply == 0 {
				s.rootBest = m
				s.rootScore = sc
			}
			if sc > alpha {
				alpha = sc
				if alpha >= beta {
					if quiet {
						s.recordKiller(ply, m)
						s.history[pos.PieceOn(m.From())][m.To()] += depth * depth
					}
					break
				}
			}
		}
	}

	flag := ttExact
	if bestScore <= origAlpha {
		flag = ttUpper
	} else if bestScore >= beta {
		flag = ttLower
	}
	if s.params.UseTT {
		s.tt.store(pos.Key(), bestMove, bestScore, depth, ply, flag)
	}
	return bestScore
}

func (s *Searcher) quiescence(pos *chess.Position, ply, alpha, beta int) int {
	s.nodes++
	s.checkStop()
	if s.stop {
		return 0
	}
	if ply >= maxPly-1 {
		return eval.Evaluate(pos)
	}

	inCheck := pos.InCheck()
	standPat := 0
	if !inCheck {
		standPat = eval.Evaluate(pos)
		if standPat >= beta {
			return beta
		}
		if standPat > alpha {
			alpha = standPat
		}
	}

	var ml chess.MoveList
	pos.GenerateLegal(&ml)
	if ml.Len() == 0 {
		if inCheck {
			return -mateScore + ply
		}
		return alpha
	}

	var scores [256]int
	s.scoreMoves(pos, &ml, chess.NullMove, ply, &scores)

	for i := 0; i < ml.Len(); i++ {
		selectMove(&ml, &scores, i)
		m := ml.Get(i)
		// Out of check, search only captures/promotions; in check, all evasions.
		if !inCheck && !isCapture(pos, m) && m.Type() != chess.Promotion {
			continue
		}
		// SEE pruning: out of check, skip captures that lose material outright.
		if !inCheck && s.params.SEE && isCapture(pos, m) && m.Type() != chess.Promotion &&
			pos.SEE(m) < 0 {
			continue
		}
		// Delta pruning: out of check, skip a capture that even in the best case
		// (winning the victim plus a margin) cannot raise alpha.
		if !inCheck && s.params.DeltaPrune && isCapture(pos, m) && m.Type() != chess.Promotion {
			if standPat+captureGain(pos, m)+deltaMargin <= alpha {
				continue
			}
		}
		var u chess.Undo
		pos.DoMove(m, &u)
		sc := -s.quiescence(pos, ply+1, -beta, -alpha)
		pos.UndoMove(m, &u)
		if s.stop {
			return 0
		}
		if sc >= beta {
			return beta
		}
		if sc > alpha {
			alpha = sc
		}
	}
	return alpha
}

func (s *Searcher) extractPV(pos *chess.Position, maxLen int) []chess.Move {
	pv := make([]chess.Move, 0, maxLen)
	p := *pos // Position is a value type (arrays only) → cheap copy
	seen := make(map[uint64]bool, maxLen)
	for len(pv) < maxLen {
		e, ok := s.tt.probe(p.Key())
		if !ok || e.move == chess.NullMove || seen[p.Key()] {
			break
		}
		seen[p.Key()] = true
		var ml chess.MoveList
		p.GenerateLegal(&ml)
		legal := false
		for i := 0; i < ml.Len(); i++ {
			if ml.Get(i) == e.move {
				legal = true
				break
			}
		}
		if !legal {
			break
		}
		pv = append(pv, e.move)
		var u chess.Undo
		p.DoMove(e.move, &u)
	}
	return pv
}
