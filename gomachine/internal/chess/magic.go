package chess

// Slider-attack dispatch shared by both the magic-bitboard and PEXT backends.
//
// The concrete slider indexers live in build-tag-split files so the hot path has
// NO runtime branch and the table layout is chosen at compile time:
//
//   - slideratt_pext_amd64.go  (amd64 && !nopext): BMI2 PEXT dense tables.
//   - slideratt_magic.go       (!amd64 || nopext): fancy magic bitboards.
//
// Both backends provide initSliders(), rookAttacksBB(sq, occ) and
// bishopAttacksBB(sq, occ) and build their tables from the SHARED reference
// helpers slidingMask/slidingAttacks (attacks.go). queenAttacksBB, PseudoAttacks
// and attacksFrom are backend-agnostic and live here.

func init() {
	initNonSliding()
	initSliders()
}

// queenAttacksBB returns queen attacks from sq for the given occupancy.
func queenAttacksBB(sq Square, occ Bitboard) Bitboard {
	return bishopAttacksBB(sq, occ) | rookAttacksBB(sq, occ)
}

// PseudoAttacks returns the squares attacked by piece pc on sq given board
// occupancy occ (sliders are blocked by occ; leapers/pawns ignore it). It is the
// exported pseudo-attack accessor used by the NNUE threat-feature extractor
// (internal/nnue), which needs "who attacks whom" per position. Castling and
// en-passant are not attacks and are excluded by construction.
func PseudoAttacks(pc Piece, sq Square, occ Bitboard) Bitboard {
	return attacksFrom(pc.Type(), pc.Color(), sq, occ)
}

// attacksFrom returns the attack set of a piece type from sq given occupancy.
func attacksFrom(pt PieceType, c Color, sq Square, occ Bitboard) Bitboard {
	switch pt {
	case Knight:
		return knightAttacks[sq]
	case Bishop:
		return bishopAttacksBB(sq, occ)
	case Rook:
		return rookAttacksBB(sq, occ)
	case Queen:
		return queenAttacksBB(sq, occ)
	case King:
		return kingAttacks[sq]
	case Pawn:
		return pawnAttacks[c][sq]
	}
	return 0
}
