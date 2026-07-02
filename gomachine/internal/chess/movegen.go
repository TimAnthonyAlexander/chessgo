package chess

// Move generation: pseudo-legal generation + make-time legality filter
// (SPEC §4.4). Castling legality (king not in/through/into check) is checked
// during generation; en-passant discovered-check is caught by the make-time
// filter.

// addTargets appends Normal moves from `from` to every square in `targets`.
func addTargets(ml *MoveList, from Square, targets Bitboard) {
	for targets != 0 {
		ml.add(NewMove(from, targets.PopLSB(), Normal, Pawn))
	}
}

func addPromotions(ml *MoveList, from, to Square) {
	ml.add(NewMove(from, to, Promotion, Queen))
	ml.add(NewMove(from, to, Promotion, Rook))
	ml.add(NewMove(from, to, Promotion, Bishop))
	ml.add(NewMove(from, to, Promotion, Knight))
}

// generatePseudo fills ml with all pseudo-legal moves for the side to move
// (legality of leaving one's own king in check is filtered later).
func (pos *Position) generatePseudo(ml *MoveList) {
	us := pos.side
	them := us.Opposite()
	occ := pos.occupied
	ours := pos.byColor[us]
	theirs := pos.byColor[them]

	pos.genPawns(ml, us, occ, theirs)

	knights := pos.pieces[MakePiece(us, Knight)]
	for knights != 0 {
		from := knights.PopLSB()
		addTargets(ml, from, knightAttacks[from]&^ours)
	}
	bishops := pos.pieces[MakePiece(us, Bishop)]
	for bishops != 0 {
		from := bishops.PopLSB()
		addTargets(ml, from, bishopAttacksBB(from, occ)&^ours)
	}
	rooks := pos.pieces[MakePiece(us, Rook)]
	for rooks != 0 {
		from := rooks.PopLSB()
		addTargets(ml, from, rookAttacksBB(from, occ)&^ours)
	}
	queens := pos.pieces[MakePiece(us, Queen)]
	for queens != 0 {
		from := queens.PopLSB()
		addTargets(ml, from, queenAttacksBB(from, occ)&^ours)
	}
	kingSq := pos.kingSq(us)
	addTargets(ml, kingSq, kingAttacks[kingSq]&^ours)

	pos.genCastling(ml, us)
}

func (pos *Position) genPawns(ml *MoveList, us Color, occ, theirs Bitboard) {
	pawns := pos.pieces[MakePiece(us, Pawn)]
	empty := ^occ
	var pushDir int
	var startRank, promoRank Rank
	if us == White {
		pushDir, startRank, promoRank = 8, Rank2, Rank8
	} else {
		pushDir, startRank, promoRank = -8, Rank7, Rank1
	}
	for pawns != 0 {
		from := pawns.PopLSB()
		// Single (and double) push.
		to := Square(int(from) + pushDir)
		if empty.Has(to) {
			if to.Rank() == promoRank {
				addPromotions(ml, from, to)
			} else {
				ml.add(NewMove(from, to, Normal, Pawn))
				if from.Rank() == startRank {
					to2 := Square(int(from) + 2*pushDir)
					if empty.Has(to2) {
						ml.add(NewMove(from, to2, Normal, Pawn))
					}
				}
			}
		}
		// Captures.
		caps := pawnAttacks[us][from] & theirs
		for caps != 0 {
			t := caps.PopLSB()
			if t.Rank() == promoRank {
				addPromotions(ml, from, t)
			} else {
				ml.add(NewMove(from, t, Normal, Pawn))
			}
		}
		// En passant.
		if pos.epSquare != SqNone && pawnAttacks[us][from].Has(pos.epSquare) {
			ml.add(NewMove(from, pos.epSquare, EnPassant, Pawn))
		}
	}
}

// genCastling emits legal castling moves for the side to move, generalized for
// Chess960: it works from the stored king/rook origin squares rather than fixed
// E1/H1-style squares. A castle is emitted as (king origin, rook origin).
//
// Legality (FRC rules, which reduce to the standard rules for a classic layout):
//   - every square the king passes through (king origin → king destination,
//     inclusive) must be unattacked — no castling out of, through, or into check;
//   - every square in the king's and the rook's travel spans must be empty,
//     EXCEPT the moving king's and moving rook's own origin squares (in FRC the
//     king may pass over the rook's origin and vice-versa).
func (pos *Position) genCastling(ml *MoveList, us Color) {
	kingFrom := pos.kingSq(us)
	if us == White {
		pos.genCastleSide(ml, us, kingFrom, castleWK, ciWK)
		pos.genCastleSide(ml, us, kingFrom, castleWQ, ciWQ)
	} else {
		pos.genCastleSide(ml, us, kingFrom, castleBK, ciBK)
		pos.genCastleSide(ml, us, kingFrom, castleBQ, ciBQ)
	}
}

func (pos *Position) genCastleSide(ml *MoveList, us Color, kingFrom Square, right uint8, rookIdx int) {
	if pos.castling&right == 0 {
		return
	}
	rookFrom := pos.castleRook[rookIdx]
	kingTo, rookTo := castleTargets(kingFrom, rookFrom)
	occ := pos.occupied

	// Squares that must be empty: king span ∪ rook span, minus the two movers.
	mustEmpty := (rankSpanBB(kingFrom, kingTo) | rankSpanBB(rookFrom, rookTo)) &^
		(kingFrom.BB() | rookFrom.BB())
	if occ&mustEmpty != 0 {
		return
	}

	// King path (inclusive of origin and destination) must be free of attack.
	them := us.Opposite()
	for path := rankSpanBB(kingFrom, kingTo); path != 0; {
		if pos.attackedBy(path.PopLSB(), them, occ) {
			return
		}
	}

	ml.add(NewMove(kingFrom, rookFrom, Castling, Pawn))
}

// GenerateLegal fills ml with the fully-legal moves for the side to move, using
// the pin-aware generator (generateLegalFast). generateLegalSlow is retained as
// the differential-test oracle; perft (TestPerft) guards the node counts.
func (pos *Position) GenerateLegal(ml *MoveList) {
	pos.generateLegalFast(ml)
}

// generateLegalSlow generates pseudo-legal moves and filters each with a
// make/unmake king-attack test. It is the simple, obviously-correct reference
// kept as the differential-test oracle for generateLegalFast.
func (pos *Position) generateLegalSlow(ml *MoveList) {
	var pseudo MoveList
	pos.generatePseudo(&pseudo)
	mover := pos.side
	for i := 0; i < pseudo.count; i++ {
		m := pseudo.moves[i]
		var u Undo
		pos.DoMove(m, &u)
		// After DoMove the side flipped; mover's king must not be attacked.
		if !pos.attackedBy(pos.kingSq(mover), pos.side, pos.occupied) {
			ml.add(m)
		}
		pos.UndoMove(m, &u)
	}
}
