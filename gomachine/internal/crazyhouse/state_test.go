package crazyhouse

import (
	"testing"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// Parse -> FEN must round-trip for the start position, pockets, and promoted marks.
func TestFENRoundTrip(t *testing.T) {
	cases := []string{
		StartFEN,
		"rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR[Pp] w KQkq - 0 1",
		"Q~7/8/8/8/8/8/8/k6K[Pp] w - - 0 1",
		"r1bqk2r/pppp1ppp/2n2n2/1B2p3/1b2P3/2N2N2/PPPP1PPP/R1BQK2R[Nn] w KQkq - 6 5",
	}
	for _, fen := range cases {
		st, err := Parse(fen)
		if err != nil {
			t.Fatalf("Parse(%q): %v", fen, err)
		}
		if got := st.FEN(); got != fen {
			t.Errorf("round-trip:\n  in  %q\n  out %q", fen, got)
		}
	}
}

// Pockets are tallied per colour and piece type.
func TestParsePocketCounts(t *testing.T) {
	st, err := Parse("k6K/8/8/8/8/8/8/8[PPPNq] w - - 0 1")
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if n := st.Pocket(chess.White, chess.Pawn); n != 3 {
		t.Errorf("white pawns = %d, want 3", n)
	}
	if n := st.Pocket(chess.White, chess.Knight); n != 1 {
		t.Errorf("white knights = %d, want 1", n)
	}
	if n := st.Pocket(chess.Black, chess.Queen); n != 1 {
		t.Errorf("black queens = %d, want 1", n)
	}
	if n := st.Pocket(chess.White, chess.Queen); n != 0 {
		t.Errorf("white queens = %d, want 0", n)
	}
}

func TestParseRejectsBadFEN(t *testing.T) {
	for _, fen := range []string{
		"not a fen",
		"rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR[Pp w KQkq - 0 1",   // unterminated pocket
		"rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR[PpX] w KQkq - 0 1", // bad pocket char
	} {
		if _, err := Parse(fen); err == nil {
			t.Errorf("Parse(%q) should have errored", fen)
		}
	}
}

// Move UCI round-trips for piece moves, promotions and drops.
func TestMoveUCI(t *testing.T) {
	cases := []struct {
		uci  string
		drop bool
	}{
		{"e2e4", false},
		{"e7e8q", false},
		{"N@f3", true},
		{"Q@d5", true},
	}
	for _, c := range cases {
		m, ok := parseUCI(c.uci)
		if !ok {
			t.Fatalf("parseUCI(%q) failed", c.uci)
		}
		if m.IsDrop != c.drop {
			t.Errorf("%q: IsDrop = %v, want %v", c.uci, m.IsDrop, c.drop)
		}
		if got := m.UCI(); got != c.uci {
			t.Errorf("UCI round-trip: %q -> %q", c.uci, got)
		}
	}
	for _, bad := range []string{"", "z9z9", "K@e4", "e2", "P@z9"} {
		if _, ok := parseUCI(bad); ok {
			t.Errorf("parseUCI(%q) should have failed", bad)
		}
	}
}
