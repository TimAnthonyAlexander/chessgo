package crazyhouse

import (
	"errors"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// Apply validates and plays a move ("e2e4", "e7e8q", or a drop "P@e4"), returning
// the resulting state. It errors on a malformed or illegal move and never mutates
// the receiver.
func (s State) Apply(move string) (State, error) {
	m, ok := parseUCI(move)
	if !ok {
		return State{}, errors.New("invalid move: " + move)
	}
	if !s.isLegal(m) {
		return State{}, errors.New("illegal move: " + move)
	}
	return s.applyLegal(m), nil
}

// ApplyUCI validates and plays a UCI move ("e2e4", "e7e8q" or a drop "P@e4"),
// returning the next state, the move's SAN, and whether it was legal — the shape
// the variant adapter needs (SAN is rendered relative to the pre-move state).
func (s State) ApplyUCI(move string) (State, string, bool) {
	m, ok := parseUCI(move)
	if !ok || !s.isLegal(m) {
		return State{}, "", false
	}
	return s.applyLegal(m), s.SAN(m), true
}

// isLegal reports whether m is among the legal moves for the side to move.
func (s State) isLegal(m Move) bool {
	for _, lm := range s.LegalMoves() {
		if lm == m {
			return true
		}
	}
	return false
}

// applyLegal plays a legal move and returns the next state WITH the pre-move key
// appended to the threefold history. It wraps advance, which does the board work.
func (s State) applyLegal(m Move) State {
	ns := s.advance(m)
	ns.history = append(append([]uint64(nil), s.history...), s.key())
	return ns
}

// advance plays a move already known to be legal and returns the next state
// WITHOUT recording repetition history — the search hot path uses this (in-tree
// threefold is not tracked). It handles the two Crazyhouse-specific bits of
// bookkeeping: a capture drops the victim into the mover's pocket (a captured
// promoted piece reverts to a pawn), and the promoted-square set follows the
// pieces.
func (s State) advance(m Move) State {
	ns := s
	ns.history = nil // caller (applyLegal) sets history when needed
	us := s.pos.SideToMove()

	if m.IsDrop {
		ns.pockets[us][m.Drop]--
		ns.pos.DoDrop(chess.MakePiece(us, m.Drop), m.To)
		return ns
	}

	// Resolve the fully-flagged core move (castling/ep) against the current position.
	cm, ok := ns.pos.ParseUCIMove(m.UCI())
	if !ok {
		return s // unreachable for a legal move
	}

	// Identify the captured square BEFORE the move (en passant captures behind To).
	captureSq := m.To
	if cm.Type() == chess.EnPassant {
		captureSq = chess.MakeSquare(m.To.File(), m.From.Rank())
	}
	victim := s.pos.PieceOn(captureSq)
	victimPromoted := s.promoted&captureSq.BB() != 0

	var undo chess.Undo
	ns.pos.DoMove(cm, &undo)

	// Pocket the victim (a promoted piece reverts to a pawn) and update the
	// promoted-square set: clear the captured square, then carry the mover's
	// promoted flag from -> to (a promotion move newly marks the destination).
	np := s.promoted
	if victim != chess.NoPiece {
		np &^= captureSq.BB()
		pt := victim.Type()
		if victimPromoted {
			pt = chess.Pawn
		}
		ns.pockets[us][pt]++
	}
	if cm.Type() == chess.Promotion {
		np = (np &^ m.From.BB()) | m.To.BB()
	} else if np&m.From.BB() != 0 {
		np = (np &^ m.From.BB()) | m.To.BB()
	}
	ns.promoted = np
	return ns
}

// key is a composite Zobrist over the board, both pockets and the promoted set, so
// two positions with identical boards but different pockets/promotions are treated
// as distinct for threefold repetition.
func (s *State) key() uint64 {
	h := uint64(1469598103934665603) // FNV-1a offset basis
	for c := 0; c < 2; c++ {
		for pt := 0; pt < 5; pt++ {
			h = (h ^ uint64(s.pockets[c][pt])) * 1099511628211
		}
	}
	return s.pos.Key() ^ (h * 0x9E3779B97F4A7C15) ^ (uint64(s.promoted) * 0xD1B54A32D192ED03)
}
