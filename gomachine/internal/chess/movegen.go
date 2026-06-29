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

func (pos *Position) genCastling(ml *MoveList, us Color) {
	occ := pos.occupied
	them := us.Opposite()
	clear := func(squares ...Square) bool {
		for _, s := range squares {
			if occ.Has(s) {
				return false
			}
		}
		return true
	}
	safe := func(squares ...Square) bool {
		for _, s := range squares {
			if pos.attackedBy(s, them, occ) {
				return false
			}
		}
		return true
	}
	if us == White {
		if pos.castling&castleWK != 0 && clear(F1, G1) && safe(E1, F1, G1) {
			ml.add(NewMove(E1, G1, Castling, Pawn))
		}
		if pos.castling&castleWQ != 0 && clear(D1, C1, B1) && safe(E1, D1, C1) {
			ml.add(NewMove(E1, C1, Castling, Pawn))
		}
	} else {
		if pos.castling&castleBK != 0 && clear(F8, G8) && safe(E8, F8, G8) {
			ml.add(NewMove(E8, G8, Castling, Pawn))
		}
		if pos.castling&castleBQ != 0 && clear(D8, C8, B8) && safe(E8, D8, C8) {
			ml.add(NewMove(E8, C8, Castling, Pawn))
		}
	}
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
