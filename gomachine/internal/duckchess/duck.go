package duckchess

import "github.com/timanthonyalexander/gomachine/internal/chess"

// centerOrder lists all squares ordered by proximity to the center, used to pick a
// neutral duck square when no better placement exists.
var centerOrder []chess.Square

func init() {
	centerOrder = make([]chess.Square, 0, 64)
	for sq := chess.Square(0); sq < 64; sq++ {
		centerOrder = append(centerOrder, sq)
	}
	// Stable insertion sort by descending centerBonus (avoids importing sort for a
	// tiny fixed array and keeps the order deterministic).
	for i := 1; i < len(centerOrder); i++ {
		for j := i; j > 0 && centerBonus[centerOrder[j]] > centerBonus[centerOrder[j-1]]; j-- {
			centerOrder[j], centerOrder[j-1] = centerOrder[j-1], centerOrder[j]
		}
	}
}

// chooseDuck picks where the mover relocates the duck after making a piece move.
// It is a HEURISTIC (not searched): block the opponent's most dangerous reply — a
// capture of the mover's king or highest-value piece along a slider ray — else sit
// on a neutral, cramping square near the enemy king, else any central empty square.
//
// `mid` is the state AFTER the piece move but BEFORE the duck is relocated (its
// `duck` field still holds the duck's CURRENT square, which the new square must
// differ from). `mover` is the side that just moved.
func chooseDuck(mid *State, mover chess.Color) chess.Square {
	opp := mover.Opposite()
	occ := mid.occupied() // pieces only; the duck is being (re)placed
	prev := mid.duck

	// 1. Find the opponent's most dangerous capture of a mover piece.
	bestVal := 0
	var bestFrom, bestTo chess.Square = chess.SqNone, chess.SqNone
	bestSlider := false
	for from := chess.Square(0); from < 64; from++ {
		p := mid.board[from]
		if p == chess.NoPiece || p.Color() != opp {
			continue
		}
		att := chess.PseudoAttacks(p, from, occ)
		targets := att & mid.colorBB(mover)
		for targets != 0 {
			to := targets.PopLSB()
			v := captureValue(mid.board[to].Type())
			if v > bestVal {
				bestVal = v
				bestFrom, bestTo = from, to
				pt := p.Type()
				bestSlider = pt == chess.Bishop || pt == chess.Rook || pt == chess.Queen
			}
		}
	}

	// 2. If that threat is a slider, try to interpose the duck on the ray.
	if bestSlider && bestTo != chess.SqNone {
		for _, sq := range between(bestFrom, bestTo) {
			if !occ.Has(sq) && sq != prev {
				return sq
			}
		}
	}

	// 3. Neutral: a cramping square adjacent to the enemy king.
	if ksq := mid.kingSquare(opp); ksq != chess.SqNone {
		adj := chess.PseudoAttacks(chess.MakePiece(opp, chess.King), ksq, occ)
		for adj != 0 {
			sq := adj.PopLSB()
			if !occ.Has(sq) && sq != prev {
				return sq
			}
		}
	}

	// 4. Fallback: the most central empty square that is not the previous square.
	for _, sq := range centerOrder {
		if !occ.Has(sq) && sq != prev {
			return sq
		}
	}
	return chess.SqNone // unreachable on any real board (always empties available)
}

// between returns the squares STRICTLY between two aligned squares (rook/bishop/
// queen line). Empty if the squares are not aligned on a rank, file, or diagonal.
func between(a, b chess.Square) []chess.Square {
	fa, ra := int(a.File()), int(a.Rank())
	fb, rb := int(b.File()), int(b.Rank())
	df := sign(fb - fa)
	dr := sign(rb - ra)
	// Must be a straight or diagonal line.
	if !((df == 0 || dr == 0) || (abs(fb-fa) == abs(rb-ra))) {
		return nil
	}
	var out []chess.Square
	f, r := fa+df, ra+dr
	for f != fb || r != rb {
		if f < 0 || f > 7 || r < 0 || r > 7 {
			return nil
		}
		out = append(out, chess.MakeSquare(chess.File(f), chess.Rank(r)))
		f += df
		r += dr
	}
	return out
}

func sign(x int) int {
	switch {
	case x > 0:
		return 1
	case x < 0:
		return -1
	default:
		return 0
	}
}
