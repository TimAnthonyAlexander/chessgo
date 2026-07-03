package chess

// Noisy (capture/promotion) legal move generation for quiescence search.
//
// GenerateCaptures emits exactly the subsequence of GenerateLegal's output that
// is "noisy" — i.e. that qsearch would keep after its
//
//	isCapture(m) || m.Type() == Promotion
//
// filter, where isCapture is "the destination square is occupied, or the move is
// en passant". It is a target-mask-restricted clone of generateLegalFast (same
// pin/check machinery, SAME EMISSION ORDER), so the produced list is
// byte-identical to filtering the full legal list. That equality is the whole
// point: qsearch can generate only the noisy moves (skipping the legality work
// for the quiet majority) with ZERO change to which moves it searches or in what
// order — a pure NPS win, gated by a differential test (movegen_captures_test.go)
// against the filtered generateLegalFast across every perft tree + random
// positions, not by a strength SPRT.
//
// "Noisy" here matches the qsearch predicate exactly, quirks included:
//   - capture-promotions AND quiet push-promotions (both are Promotion type);
//   - en passant (a capture);
//   - castling — encoded as (king, rook-origin), whose destination square holds
//     our own rook, so PieceOn(To()) != NoPiece ⇒ it passes isCapture. The full
//     generator emits it only when not in check, and so do we.
//
// It is correct as a standalone noisy-legal generator in ALL positions (it
// computes checkers/checkMask and handles double check → king captures only), so
// the differential test can assert parity on in-check positions too, even though
// qsearch itself only calls it when NOT in check (in check it needs every
// evasion, quiet ones included, so it calls GenerateLegal).
func (pos *Position) GenerateCaptures(ml *MoveList) {
	us := pos.side
	them := us.Opposite()
	occ := pos.occupied
	ours := pos.byColor[us]
	theirs := pos.byColor[them]
	ksq := pos.kingSq(us)

	checkers := pos.attackersBy(ksq, them, occ)
	numCheckers := checkers.Count()
	occNoKing := occ ^ ksq.BB()

	if numCheckers < 2 {
		checkMask := ^Bitboard(0)
		if numCheckers == 1 {
			cs := checkers.LSB()
			checkMask = betweenBB[ksq][cs] | cs.BB()
		}
		pinned := pos.pinnedTo(us, ksq, occ, ours)

		// Pawns: capture-promotions + push-promotions + captures + en passant.
		pos.genPawnsNoisy(ml, us, occ, theirs, checkMask, pinned, ksq)

		// Knights: captures only (targets ∩ enemy). Pinned knights never move.
		knights := pos.pieces[MakePiece(us, Knight)] &^ pinned
		for knights != 0 {
			from := knights.PopLSB()
			addTargets(ml, from, knightAttacks[from]&theirs&checkMask)
		}

		// Sliders: captures only. A pinned slider stays on its pin ray.
		for _, pt := range [3]PieceType{Bishop, Rook, Queen} {
			bb := pos.pieces[MakePiece(us, pt)]
			for bb != 0 {
				from := bb.PopLSB()
				t := attacksFrom(pt, us, from, occ) & theirs & checkMask
				if pinned.Has(from) {
					t &= lineBB[ksq][from]
				}
				addTargets(ml, from, t)
			}
		}
	}

	// King captures. Restrict to enemy-occupied targets; same safety test as the
	// full generator (attacked with our king removed from the occupancy).
	kt := kingAttacks[ksq] & theirs
	for kt != 0 {
		to := kt.PopLSB()
		if !pos.attackedBy(to, them, occNoKing) {
			ml.add(NewMove(ksq, to, Normal, Pawn))
		}
	}

	// Castling — a "noisy" move by the isCapture-on-rook-square quirk (see the
	// doc comment). Emitted only when not in check, matching the full generator.
	if numCheckers == 0 {
		pos.genCastling(ml, us)
	}
}

// genPawnsNoisy mirrors genPawnsLegal but emits only the noisy pawn moves:
// promotions (both capture- and push-promotions), ordinary captures, and en
// passant — in the SAME per-pawn order as genPawnsLegal (push-promotion first,
// then captures, then en passant), so the output is a subsequence of the full
// pawn move list. Quiet single/double pushes are skipped.
func (pos *Position) genPawnsNoisy(ml *MoveList, us Color, occ, theirs, checkMask, pinned Bitboard, ksq Square) {
	pawns := pos.pieces[MakePiece(us, Pawn)]
	empty := ^occ
	var pushDir int
	var startRank, promoRank Rank
	if us == White {
		pushDir, startRank, promoRank = 8, Rank2, Rank8
	} else {
		pushDir, startRank, promoRank = -8, Rank7, Rank1
	}
	_ = startRank // double pushes are quiet → never noisy
	for pawns != 0 {
		from := pawns.PopLSB()
		pinLine := ^Bitboard(0)
		if pinned.Has(from) {
			pinLine = lineBB[ksq][from]
		}

		// Push-promotion (a quiet push to the last rank is noisy: Promotion type).
		// Non-promo pushes and double pushes are quiet → skipped.
		to := Square(int(from) + pushDir)
		if empty.Has(to) && to.Rank() == promoRank && to.BB()&checkMask&pinLine != 0 {
			addPromotions(ml, from, to)
		}

		// Captures (including capture-promotions).
		caps := pawnAttacks[us][from] & theirs & checkMask & pinLine
		for caps != 0 {
			t := caps.PopLSB()
			if t.Rank() == promoRank {
				addPromotions(ml, from, t)
			} else {
				ml.add(NewMove(from, t, Normal, Pawn))
			}
		}

		// En passant — exact make/unmake legality (byte-for-byte the full path's
		// filter, so EP parity is guaranteed).
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
