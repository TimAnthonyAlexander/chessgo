package crazyhouse

import "github.com/timanthonyalexander/gomachine/internal/chess"

// Move is either a normal piece move or a drop. For a drop, IsDrop is true, Drop
// is the pocketed piece type, and To is the (empty) target; From/Promo are unused.
// For a piece move, From/To (and Promo for a promotion) are set as in standard
// chess. The engine core resolves special flags (castling/ep) when the move is
// matched against generated legal moves, so callers only set From/To/Promo.
type Move struct {
	From, To chess.Square
	Promo    chess.PieceType // NoPieceType unless a promotion
	IsDrop   bool
	Drop     chess.PieceType // the pocketed piece type; valid iff IsDrop
}

// UCI renders the move: "e2e4" / "e7e8q" for piece moves, "P@e4" for a drop (the
// piece letter is always uppercase — the colour is implied by the side to move).
func (m Move) UCI() string {
	if m.IsDrop {
		return string([]byte{upperLetter(m.Drop), '@'}) + m.To.String()
	}
	s := m.From.String() + m.To.String()
	if m.Promo != chess.NoPieceType {
		s += string([]byte{typeLetter[m.Promo]})
	}
	return s
}

// upperLetter is a piece type's uppercase FEN letter (for drop notation).
func upperLetter(pt chess.PieceType) byte { return typeLetter[pt] - ('a' - 'A') }

// parseUCI parses "e2e4"/"e7e8q"/"P@e4" into a Move. The piece-move flags
// (ep/castling) are resolved later against a concrete position; a drop is fully
// specified here. Returns false on any malformed input.
func parseUCI(s string) (Move, bool) {
	// Drop: "<PIECE>@<square>", e.g. "N@f3".
	if len(s) == 4 && s[1] == '@' {
		pt, ok := pocketTypeFromLetter(s[0])
		if !ok {
			return Move{}, false
		}
		to, ok := chess.ParseSquare(s[2:4])
		if !ok {
			return Move{}, false
		}
		return Move{To: to, IsDrop: true, Drop: pt}, true
	}

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

// promoFromLetter maps a UCI promotion letter to a piece type (NoPieceType/false
// on miss); the king and pawn are not valid promotions.
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
	}
	return chess.NoPieceType, false
}
