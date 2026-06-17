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
)

// isCapture reports whether m captures on the (pre-move) position.
func isCapture(pos *chess.Position, m chess.Move) bool {
	return pos.PieceOn(m.To()) != chess.NoPiece || m.Type() == chess.EnPassant
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
		return scoreCapture + pieceOrderVal[chess.Pawn]*16 - pieceOrderVal[chess.Pawn]
	}
	if victim := pos.PieceOn(m.To()); victim != chess.NoPiece {
		attacker := pos.PieceOn(m.From()).Type()
		return scoreCapture + pieceOrderVal[victim.Type()]*16 - pieceOrderVal[attacker]
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
