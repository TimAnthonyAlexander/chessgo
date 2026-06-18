package chess

import (
	"errors"
	"strconv"
	"strings"
)

// StartFEN is the standard initial position.
const StartFEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"

// Castling-right bits.
const (
	castleWK uint8 = 1 << iota
	castleWQ
	castleBK
	castleBQ
)

// castleMask[sq] holds the castling-right bits to KEEP when a piece moves from or
// to sq. Touching a king or rook home square clears the relevant rights.
var castleMask [64]uint8

func init() {
	for i := range castleMask {
		castleMask[i] = 0xF
	}
	castleMask[E1] &^= castleWK | castleWQ
	castleMask[A1] &^= castleWQ
	castleMask[H1] &^= castleWK
	castleMask[E8] &^= castleBK | castleBQ
	castleMask[A8] &^= castleBQ
	castleMask[H8] &^= castleBK
}

// Position is a full chess position: bitboards + redundant mailbox + state.
type Position struct {
	pieces   [12]Bitboard // one bitboard per piece (WP..BK)
	byColor  [2]Bitboard  // occupancy per color
	occupied Bitboard     // all pieces
	board    [64]Piece    // mailbox: square -> piece (NoPiece if empty)
	side     Color        // side to move
	castling uint8        // castleWK|castleWQ|castleBK|castleBQ
	epSquare Square       // en-passant target, or SqNone
	halfmove uint16       // plies since last capture/pawn move (50-move rule)
	fullmove uint16       // starts at 1, +1 after Black moves
	key      uint64       // Zobrist hash
}

// --- piece manipulation (maintain bitboards, mailbox, and key together) ---

func (pos *Position) addPiece(p Piece, s Square) {
	bb := s.BB()
	pos.pieces[p] |= bb
	pos.byColor[p.Color()] |= bb
	pos.occupied |= bb
	pos.board[s] = p
	pos.key ^= zobristPieces[p][s]
}

func (pos *Position) removePiece(s Square) {
	p := pos.board[s]
	bb := s.BB()
	pos.pieces[p] &^= bb
	pos.byColor[p.Color()] &^= bb
	pos.occupied &^= bb
	pos.board[s] = NoPiece
	pos.key ^= zobristPieces[p][s]
}

// movePiece moves the piece on `from` to `to`, which must be empty.
func (pos *Position) movePiece(from, to Square) {
	p := pos.board[from]
	fromTo := from.BB() | to.BB()
	pos.pieces[p] ^= fromTo
	pos.byColor[p.Color()] ^= fromTo
	pos.occupied ^= fromTo
	pos.board[from] = NoPiece
	pos.board[to] = p
	pos.key ^= zobristPieces[p][from] ^ zobristPieces[p][to]
}

// --- accessors ---

// SideToMove returns the side to move.
func (pos *Position) SideToMove() Color { return pos.side }

// Key returns the Zobrist hash of the position.
func (pos *Position) Key() uint64 { return pos.key }

// HalfmoveClock returns plies since the last capture or pawn move.
func (pos *Position) HalfmoveClock() uint16 { return pos.halfmove }

// PieceOn returns the piece on a square (NoPiece if empty).
func (pos *Position) PieceOn(s Square) Piece { return pos.board[s] }

func (pos *Position) kingSq(c Color) Square { return pos.pieces[MakePiece(c, King)].LSB() }

// PieceBB returns the bitboard of squares occupied by piece p.
func (pos *Position) PieceBB(p Piece) Bitboard { return pos.pieces[p] }

// ColorBB returns the occupancy bitboard for color c.
func (pos *Position) ColorBB(c Color) Bitboard { return pos.byColor[c] }

// Occupied returns the all-pieces occupancy bitboard.
func (pos *Position) Occupied() Bitboard { return pos.occupied }

// NonPawnMaterial reports whether color c has any piece other than king/pawns
// (used to guard null-move pruning against zugzwang).
func (pos *Position) NonPawnMaterial(c Color) bool {
	return pos.pieces[MakePiece(c, Knight)]|pos.pieces[MakePiece(c, Bishop)]|
		pos.pieces[MakePiece(c, Rook)]|pos.pieces[MakePiece(c, Queen)] != 0
}

// attackedBy reports whether color `by` attacks square `s` given occupancy `occ`.
func (pos *Position) attackedBy(s Square, by Color, occ Bitboard) bool {
	if pawnAttacks[by.Opposite()][s]&pos.pieces[MakePiece(by, Pawn)] != 0 {
		return true
	}
	if knightAttacks[s]&pos.pieces[MakePiece(by, Knight)] != 0 {
		return true
	}
	if kingAttacks[s]&pos.pieces[MakePiece(by, King)] != 0 {
		return true
	}
	bishopsQueens := pos.pieces[MakePiece(by, Bishop)] | pos.pieces[MakePiece(by, Queen)]
	if bishopAttacksBB(s, occ)&bishopsQueens != 0 {
		return true
	}
	rooksQueens := pos.pieces[MakePiece(by, Rook)] | pos.pieces[MakePiece(by, Queen)]
	return rookAttacksBB(s, occ)&rooksQueens != 0
}

// InCheck reports whether the side to move is in check.
func (pos *Position) InCheck() bool {
	return pos.attackedBy(pos.kingSq(pos.side), pos.side.Opposite(), pos.occupied)
}

// Legal reports whether the position is sound to search/play from: both kings
// are present and the side NOT to move is not in check (an "illegal" position
// would otherwise let the search capture a king and crash). Input FENs from
// clients must pass this before being searched.
func (pos *Position) Legal() bool {
	if pos.pieces[MakePiece(White, King)] == 0 || pos.pieces[MakePiece(Black, King)] == 0 {
		return false
	}
	them := pos.side.Opposite()
	return !pos.attackedBy(pos.kingSq(them), pos.side, pos.occupied)
}

// epIsRealFor reports whether color c could legally-by-attack capture on the
// current en-passant square with a pawn (pseudo-legal pawn-attack test).
func (pos *Position) epIsRealFor(c Color) bool {
	if pos.epSquare == SqNone {
		return false
	}
	return pawnAttacks[c.Opposite()][pos.epSquare]&pos.pieces[MakePiece(c, Pawn)] != 0
}

func (pos *Position) epIsReal() bool { return pos.epIsRealFor(pos.side) }

// computeKey recomputes the Zobrist hash from scratch (used at parse time and in
// tests to validate incremental updates).
func (pos *Position) computeKey() uint64 {
	var k uint64
	for s := Square(0); s < 64; s++ {
		if p := pos.board[s]; p != NoPiece {
			k ^= zobristPieces[p][s]
		}
	}
	k ^= zobristCastling[pos.castling]
	if pos.side == Black {
		k ^= zobristSide
	}
	if pos.epIsReal() {
		k ^= zobristEP[pos.epSquare.File()]
	}
	return k
}

// --- FEN ---

// ParseFEN parses a FEN string into a Position.
func ParseFEN(fen string) (*Position, error) {
	fields := strings.Fields(fen)
	if len(fields) < 4 {
		return nil, errors.New("FEN must have at least 4 fields")
	}
	pos := &Position{epSquare: SqNone}
	for i := range pos.board {
		pos.board[i] = NoPiece
	}

	// 1. Piece placement (ranks 8 -> 1).
	rank := 7
	file := 0
	for i := 0; i < len(fields[0]); i++ {
		c := fields[0][i]
		switch {
		case c == '/':
			rank--
			file = 0
		case c >= '1' && c <= '8':
			file += int(c - '0')
		default:
			p := fenToPiece(c)
			if p == NoPiece {
				return nil, errors.New("invalid piece char in FEN: " + string(c))
			}
			if rank < 0 || file > 7 {
				return nil, errors.New("FEN piece placement out of range")
			}
			pos.addPiece(p, MakeSquare(File(file), Rank(rank)))
			file++
		}
	}

	// 2. Side to move.
	switch fields[1] {
	case "w":
		pos.side = White
	case "b":
		pos.side = Black
	default:
		return nil, errors.New("invalid side to move: " + fields[1])
	}

	// 3. Castling rights.
	if fields[2] != "-" {
		for i := 0; i < len(fields[2]); i++ {
			switch fields[2][i] {
			case 'K':
				pos.castling |= castleWK
			case 'Q':
				pos.castling |= castleWQ
			case 'k':
				pos.castling |= castleBK
			case 'q':
				pos.castling |= castleBQ
			default:
				return nil, errors.New("invalid castling char: " + string(fields[2][i]))
			}
		}
	}

	// 4. En-passant target.
	if fields[3] != "-" {
		sq, ok := ParseSquare(fields[3])
		if !ok {
			return nil, errors.New("invalid en-passant square: " + fields[3])
		}
		pos.epSquare = sq
	}

	// 5/6. Clocks (optional).
	pos.halfmove = 0
	pos.fullmove = 1
	if len(fields) >= 5 {
		if n, err := strconv.Atoi(fields[4]); err == nil {
			pos.halfmove = uint16(n)
		}
	}
	if len(fields) >= 6 {
		if n, err := strconv.Atoi(fields[5]); err == nil && n > 0 {
			pos.fullmove = uint16(n)
		}
	}

	pos.key = pos.computeKey()
	return pos, nil
}

// FEN serializes the position back to a FEN string.
func (pos *Position) FEN() string {
	var sb strings.Builder
	for rank := 7; rank >= 0; rank-- {
		empty := 0
		for file := 0; file < 8; file++ {
			p := pos.board[MakeSquare(File(file), Rank(rank))]
			if p == NoPiece {
				empty++
				continue
			}
			if empty > 0 {
				sb.WriteByte(byte('0' + empty))
				empty = 0
			}
			sb.WriteByte(pieceToFEN[p])
		}
		if empty > 0 {
			sb.WriteByte(byte('0' + empty))
		}
		if rank > 0 {
			sb.WriteByte('/')
		}
	}
	sb.WriteByte(' ')
	if pos.side == White {
		sb.WriteByte('w')
	} else {
		sb.WriteByte('b')
	}
	sb.WriteByte(' ')
	if pos.castling == 0 {
		sb.WriteByte('-')
	} else {
		if pos.castling&castleWK != 0 {
			sb.WriteByte('K')
		}
		if pos.castling&castleWQ != 0 {
			sb.WriteByte('Q')
		}
		if pos.castling&castleBK != 0 {
			sb.WriteByte('k')
		}
		if pos.castling&castleBQ != 0 {
			sb.WriteByte('q')
		}
	}
	sb.WriteByte(' ')
	if pos.epSquare == SqNone {
		sb.WriteByte('-')
	} else {
		sb.WriteString(pos.epSquare.String())
	}
	sb.WriteByte(' ')
	sb.WriteString(strconv.Itoa(int(pos.halfmove)))
	sb.WriteByte(' ')
	sb.WriteString(strconv.Itoa(int(pos.fullmove)))
	return sb.String()
}
