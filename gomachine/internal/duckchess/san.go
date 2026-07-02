package duckchess

import "github.com/timanthonyalexander/gomachine/internal/chess"

var sanPieceLetter = [6]byte{0, 'N', 'B', 'R', 'Q', 'K'} // index by PieceType

// SAN renders a display-only human string for a composite move, e.g. "e4 🦆e5",
// "Nf3 🦆d4", "O-O 🦆h6", "exd6 🦆c4". It is intentionally simple: no check/mate
// suffix (Duck Chess has neither) and no disambiguation. `duck` is the square the
// duck ends on. The move is rendered relative to THIS (pre-move) state.
func (s *State) SAN(m PieceMove, duck chess.Square) string {
	piece := s.pieceSAN(m)
	if duck == chess.SqNone {
		return piece
	}
	return piece + " \U0001F986" + duck.String()
}

// pieceSAN renders just the piece portion of the move in short algebraic form.
func (s *State) pieceSAN(m PieceMove) string {
	if m.Castle {
		if m.To.File() == chess.FileG {
			return "O-O"
		}
		return "O-O-O"
	}

	mover := s.board[m.From]
	pt := mover.Type()
	capture := s.board[m.To] != chess.NoPiece || m.EP

	if pt == chess.Pawn {
		out := ""
		if capture {
			out += string([]byte{byte('a' + m.From.File())}) + "x"
		}
		out += m.To.String()
		if m.Promo != chess.NoPieceType {
			out += "=" + string([]byte{sanPieceLetter[m.Promo]})
		}
		return out
	}

	out := string([]byte{sanPieceLetter[pt]})
	if capture {
		out += "x"
	}
	out += m.To.String()
	return out
}
