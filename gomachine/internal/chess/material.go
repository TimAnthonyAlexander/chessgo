package chess

// squareColor returns 0 for dark squares, 1 for light squares.
func squareColor(s Square) int { return (int(s.File()) + int(s.Rank())) & 1 }

// InsufficientMaterial reports whether the position is a dead position by the
// FIDE-conservative material set (SPEC §5.4): K vs K, K+B vs K, K+N vs K, and
// K+B vs K+B with bishops on the same color. KNN vs K and others are NOT
// included (a mate exists, even if unforceable) and draw only via 75-move/5-fold.
func (pos *Position) InsufficientMaterial() bool {
	// Any pawn, rook, or queen means mate is possible.
	for c := White; c <= Black; c++ {
		if pos.pieces[MakePiece(c, Pawn)]|pos.pieces[MakePiece(c, Rook)]|pos.pieces[MakePiece(c, Queen)] != 0 {
			return false
		}
	}
	wN := pos.pieces[MakePiece(White, Knight)].Count()
	bN := pos.pieces[MakePiece(Black, Knight)].Count()
	wB := pos.pieces[MakePiece(White, Bishop)]
	bB := pos.pieces[MakePiece(Black, Bishop)]
	minors := wN + bN + wB.Count() + bB.Count()

	switch {
	case minors == 0: // K vs K
		return true
	case minors == 1: // K+minor vs K
		return true
	case minors == 2 && wN == 0 && bN == 0 && wB.Count() == 1 && bB.Count() == 1:
		// K+B vs K+B: dead only if bishops are on the same color.
		return squareColor(wB.LSB()) == squareColor(bB.LSB())
	}
	return false
}

// CanAnyoneMate reports whether color c could possibly deliver checkmate by some
// (not necessarily forced) legal sequence, given only material. Used for the
// FIDE 6.9 timeout-vs-material adjudication (SPEC §5.4): a lone K, K+B, or K+N
// cannot mate, but K+N+N can (a helpmate exists).
func (pos *Position) CanAnyoneMate(c Color) bool {
	if pos.pieces[MakePiece(c, Pawn)]|pos.pieces[MakePiece(c, Rook)]|pos.pieces[MakePiece(c, Queen)] != 0 {
		return true
	}
	knights := pos.pieces[MakePiece(c, Knight)].Count()
	bishops := pos.pieces[MakePiece(c, Bishop)].Count()
	// K, K+B, K+N cannot mate; two or more minors (incl. K+N+N) can.
	return knights+bishops >= 2
}
