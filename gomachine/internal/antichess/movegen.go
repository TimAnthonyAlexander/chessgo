package antichess

import "github.com/timanthonyalexander/gomachine/internal/chess"

// LegalMoves returns every legal move for the side to move under the
// Antichess forced-capture rule: if ANY pseudo-legal move is a capture
// (landing on an enemy piece, or an en-passant capture), only captures are
// legal, and the mover has free choice among them; otherwise every
// pseudo-legal move is legal. There is no check/pin/castling filter — none of
// that exists in this ruleset, so "pseudo-legal" already IS "legal" (modulo
// the forced-capture cut). Empty exactly when the game is over.
func (s *State) LegalMoves() []Move {
	pseudo := s.pseudoMoves()

	captures := make([]Move, 0, len(pseudo))
	for _, m := range pseudo {
		if s.isCapture(m) {
			captures = append(captures, m)
		}
	}
	if len(captures) > 0 {
		return captures
	}
	return pseudo
}

// isCapture reports whether m removes an enemy piece: either it lands on an
// occupied square, or it is flagged as an en-passant capture (whose landing
// square is empty by definition).
func (s *State) isCapture(m Move) bool {
	return m.EP || s.board[m.To] != chess.NoPiece
}

// pseudoMoves generates every pseudo-legal move for the side to move: pawn
// pushes/captures/en-passant/promotions (including king promotion), and every
// other piece's normal attack pattern minus its own-color occupied squares.
// The king moves exactly like any other piece — no castling, no "can't move
// into check" restriction (there is no check in Antichess).
func (s *State) pseudoMoves() []Move {
	us := s.side
	occ := s.occupied()
	own := s.colorBB(us)
	enemy := s.colorBB(us.Opposite())

	moves := make([]Move, 0, 48)
	for from := chess.Square(0); from < 64; from++ {
		p := s.board[from]
		if p == chess.NoPiece || p.Color() != us {
			continue
		}
		if p.Type() == chess.Pawn {
			moves = s.genPawn(moves, from, occ, enemy)
			continue
		}
		targets := chess.PseudoAttacks(p, from, occ) &^ own
		moves = emitTargets(moves, from, targets)
	}
	return moves
}

// emitTargets appends a plain (non-promotion, non-EP) move for each target.
func emitTargets(moves []Move, from chess.Square, targets chess.Bitboard) []Move {
	for targets != 0 {
		to := targets.PopLSB()
		moves = append(moves, Move{From: from, To: to, Promo: chess.NoPieceType})
	}
	return moves
}

// genPawn appends every pseudo-legal move for the pawn on `from`: single/
// double push, diagonal captures, and en passant — each expanded into five
// promotion choices (Q/R/B/N/K) when it lands on the last rank.
func (s *State) genPawn(moves []Move, from chess.Square, occ, enemy chess.Bitboard) []Move {
	us := s.side
	var forward int
	var startRank, promoRank chess.Rank
	if us == chess.White {
		forward, startRank, promoRank = 8, chess.Rank2, chess.Rank8
	} else {
		forward, startRank, promoRank = -8, chess.Rank7, chess.Rank1
	}

	// Single / double push (blocked by any piece).
	one := chess.Square(int(from) + forward)
	if one < 64 && !occ.Has(one) {
		moves = s.addPawnMove(moves, from, one, promoRank, false)
		if from.Rank() == startRank {
			two := chess.Square(int(from) + 2*forward)
			if !occ.Has(two) {
				moves = append(moves, Move{From: from, To: two, Promo: chess.NoPieceType})
			}
		}
	}

	// Diagonal captures.
	att := chess.PseudoAttacks(chess.MakePiece(us, chess.Pawn), from, occ)
	caps := att & enemy
	for caps != 0 {
		to := caps.PopLSB()
		moves = s.addPawnMove(moves, from, to, promoRank, false)
	}

	// En passant — counts as a capture under the forced-capture rule.
	if s.ep != chess.SqNone && att.Has(s.ep) {
		moves = append(moves, Move{From: from, To: s.ep, Promo: chess.NoPieceType, EP: true})
	}
	return moves
}

// addPawnMove appends a pawn move to `to`, expanding to five promotion
// choices (Q/R/B/N/K) when `to` is on the promotion rank.
func (s *State) addPawnMove(moves []Move, from, to chess.Square, promoRank chess.Rank, ep bool) []Move {
	if to.Rank() == promoRank {
		for _, pt := range promoTypes {
			moves = append(moves, Move{From: from, To: to, Promo: pt})
		}
		return moves
	}
	return append(moves, Move{From: from, To: to, Promo: chess.NoPieceType, EP: ep})
}
