package duckchess

import "github.com/timanthonyalexander/gomachine/internal/chess"

// LegalPieceMoves returns every legal PIECE move for the side to move. In Duck
// Chess "legal" == "pseudo-legal, duck-aware": there is NO self-check filter and
// king captures ARE included (capturing the enemy king wins). The duck blocks all
// landing squares and every sliding/pawn path; knights jump but may not land on
// the duck. The duck itself is never captured.
func (s *State) LegalPieceMoves() []PieceMove {
	us := s.side
	occ := s.occupied()
	duckBB := s.duckBB()
	occWithDuck := occ | duckBB
	own := s.colorBB(us)
	enemy := s.colorBB(us.Opposite())

	moves := make([]PieceMove, 0, 48)
	for from := chess.Square(0); from < 64; from++ {
		p := s.board[from]
		if p == chess.NoPiece || p.Color() != us {
			continue
		}
		switch p.Type() {
		case chess.Pawn:
			moves = s.genPawn(moves, from, occ, enemy, duckBB)
		case chess.Knight:
			targets := chess.PseudoAttacks(p, from, occWithDuck) &^ own &^ duckBB
			moves = emitTargets(moves, from, targets)
		case chess.King:
			targets := chess.PseudoAttacks(p, from, occWithDuck) &^ own &^ duckBB
			moves = emitTargets(moves, from, targets)
			moves = s.genCastling(moves, from, occWithDuck)
		default: // Bishop, Rook, Queen — sliders blocked by pieces AND the duck.
			targets := chess.PseudoAttacks(p, from, occWithDuck) &^ own &^ duckBB
			moves = emitTargets(moves, from, targets)
		}
	}
	return moves
}

// emitTargets appends a plain (non-special) PieceMove for each set target square.
func emitTargets(moves []PieceMove, from chess.Square, targets chess.Bitboard) []PieceMove {
	for targets != 0 {
		to := targets.PopLSB()
		moves = append(moves, PieceMove{From: from, To: to, Promo: chess.NoPieceType})
	}
	return moves
}

var promoPieces = [4]chess.PieceType{chess.Queen, chess.Rook, chess.Bishop, chess.Knight}

// genPawn appends every legal move for the pawn on `from`.
func (s *State) genPawn(moves []PieceMove, from chess.Square, occ, enemy, duckBB chess.Bitboard) []PieceMove {
	us := s.side
	occWithDuck := occ | duckBB

	var forward int
	var startRank, promoRank chess.Rank
	if us == chess.White {
		forward, startRank, promoRank = 8, chess.Rank2, chess.Rank8
	} else {
		forward, startRank, promoRank = -8, chess.Rank7, chess.Rank1
	}

	// Single / double push (blocked by any piece OR the duck).
	one := chess.Square(int(from) + forward)
	if one < 64 && !occWithDuck.Has(one) {
		moves = s.addPawnMove(moves, from, one, promoRank, false)
		if from.Rank() == startRank {
			two := chess.Square(int(from) + 2*forward)
			if !occWithDuck.Has(two) {
				moves = append(moves, PieceMove{From: from, To: two, Promo: chess.NoPieceType})
			}
		}
	}

	// Captures (diagonals). The duck is never capturable, so a duck on a diagonal
	// yields no capture there.
	att := chess.PseudoAttacks(chess.MakePiece(us, chess.Pawn), from, occWithDuck)
	caps := att & enemy &^ duckBB
	for caps != 0 {
		to := caps.PopLSB()
		moves = s.addPawnMove(moves, from, to, promoRank, false)
	}

	// En passant: the target square is empty by definition; it is legal only if the
	// duck is not sitting on it (the duck would block the landing square).
	if s.ep != chess.SqNone && !duckBB.Has(s.ep) && att.Has(s.ep) {
		moves = append(moves, PieceMove{From: from, To: s.ep, Promo: chess.NoPieceType, EP: true})
	}
	return moves
}

// addPawnMove appends a pawn move to `to`, expanding to four promotions when `to`
// is on the promotion rank.
func (s *State) addPawnMove(moves []PieceMove, from, to chess.Square, promoRank chess.Rank, ep bool) []PieceMove {
	if to.Rank() == promoRank {
		for _, pt := range promoPieces {
			moves = append(moves, PieceMove{From: from, To: to, Promo: pt})
		}
		return moves
	}
	return append(moves, PieceMove{From: from, To: to, Promo: chess.NoPieceType, EP: ep})
}

// genCastling appends legal castling moves. Duck Chess castling is normal EXCEPT
// there is no "castle out of / through check" rule (no check exists); the duck may
// not sit on any square the king passes over or the squares that must be empty.
func (s *State) genCastling(moves []PieceMove, kingFrom chess.Square, occWithDuck chess.Bitboard) []PieceMove {
	us := s.side
	if us == chess.White {
		if kingFrom != chess.E1 || s.board[chess.E1] != chess.WhiteKing {
			return moves
		}
		if s.castling&castleWK != 0 && s.board[chess.H1] == chess.WhiteRook &&
			!occWithDuck.Has(chess.F1) && !occWithDuck.Has(chess.G1) {
			moves = append(moves, PieceMove{From: chess.E1, To: chess.G1, Promo: chess.NoPieceType, Castle: true})
		}
		if s.castling&castleWQ != 0 && s.board[chess.A1] == chess.WhiteRook &&
			!occWithDuck.Has(chess.B1) && !occWithDuck.Has(chess.C1) && !occWithDuck.Has(chess.D1) {
			moves = append(moves, PieceMove{From: chess.E1, To: chess.C1, Promo: chess.NoPieceType, Castle: true})
		}
		return moves
	}
	if kingFrom != chess.E8 || s.board[chess.E8] != chess.BlackKing {
		return moves
	}
	if s.castling&castleBK != 0 && s.board[chess.H8] == chess.BlackRook &&
		!occWithDuck.Has(chess.F8) && !occWithDuck.Has(chess.G8) {
		moves = append(moves, PieceMove{From: chess.E8, To: chess.G8, Promo: chess.NoPieceType, Castle: true})
	}
	if s.castling&castleBQ != 0 && s.board[chess.A8] == chess.BlackRook &&
		!occWithDuck.Has(chess.B8) && !occWithDuck.Has(chess.C8) && !occWithDuck.Has(chess.D8) {
		moves = append(moves, PieceMove{From: chess.E8, To: chess.C8, Promo: chess.NoPieceType, Castle: true})
	}
	return moves
}

// capturesEnemyKing reports whether m lands on the enemy king's square.
func (s *State) capturesEnemyKing(m PieceMove) bool {
	return s.board[m.To] == chess.MakePiece(s.side.Opposite(), chess.King)
}
