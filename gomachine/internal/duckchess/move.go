// Package duckchess implements the Duck Chess variant as a self-contained module.
//
// Duck Chess rules (see the engine README/spec):
//   - A single rubber duck sits on one square and blocks ALL pieces: nothing may
//     move onto it and no slider/pawn may move through it (knights jump, so the
//     duck only blocks a knight's LANDING square, not its path).
//   - Each turn is a normal piece move followed by relocating the duck to a
//     DIFFERENT empty square. On the very first move the duck is not yet on the
//     board, so the mover places it on any empty square.
//   - There is NO check and NO checkmate. You win by CAPTURING the enemy king, so
//     king-capturing moves are legal and generated. A side with zero legal piece
//     moves loses. An optional move cap adjudicates a draw.
//
// The package reuses internal/chess READ-ONLY for square/piece/bitboard helpers
// (FEN parsing, attack tables) but never mutates the engine core.
package duckchess

import "github.com/timanthonyalexander/gomachine/internal/chess"

// PieceMove is a single piece move (no duck). Special flags are derived by the
// generator; the applier trusts them, so a hand-built PieceMove must set them.
type PieceMove struct {
	From  chess.Square
	To    chess.Square
	Promo chess.PieceType // chess.NoPieceType when not a promotion
	EP    bool            // en-passant capture
	Castle bool           // castling (To is the king's destination file g/c)
}

// promoFromChar maps a UCI promotion letter to a piece type (NoPieceType on miss).
func promoFromChar(c byte) chess.PieceType {
	switch c {
	case 'n', 'N':
		return chess.Knight
	case 'b', 'B':
		return chess.Bishop
	case 'r', 'R':
		return chess.Rook
	case 'q', 'Q':
		return chess.Queen
	}
	return chess.NoPieceType
}

// promoChar maps a promotion piece type to its lowercase UCI letter.
func promoChar(pt chess.PieceType) byte {
	switch pt {
	case chess.Knight:
		return 'n'
	case chess.Bishop:
		return 'b'
	case chess.Rook:
		return 'r'
	case chess.Queen:
		return 'q'
	}
	return 0
}

// UCI renders the piece move in long algebraic notation (e2e4, e7e8q, e1g1).
func (m PieceMove) UCI() string {
	s := m.From.String() + m.To.String()
	if m.Promo != chess.NoPieceType {
		s += string([]byte{promoChar(m.Promo)})
	}
	return s
}

// parsePieceUCI parses a 4- or 5-char UCI string into origin/destination/promo.
// The returned flags (EP/Castle) are NOT set here — they are resolved against a
// concrete position when the move is matched to a generated legal move.
func parsePieceUCI(s string) (PieceMove, bool) {
	if len(s) != 4 && len(s) != 5 {
		return PieceMove{}, false
	}
	from, ok := chess.ParseSquare(s[0:2])
	if !ok {
		return PieceMove{}, false
	}
	to, ok := chess.ParseSquare(s[2:4])
	if !ok {
		return PieceMove{}, false
	}
	promo := chess.NoPieceType
	if len(s) == 5 {
		promo = promoFromChar(s[4])
		if promo == chess.NoPieceType {
			return PieceMove{}, false
		}
	}
	return PieceMove{From: from, To: to, Promo: promo}, true
}
