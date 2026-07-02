package chess

// ParseUCIMove resolves a UCI move string against the legal moves of the position,
// returning the matching Move. It handles castling, en passant, and promotion by
// matching the move's UCI string. Both castling UCI conventions are accepted:
//   - king-captures-rook, e.g. "e1h1" (canonical Chess960, Lichess convention);
//   - king-two-squares, e.g. "e1g1" (standard chess).
//
// The king-captures-rook form is matched first (it is unambiguous in Chess960,
// where a normal king step can share a king-two-square string with a castle).
// Returns false if no legal move matches.
func (pos *Position) ParseUCIMove(s string) (Move, bool) {
	var ml MoveList
	pos.GenerateLegal(&ml)
	// Pass 1: king-captures-rook form for castling (unambiguous in FRC).
	for i := 0; i < ml.Len(); i++ {
		m := ml.Get(i)
		if m.Type() == Castling && m.CastleUCI() == s {
			return m, true
		}
	}
	// Pass 2: canonical String form (king-two-square castles + all other moves).
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
