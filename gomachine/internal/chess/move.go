package chess

// Move is a packed move. Low 16 bits hold from/to/type/promo; the wider uint32
// leaves room to cache piece context for ordering later (SPEC §4.3).
//
//	bits  0-5   from square
//	bits  6-11  to square
//	bits 12-13  move type (Normal/Promotion/EnPassant/Castling)
//	bits 14-15  promotion piece code (0=N,1=B,2=R,3=Q), only for Promotion
type Move uint32

// NullMove is a sentinel "no move".
const NullMove Move = 0

// MoveType classifies special moves.
type MoveType uint8

const (
	Normal MoveType = iota
	Promotion
	EnPassant
	Castling
)

// promoCode maps a promotion piece type to its 2-bit code.
func promoCode(pt PieceType) uint32 { return uint32(pt - Knight) }

// NewMove builds a move. promo is only meaningful when mt == Promotion.
func NewMove(from, to Square, mt MoveType, promo PieceType) Move {
	return Move(uint32(from) | uint32(to)<<6 | uint32(mt)<<12 | promoCode(promo)<<14)
}

// From returns the origin square.
func (m Move) From() Square { return Square(m & 0x3F) }

// To returns the destination square.
func (m Move) To() Square { return Square((m >> 6) & 0x3F) }

// Type returns the move type.
func (m Move) Type() MoveType { return MoveType((m >> 12) & 0x3) }

// Promo returns the promotion piece type (valid only when Type()==Promotion).
func (m Move) Promo() PieceType { return PieceType((m>>14)&0x3) + Knight }

// String renders the move in UCI long algebraic notation (e2e4, e7e8q, e1g1).
func (m Move) String() string {
	if m == NullMove {
		return "0000"
	}
	s := m.From().String() + m.To().String()
	if m.Type() == Promotion {
		s += string([]byte{"nbrq"[(m>>14)&0x3]})
	}
	return s
}

// MoveList is a fixed-capacity move buffer (max 218 legal moves; 256 rounds up).
type MoveList struct {
	moves [256]Move
	count int
}

func (ml *MoveList) add(m Move) {
	ml.moves[ml.count] = m
	ml.count++
}

// Len returns the number of moves in the list.
func (ml *MoveList) Len() int { return ml.count }

// Get returns the i-th move.
func (ml *MoveList) Get(i int) Move { return ml.moves[i] }

// Swap exchanges the moves at i and j (used by move-ordering selection sort).
func (ml *MoveList) Swap(i, j int) { ml.moves[i], ml.moves[j] = ml.moves[j], ml.moves[i] }
