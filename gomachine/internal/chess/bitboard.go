package chess

import "math/bits"

// Bitboard is a set of squares, one bit per square (LERF: bit 0 = a1).
type Bitboard uint64

// File and rank masks.
const (
	fileABB Bitboard = 0x0101010101010101
	fileBBB Bitboard = fileABB << 1
	fileGBB Bitboard = fileABB << 6
	fileHBB Bitboard = fileABB << 7

	rank1BB Bitboard = 0x00000000000000FF
	rank2BB Bitboard = rank1BB << (8 * 1)
	rank4BB Bitboard = rank1BB << (8 * 3)
	rank5BB Bitboard = rank1BB << (8 * 4)
	rank7BB Bitboard = rank1BB << (8 * 6)
	rank8BB Bitboard = rank1BB << (8 * 7)
)

// BB returns a bitboard with only this square set.
func (s Square) BB() Bitboard { return Bitboard(1) << s }

// Has reports whether the square is set.
func (b Bitboard) Has(s Square) bool { return b&s.BB() != 0 }

// Count returns the number of set squares (POPCNT).
func (b Bitboard) Count() int { return bits.OnesCount64(uint64(b)) }

// LSB returns the least-significant set square. Undefined if b == 0.
func (b Bitboard) LSB() Square { return Square(bits.TrailingZeros64(uint64(b))) }

// PopLSB clears and returns the least-significant set square.
func (b *Bitboard) PopLSB() Square {
	s := b.LSB()
	*b &= *b - 1
	return s
}

// More reports whether more than one bit is set (cheap multi-attacker test).
func (b Bitboard) More() bool { return b&(b-1) != 0 }

// Shift helpers (compile to single shifts; masks prevent wraparound).
func north(b Bitboard) Bitboard { return b << 8 }
func south(b Bitboard) Bitboard { return b >> 8 }
func east(b Bitboard) Bitboard  { return (b &^ fileHBB) << 1 }
func west(b Bitboard) Bitboard  { return (b &^ fileABB) >> 1 }
