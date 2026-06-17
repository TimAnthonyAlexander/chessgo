package chess

// Zobrist hashing keys. Generated once at init with a fixed seed so identical
// positions hash identically across runs and platforms. The key encodes piece
// placement, side to move, castling rights, and the en-passant file ONLY when an
// en-passant capture is actually possible (see Position.epIsReal). SPEC §4.6.
var (
	zobristPieces   [12][64]uint64
	zobristCastling [16]uint64
	zobristEP       [8]uint64 // by file
	zobristSide     uint64
)

func init() {
	var r uint64 = 0x9E3779B97F4A7C15
	next := func() uint64 {
		r ^= r << 13
		r ^= r >> 7
		r ^= r << 17
		return r
	}
	for p := 0; p < 12; p++ {
		for s := 0; s < 64; s++ {
			zobristPieces[p][s] = next()
		}
	}
	for i := 0; i < 16; i++ {
		zobristCastling[i] = next()
	}
	for f := 0; f < 8; f++ {
		zobristEP[f] = next()
	}
	zobristSide = next()
}
