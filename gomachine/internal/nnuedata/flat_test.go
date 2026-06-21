package nnuedata

import (
	"bytes"
	"io"
	"testing"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// roundTripCase is one FEN exercised by the encode→decode→parse gate.
type roundTripCase struct {
	name  string
	fen   string
	score int16
	res   uint8
}

var roundTripCases = []roundTripCase{
	{"startpos", "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", 12, 1},
	{"kiwipete", "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1", -45, 2},
	{"ep-white", "rnbqkbnr/pp1ppppp/8/2pP4/8/8/PPP1PPPP/RNBQKBNR w KQkq c6 0 3", 30, 0},
	{"ep-black", "rnbqkbnr/ppp1pppp/8/8/3pP3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 2", -22, 1},
	{"partial-castling", "r3k2r/8/8/8/8/8/8/R3K2R w Kq - 5 12", 0, 1},
	{"no-castling-endgame", "8/8/4k3/8/8/4K3/4P3/8 w - - 7 40", 220, 2},
	{"black-to-move", "8/8/8/3k4/8/3K4/8/7q b - - 3 60", -900, 0},
}

// TestRoundTrip is the definition of done: every FEN must survive
// Encode → Decode → ParseFEN with an identical position (perft@3 equal, plus
// board/stm/castling/ep exact), and the stored score/result must be preserved.
func TestRoundTrip(t *testing.T) {
	for _, tc := range roundTripCases {
		t.Run(tc.name, func(t *testing.T) {
			orig, err := chess.ParseFEN(tc.fen)
			if err != nil {
				t.Fatalf("ParseFEN(orig) %q: %v", tc.fen, err)
			}

			rec, err := Encode(tc.fen, tc.score, tc.res)
			if err != nil {
				t.Fatalf("Encode: %v", err)
			}
			fen, score, res, err := Decode(rec)
			if err != nil {
				t.Fatalf("Decode: %v", err)
			}

			if score != tc.score {
				t.Errorf("score: got %d want %d", score, tc.score)
			}
			if res != tc.res {
				t.Errorf("result: got %d want %d", res, tc.res)
			}

			rebuilt, err := chess.ParseFEN(fen)
			if err != nil {
				t.Fatalf("ParseFEN(rebuilt) %q: %v", fen, err)
			}

			// Board placement + stm must match exactly.
			for sq := chess.Square(0); sq < 64; sq++ {
				if orig.PieceOn(sq) != rebuilt.PieceOn(sq) {
					t.Errorf("piece on %s: orig %d rebuilt %d", sq, orig.PieceOn(sq), rebuilt.PieceOn(sq))
				}
			}
			if orig.SideToMove() != rebuilt.SideToMove() {
				t.Errorf("stm: orig %d rebuilt %d", orig.SideToMove(), rebuilt.SideToMove())
			}
			if orig.HasCastlingRights() != rebuilt.HasCastlingRights() {
				t.Errorf("castling-rights mismatch")
			}
			if orig.EnPassantSquare() != rebuilt.EnPassantSquare() {
				t.Errorf("ep: orig %s rebuilt %s", orig.EnPassantSquare(), rebuilt.EnPassantSquare())
			}

			// Perft@3 equal on both positions ⇒ legally-identical positions
			// (castling rights + ep affect generated moves, so this is strong).
			po := chess.Perft(orig, 3)
			pr := chess.Perft(rebuilt, 3)
			if po != pr {
				t.Errorf("perft@3 mismatch: orig %d rebuilt %d", po, pr)
			}
			t.Logf("ok: %s perft@3=%d score=%d result=%d → %q", tc.name, pr, score, res, fen)
		})
	}
}

// TestStreamRoundTrip writes several records and reads them back in order,
// checking the reader terminates cleanly on a record boundary.
func TestStreamRoundTrip(t *testing.T) {
	var buf bytes.Buffer
	for _, tc := range roundTripCases {
		rec, err := Encode(tc.fen, tc.score, tc.res)
		if err != nil {
			t.Fatalf("Encode %s: %v", tc.name, err)
		}
		if err := WriteRecord(&buf, rec); err != nil {
			t.Fatalf("WriteRecord: %v", err)
		}
	}

	rd := NewReader(&buf)
	for i := 0; ; i++ {
		rec, err := rd.Next()
		if err == io.EOF {
			if i != len(roundTripCases) {
				t.Fatalf("read %d records, want %d", i, len(roundTripCases))
			}
			break
		}
		if err != nil {
			t.Fatalf("Next: %v", err)
		}
		_, score, res, derr := Decode(rec)
		if derr != nil {
			t.Fatalf("Decode: %v", derr)
		}
		if score != roundTripCases[i].score || res != roundTripCases[i].res {
			t.Errorf("record %d: got score=%d res=%d", i, score, res)
		}
	}
}

// TestTruncatedRecord ensures a partial trailing record is reported, not
// silently swallowed.
func TestTruncatedRecord(t *testing.T) {
	rec, _ := Encode(roundTripCases[0].fen, 0, 1)
	rd := NewReader(bytes.NewReader(rec[:RecordSize-1]))
	if _, err := rd.Next(); err == nil || err == io.EOF {
		t.Fatalf("expected truncation error, got %v", err)
	}
}
