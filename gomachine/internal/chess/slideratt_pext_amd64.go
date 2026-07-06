//go:build amd64 && !nopext

package chess

// PEXT-based slider attacks (BMI2). The default slider backend on amd64.
//
// Instead of the magic multiply/shift, the BMI2 PEXTQ instruction extracts the
// blocker bits under the relevant-occupancy mask directly into a DENSE index:
//
//	index = pext(occ, mask)   // gathers the popcount(mask) mask bits, packed low
//
// index ranges over [0, 1<<popcount(mask)) bijectively, so the per-square table
// is the same 1<<popcount(mask) size as the fancy-magic table but needs no magic
// search and no multiply — one PEXTQ + one load. Tables are built from the SAME
// slidingMask/slidingAttacks reference helpers (attacks.go) the magic backend
// uses, so the returned attack sets are bit-identical (proven by
// zz_pext_equiv_test.go and by perft).
//
// PEXT is fast on Zen 3+ and modern Intel; it is microcoded-slow on pre-Zen 3
// AMD, which is why this backend is build-tag-gated (amd64 && !nopext) rather
// than CPU-detected — `-tags nopext` (and every non-amd64 arch) falls back to
// slideratt_magic.go. The orchestrator A/Bs the two binaries built from this
// tree.

// pext extracts the bits of src selected by mask, packed into the low bits, via
// the BMI2 PEXTQ instruction. Defined in pext_amd64.s.
func pext(src, mask uint64) uint64

// Dense per-square PEXT tables and their relevant-occupancy masks. Each
// pext*Attacks[sq] slice has length 1<<popcount(pext*Mask[sq]).
var (
	pextRookMask      [64]Bitboard
	pextBishopMask    [64]Bitboard
	pextRookAttacks   [64][]Bitboard
	pextBishopAttacks [64][]Bitboard
)

// buildPextTable fills maskOut/tableOut for one square/direction-set. It walks
// every occupancy subset of the mask (carry-rippler) and stores the reference
// sliding attack at the dense PEXT index for that subset.
func buildPextTable(sq Square, dirs [4][2]int, maskOut *Bitboard, tableOut *[]Bitboard) {
	mask := slidingMask(sq, dirs)
	*maskOut = mask
	size := 1 << mask.Count()
	tbl := make([]Bitboard, size)
	b := Bitboard(0)
	for i := 0; i < size; i++ {
		tbl[pext(uint64(b), uint64(mask))] = slidingAttacks(sq, b, dirs)
		b = (b - mask) & mask
	}
	*tableOut = tbl
}

// initSliders builds the dense rook/bishop PEXT tables. Shared init() (magic.go)
// calls this after initNonSliding().
func initSliders() {
	for s := Square(0); s < 64; s++ {
		buildPextTable(s, rookDirs, &pextRookMask[s], &pextRookAttacks[s])
		buildPextTable(s, bishopDirs, &pextBishopMask[s], &pextBishopAttacks[s])
	}
}

// bishopAttacksBB returns bishop attacks from sq for the given occupancy.
func bishopAttacksBB(sq Square, occ Bitboard) Bitboard {
	return pextBishopAttacks[sq][pext(uint64(occ), uint64(pextBishopMask[sq]))]
}

// rookAttacksBB returns rook attacks from sq for the given occupancy.
func rookAttacksBB(sq Square, occ Bitboard) Bitboard {
	return pextRookAttacks[sq][pext(uint64(occ), uint64(pextRookMask[sq]))]
}
