package chess

// Static Exchange Evaluation (SEE): the net material (centipawns) won or lost by
// playing a capture on its destination square, assuming both sides keep
// recapturing with their least valuable attacker while it is favorable. The
// search uses it to order captures and to prune losing ones in quiescence —
// strictly an ordering/pruning heuristic, so the king-into-check subtlety and
// promotions are handled approximately, never affecting legality.

// SEEValues are the piece values used by SEE, indexed by PieceType
// (P,N,B,R,Q,K). The king value is large so a "king capture" terminates a swap.
var SEEValues = [6]int{100, 320, 330, 500, 900, 10000}

// attackersTo returns every piece of either color attacking sq, given occupancy
// occ. Sliders are computed against occ so callers can re-probe for x-ray
// attackers after removing a piece.
func (pos *Position) attackersTo(sq Square, occ Bitboard) Bitboard {
	var bb Bitboard
	bb |= pawnAttacks[Black][sq] & pos.pieces[WhitePawn] // white pawns hitting sq
	bb |= pawnAttacks[White][sq] & pos.pieces[BlackPawn] // black pawns hitting sq
	bb |= knightAttacks[sq] & (pos.pieces[WhiteKnight] | pos.pieces[BlackKnight])
	bb |= kingAttacks[sq] & (pos.pieces[WhiteKing] | pos.pieces[BlackKing])
	bb |= bishopAttacksBB(sq, occ) & pos.bishopsQueens()
	bb |= rookAttacksBB(sq, occ) & pos.rooksQueens()
	return bb & occ
}

// AttackersTo is the exported view of attackersTo: every piece of either color
// attacking sq given occupancy occ (sliders re-probed against occ). Used by the
// NNUE move-aware threat delta to find the pieces whose attack edges a move
// perturbs. sq need not be occupied.
func (pos *Position) AttackersTo(sq Square, occ Bitboard) Bitboard { return pos.attackersTo(sq, occ) }

func (pos *Position) bishopsQueens() Bitboard {
	return pos.pieces[WhiteBishop] | pos.pieces[BlackBishop] |
		pos.pieces[WhiteQueen] | pos.pieces[BlackQueen]
}

func (pos *Position) rooksQueens() Bitboard {
	return pos.pieces[WhiteRook] | pos.pieces[BlackRook] |
		pos.pieces[WhiteQueen] | pos.pieces[BlackQueen]
}

// epCaptureSquare returns the square of the pawn captured by an en-passant move
// to `to` by the given side.
func epCaptureSquare(side Color, to Square) Square {
	if side == White {
		return to - 8
	}
	return to + 8
}

// SEE returns the static exchange evaluation of capture move m, in centipawns,
// from the perspective of the side to move. A non-negative result means the
// capture does not lose material against best defense.
func (pos *Position) SEE(m Move) int {
	if m.Type() == Castling {
		return 0
	}
	to := m.To()
	from := m.From()

	occ := pos.occupied

	// gain[0] = value of the piece initially captured.
	var gain [32]int
	if m.Type() == EnPassant {
		gain[0] = SEEValues[Pawn]
		occ &^= epCaptureSquare(pos.side, to).BB()
	} else if victim := pos.board[to]; victim != NoPiece {
		gain[0] = SEEValues[victim.Type()]
	}

	// aPiece tracks the value of the piece currently sitting on `to` (initially
	// the moving piece), i.e. what the opponent would capture next.
	aPieceType := pos.board[from].Type()
	aPiece := SEEValues[aPieceType]
	if m.Type() == Promotion {
		// Approximate: the pawn promotes on capture; count the upgrade once.
		promoGain := SEEValues[m.Promo()] - SEEValues[Pawn]
		gain[0] += promoGain
		aPiece = SEEValues[m.Promo()]
	}

	occ &^= from.BB()
	attackers := pos.attackersTo(to, occ)

	side := pos.side // the side that just captured (occupies `to`)
	d := 0
	for {
		d++
		gain[d] = aPiece - gain[d-1]
		// Pruning: if even giving up the piece on `to` for free the running
		// balance can't go negative for the side to move, stop.
		if max2(-gain[d-1], gain[d]) < 0 {
			break
		}
		side = side.Opposite()

		// Least valuable attacker of `side` still on the board.
		sideBB := attackers & occ & pos.byColor[side]
		if sideBB == 0 {
			break
		}
		var lsb Bitboard
		var pt PieceType
		for pt = Pawn; pt <= King; pt++ {
			if b := sideBB & pos.pieces[MakePiece(side, pt)]; b != 0 {
				lsb = b & (-b)
				break
			}
		}
		if lsb == 0 {
			break
		}
		occ ^= lsb
		// Reveal x-ray attackers behind the one just removed.
		if pt == Pawn || pt == Bishop || pt == Queen {
			attackers |= bishopAttacksBB(to, occ) & pos.bishopsQueens()
		}
		if pt == Rook || pt == Queen {
			attackers |= rookAttacksBB(to, occ) & pos.rooksQueens()
		}
		attackers &= occ
		aPiece = SEEValues[pt]
		if d >= len(gain)-1 {
			break
		}
	}

	// Minimax the swap list back to the root.
	for d--; d > 0; d-- {
		if -gain[d] < gain[d-1] {
			gain[d-1] = -gain[d]
		}
	}
	return gain[0]
}

// SEEGE reports whether SEE(m) >= threshold (a common form: "is this capture at
// least break-even / winning material?").
func (pos *Position) SEEGE(m Move, threshold int) bool {
	return pos.SEE(m) >= threshold
}

func max2(a, b int) int {
	if a > b {
		return a
	}
	return b
}
