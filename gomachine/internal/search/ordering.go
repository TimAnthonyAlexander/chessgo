package search

import "github.com/timanthonyalexander/gomachine/internal/chess"

// Move-ordering scores (SPEC §4.7): TT move first, then captures by MVV-LVA,
// then killer moves, then quiet moves by history heuristic.
const (
	scoreTT      = 2_000_000
	scorePromo   = 1_500_000
	scoreCapture = 1_000_000
	scoreKiller0 = 900_000
	scoreKiller1 = 800_000
	// scoreLosingCapture sits below killers and quiet (history) moves so that
	// SEE-losing captures are tried last (SEE ordering, enabled by Params.SEE).
	scoreLosingCapture = -2_000_000
)

// isCapture reports whether m captures on the (pre-move) position.
func isCapture(pos *chess.Position, m chess.Move) bool {
	return pos.PieceOn(m.To()) != chess.NoPiece || m.Type() == chess.EnPassant
}

// captureGain returns the centipawn value of m's victim (for delta pruning).
func captureGain(pos *chess.Position, m chess.Move) int {
	if m.Type() == chess.EnPassant {
		return chess.SEEValues[chess.Pawn]
	}
	if v := pos.PieceOn(m.To()); v != chess.NoPiece {
		return chess.SEEValues[v.Type()]
	}
	return 0
}

// scoreMoves fills scores[i] with the ordering score of ml[i].
func (s *Searcher) scoreMoves(pos *chess.Position, ml *chess.MoveList, ttMove chess.Move, ply int, scores *[256]int) {
	for i := 0; i < ml.Len(); i++ {
		scores[i] = s.moveScore(pos, ml.Get(i), ttMove, ply)
	}
}

func (s *Searcher) moveScore(pos *chess.Position, m, ttMove chess.Move, ply int) int {
	if m == ttMove {
		return scoreTT
	}
	if m.Type() == chess.Promotion {
		return scorePromo + pieceOrderVal[m.Promo()]
	}
	if m.Type() == chess.EnPassant {
		mvvlva := pieceOrderVal[chess.Pawn]*16 - pieceOrderVal[chess.Pawn]
		return s.captureScore(pos, m, mvvlva)
	}
	if victim := pos.PieceOn(m.To()); victim != chess.NoPiece {
		attacker := pos.PieceOn(m.From()).Type()
		mvvlva := pieceOrderVal[victim.Type()]*16 - pieceOrderVal[attacker]
		return s.captureScore(pos, m, mvvlva)
	}
	// Quiet move.
	if m == s.killers[ply][0] {
		return scoreKiller0
	}
	if m == s.killers[ply][1] {
		return scoreKiller1
	}
	return s.history[pos.PieceOn(m.From())][m.To()]
}

// captureScore ranks a capture: winning/equal captures (or all captures when SEE
// is off) sort by MVV-LVA above killers; SEE-losing captures sort last.
func (s *Searcher) captureScore(pos *chess.Position, m chess.Move, mvvlva int) int {
	if s.params.SEE && pos.SEE(m) < 0 {
		return scoreLosingCapture + mvvlva
	}
	return scoreCapture + mvvlva
}

// selectMove performs one step of a selection sort: it finds the highest-scored
// move in [i, len) and swaps it (and its score) into slot i. This lazily orders
// moves so a beta-cutoff avoids sorting the rest.
func selectMove(ml *chess.MoveList, scores *[256]int, i int) {
	best := i
	for j := i + 1; j < ml.Len(); j++ {
		if scores[j] > scores[best] {
			best = j
		}
	}
	if best != i {
		ml.Swap(i, best)
		scores[i], scores[best] = scores[best], scores[i]
	}
}

func (s *Searcher) recordKiller(ply int, m chess.Move) {
	if s.killers[ply][0] != m {
		s.killers[ply][1] = s.killers[ply][0]
		s.killers[ply][0] = m
	}
}
