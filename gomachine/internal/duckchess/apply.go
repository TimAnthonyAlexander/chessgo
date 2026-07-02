package duckchess

import (
	"errors"
	"strings"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// castleMask holds the castling bits to KEEP when a square is touched (moved from
// or to). Touching a king/rook home square clears the relevant rights.
var castleMask [64]uint8

func init() {
	for i := range castleMask {
		castleMask[i] = 0xF
	}
	castleMask[chess.E1] &^= castleWK | castleWQ
	castleMask[chess.A1] &^= castleWQ
	castleMask[chess.H1] &^= castleWK
	castleMask[chess.E8] &^= castleBK | castleBQ
	castleMask[chess.A8] &^= castleBQ
	castleMask[chess.H8] &^= castleBK
}

// doPieceMove applies ONLY the piece move to a copy of the board (no duck move,
// no side flip, no fullmove bump). It updates castling rights, the en-passant
// target and the halfmove clock, and reports whether the enemy king was captured.
func (s State) doPieceMove(m PieceMove) (State, bool) {
	ns := s
	mover := ns.board[m.From]
	captured := ns.board[m.To]
	capturedKing := captured != chess.NoPiece && captured.Type() == chess.King

	isCaptureOrPawn := captured != chess.NoPiece || mover.Type() == chess.Pawn || m.EP

	// Move the piece (with promotion / en-passant / castling side effects).
	ns.board[m.From] = chess.NoPiece
	if m.Promo != chess.NoPieceType {
		ns.board[m.To] = chess.MakePiece(mover.Color(), m.Promo)
	} else {
		ns.board[m.To] = mover
	}
	if m.EP {
		// Remove the pawn that sits behind the en-passant target square.
		var capSq chess.Square
		if mover.Color() == chess.White {
			capSq = chess.Square(int(m.To) - 8)
		} else {
			capSq = chess.Square(int(m.To) + 8)
		}
		ns.board[capSq] = chess.NoPiece
	}
	if m.Castle {
		// Relocate the rook to the far side of the king.
		switch m.To {
		case chess.G1:
			ns.board[chess.H1], ns.board[chess.F1] = chess.NoPiece, chess.WhiteRook
		case chess.C1:
			ns.board[chess.A1], ns.board[chess.D1] = chess.NoPiece, chess.WhiteRook
		case chess.G8:
			ns.board[chess.H8], ns.board[chess.F8] = chess.NoPiece, chess.BlackRook
		case chess.C8:
			ns.board[chess.A8], ns.board[chess.D8] = chess.NoPiece, chess.BlackRook
		}
	}

	// Castling rights: clear any tied to the from/to squares.
	ns.castling &= castleMask[m.From] & castleMask[m.To]

	// En-passant target: only a pawn double-push creates one.
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
	return ns, capturedKing
}

// MakeMove applies a full turn: the piece move THEN the duck relocation, flipping
// the side and bumping the move number. It reports whether the enemy king was
// captured (an immediate win). The duck square is trusted here — callers validate.
func (s State) MakeMove(m PieceMove, newDuck chess.Square) (State, bool) {
	ns, capturedKing := s.doPieceMove(m)
	ns.duck = newDuck
	if s.side == chess.Black {
		ns.fullmove++
	}
	ns.side = s.side.Opposite()
	return ns, capturedKing
}

// findLegal matches a parsed origin/destination/promo against the generated legal
// moves, recovering the EP/Castle flags. Returns false if not legal.
func (s *State) findLegal(want PieceMove) (PieceMove, bool) {
	for _, m := range s.LegalPieceMoves() {
		if m.From == want.From && m.To == want.To && m.Promo == want.Promo {
			return m, true
		}
	}
	return PieceMove{}, false
}

// ApplyComposite validates and applies a composite move string
// "<pieceUCI>:<duckSquare>" (e.g. "e2e4:e5"). It returns the resulting state, the
// resolved piece move, the terminal status, and an error describing any rule
// violation (illegal piece move, bad/occupied/unchanged duck square, ...).
func (s State) ApplyComposite(move string) (State, PieceMove, Status, error) {
	piecePart, duckPart, ok := strings.Cut(move, ":")
	if !ok {
		return State{}, PieceMove{}, "", errors.New("move must be \"<pieceUCI>:<duckSquare>\"")
	}
	parsed, ok := parsePieceUCI(piecePart)
	if !ok {
		return State{}, PieceMove{}, "", errors.New("invalid piece move: " + piecePart)
	}
	pm, ok := s.findLegal(parsed)
	if !ok {
		return State{}, PieceMove{}, "", errors.New("illegal piece move: " + piecePart)
	}

	duckSq, ok := chess.ParseSquare(duckPart)
	if !ok {
		return State{}, PieceMove{}, "", errors.New("invalid duck square: " + duckPart)
	}

	// The duck must land on a square that is empty AFTER the piece move and that
	// differs from its current square (it may not stay). On the first move the duck
	// has no current square, so any empty square is allowed.
	mid, _ := s.doPieceMove(pm)
	if mid.board[duckSq] != chess.NoPiece {
		return State{}, PieceMove{}, "", errors.New("duck target is occupied: " + duckPart)
	}
	if s.duck != chess.SqNone && duckSq == s.duck {
		return State{}, PieceMove{}, "", errors.New("duck must move to a different square")
	}

	ns, capturedKing := s.MakeMove(pm, duckSq)
	status := ns.statusAfter(s.side, capturedKing)
	return ns, pm, status, nil
}
