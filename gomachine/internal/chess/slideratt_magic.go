//go:build !amd64 || nopext

package chess

// Fancy magic bitboards. Magics are searched deterministically at init with a
// fixed-seed PRNG, so builds are reproducible across platforms. See SPEC §4.2.
//
// This is the portable slider backend, used on every non-amd64 arch and on amd64
// when built with `-tags nopext`. The amd64 default backend is PEXT
// (slideratt_pext_amd64.go), which the orchestrator A/Bs against this one by
// building two binaries from the same tree.

type magicEntry struct {
	mask    Bitboard
	magic   uint64
	shift   uint
	attacks []Bitboard // size 1<<popcount(mask)
}

var (
	rookMagics   [64]magicEntry
	bishopMagics [64]magicEntry
)

// xorshift64 PRNG with a fixed seed for reproducible magic generation.
var magicRNG uint64 = 0x246C_8B11_03F0_E5C7

func rand64() uint64 {
	magicRNG ^= magicRNG << 13
	magicRNG ^= magicRNG >> 7
	magicRNG ^= magicRNG << 17
	return magicRNG
}

// sparseRand returns a random uint64 with relatively few bits set (good magic
// candidates).
func sparseRand() uint64 { return rand64() & rand64() & rand64() }

// findMagic searches for a collision-free magic multiplier for a slider on sq.
func findMagic(sq Square, dirs [4][2]int) magicEntry {
	mask := slidingMask(sq, dirs)
	n := mask.Count()
	size := 1 << n
	shift := uint(64 - n)

	// Enumerate all occupancy subsets (carry-rippler) and their true attacks.
	occs := make([]Bitboard, size)
	refs := make([]Bitboard, size)
	b := Bitboard(0)
	for i := 0; i < size; i++ {
		occs[i] = b
		refs[i] = slidingAttacks(sq, b, dirs)
		b = (b - mask) & mask
	}

	used := make([]Bitboard, size)
	seen := make([]uint16, size) // epoch tag to avoid clearing each attempt
	var epoch uint16

	for {
		magic := sparseRand()
		// Heuristic: require enough high bits in mask*magic, else reject early.
		if Bitboard((uint64(mask)*magic)&0xFF00000000000000).Count() < 6 {
			continue
		}
		epoch++
		ok := true
		for i := 0; i < size; i++ {
			idx := (uint64(occs[i]) * magic) >> shift
			if seen[idx] != epoch {
				seen[idx] = epoch
				used[idx] = refs[i]
			} else if used[idx] != refs[i] {
				ok = false
				break
			}
		}
		if ok {
			attacks := make([]Bitboard, size)
			// Recompute the final mapping cleanly into the result table.
			for i := 0; i < size; i++ {
				idx := (uint64(occs[i]) * magic) >> shift
				attacks[idx] = refs[i]
			}
			return magicEntry{mask: mask, magic: magic, shift: shift, attacks: attacks}
		}
	}
}

// initSliders fills the rook/bishop magic tables. Shared init() (magic.go) calls
// this after initNonSliding().
func initSliders() {
	for s := Square(0); s < 64; s++ {
		rookMagics[s] = findMagic(s, rookDirs)
		bishopMagics[s] = findMagic(s, bishopDirs)
	}
}

// bishopAttacksBB returns bishop attacks from sq for the given occupancy.
func bishopAttacksBB(sq Square, occ Bitboard) Bitboard {
	m := &bishopMagics[sq]
	return m.attacks[(uint64(occ&m.mask)*m.magic)>>m.shift]
}

// rookAttacksBB returns rook attacks from sq for the given occupancy.
func rookAttacksBB(sq Square, occ Bitboard) Bitboard {
	m := &rookMagics[sq]
	return m.attacks[(uint64(occ&m.mask)*m.magic)>>m.shift]
}
