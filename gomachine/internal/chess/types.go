// Package chess implements the core of the gomachine engine: board
// representation (bitboards + mailbox), FEN, Zobrist hashing, legal move
// generation, make/unmake, and perft. It is the single source of truth for
// chess rules. See docs/SPEC.md §4–§5.
package chess

// Color is the side to move / piece owner.
type Color uint8

const (
	White Color = 0
	Black Color = 1
)

// Opposite returns the other color.
func (c Color) Opposite() Color { return c ^ 1 }

// PieceType identifies a kind of piece, independent of color.
type PieceType uint8

const (
	Pawn PieceType = iota
	Knight
	Bishop
	Rook
	Queen
	King
	NoPieceType PieceType = 6
)

// Piece is a colored piece, encoded 0..11 (White P,N,B,R,Q,K then Black ...).
type Piece uint8

const (
	WhitePawn Piece = iota
	WhiteKnight
	WhiteBishop
	WhiteRook
	WhiteQueen
	WhiteKing
	BlackPawn
	BlackKnight
	BlackBishop
	BlackRook
	BlackQueen
	BlackKing
	NoPiece Piece = 12
)

// MakePiece builds a Piece from a color and type.
func MakePiece(c Color, pt PieceType) Piece { return Piece(uint8(c)*6 + uint8(pt)) }

// Color returns the owning color of the piece. Undefined for NoPiece.
func (p Piece) Color() Color { return Color(p / 6) }

// Type returns the piece type. Undefined for NoPiece.
func (p Piece) Type() PieceType { return PieceType(p % 6) }

// File is a column a..h encoded 0..7.
type File uint8

// Rank is a row 1..8 encoded 0..7.
type Rank uint8

const (
	FileA File = iota
	FileB
	FileC
	FileD
	FileE
	FileF
	FileG
	FileH
)

const (
	Rank1 Rank = iota
	Rank2
	Rank3
	Rank4
	Rank5
	Rank6
	Rank7
	Rank8
)

// Square is a board square 0..63 in Little-Endian Rank-File order: a1=0, b1=1,
// ..., h1=7, a2=8, ..., h8=63.
type Square uint8

const SqNone Square = 64

// Named squares (a subset used in code/tests).
const (
	A1 Square = iota
	B1
	C1
	D1
	E1
	F1
	G1
	H1
)
const (
	A8 Square = 56 + iota
	B8
	C8
	D8
	E8
	F8
	G8
	H8
)

// MakeSquare composes a square from file and rank.
func MakeSquare(f File, r Rank) Square { return Square(uint8(r)*8 + uint8(f)) }

// File returns the file (0..7) of the square.
func (s Square) File() File { return File(s & 7) }

// Rank returns the rank (0..7) of the square.
func (s Square) Rank() Rank { return Rank(s >> 3) }

// String renders a square in algebraic coordinates, e.g. "e4".
func (s Square) String() string {
	if s >= 64 {
		return "-"
	}
	return string([]byte{byte('a' + s.File()), byte('1' + s.Rank())})
}

// ParseSquare parses algebraic coordinates like "e4" into a Square. The bool is
// false on malformed input.
func ParseSquare(s string) (Square, bool) {
	if len(s) != 2 || s[0] < 'a' || s[0] > 'h' || s[1] < '1' || s[1] > '8' {
		return SqNone, false
	}
	return MakeSquare(File(s[0]-'a'), Rank(s[1]-'1')), true
}

// pieceToFEN maps a Piece to its FEN character.
var pieceToFEN = [12]byte{'P', 'N', 'B', 'R', 'Q', 'K', 'p', 'n', 'b', 'r', 'q', 'k'}

// fenToPiece maps a FEN character to a Piece, or NoPiece if unknown.
func fenToPiece(c byte) Piece {
	switch c {
	case 'P':
		return WhitePawn
	case 'N':
		return WhiteKnight
	case 'B':
		return WhiteBishop
	case 'R':
		return WhiteRook
	case 'Q':
		return WhiteQueen
	case 'K':
		return WhiteKing
	case 'p':
		return BlackPawn
	case 'n':
		return BlackKnight
	case 'b':
		return BlackBishop
	case 'r':
		return BlackRook
	case 'q':
		return BlackQueen
	case 'k':
		return BlackKing
	}
	return NoPiece
}
