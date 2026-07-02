package chess

import mrand "math/rand/v2"

// RandomChess960FEN returns a valid Fischer-random (Chess960) starting position
// as a FEN string. The back rank is shuffled subject to the two Fischer rules —
// the bishops sit on opposite-colored squares and the king sits strictly between
// the two rooks — then mirrored onto Black's back rank. Pawns fill rank 2/7,
// White is to move, castling is the X-FEN "KQkq" (which the engine's parser maps
// to the outermost rook on each side of the king — correct for 960, where there
// is exactly one rook on each side of the king), no en-passant, clocks 0 1.
//
// Standard chess (RNBQKBNR) is one of the 960 outcomes. The result always
// ParseFEN's successfully and FEN()-round-trips.
func RandomChess960FEN() string {
	back := randomBackRank()

	// FEN piece placement is written file a→h. Black's back rank (rank 8) is the
	// same arrangement in lowercase; White's (rank 1) in uppercase.
	white := make([]byte, 8)
	blackRow := make([]byte, 8)
	for f, pt := range back {
		white[f] = pieceToFEN[MakePiece(White, pt)]
		blackRow[f] = pieceToFEN[MakePiece(Black, pt)]
	}

	return string(blackRow) + "/pppppppp/8/8/8/8/PPPPPPPP/" + string(white) + " w KQkq - 0 1"
}

// randomBackRank returns a length-8 arrangement of the back-rank piece types
// (by file 0..7) satisfying the Fischer-random constraints: the two bishops are
// on opposite-colored squares and the king is strictly between the two rooks.
// Uses rejection sampling on a shuffle — trivially fast (a large fraction of the
// 8! shuffles are already valid; the two constraints hold with probability well
// above 10%).
func randomBackRank() [8]PieceType {
	pieces := [8]PieceType{King, Queen, Rook, Rook, Bishop, Bishop, Knight, Knight}
	for {
		mrand.Shuffle(len(pieces), func(i, j int) {
			pieces[i], pieces[j] = pieces[j], pieces[i]
		})
		if validBackRank(pieces) {
			return pieces
		}
	}
}

// validBackRank reports whether an arrangement obeys the two Fischer rules.
func validBackRank(pieces [8]PieceType) bool {
	rooks := make([]int, 0, 2)
	bishops := make([]int, 0, 2)
	king := -1
	for f, pt := range pieces {
		switch pt {
		case Rook:
			rooks = append(rooks, f)
		case Bishop:
			bishops = append(bishops, f)
		case King:
			king = f
		}
	}
	// Bishops on opposite-colored squares: on a single rank the square color is the
	// file parity, so the two bishop files must differ in parity.
	if bishops[0]%2 == bishops[1]%2 {
		return false
	}
	// King strictly between the two rooks.
	lo, hi := rooks[0], rooks[1]
	if lo > hi {
		lo, hi = hi, lo
	}
	return lo < king && king < hi
}
