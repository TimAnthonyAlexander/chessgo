package crazyhouse

import "github.com/timanthonyalexander/gomachine/internal/chess"

// LegalMoves returns every legal move for the side to move: standard piece moves
// (from the embedded position's fully-legal generator — check, pins, castling and
// en passant included) plus every legal drop of a pocketed piece. It is empty
// exactly when the game is over (checkmate or stalemate).
func (s *State) LegalMoves() []Move {
	var moves []Move

	for _, uci := range s.pos.LegalMoveStrings(chess.SqNone) {
		if m, ok := parseUCI(uci); ok {
			moves = append(moves, m)
		}
	}

	moves = append(moves, s.legalDrops()...)
	return moves
}

// legalDrops generates every legal drop: each pocketed piece type onto every empty
// square that leaves the king safe (pawns not on the back ranks).
func (s *State) legalDrops() []Move {
	us := s.pos.SideToMove()
	if s.pocketEmpty(us) {
		return nil
	}
	kingSq := s.pos.KingSquare(us)
	enemy := s.pos.ColorBB(us.Opposite())
	occ := s.pos.Occupied()

	var drops []Move
	for _, pt := range pocketOrder {
		if s.pockets[us][pt] == 0 {
			continue
		}
		for sq := chess.Square(0); sq < 64; sq++ {
			if s.pos.PieceOn(sq) != chess.NoPiece {
				continue
			}
			if pt == chess.Pawn {
				if r := sq.Rank(); r == chess.Rank1 || r == chess.Rank8 {
					continue
				}
			}
			// A drop only ADDS a blocker on an empty square, so it can never expose
			// the king — it is legal iff the king is unattacked once that square is
			// occupied. This uniformly rejects drops that fail to block an existing
			// check and accepts everything else.
			if s.pos.AttackersTo(kingSq, occ|sq.BB())&enemy == 0 {
				drops = append(drops, Move{To: sq, IsDrop: true, Drop: pt})
			}
		}
	}
	return drops
}

// pocketEmpty reports whether color c has nothing to drop.
func (s *State) pocketEmpty(c chess.Color) bool {
	for _, pt := range pocketOrder {
		if s.pockets[c][pt] != 0 {
			return false
		}
	}
	return true
}
