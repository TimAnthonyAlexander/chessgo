package crazyhouse

import "github.com/timanthonyalexander/gomachine/internal/chess"

// pieceValue is the centipawn value of a piece on the board (king excluded — its
// safety is scored separately and losing it is a terminal mate).
var pieceValue = [6]int{
	chess.Pawn:   100,
	chess.Knight: 320,
	chess.Bishop: 330,
	chess.Rook:   500,
	chess.Queen:  900,
	chess.King:   0,
}

// pocketValue is the centipawn value of a piece held IN HAND. Crazyhouse hand
// pieces are strong (droppable anywhere for attack), but slightly below their
// board value since deploying them costs a tempo. Deliberately close to material
// so the bot neither hoards nor dumps its pocket.
var pocketValue = [6]int{
	chess.Pawn:   90,
	chess.Knight: 250,
	chess.Bishop: 250,
	chess.Rook:   280,
	chess.Queen:  420,
	chess.King:   0,
}

// captureValue scores "how valuable is this victim" for move ordering; the king
// dominates so that checks/king attacks sort first.
func captureValue(pt chess.PieceType) int {
	if pt == chess.King {
		return 100000
	}
	return pieceValue[pt]
}

// centerBonus rewards central occupation (a cheap positional term), symmetric by
// square so it applies identically to both colors.
var centerBonus [64]int

func init() {
	for sq := chess.Square(0); sq < 64; sq++ {
		f := int(sq.File())
		r := int(sq.Rank())
		df := 3 - abs(2*f-7)/2 // 0..3, peak on the d/e files
		dr := 3 - abs(2*r-7)/2
		centerBonus[sq] = (df + dr) * 3
	}
}

func abs(x int) int {
	if x < 0 {
		return -x
	}
	return x
}

// evaluate returns a centipawn score from the SIDE-TO-MOVE's perspective:
// board material + a small center term + pocket material + a drop-aware king
// danger term (in Crazyhouse, king safety and the enemy's pocket dominate — a
// bare king near an enemy with pieces in hand is often lost).
func (s *State) evaluate() int {
	score := 0 // White - Black

	for sq := chess.Square(0); sq < 64; sq++ {
		p := s.pos.PieceOn(sq)
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

	for pt := chess.Pawn; pt <= chess.Queen; pt++ {
		score += s.pockets[chess.White][pt] * pocketValue[pt]
		score -= s.pockets[chess.Black][pt] * pocketValue[pt]
	}

	score -= s.kingDanger(chess.White)
	score += s.kingDanger(chess.Black)

	if s.pos.SideToMove() == chess.Black {
		return -score
	}
	return score
}

// kingDanger is a heuristic penalty (centipawns) for how exposed color c's king
// is: enemy pieces bearing on the king zone, empty squares around the king the
// enemy could drop onto, and general pressure from the size of the enemy pocket
// (more pieces in hand = more drop-mate threats).
func (s *State) kingDanger(c chess.Color) int {
	ksq := s.pos.KingSquare(c)
	if ksq == chess.SqNone {
		return 0
	}
	them := c.Opposite()
	enemy := s.pos.ColorBB(them)
	occ := s.pos.Occupied()

	danger := 0
	zone := chess.PseudoAttacks(chess.MakePiece(c, chess.King), ksq, 0) | ksq.BB()
	for bb := zone; bb != 0; {
		sq := bb.PopLSB()
		if s.pos.AttackersTo(sq, occ)&enemy != 0 {
			danger += 12 // an enemy piece already attacks the king zone
		}
		if s.pos.PieceOn(sq) == chess.NoPiece && sq != ksq {
			danger += 5 // an empty landing square next to the king (drop target)
		}
	}
	// General drop pressure: every piece in the enemy's hand is a latent attacker.
	if hand := s.pocketCount(them); hand > 0 {
		danger += hand * 8
	}
	return danger
}

// pocketCount is the total number of pieces color c holds in hand.
func (s *State) pocketCount(c chess.Color) int {
	n := 0
	for pt := chess.Pawn; pt <= chess.Queen; pt++ {
		n += s.pockets[c][pt]
	}
	return n
}
