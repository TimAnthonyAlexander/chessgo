package antichess

import "github.com/timanthonyalexander/gomachine/internal/chess"

// pieceValue is the centipawn "weight" of a piece for the shallow fallback
// eval below. Every piece type (including the king — an ordinary, capturable
// piece here) counts toward material; there is no special king value.
var pieceValue = [6]int{
	chess.Pawn:   100,
	chess.Knight: 300,
	chess.Bishop: 310,
	chess.Rook:   450,
	chess.Queen:  700,
	chess.King:   250,
}

// captureValue scores "how valuable is this victim" for move ordering.
func captureValue(pt chess.PieceType) int { return pieceValue[pt] }

// evaluate returns a centipawn score from the SIDE-TO-MOVE's perspective for
// this ONLY-search fallback (zugzwang owns real Antichess strength; this is
// the "-emergency-inproc" safety net). Antichess strategy is inverted from
// normal chess: a side wants to SHED its own material (closer to having none,
// which is an immediate win on its own turn) while the opponent keeps more
// (further from their own win) — so the score is enemy material minus own
// material, the mirror image of a normal material count.
func (s *State) evaluate() int {
	own, enemy := 0, 0
	us := s.side
	for sq := chess.Square(0); sq < 64; sq++ {
		p := s.board[sq]
		if p == chess.NoPiece {
			continue
		}
		v := pieceValue[p.Type()]
		if p.Color() == us {
			own += v
		} else {
			enemy += v
		}
	}
	return enemy - own
}
