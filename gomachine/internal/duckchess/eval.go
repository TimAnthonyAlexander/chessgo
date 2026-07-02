package duckchess

import "github.com/timanthonyalexander/gomachine/internal/chess"

// pieceValue is the centipawn value of a piece type (king excluded from material
// — capturing it is the win condition, handled as a terminal score in search).
var pieceValue = [6]int{
	chess.Pawn:   100,
	chess.Knight: 320,
	chess.Bishop: 330,
	chess.Rook:   500,
	chess.Queen:  900,
	chess.King:   0,
}

// captureValue is the value used when scoring "how bad is losing this piece"; the
// king is worth more than any material so protecting it dominates.
func captureValue(pt chess.PieceType) int {
	if pt == chess.King {
		return 100000
	}
	return pieceValue[pt]
}

// centerBonus rewards central occupation (a cheap positional term). Symmetric, so
// it applies identically to both colors by square.
var centerBonus [64]int

func init() {
	// Distance-to-center bonus: the four central squares get the most.
	for sq := chess.Square(0); sq < 64; sq++ {
		f := int(sq.File())
		r := int(sq.Rank())
		df := 3 - abs(2*f-7)/2 // 0..3, peak at files d/e
		dr := 3 - abs(2*r-7)/2
		centerBonus[sq] = (df + dr) * 4
	}
}

func abs(x int) int {
	if x < 0 {
		return -x
	}
	return x
}

// evaluate returns a centipawn score from the SIDE-TO-MOVE's perspective:
// material + a small central bonus + a king-danger term (a king currently
// attacked by the enemy is in peril, since the duck cannot always save it).
func (s *State) evaluate() int {
	occWithDuck := s.occupied() | s.duckBB()
	score := 0 // White - Black

	for sq := chess.Square(0); sq < 64; sq++ {
		p := s.board[sq]
		if p == chess.NoPiece {
			continue
		}
		v := pieceValue[p.Type()] + centerBonus[sq]
		if p.Color() == chess.White {
			score += v
		} else {
			score -= v
		}
	}

	// King danger: a king under attack risks capture next ply.
	if s.kingAttacked(chess.White, occWithDuck) {
		score -= 300
	}
	if s.kingAttacked(chess.Black, occWithDuck) {
		score += 300
	}

	if s.side == chess.Black {
		return -score
	}
	return score
}

// kingAttacked reports whether color c's king is attacked by the opponent under
// the given occupancy (which includes the duck, so a duck-blocked ray is not an
// attack). Returns false if the king is missing.
func (s *State) kingAttacked(c chess.Color, occWithDuck chess.Bitboard) bool {
	ksq := s.kingSquare(c)
	if ksq == chess.SqNone {
		return false
	}
	return s.attacked(ksq, c.Opposite(), occWithDuck)
}

// attacked reports whether square `sq` is attacked by any piece of color `by`,
// given occupancy `occ` (the duck blocks sliders when included in occ).
func (s *State) attacked(sq chess.Square, by chess.Color, occ chess.Bitboard) bool {
	for from := chess.Square(0); from < 64; from++ {
		p := s.board[from]
		if p == chess.NoPiece || p.Color() != by {
			continue
		}
		if chess.PseudoAttacks(p, from, occ).Has(sq) {
			return true
		}
	}
	return false
}
