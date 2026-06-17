package chess

// ParseUCIMove resolves a UCI move string (e.g. "e2e4", "e7e8q", "e1g1") against
// the legal moves of the position, returning the matching Move. This is robust:
// it handles castling, en passant, and promotion without special-casing because
// it matches the move's canonical UCI string. Returns false if no legal move
// matches.
func (pos *Position) ParseUCIMove(s string) (Move, bool) {
	var ml MoveList
	pos.GenerateLegal(&ml)
	for i := 0; i < ml.Len(); i++ {
		if ml.Get(i).String() == s {
			return ml.Get(i), true
		}
	}
	return NullMove, false
}

// LegalMoveStrings returns the UCI strings of all legal moves, optionally
// restricted to those originating from `from` (pass SqNone for all).
func (pos *Position) LegalMoveStrings(from Square) []string {
	var ml MoveList
	pos.GenerateLegal(&ml)
	out := make([]string, 0, ml.Len())
	for i := 0; i < ml.Len(); i++ {
		m := ml.Get(i)
		if from != SqNone && m.From() != from {
			continue
		}
		out = append(out, m.String())
	}
	return out
}
