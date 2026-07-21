// Package antichess implements Antichess (aka Losing Chess / Räuberschach) as a
// self-contained module, matching the Lichess ruleset exactly:
//
//   - Compulsory capture: if any capture is available (including en passant),
//     ONLY captures are legal — the mover has free choice among them.
//   - No check, no checkmate, no pins, no castling. The king is an ordinary,
//     capturable piece; every pseudo-legal move is legal (subject only to the
//     forced-capture filter above).
//   - A pawn reaching the last rank may promote to Q/R/B/N OR KING (so a side
//     can end up with more than one king, or none).
//   - INVERTED win condition: the side to move WINS if it has no pieces left or
//     no legal move at all (stalemate is a WIN, not a draw). Note "no pieces"
//     is a special case of "no legal move" — LegalMoves() naturally returns
//     empty when the side to move controls no pieces, so Status() only needs
//     the one check.
//   - Draws: threefold repetition and the 50-move rule, both applied
//     automatically (there is no "claim a draw" UI action for this variant in
//     the hub, mirroring how Crazyhouse auto-draws at threefold).
//
// The package reuses internal/chess READ-ONLY for square/piece/bitboard
// helpers (FEN parsing, attack tables) but never mutates the engine core or
// relies on its check/pin/castling-aware legal-move generator — none of that
// applies here. Every operation is immutable (value copy), matching the
// internal/variant State contract.
package antichess

import (
	"errors"
	"strconv"
	"strings"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// StartFEN is the Antichess starting position (identical to standard chess).
const StartFEN = chess.StartFEN

// State is a complete Antichess position: a piece mailbox, side to move, the
// raw en-passant target, clocks, and the prior-position key history (for
// threefold detection). It is a value type — every mutating operation returns
// a NEW State. There is no castling in Antichess, so no castling rights are
// tracked.
type State struct {
	board    [64]chess.Piece
	side     chess.Color
	ep       chess.Square // raw en-passant target, or chess.SqNone
	halfmove uint16       // plies since the last capture or pawn move (50-move rule)
	fullmove uint16
	history  []uint64 // prior composite position keys (excludes the current position)
}

// Side returns the side to move.
func (s *State) Side() chess.Color { return s.side }

// SideChar returns "w" or "b" for the side to move.
func (s *State) SideChar() string {
	if s.side == chess.White {
		return "w"
	}
	return "b"
}

// PieceOn returns the piece on a square (chess.NoPiece if empty).
func (s *State) PieceOn(sq chess.Square) chess.Piece { return s.board[sq] }

// occupied returns the occupancy of every piece on the board.
func (s *State) occupied() chess.Bitboard {
	var bb chess.Bitboard
	for sq := chess.Square(0); sq < 64; sq++ {
		if s.board[sq] != chess.NoPiece {
			bb |= sq.BB()
		}
	}
	return bb
}

// colorBB returns the occupancy of one color's pieces.
func (s *State) colorBB(c chess.Color) chess.Bitboard {
	var bb chess.Bitboard
	for sq := chess.Square(0); sq < 64; sq++ {
		if p := s.board[sq]; p != chess.NoPiece && p.Color() == c {
			bb |= sq.BB()
		}
	}
	return bb
}

// HasPieces reports whether color c has any piece left on the board.
func (s *State) HasPieces(c chess.Color) bool {
	for sq := chess.Square(0); sq < 64; sq++ {
		if p := s.board[sq]; p != chess.NoPiece && p.Color() == c {
			return true
		}
	}
	return false
}

// Parse builds a State from a standard FEN. Castling-rights and check-related
// fields in the FEN (if present) are ignored — Antichess has neither. The
// board is validated by reusing chess.ParseFEN for the piece-placement/side/
// clock fields; a king-less or multi-king position is ACCEPTED (Antichess
// allows both via promotion/capture).
func Parse(fen string) (State, error) {
	pos, err := chess.ParseFEN(fen)
	if err != nil {
		return State{}, errors.New("invalid fen: " + err.Error())
	}
	var st State
	for sq := chess.Square(0); sq < 64; sq++ {
		st.board[sq] = pos.PieceOn(sq)
	}
	st.side = pos.SideToMove()
	st.halfmove = pos.HalfmoveClock()
	st.fullmove = pos.FullmoveNumber()

	// Read the raw en-passant field directly (Antichess wants the literal FEN
	// target, not the engine core's "is it actually capturable" normalization —
	// the forced-capture movegen below already only offers it when a pawn can
	// actually take it).
	fields := strings.Fields(fen)
	st.ep = chess.SqNone
	if len(fields) >= 4 && fields[3] != "-" {
		if sq, ok := chess.ParseSquare(fields[3]); ok {
			st.ep = sq
		}
	}
	return st, nil
}

// pieceFENChar maps a piece to its FEN letter.
var pieceFENChar = [12]byte{'P', 'N', 'B', 'R', 'Q', 'K', 'p', 'n', 'b', 'r', 'q', 'k'}

// FEN serializes the position back to a standard-shape FEN (no castling
// field content — Antichess has none — rendered as "-").
func (s *State) FEN() string {
	var sb strings.Builder
	for rank := 7; rank >= 0; rank-- {
		empty := 0
		for file := 0; file < 8; file++ {
			p := s.board[chess.MakeSquare(chess.File(file), chess.Rank(rank))]
			if p == chess.NoPiece {
				empty++
				continue
			}
			if empty > 0 {
				sb.WriteByte(byte('0' + empty))
				empty = 0
			}
			sb.WriteByte(pieceFENChar[p])
		}
		if empty > 0 {
			sb.WriteByte(byte('0' + empty))
		}
		if rank > 0 {
			sb.WriteByte('/')
		}
	}
	sb.WriteByte(' ')
	if s.side == chess.White {
		sb.WriteByte('w')
	} else {
		sb.WriteByte('b')
	}
	sb.WriteString(" - ") // no castling rights in Antichess
	if s.ep == chess.SqNone {
		sb.WriteByte('-')
	} else {
		sb.WriteString(s.ep.String())
	}
	sb.WriteByte(' ')
	sb.WriteString(strconv.Itoa(int(s.halfmove)))
	sb.WriteByte(' ')
	sb.WriteString(strconv.Itoa(int(s.fullmove)))
	return sb.String()
}

// key is a composite hash over the board, side to move and en-passant target,
// used for threefold repetition. It deliberately does NOT hash halfmove/
// fullmove (those never repeat) or castling (there is none in Antichess).
func (s *State) key() uint64 {
	h := uint64(1469598103934665603) // FNV-1a offset basis
	const prime = uint64(1099511628211)
	for sq := chess.Square(0); sq < 64; sq++ {
		h = (h ^ uint64(s.board[sq])) * prime
	}
	h = (h ^ uint64(s.side)) * prime
	h = (h ^ uint64(s.ep)) * prime
	return h
}
