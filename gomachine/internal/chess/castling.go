package chess

import "errors"

// Chess960 (Fischer Random) castling support. Standard chess is the special case
// where the king starts on e1/e8 and the castling rooks on a1/h1/a8/h8 — every
// helper here reproduces the classic behavior byte-for-byte for that layout.
//
// Castling is encoded internally as a "king-captures-rook" move: from = king
// origin, to = the castling ROOK's origin square. This is the only unambiguous
// encoding in Chess960 (a normal king step and a castle can share the same
// king-destination square). See Move.String / ParseUCIMove for the UCI mapping.

// backRank returns the castling home rank for color c.
func backRank(c Color) Rank {
	if c == White {
		return Rank1
	}
	return Rank8
}

// outerRook returns the outermost (edge-most) rook of color c on its back rank to
// the given side of the king — the X-FEN interpretation of a K/Q/k/q castling
// right. kingside scans from the h-file inward, queenside from the a-file inward.
// Returns SqNone if there is no such rook.
func (pos *Position) outerRook(c Color, kingside bool) Square {
	r := backRank(c)
	kingFile := int(pos.kingSq(c).File())
	rookP := MakePiece(c, Rook)
	if kingside {
		for f := 7; f > kingFile; f-- {
			s := MakeSquare(File(f), r)
			if pos.board[s] == rookP {
				return s
			}
		}
	} else {
		for f := 0; f < kingFile; f++ {
			s := MakeSquare(File(f), r)
			if pos.board[s] == rookP {
				return s
			}
		}
	}
	return SqNone
}

// parseCastling parses the FEN castling field into pos.castling + pos.castleRook,
// then rebuilds pos.castleMask. It accepts:
//   - "-"                : no rights.
//   - standard/X-FEN     : K Q k q (rook = outermost on that side of the king).
//   - Shredder-FEN       : A-H (white) / a-h (black) naming the rook's file; the
//     side (king/queen) is inferred from the file relative to the king.
func (pos *Position) parseCastling(field string) error {
	if field != "-" {
		for i := 0; i < len(field); i++ {
			ch := field[i]
			var right uint8
			var rookSq Square
			switch {
			case ch == 'K':
				right, rookSq = castleWK, pos.outerRook(White, true)
			case ch == 'Q':
				right, rookSq = castleWQ, pos.outerRook(White, false)
			case ch == 'k':
				right, rookSq = castleBK, pos.outerRook(Black, true)
			case ch == 'q':
				right, rookSq = castleBQ, pos.outerRook(Black, false)
			case ch >= 'A' && ch <= 'H':
				f := File(ch - 'A')
				rookSq = MakeSquare(f, Rank1)
				if f > pos.kingSq(White).File() {
					right = castleWK
				} else {
					right = castleWQ
				}
			case ch >= 'a' && ch <= 'h':
				f := File(ch - 'a')
				rookSq = MakeSquare(f, Rank8)
				if f > pos.kingSq(Black).File() {
					right = castleBK
				} else {
					right = castleBQ
				}
			default:
				return errors.New("invalid castling char: " + string(ch))
			}
			if rookSq == SqNone {
				return errors.New("castling right with no matching rook: " + string(ch))
			}
			pos.castling |= right
			pos.castleRook[rightIndex(right)] = rookSq
		}
	}
	pos.refreshCastleMask()
	return nil
}

// refreshCastleMask rebuilds castleMask from the current king squares and stored
// rook origins: moving from/to a king square clears that color's two rights;
// moving from/to a castling rook's origin clears that one right.
func (pos *Position) refreshCastleMask() {
	for i := range pos.castleMask {
		pos.castleMask[i] = 0xF
	}
	// Guard king squares against a malformed FEN (rights present but king absent →
	// kingSq is SqNone): never index the array out of range.
	if wk := pos.kingSq(White); wk < 64 && pos.castling&(castleWK|castleWQ) != 0 {
		pos.castleMask[wk] &^= castleWK | castleWQ
	}
	if bk := pos.kingSq(Black); bk < 64 && pos.castling&(castleBK|castleBQ) != 0 {
		pos.castleMask[bk] &^= castleBK | castleBQ
	}
	if pos.castling&castleWK != 0 {
		pos.castleMask[pos.castleRook[ciWK]] &^= castleWK
	}
	if pos.castling&castleWQ != 0 {
		pos.castleMask[pos.castleRook[ciWQ]] &^= castleWQ
	}
	if pos.castling&castleBK != 0 {
		pos.castleMask[pos.castleRook[ciBK]] &^= castleBK
	}
	if pos.castling&castleBQ != 0 {
		pos.castleMask[pos.castleRook[ciBQ]] &^= castleBQ
	}
}

// castleTargets returns the king and rook DESTINATION squares for a castling move
// encoded as (king origin, rook origin). Kingside (rook right of king) → king to
// g-file, rook to f-file; queenside → king to c-file, rook to d-file.
func castleTargets(kingFrom, rookFrom Square) (kingTo, rookTo Square) {
	r := kingFrom.Rank()
	if rookFrom.File() > kingFrom.File() {
		return MakeSquare(FileG, r), MakeSquare(FileF, r)
	}
	return MakeSquare(FileC, r), MakeSquare(FileD, r)
}

// CastleTargets returns the king and rook DESTINATION squares for a castling move
// encoded as (king origin, rook origin). Exposed for consumers that must replay a
// castle's piece movement (e.g. the NNUE accumulator delta).
func CastleTargets(kingFrom, rookFrom Square) (kingTo, rookTo Square) {
	return castleTargets(kingFrom, rookFrom)
}

// rankSpanBB returns every square between a and b inclusive; a and b must share a
// rank (all castling squares are on one back rank).
func rankSpanBB(a, b Square) Bitboard {
	lo, hi := a, b
	if lo > hi {
		lo, hi = hi, lo
	}
	var bb Bitboard
	for s := lo; s <= hi; s++ {
		bb |= s.BB()
	}
	return bb
}

// castlingField serializes the castling rights as an X-FEN field: a right whose
// rook is the outermost on its side prints as K/Q/k/q (so standard positions
// round-trip to "KQkq"); an inner rook prints as a Shredder file letter.
func (pos *Position) castlingField() string {
	var sb []byte
	emit := func(right uint8, c Color, kingside bool, std byte) {
		if pos.castling&right == 0 {
			return
		}
		rookSq := pos.castleRook[rightIndex(right)]
		if rookSq == pos.outerRook(c, kingside) {
			sb = append(sb, std)
			return
		}
		f := byte(rookSq.File())
		if c == White {
			sb = append(sb, 'A'+f)
		} else {
			sb = append(sb, 'a'+f)
		}
	}
	emit(castleWK, White, true, 'K')
	emit(castleWQ, White, false, 'Q')
	emit(castleBK, Black, true, 'k')
	emit(castleBQ, Black, false, 'q')
	return string(sb)
}
