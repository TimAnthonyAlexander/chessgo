package chess

// Make/unmake with a caller-provided Undo record (SPEC §4.4). The Undo captures
// everything not reconstructible from the move itself, so UndoMove restores the
// position exactly, including the Zobrist key.

// Undo holds the irreversible state needed to revert a move.
type Undo struct {
	captured Piece
	castling uint8
	epSquare Square
	halfmove uint16
	key      uint64
}

// dirForward is the single-push direction (in squares) for a pawn of color c.
func dirForward(c Color) int {
	if c == White {
		return 8
	}
	return -8
}

// DoMove applies m to the position, recording undo info in u.
func (pos *Position) DoMove(m Move, u *Undo) {
	u.captured = NoPiece
	u.castling = pos.castling
	u.epSquare = pos.epSquare
	u.halfmove = pos.halfmove
	u.key = pos.key

	us := pos.side
	them := us.Opposite()
	from := m.From()
	to := m.To()
	moving := pos.board[from]

	// Remove any existing en-passant contribution from the key.
	if pos.epIsReal() {
		pos.key ^= zobristEP[pos.epSquare.File()]
	}
	pos.epSquare = SqNone
	pos.halfmove++

	switch m.Type() {
	case Normal:
		if moving.Type() == Pawn {
			pos.halfmove = 0
		}
		if pos.board[to] != NoPiece {
			u.captured = pos.board[to]
			pos.removePiece(to)
			pos.halfmove = 0
		}
		pos.movePiece(from, to)
		if moving.Type() == Pawn {
			if (from.Rank() == Rank2 && to.Rank() == Rank4) ||
				(from.Rank() == Rank7 && to.Rank() == Rank5) {
				pos.epSquare = Square((int(from) + int(to)) / 2)
			}
		}
	case Promotion:
		pos.halfmove = 0
		if pos.board[to] != NoPiece {
			u.captured = pos.board[to]
			pos.removePiece(to)
		}
		pos.removePiece(from) // remove the pawn
		pos.addPiece(MakePiece(us, m.Promo()), to)
	case EnPassant:
		pos.halfmove = 0
		capSq := Square(int(to) - dirForward(us))
		u.captured = pos.board[capSq]
		pos.removePiece(capSq)
		pos.movePiece(from, to)
	case Castling:
		// from = king origin, to = rook origin (king-captures-rook encoding).
		// Remove both movers before placing them so overlapping origin/destination
		// squares (the FRC king-over-rook / rook-onto-king-origin cases, and the
		// king-doesn't-move case) can never collide.
		kingTo, rookTo := castleTargets(from, to)
		king := pos.board[from]
		rook := pos.board[to]
		pos.removePiece(from)
		pos.removePiece(to)
		pos.addPiece(king, kingTo)
		pos.addPiece(rook, rookTo)
	}

	// Update castling rights.
	newCastling := pos.castling & pos.castleMask[from] & pos.castleMask[to]
	if newCastling != pos.castling {
		pos.key ^= zobristCastling[pos.castling] ^ zobristCastling[newCastling]
		pos.castling = newCastling
	}

	// Add the new en-passant contribution (capturable by the side to move next).
	if pos.epSquare != SqNone && pos.epIsRealFor(them) {
		pos.key ^= zobristEP[pos.epSquare.File()]
	}

	if us == Black {
		pos.fullmove++
	}
	pos.side = them
	pos.key ^= zobristSide
}

// DoNullMove passes the turn (used by null-move pruning). It must not be called
// while in check.
func (pos *Position) DoNullMove(u *Undo) {
	u.captured = NoPiece
	u.castling = pos.castling
	u.epSquare = pos.epSquare
	u.halfmove = pos.halfmove
	u.key = pos.key

	if pos.epIsReal() {
		pos.key ^= zobristEP[pos.epSquare.File()]
	}
	pos.epSquare = SqNone
	pos.halfmove++
	pos.side = pos.side.Opposite()
	pos.key ^= zobristSide
}

// UndoNullMove reverts a null move.
func (pos *Position) UndoNullMove(u *Undo) {
	pos.side = pos.side.Opposite()
	pos.castling = u.castling
	pos.epSquare = u.epSquare
	pos.halfmove = u.halfmove
	pos.key = u.key
}

// UndoMove reverts the move applied by DoMove, using u.
func (pos *Position) UndoMove(m Move, u *Undo) {
	us := pos.side.Opposite() // side that made the move
	from := m.From()
	to := m.To()

	pos.side = us
	if us == Black {
		pos.fullmove--
	}

	switch m.Type() {
	case Normal:
		pos.movePiece(to, from)
		if u.captured != NoPiece {
			pos.addPiece(u.captured, to)
		}
	case Promotion:
		pos.removePiece(to) // remove promoted piece
		pos.addPiece(MakePiece(us, Pawn), from)
		if u.captured != NoPiece {
			pos.addPiece(u.captured, to)
		}
	case EnPassant:
		pos.movePiece(to, from)
		capSq := Square(int(to) - dirForward(us))
		pos.addPiece(u.captured, capSq)
	case Castling:
		// from = king origin, to = rook origin. Pull both pieces off their
		// destinations and restore them to their origins (remove-then-add handles
		// every FRC origin/destination overlap; the key is restored from u below).
		kingTo, rookTo := castleTargets(from, to)
		king := pos.board[kingTo]
		rook := pos.board[rookTo]
		pos.removePiece(kingTo)
		pos.removePiece(rookTo)
		pos.addPiece(king, from)
		pos.addPiece(rook, to)
	}

	// Restore irreversible state (also restores the key exactly).
	pos.castling = u.castling
	pos.epSquare = u.epSquare
	pos.halfmove = u.halfmove
	pos.key = u.key
}
