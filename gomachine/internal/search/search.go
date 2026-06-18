// Package search implements iterative-deepening negamax with alpha-beta,
// a transposition table, move ordering, quiescence, null-move pruning, and late
// move reductions (SPEC §4.5–§4.7). Scores are centipawns; mate scores are
// encoded near ±mateScore.
package search

import (
	"time"

	"github.com/timanthonyalexander/gomachine/internal/chess"
	"github.com/timanthonyalexander/gomachine/internal/eval"
)

const (
	maxPly        = 128
	infinity      = 30000
	mateScore     = 29000
	mateThreshold = mateScore - maxPly
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

// ClearTT empties the transposition table. The match driver calls this between
// games so a finished game's entries never bias the next one.
func (s *Searcher) ClearTT() { s.tt.Clear() }

func (s *Searcher) reset(limits Limits, gameHistory []uint64) {
	s.nodes = 0
	s.stop = false
	s.killers = [maxPly][2]chess.Move{}
	s.history = [12][64]int{}
	s.tt.NewSearchAge()
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
	s.reset(limits, gameHistory)
	s.pushKey(pos.Key())

	maxDepth := limits.Depth
	if maxDepth <= 0 || maxDepth >= maxPly {
		maxDepth = maxPly - 1
	}

	start := time.Now()
	var result Result
	for d := 1; d <= maxDepth; d++ {
		s.negamax(pos, d, 0, -infinity, infinity)
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
	if !inCheck {
		standPat := eval.Evaluate(pos)
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
