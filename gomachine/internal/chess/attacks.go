package chess

// Non-sliding attack tables, indexed by square. Built once at init.
var (
	knightAttacks [64]Bitboard
	kingAttacks   [64]Bitboard
	pawnAttacks   [2][64]Bitboard // [color][square]
)

// Ray directions as (file delta, rank delta).
var rookDirs = [4][2]int{{1, 0}, {-1, 0}, {0, 1}, {0, -1}}
var bishopDirs = [4][2]int{{1, 1}, {1, -1}, {-1, 1}, {-1, -1}}

var knightDeltas = [8][2]int{{1, 2}, {2, 1}, {2, -1}, {1, -2}, {-1, -2}, {-2, -1}, {-2, 1}, {-1, 2}}
var kingDeltas = [8][2]int{{1, 0}, {1, 1}, {0, 1}, {-1, 1}, {-1, 0}, {-1, -1}, {0, -1}, {1, -1}}
var pawnDeltas = [2][2][2]int{
	{{-1, 1}, {1, 1}},   // White: NW, NE
	{{-1, -1}, {1, -1}}, // Black: SW, SE
}

// addIfOnBoard sets the square at (f,r) in *bb if it lies on the board.
func addIfOnBoard(bb *Bitboard, f, r int) {
	if f >= 0 && f <= 7 && r >= 0 && r <= 7 {
		*bb |= MakeSquare(File(f), Rank(r)).BB()
	}
}

// initNonSliding fills the knight, king, and pawn attack tables.
func initNonSliding() {
	for s := Square(0); s < 64; s++ {
		f, r := int(s.File()), int(s.Rank())
		for _, d := range knightDeltas {
			addIfOnBoard(&knightAttacks[s], f+d[0], r+d[1])
		}
		for _, d := range kingDeltas {
			addIfOnBoard(&kingAttacks[s], f+d[0], r+d[1])
		}
		for c := 0; c < 2; c++ {
			for _, d := range pawnDeltas[c] {
				addIfOnBoard(&pawnAttacks[c][s], f+d[0], r+d[1])
			}
		}
	}
}

// slidingAttacks computes a sliding attack set by ray-casting, stopping at (and
// including) the first occupied square in each direction. Used to build magic
// tables and as the perft cross-check oracle.
func slidingAttacks(sq Square, occ Bitboard, dirs [4][2]int) Bitboard {
	var attacks Bitboard
	f0, r0 := int(sq.File()), int(sq.Rank())
	for _, d := range dirs {
		f, r := f0+d[0], r0+d[1]
		for f >= 0 && f <= 7 && r >= 0 && r <= 7 {
			s := MakeSquare(File(f), Rank(r))
			attacks |= s.BB()
			if occ.Has(s) {
				break
			}
			f += d[0]
			r += d[1]
		}
	}
	return attacks
}

// slidingMask returns the relevant-occupancy mask for a slider on sq: ray
// squares excluding board edges (edge squares never block).
func slidingMask(sq Square, dirs [4][2]int) Bitboard {
	var m Bitboard
	f0, r0 := int(sq.File()), int(sq.Rank())
	for _, d := range dirs {
		f, r := f0+d[0], r0+d[1]
		for f >= 0 && f <= 7 && r >= 0 && r <= 7 {
			nf, nr := f+d[0], r+d[1]
			if nf < 0 || nf > 7 || nr < 0 || nr > 7 {
				break // skip the edge square in this direction
			}
			m |= MakeSquare(File(f), Rank(r)).BB()
			f += d[0]
			r += d[1]
		}
	}
	return m
}

// pawnAttacksBB returns the squares attacked by a pawn of color c on sq.
func pawnAttacksBB(c Color, s Square) Bitboard { return pawnAttacks[c][s] }

// knightAttacksBB returns the squares attacked by a knight on sq.
func knightAttacksBB(s Square) Bitboard { return knightAttacks[s] }

// kingAttacksBB returns the squares attacked by a king on sq.
func kingAttacksBB(s Square) Bitboard { return kingAttacks[s] }

// bishopAttacksBB / rookAttacksBB / queenAttacksBB return slider attacks for the
// given occupancy via magic lookup. Defined in magic.go.
