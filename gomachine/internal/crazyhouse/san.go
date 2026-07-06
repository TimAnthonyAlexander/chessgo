package crazyhouse

import "strings"

// SAN renders a legal move in Crazyhouse algebraic notation: a drop is
// "<PIECE>@<square>" (e.g. "N@f3"), a piece move reuses the chess core's SAN. The
// check/mate suffix is computed here rather than taken from the core, because a
// board position that is checkmate in standard chess may not be in Crazyhouse (the
// defender can drop a piece to interpose) — so "#" must reflect the real result.
func (s *State) SAN(m Move) string {
	var base string
	if m.IsDrop {
		base = string([]byte{upperLetter(m.Drop), '@'}) + m.To.String()
	} else {
		cm, ok := s.pos.ParseUCIMove(m.UCI())
		if !ok {
			return m.UCI()
		}
		base = strings.TrimRight(s.pos.SAN(cm), "+#")
	}

	next := s.advance(m)
	if next.pos.InCheck() {
		if len(next.LegalMoves()) == 0 {
			base += "#"
		} else {
			base += "+"
		}
	}
	return base
}
