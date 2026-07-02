package duckchess

import (
	"errors"
	"strconv"
	"strings"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// Castling-right bits (independent of the engine core's private bits).
const (
	castleWK uint8 = 1 << iota
	castleWQ
	castleBK
	castleBQ
)

// State is a complete Duck Chess position: the piece board (mailbox), side to
// move, castling rights, en-passant target, the duck's square, and clocks. It is
// a value type and every mutating operation returns a NEW State (immutable style)
// — the duck is stored SEPARATELY from the board mailbox (it is never a piece).
type State struct {
	board    [64]chess.Piece
	side     chess.Color
	castling uint8
	ep       chess.Square // raw en-passant target, or chess.SqNone
	duck     chess.Square // the duck's square, or chess.SqNone if not yet placed
	halfmove uint16
	fullmove uint16
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

// Duck returns the duck's square (chess.SqNone if not yet placed).
func (s *State) Duck() chess.Square { return s.duck }

// DuckString returns the duck square in algebraic form, or "" if not yet placed.
func (s *State) DuckString() string {
	if s.duck == chess.SqNone {
		return ""
	}
	return s.duck.String()
}

// PieceOn returns the piece on a square (chess.NoPiece if empty; the duck is
// never a piece and is not reported here).
func (s *State) PieceOn(sq chess.Square) chess.Piece { return s.board[sq] }

// occupied returns the occupancy of PIECES only (the duck is not included).
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

// duckBB returns the duck's single-square bitboard (0 if unplaced).
func (s *State) duckBB() chess.Bitboard {
	if s.duck == chess.SqNone {
		return 0
	}
	return s.duck.BB()
}

// kingSquare returns color c's king square, or chess.SqNone if it has been
// captured (Duck Chess allows a king to be captured — the game then ends).
func (s *State) kingSquare(c chess.Color) chess.Square {
	want := chess.MakePiece(c, chess.King)
	for sq := chess.Square(0); sq < 64; sq++ {
		if s.board[sq] == want {
			return sq
		}
	}
	return chess.SqNone
}

// parseCastling decodes the FEN castling field into this package's bits.
func parseCastling(field string) uint8 {
	if field == "-" {
		return 0
	}
	var c uint8
	for i := 0; i < len(field); i++ {
		switch field[i] {
		case 'K':
			c |= castleWK
		case 'Q':
			c |= castleWQ
		case 'k':
			c |= castleBK
		case 'q':
			c |= castleBQ
		}
	}
	return c
}

// Parse builds a State from a standard FEN plus the duck square ("" = not yet
// placed). The board is validated by reusing chess.ParseFEN; the duck must be
// empty (not on a piece). Illegal-by-classic-chess positions (king "in check")
// are ACCEPTED — Duck Chess has no check.
func Parse(fen, duckStr string) (State, error) {
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

	// Castling + raw en-passant are read from the FEN fields directly (the engine
	// core normalizes ep to "capturable", but Duck Chess wants the raw target).
	fields := strings.Fields(fen)
	st.castling = parseCastling(fields[2])
	st.ep = chess.SqNone
	if len(fields) >= 4 && fields[3] != "-" {
		if sq, ok := chess.ParseSquare(fields[3]); ok {
			st.ep = sq
		}
	}

	st.duck = chess.SqNone
	if duckStr != "" {
		sq, ok := chess.ParseSquare(duckStr)
		if !ok {
			return State{}, errors.New("invalid duck square: " + duckStr)
		}
		if st.board[sq] != chess.NoPiece {
			return State{}, errors.New("duck square is occupied: " + duckStr)
		}
		st.duck = sq
	}
	return st, nil
}

// pieceFENChar maps a piece to its FEN letter.
var pieceFENChar = [12]byte{'P', 'N', 'B', 'R', 'Q', 'K', 'p', 'n', 'b', 'r', 'q', 'k'}

// FEN serializes the board back to a STANDARD FEN (the duck rides alongside in a
// separate field of the API, never inside the FEN).
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
	sb.WriteByte(' ')
	if s.castling == 0 {
		sb.WriteByte('-')
	} else {
		if s.castling&castleWK != 0 {
			sb.WriteByte('K')
		}
		if s.castling&castleWQ != 0 {
			sb.WriteByte('Q')
		}
		if s.castling&castleBK != 0 {
			sb.WriteByte('k')
		}
		if s.castling&castleBQ != 0 {
			sb.WriteByte('q')
		}
	}
	sb.WriteByte(' ')
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
