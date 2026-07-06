// Package crazyhouse implements the Crazyhouse variant on top of the standard
// chess core.
//
// Crazyhouse rules:
//   - Normal chess, but a captured piece flips colour and goes into the
//     capturing side's POCKET. On your turn you may either move a piece OR DROP a
//     pocketed piece onto any empty square (notation "P@e4").
//   - Pawns may not be dropped on the 1st or 8th rank. A drop may give check or
//     even mate, and may interpose to block a check (it can never self-check,
//     since a drop only adds a blocker).
//   - Standard king rules apply: check, checkmate and stalemate are as in chess,
//     except a "mate" is only real if no legal DROP also escapes it.
//   - A captured PROMOTED piece reverts to a pawn in the pocket, so promoted
//     squares are tracked (serialized as "Q~" in the FEN).
//
// The package embeds a chess.Position for the board and reuses the core's legal
// move generation, check/pin detection and make/unmake — it only adds pockets,
// promotion tracking and drops. Every operation is immutable (value copy), which
// matches the internal/variant State contract.
package crazyhouse

import (
	"errors"
	"strings"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// StartFEN is the Crazyhouse starting position (standard start, empty pockets).
const StartFEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR[] w KQkq - 0 1"

// State is a complete Crazyhouse position: the board and standard state (an
// embedded chess.Position), each side's pocket, the set of squares holding
// promoted pieces, and the prior-position keys for threefold detection. It is a
// value type; every mutating operation returns a NEW State.
type State struct {
	pos      chess.Position
	pockets  [2][5]int      // [color][PieceType] counts; Pawn..Queen (King is never pocketed)
	promoted chess.Bitboard // squares whose piece is a promoted pawn (reverts on capture)
	history  []uint64       // prior-position composite keys (see key); for threefold
}

// pocketOrder lists the pocketable piece types in the (descending-value) order
// used to serialize a FEN pocket. Parsing is order-agnostic.
var pocketOrder = [5]chess.PieceType{chess.Queen, chess.Rook, chess.Bishop, chess.Knight, chess.Pawn}

// typeLetter maps a piece type to its lowercase FEN letter (indexed by PieceType).
var typeLetter = [6]byte{'p', 'n', 'b', 'r', 'q', 'k'}

// Side returns the side to move.
func (s *State) Side() chess.Color { return s.pos.SideToMove() }

// Pocket returns how many pieces of type pt color c holds in its pocket.
func (s *State) Pocket(c chess.Color, pt chess.PieceType) int { return s.pockets[c][pt] }

// Parse builds a State from a Crazyhouse FEN: a standard FEN whose piece-placement
// field carries a "[pocket]" suffix and may mark promoted pieces with "~".
func Parse(fen string) (State, error) {
	placement, rest, ok := strings.Cut(fen, " ")
	if !ok {
		return State{}, errors.New("crazyhouse fen: missing fields")
	}

	// Split the pocket off the placement field: "<board>[<pocket>]".
	pocketStr := ""
	if i := strings.IndexByte(placement, '['); i >= 0 {
		if placement[len(placement)-1] != ']' {
			return State{}, errors.New("crazyhouse fen: malformed pocket")
		}
		pocketStr = placement[i+1 : len(placement)-1]
		placement = placement[:i]
	}

	// Strip promotion marks, remembering which squares carried them.
	board, promoSquares, err := stripPromoMarks(placement)
	if err != nil {
		return State{}, err
	}

	pos, err := chess.ParseFEN(board + " " + rest)
	if err != nil {
		return State{}, errors.New("crazyhouse fen: " + err.Error())
	}

	var st State
	st.pos = *pos
	if err := parsePocket(pocketStr, &st.pockets); err != nil {
		return State{}, err
	}
	for _, sq := range promoSquares {
		st.promoted |= sq.BB()
	}
	return st, nil
}

// stripPromoMarks removes "~" promotion marks from a board placement field,
// returning the cleaned field and the squares that were marked.
func stripPromoMarks(board string) (string, []chess.Square, error) {
	var sb strings.Builder
	var promo []chess.Square
	file, rank := 0, 7
	lastSq := chess.SqNone
	for i := 0; i < len(board); i++ {
		c := board[i]
		switch {
		case c == '/':
			sb.WriteByte(c)
			file, rank = 0, rank-1
		case c >= '1' && c <= '8':
			sb.WriteByte(c)
			file += int(c - '0')
		case c == '~':
			if lastSq == chess.SqNone {
				return "", nil, errors.New("crazyhouse fen: stray ~")
			}
			promo = append(promo, lastSq)
		default: // a piece letter
			lastSq = chess.MakeSquare(chess.File(file), chess.Rank(rank))
			sb.WriteByte(c)
			file++
		}
	}
	return sb.String(), promo, nil
}

// parsePocket tallies a FEN pocket string ("PPq" = white two pawns, black queen).
func parsePocket(s string, pockets *[2][5]int) error {
	for i := 0; i < len(s); i++ {
		c := s[i]
		color := chess.White
		if c >= 'a' && c <= 'z' {
			color = chess.Black
			c -= 'a' - 'A'
		}
		pt, ok := pocketTypeFromLetter(c)
		if !ok {
			return errors.New("crazyhouse fen: bad pocket char")
		}
		pockets[color][pt]++
	}
	return nil
}

// pocketTypeFromLetter maps an uppercase FEN letter to a pocketable piece type.
func pocketTypeFromLetter(c byte) (chess.PieceType, bool) {
	switch c {
	case 'P':
		return chess.Pawn, true
	case 'N':
		return chess.Knight, true
	case 'B':
		return chess.Bishop, true
	case 'R':
		return chess.Rook, true
	case 'Q':
		return chess.Queen, true
	}
	return chess.NoPieceType, false
}

// FEN serializes the position to a Crazyhouse FEN (board with "~" marks + a
// "[pocket]" suffix, then the standard side/castling/ep/clock fields).
func (s *State) FEN() string {
	var sb strings.Builder
	for rank := 7; rank >= 0; rank-- {
		empty := 0
		for file := 0; file < 8; file++ {
			sq := chess.MakeSquare(chess.File(file), chess.Rank(rank))
			p := s.pos.PieceOn(sq)
			if p == chess.NoPiece {
				empty++
				continue
			}
			if empty > 0 {
				sb.WriteByte(byte('0' + empty))
				empty = 0
			}
			sb.WriteByte(pieceLetter(p))
			if s.promoted&sq.BB() != 0 {
				sb.WriteByte('~')
			}
		}
		if empty > 0 {
			sb.WriteByte(byte('0' + empty))
		}
		if rank > 0 {
			sb.WriteByte('/')
		}
	}
	sb.WriteByte('[')
	sb.WriteString(s.pocketString())
	sb.WriteByte(']')

	// Reuse the core's FEN for the side/castling/ep/halfmove/fullmove fields.
	parts := strings.Fields(s.pos.FEN())
	sb.WriteByte(' ')
	sb.WriteString(strings.Join(parts[1:], " "))
	return sb.String()
}

// pocketString renders both pockets: white's pieces (uppercase) then black's
// (lowercase), each in descending-value order.
func (s *State) pocketString() string {
	var sb strings.Builder
	for _, c := range [2]chess.Color{chess.White, chess.Black} {
		for _, pt := range pocketOrder {
			ch := typeLetter[pt]
			if c == chess.White {
				ch -= 'a' - 'A'
			}
			for n := 0; n < s.pockets[c][pt]; n++ {
				sb.WriteByte(ch)
			}
		}
	}
	return sb.String()
}

// pieceLetter is a board piece's FEN letter (uppercase for White).
func pieceLetter(p chess.Piece) byte {
	ch := typeLetter[p.Type()]
	if p.Color() == chess.White {
		ch -= 'a' - 'A'
	}
	return ch
}
