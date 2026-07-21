package antichess

import "github.com/timanthonyalexander/gomachine/internal/chess"

var sanPieceLetter = [6]byte{0, 'N', 'B', 'R', 'Q', 'K'} // index by PieceType (Pawn unused)

// SAN renders a legal move in simple algebraic notation. Antichess has no
// check/mate suffix (there is no check) and no disambiguation (mirroring
// Duck's SAN, which is display-only and intentionally simple) — a decisive
// ending is communicated by the game's terminal status, not a move suffix.
// The move is rendered relative to THIS (pre-move) state.
func (s *State) SAN(m Move) string {
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
