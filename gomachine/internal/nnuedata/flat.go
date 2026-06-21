// Package nnuedata is the codec for the engine's NNUE training data: a compact
// 32-byte flat record (board + side-to-move + clocks + a White-relative score
// and game result). It is the *only* on-disk format the Go side reads/writes —
// upstream binpack/.plain → .plain conversion is done by Stockfish's C++ tool;
// nnuedata never touches binpack or Huffman. See docs/NNUE/DATA_PIPELINE.md §7.
//
// Record layout (32 bytes, little-endian):
//
//	[ 0.. 7]  occupancy   u64  bit i set ⇔ a piece on LERF square i (a1=0)
//	[ 8..23]  nibbles     16B  one 4-bit Piece (0..11) per occupied square, in
//	                           ascending square order; low nibble of byte k is
//	                           the (2k)-th occupied piece, high nibble the (2k+1)-th
//	[24]      stm         u8   0=White to move, 1=Black
//	[25]      castling    u8   bit0 K, bit1 Q, bit2 k, bit3 q
//	[26]      epFile      u8   0..7 en-passant file, 255 = none
//	[27]      halfmove    u8   halfmove clock (saturated at 255)
//	[28..29]  score       i16  White-relative centipawns
//	[30]      result      u8   White-relative game result: 0=loss 1=draw 2=win
//	[31]      reserved    u8   always 0
package nnuedata

import (
	"errors"
	"strconv"
	"strings"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// RecordSize is the fixed on-disk size of one flat record.
const RecordSize = 32

// Castling bit positions inside the castling byte (KQkq).
const (
	castleWK = 1 << 0
	castleWQ = 1 << 1
	castleBK = 1 << 2
	castleBQ = 1 << 3
)

// epNone is the epFile sentinel meaning "no en-passant target".
const epNone = 255

// Record is the decoded form of a flat record. It is a plain value type; build
// one with Decode/DecodeFEN or by hand, and serialize via Encode'd bytes.
type Record struct {
	FEN        string // reconstructed FEN (fullmove always 1)
	WhiteScore int16  // White-relative centipawns
	Result     uint8  // White-relative result: 0=loss 1=draw 2=win
}

// Encode builds a 32-byte flat record from a FEN, a White-relative score, and a
// White-relative result (0/1/2). The FEN is validated via chess.ParseFEN; board
// occupancy/pieces come from the parsed Position, while castling/ep/halfmove are
// read straight from the FEN tokens (so the record matches the literal FEN).
func Encode(fen string, whiteScore int16, result uint8) ([RecordSize]byte, error) {
	var rec [RecordSize]byte
	if result > 2 {
		return rec, errors.New("nnuedata: result must be 0, 1 or 2")
	}
	pos, err := chess.ParseFEN(fen)
	if err != nil {
		return rec, err
	}
	fields := strings.Fields(fen)
	if len(fields) < 4 {
		return rec, errors.New("nnuedata: FEN must have at least 4 fields")
	}

	// Board: occupancy bitmap + nibble stream in ascending square order.
	var occ uint64
	nibbleIdx := 0
	for sq := chess.Square(0); sq < 64; sq++ {
		pc := pos.PieceOn(sq)
		if pc == chess.NoPiece {
			continue
		}
		occ |= uint64(1) << uint(sq)
		putNibble(rec[8:24], nibbleIdx, byte(pc))
		nibbleIdx++
	}
	putU64(rec[0:8], occ)

	// Side to move.
	if pos.SideToMove() == chess.Black {
		rec[24] = 1
	}

	// Castling (literal FEN field 2).
	rec[25] = parseCastling(fields[2])

	// En-passant file (literal FEN field 3).
	rec[26] = epNone
	if fields[3] != "-" {
		sq, ok := chess.ParseSquare(fields[3])
		if !ok {
			return rec, errors.New("nnuedata: invalid en-passant square: " + fields[3])
		}
		rec[26] = byte(sq.File())
	}

	// Halfmove clock (field 4, saturated to a byte).
	hm := 0
	if len(fields) >= 5 {
		if n, err := strconv.Atoi(fields[4]); err == nil && n > 0 {
			hm = n
		}
	}
	if hm > 255 {
		hm = 255
	}
	rec[27] = byte(hm)

	putI16(rec[28:30], whiteScore)
	rec[30] = result
	rec[31] = 0
	return rec, nil
}

// Decode reconstructs a FEN string and the stored score/result from a flat
// record. The reconstructed FEN round-trips through chess.ParseFEN to the same
// position Encode was given (fullmove is fixed to 1 — it is not stored).
func Decode(rec [RecordSize]byte) (fen string, whiteScore int16, result uint8, err error) {
	occ := getU64(rec[0:8])

	// Per-square Piece, indexed by LERF square. NoPiece elsewhere.
	var board [64]chess.Piece
	for i := range board {
		board[i] = chess.NoPiece
	}
	nibbleIdx := 0
	for sq := 0; sq < 64; sq++ {
		if occ&(uint64(1)<<uint(sq)) == 0 {
			continue
		}
		n := getNibble(rec[8:24], nibbleIdx)
		nibbleIdx++
		if n > 11 {
			return "", 0, 0, errors.New("nnuedata: invalid piece nibble in record")
		}
		board[sq] = chess.Piece(n)
	}

	stm := chess.White
	if rec[24] != 0 {
		stm = chess.Black
	}

	fen = buildFEN(board, stm, rec[25], rec[26], rec[27])
	whiteScore = getI16(rec[28:30])
	result = rec[30]
	if result > 2 {
		return "", 0, 0, errors.New("nnuedata: invalid result in record")
	}
	return fen, whiteScore, result, nil
}

// DecodeRecord is a convenience wrapper returning a Record value.
func DecodeRecord(rec [RecordSize]byte) (Record, error) {
	fen, score, result, err := Decode(rec)
	if err != nil {
		return Record{}, err
	}
	return Record{FEN: fen, WhiteScore: score, Result: result}, nil
}

// buildFEN renders ranks 8→1 from the per-square board, then stm/castling/ep/
// halfmove and a fixed fullmove of 1. The ep target square's rank is derived
// from the side to move: White-to-move ⇒ the captured pawn sits on rank 5 so the
// target is on rank 6 (index 5); Black-to-move ⇒ target on rank 3 (index 2).
func buildFEN(board [64]chess.Piece, stm chess.Color, castling, epFile, halfmove byte) string {
	var sb strings.Builder
	for rank := 7; rank >= 0; rank-- {
		empty := 0
		for file := 0; file < 8; file++ {
			pc := board[rank*8+file]
			if pc == chess.NoPiece {
				empty++
				continue
			}
			if empty > 0 {
				sb.WriteByte(byte('0' + empty))
				empty = 0
			}
			sb.WriteByte(pieceFENChar(pc))
		}
		if empty > 0 {
			sb.WriteByte(byte('0' + empty))
		}
		if rank > 0 {
			sb.WriteByte('/')
		}
	}

	sb.WriteByte(' ')
	if stm == chess.White {
		sb.WriteByte('w')
	} else {
		sb.WriteByte('b')
	}

	sb.WriteByte(' ')
	sb.WriteString(formatCastling(castling))

	sb.WriteByte(' ')
	if epFile == epNone {
		sb.WriteByte('-')
	} else {
		epRank := byte('6') // White to move
		if stm == chess.Black {
			epRank = '3'
		}
		sb.WriteByte('a' + epFile)
		sb.WriteByte(epRank)
	}

	sb.WriteByte(' ')
	sb.WriteString(strconv.Itoa(int(halfmove)))
	sb.WriteString(" 1") // fullmove not stored; fixed to 1
	return sb.String()
}

// --- small helpers ---

func parseCastling(field string) byte {
	if field == "-" {
		return 0
	}
	var c byte
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

func formatCastling(c byte) string {
	if c == 0 {
		return "-"
	}
	var sb strings.Builder
	if c&castleWK != 0 {
		sb.WriteByte('K')
	}
	if c&castleWQ != 0 {
		sb.WriteByte('Q')
	}
	if c&castleBK != 0 {
		sb.WriteByte('k')
	}
	if c&castleBQ != 0 {
		sb.WriteByte('q')
	}
	return sb.String()
}

// pieceFENChar maps a Piece (0..11) to its FEN character.
var pieceFENChars = [12]byte{'P', 'N', 'B', 'R', 'Q', 'K', 'p', 'n', 'b', 'r', 'q', 'k'}

func pieceFENChar(pc chess.Piece) byte { return pieceFENChars[pc] }

// putNibble writes a 4-bit value at logical nibble index i into a 16-byte slice
// (low nibble first within each byte).
func putNibble(buf []byte, i int, val byte) {
	b := i >> 1
	if i&1 == 0 {
		buf[b] = (buf[b] &^ 0x0f) | (val & 0x0f)
	} else {
		buf[b] = (buf[b] &^ 0xf0) | (val << 4)
	}
}

// getNibble reads the 4-bit value at logical nibble index i.
func getNibble(buf []byte, i int) byte {
	b := buf[i>>1]
	if i&1 == 0 {
		return b & 0x0f
	}
	return b >> 4
}

func putU64(buf []byte, v uint64) {
	for i := 0; i < 8; i++ {
		buf[i] = byte(v >> (8 * uint(i)))
	}
}

func getU64(buf []byte) uint64 {
	var v uint64
	for i := 0; i < 8; i++ {
		v |= uint64(buf[i]) << (8 * uint(i))
	}
	return v
}

func putI16(buf []byte, v int16) {
	u := uint16(v)
	buf[0] = byte(u)
	buf[1] = byte(u >> 8)
}

func getI16(buf []byte) int16 {
	return int16(uint16(buf[0]) | uint16(buf[1])<<8)
}
