package antichess

import "github.com/timanthonyalexander/gomachine/internal/chess"

// Move is a single Antichess move. There are no drops and no castling; EP
// marks an en-passant capture (the destination square is empty by
// definition, so isCapture must be told separately). Promo is NoPieceType
// unless the move is a promotion, in which case it is one of
// Queen/Rook/Bishop/Knight/King — Antichess uniquely allows promoting to King.
type Move struct {
	From, To chess.Square
	Promo    chess.PieceType
	EP       bool
}

// promoTypes lists every piece a pawn may promote to, in the order emitted by
// the generator (Queen first, King last — an arbitrary but stable order).
var promoTypes = [5]chess.PieceType{chess.Queen, chess.Rook, chess.Bishop, chess.Knight, chess.King}

// promoLetter maps a promotion piece type to its lowercase UCI letter,
// including 'k' for a king promotion (non-standard but required by the
// Antichess ruleset; lichess/UCI convention).
func promoLetter(pt chess.PieceType) byte {
	switch pt {
	case chess.Knight:
		return 'n'
	case chess.Bishop:
		return 'b'
	case chess.Rook:
		return 'r'
	case chess.Queen:
		return 'q'
	case chess.King:
		return 'k'
	}
	return 0
}

// promoFromLetter is the inverse of promoLetter (case-insensitive).
func promoFromLetter(c byte) (chess.PieceType, bool) {
	switch c {
	case 'n', 'N':
		return chess.Knight, true
	case 'b', 'B':
		return chess.Bishop, true
	case 'r', 'R':
		return chess.Rook, true
	case 'q', 'Q':
		return chess.Queen, true
	case 'k', 'K':
		return chess.King, true
	}
	return chess.NoPieceType, false
}

// UCI renders the move in long algebraic notation: "e2e4", "e7e8q", or the
// Antichess-only king promotion "a7a8k".
func (m Move) UCI() string {
	s := m.From.String() + m.To.String()
	if m.Promo != chess.NoPieceType {
		s += string([]byte{promoLetter(m.Promo)})
	}
	return s
}

// parseUCI parses a 4- or 5-char UCI string into from/to/promo. The EP flag is
// NOT set here — it is resolved against a concrete position when the parsed
// move is matched against a generated legal move (see State.findLegal).
func parseUCI(s string) (Move, bool) {
	if len(s) != 4 && len(s) != 5 {
		return Move{}, false
	}
	from, ok := chess.ParseSquare(s[0:2])
	if !ok {
		return Move{}, false
	}
	to, ok := chess.ParseSquare(s[2:4])
	if !ok {
		return Move{}, false
	}
	promo := chess.NoPieceType
	if len(s) == 5 {
		promo, ok = promoFromLetter(s[4])
		if !ok {
			return Move{}, false
		}
	}
	return Move{From: from, To: to, Promo: promo}, true
}
