package antichess

import "github.com/timanthonyalexander/gomachine/internal/chess"

// findLegal matches a parsed from/to/promo against the generated legal moves,
// recovering the EP flag. Returns false if not legal.
func (s *State) findLegal(want Move) (Move, bool) {
	for _, m := range s.LegalMoves() {
		if m.From == want.From && m.To == want.To && m.Promo == want.Promo {
			return m, true
		}
	}
	return Move{}, false
}

// doMove applies an already-legal move to a copy of the board (no side flip,
// no fullmove bump) and updates the en-passant target and halfmove clock.
func (s State) doMove(m Move) State {
	ns := s
	mover := ns.board[m.From]
	captured := ns.board[m.To]
	isCaptureOrPawn := captured != chess.NoPiece || mover.Type() == chess.Pawn || m.EP

	ns.board[m.From] = chess.NoPiece
	if m.Promo != chess.NoPieceType {
		ns.board[m.To] = chess.MakePiece(mover.Color(), m.Promo)
	} else {
		ns.board[m.To] = mover
	}
	if m.EP {
		// Remove the pawn sitting behind the en-passant target square.
		var capSq chess.Square
		if mover.Color() == chess.White {
			capSq = chess.Square(int(m.To) - 8)
		} else {
			capSq = chess.Square(int(m.To) + 8)
		}
		ns.board[capSq] = chess.NoPiece
	}

	// A new en-passant target is created ONLY by a pawn double push.
	ns.ep = chess.SqNone
	if mover.Type() == chess.Pawn {
		diff := int(m.To) - int(m.From)
		if diff == 16 || diff == -16 {
			ns.ep = chess.Square((int(m.From) + int(m.To)) / 2)
		}
	}

	if isCaptureOrPawn {
		ns.halfmove = 0
	} else {
		ns.halfmove++
	}
	return ns
}

// MakeMove applies a full turn: the move, then flips the side and bumps the
// fullmove counter. The move is trusted here — callers validate first.
func (s State) MakeMove(m Move) State {
	ns := s.doMove(m)
	if s.side == chess.Black {
		ns.fullmove++
	}
	ns.side = s.side.Opposite()
	return ns
}

// Apply validates and plays a UCI move, returning the next state, its SAN,
// and whether it was legal. Never mutates the receiver.
func (s State) Apply(move string) (State, string, bool) {
	parsed, ok := parseUCI(move)
	if !ok {
		return State{}, "", false
	}
	m, ok := s.findLegal(parsed)
	if !ok {
		return State{}, "", false
	}
	san := s.SAN(m)
	ns := s.MakeMove(m)
	ns.history = append(append([]uint64(nil), s.history...), s.key())
	return ns, san, true
}
