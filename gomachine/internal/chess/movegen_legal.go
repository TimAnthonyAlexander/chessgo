package chess

// Pin-aware legal move generation. Instead of generating pseudo-legal moves and
// filtering each with a make/unmake + king-attack test (the O(moves) approach in
// generateLegalSlow), this computes the checkers and the pinned-piece set ONCE
// per node, then emits only legal moves directly:
//
//   - non-king, non-pinned pieces: targets ∩ checkMask (the squares that resolve
//     check — all squares when not in check, the block/capture squares in single
//     check, nothing in double check).
//   - pinned pieces: additionally ∩ lineBB[king][piece] (stay on the pin ray).
//   - king: each destination tested for safety with the king removed from the
//     occupancy (so a slider checking THROUGH the king's square is seen).
//   - en passant: the ONE case kept on the make/unmake path — it removes two
//     pawns from a rank and can spring a horizontal discovered check that the
//     pin mask doesn't model. It's rare, so an exact make/unmake legality test
//     is both bulletproof and cheap, and guarantees parity with the slow path.
//
// generateLegalSlow remains the differential-test oracle (movegen_legal_test.go
// asserts the two emit identical move sets across every perft tree + random
// positions). Movegen correctness is the load-bearing invariant; perft is the
// permanent guard.

// attackersBy returns the set of color `by` pieces that attack square s under
// occupancy occ (the bitboard form of attackedBy).
func (pos *Position) attackersBy(s Square, by Color, occ Bitboard) Bitboard {
	var a Bitboard
	a |= pawnAttacks[by.Opposite()][s] & pos.pieces[MakePiece(by, Pawn)]
	a |= knightAttacks[s] & pos.pieces[MakePiece(by, Knight)]
	a |= kingAttacks[s] & pos.pieces[MakePiece(by, King)]
	a |= bishopAttacksBB(s, occ) & (pos.pieces[MakePiece(by, Bishop)] | pos.pieces[MakePiece(by, Queen)])
	a |= rookAttacksBB(s, occ) & (pos.pieces[MakePiece(by, Rook)] | pos.pieces[MakePiece(by, Queen)])
	return a
}

// pinnedTo returns the set of `us` pieces pinned against the king on ksq: a piece
// is pinned when it is the SOLE occupant between the king and an enemy slider that
// bears on the king's rank/file/diagonal.
func (pos *Position) pinnedTo(us Color, ksq Square, occ, ours Bitboard) Bitboard {
	them := us.Opposite()
	rq := pos.pieces[MakePiece(them, Rook)] | pos.pieces[MakePiece(them, Queen)]
	bq := pos.pieces[MakePiece(them, Bishop)] | pos.pieces[MakePiece(them, Queen)]
	// Sliders that would hit the king on an EMPTY board (occ=0 → full rays).
	snipers := (rookAttacksBB(ksq, 0) & rq) | (bishopAttacksBB(ksq, 0) & bq)
	var pinned Bitboard
	for snipers != 0 {
		s := snipers.PopLSB()
		blockers := betweenBB[ksq][s] & occ
		if blockers != 0 && !blockers.More() && blockers&ours != 0 {
			pinned |= blockers
		}
	}
	return pinned
}

// generateLegalFast fills ml with the fully-legal moves via the pin/check-mask path.
func (pos *Position) generateLegalFast(ml *MoveList) {
	us := pos.side
	them := us.Opposite()
	occ := pos.occupied
	ours := pos.byColor[us]
	theirs := pos.byColor[them]
	ksq := pos.kingSq(us)

	checkers := pos.attackersBy(ksq, them, occ)
	numCheckers := checkers.Count()
	occNoKing := occ ^ ksq.BB()

	// Emit in the SAME ORDER as generatePseudo (pawns, knights, bishops, rooks,
	// queens, king, castling) so the produced move list is byte-identical to the
	// slow generator's — keeping the search tree (which depends on generation
	// order for equal-scored quiets) unchanged. Only the king may move in double
	// check, so the non-king block is skipped there.
	if numCheckers < 2 {
		// checkMask: squares a non-king piece may move to. In single check it is the
		// blocking squares plus the checker itself; otherwise the whole board.
		checkMask := ^Bitboard(0)
		if numCheckers == 1 {
			cs := checkers.LSB()
			checkMask = betweenBB[ksq][cs] | cs.BB()
		}
		pinned := pos.pinnedTo(us, ksq, occ, ours)

		// Pawns (pushes / captures / promotions with masks; en passant via make/unmake).
		pos.genPawnsLegal(ml, us, occ, theirs, checkMask, pinned, ksq)

		// Knights: a pinned knight can never move (no knight target lies on a pin
		// ray), so exclude pinned knights up front.
		knights := pos.pieces[MakePiece(us, Knight)] &^ pinned
		for knights != 0 {
			from := knights.PopLSB()
			addTargets(ml, from, knightAttacks[from]&^ours&checkMask)
		}

		// Sliders: bishops, rooks, queens. A pinned slider stays on its pin ray.
		for _, pt := range [3]PieceType{Bishop, Rook, Queen} {
			bb := pos.pieces[MakePiece(us, pt)]
			for bb != 0 {
				from := bb.PopLSB()
				t := attacksFrom(pt, us, from, occ) &^ ours & checkMask
				if pinned.Has(from) {
					t &= lineBB[ksq][from]
				}
				addTargets(ml, from, t)
			}
		}
	}

	// King moves. A destination is legal iff it is not attacked with our own king
	// removed from the occupancy (so a slider checking THROUGH the king's current
	// square still covers the escape square).
	kt := kingAttacks[ksq] &^ ours
	for kt != 0 {
		to := kt.PopLSB()
		if !pos.attackedBy(to, them, occNoKing) {
			ml.add(NewMove(ksq, to, Normal, Pawn))
		}
	}

	// Castling cannot occur while in check (genCastling's own safety test already
	// excludes it, but gating keeps the intent explicit and avoids the work).
	if numCheckers == 0 {
		pos.genCastling(ml, us)
	}
}

// genPawnsLegal mirrors genPawns but applies the check mask and pin ray directly,
// so only legal pawn moves are emitted. En passant remains on the make/unmake
// legality path (the discovered-check special case).
func (pos *Position) genPawnsLegal(ml *MoveList, us Color, occ, theirs, checkMask, pinned Bitboard, ksq Square) {
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
		pinLine := ^Bitboard(0)
		if pinned.Has(from) {
			pinLine = lineBB[ksq][from]
		}

		// Pushes (single, then double from the start rank). A push is legal when
		// its destination resolves any check (∩ checkMask) and stays on the pin
		// ray (∩ pinLine).
		to := Square(int(from) + pushDir)
		if empty.Has(to) {
			if to.BB()&checkMask&pinLine != 0 {
				if to.Rank() == promoRank {
					addPromotions(ml, from, to)
				} else {
					ml.add(NewMove(from, to, Normal, Pawn))
				}
			}
			if from.Rank() == startRank {
				to2 := Square(int(from) + 2*pushDir)
				if empty.Has(to2) && to2.BB()&checkMask&pinLine != 0 {
					ml.add(NewMove(from, to2, Normal, Pawn))
				}
			}
		}

		// Captures.
		caps := pawnAttacks[us][from] & theirs & checkMask & pinLine
		for caps != 0 {
			t := caps.PopLSB()
			if t.Rank() == promoRank {
				addPromotions(ml, from, t)
			} else {
				ml.add(NewMove(from, t, Normal, Pawn))
			}
		}

		// En passant — exact make/unmake legality (rare; handles the two-pawns-
		// off-a-rank discovered check that the pin mask doesn't model). This is
		// byte-for-byte the slow path's filter, so EP parity is guaranteed.
		if pos.epSquare != SqNone && pawnAttacks[us][from].Has(pos.epSquare) {
			m := NewMove(from, pos.epSquare, EnPassant, Pawn)
			var u Undo
			pos.DoMove(m, &u)
			if !pos.attackedBy(pos.kingSq(us), pos.side, pos.occupied) {
				ml.add(m)
			}
			pos.UndoMove(m, &u)
		}
	}
}
