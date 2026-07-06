//go:build amd64 && !nopext

package chess

import "testing"

// TestPextEquivReference proves the PEXT slider backend returns bit-identical
// attack sets to the ray-cast reference (slidingAttacks) for EVERY square and
// EVERY relevant-occupancy subset. Because the fancy-magic backend is built from
// the same reference, PEXT == reference == magic; perft (which is attack-driven)
// is the end-to-end oracle, this is the direct per-square proof.
//
// amd64 && !nopext only: the pext* tables and pext() exist solely in that build.
func TestPextEquivReference(t *testing.T) {
	for s := Square(0); s < 64; s++ {
		for name, dirs := range map[string][4][2]int{"rook": rookDirs, "bishop": bishopDirs} {
			mask := slidingMask(s, dirs)
			var table []Bitboard
			var tblMask Bitboard
			if name == "rook" {
				table, tblMask = pextRookAttacks[s], pextRookMask[s]
			} else {
				table, tblMask = pextBishopAttacks[s], pextBishopMask[s]
			}
			if tblMask != mask {
				t.Fatalf("%s sq %d: table mask %#x != reference mask %#x", name, s, uint64(tblMask), uint64(mask))
			}
			// Enumerate every occupancy subset of the mask (carry-rippler).
			b := Bitboard(0)
			for i := 0; i < (1 << mask.Count()); i++ {
				ref := slidingAttacks(s, b, dirs)
				idx := pext(uint64(b), uint64(mask))
				if got := table[idx]; got != ref {
					t.Fatalf("%s sq %d occ %#x: pext table %#x != reference %#x",
						name, s, uint64(b), uint64(got), uint64(ref))
				}
				b = (b - mask) & mask
			}
		}
	}
}

// TestPextEquivBackendFuncs checks the public rook/bishopAttacksBB indexers (the
// hot-path entry points) against the reference for a large set of pseudo-random
// full-board occupancies, i.e. bits outside the mask present too.
func TestPextEquivBackendFuncs(t *testing.T) {
	var rng uint64 = 0x9E3779B97F4A7C15
	next := func() uint64 {
		rng ^= rng << 13
		rng ^= rng >> 7
		rng ^= rng << 17
		return rng
	}
	for iter := 0; iter < 200000; iter++ {
		occ := Bitboard(next() & next()) // sparser boards, ~quarter-full
		s := Square(next() % 64)
		if got, ref := rookAttacksBB(s, occ), slidingAttacks(s, occ, rookDirs); got != ref {
			t.Fatalf("rookAttacksBB sq %d occ %#x: %#x != reference %#x", s, uint64(occ), uint64(got), uint64(ref))
		}
		if got, ref := bishopAttacksBB(s, occ), slidingAttacks(s, occ, bishopDirs); got != ref {
			t.Fatalf("bishopAttacksBB sq %d occ %#x: %#x != reference %#x", s, uint64(occ), uint64(got), uint64(ref))
		}
	}
}
