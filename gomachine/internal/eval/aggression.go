package eval

import "github.com/timanthonyalexander/gomachine/internal/chess"

// AggressionTerm returns a side-to-move-relative "attacking pressure" score in
// centipawns: how much harder the side to move is menacing the enemy king than
// vice versa. It is deliberately NOT part of the objective evaluation — the
// searcher adds a *scaled fraction* of it (search.Params.Aggr) on top of the
// NNUE/HCE static eval to bias move choice toward (Aggr>50) or away from (Aggr<50)
// sharp king-attacking play. At the default Aggr=50 the scale is 0 and the
// searcher never calls this, so the engine stays byte-identical.
//
// It is symmetric (us pressure − them pressure) and per-side capped, so it can
// only nudge selection at the margins; it can never overturn a real material or
// positional eval. This is a *style* lever, not a strength patch.
func AggressionTerm(pos *chess.Position) int {
	us := pos.SideToMove()
	return sideAggression(pos, us) - sideAggression(pos, us.Opposite())
}

// kzWeight is the classic king-attack weight per attacking piece type
// (0=N,1=B,2=R,3=Q). Pawns and the king itself are excluded.
var kzWeight = [4]int{2, 2, 3, 5}

// aggrPerUnit / aggrPerTropism convert raw attack units and tropism into cp;
// aggrCap bounds each side's raw pressure so a single crowded position can't dwarf
// the real eval (the searcher then scales the netted, capped value by Aggr).
const (
	aggrPerUnit     = 4
	aggrPerTropism  = 1
	aggrCap         = 80
	aggrTropismBase = 5 // 5 − Chebyshev(piece, enemyKing): adjacent≈4, far≈0
)

// sideAggression scores how hard `us` is pressing the enemy king: piece attacks
// landing in the enemy king's zone (the king square + its 8 neighbours), weighted
// by piece type, plus a small tropism bonus for pieces standing near that king.
func sideAggression(pos *chess.Position, us chess.Color) int {
	enemyK := pos.KingSquare(us.Opposite())
	zone := pos.AttacksFrom(enemyK) | enemyK.BB() // king + its 8 neighbours

	units, tropism := 0, 0
	for pt := chess.Knight; pt <= chess.Queen; pt++ {
		idx := int(pt - chess.Knight)
		bb := pos.PieceBB(chess.MakePiece(us, pt))
		for bb != 0 {
			sq := bb.PopLSB()
			if pos.AttacksFrom(sq)&zone != 0 {
				units += kzWeight[idx]
			}
			tropism += aggrTropismBase - kingDist(sq, enemyK)
		}
	}
	cp := units*aggrPerUnit + tropism*aggrPerTropism
	if cp > aggrCap {
		cp = aggrCap
	}
	return cp
}
