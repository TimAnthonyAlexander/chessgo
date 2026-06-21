package eval

import (
	"testing"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// TestScaleFactor checks the endgame scale factor against known material configs.
// The safety-critical property is the second half: a genuine material win must
// NOT be scaled toward a draw (sf stays 64). The first half checks the drawish
// configs scale down as intended.
func TestScaleFactor(t *testing.T) {
	cases := []struct {
		name string
		fen  string
		eg   int // White's-perspective eg sign (picks the strong side)
		want int
	}{
		// --- drawish: must scale down ---
		{"KBvK lone bishop", "8/8/8/4k3/8/8/4K3/5B2 w - - 0 1", +300, 0},
		{"KNvK lone knight", "8/8/8/4k3/8/8/4K3/5N2 w - - 0 1", +300, 0},
		{"bare kings", "8/8/8/4k3/8/8/4K3/8 w - - 0 1", 0, 0},
		{"KRvKB fortress", "8/8/8/4k3/5b2/8/4K3/5R2 w - - 0 1", +200, 4},
		{"KRvKN fortress", "8/8/8/4k3/5n2/8/4K3/5R2 w - - 0 1", +200, 4},
		{"KRBvKR", "8/8/8/4k3/5r2/8/4K3/4RB2 w - - 0 1", +300, 14},

		// --- genuine wins: must NOT scale to a draw (sf stays high) ---
		{"KRvK rook up", "8/8/8/4k3/8/8/4K3/5R2 w - - 0 1", +500, scaleNormal},
		{"KQvKR queen vs rook", "8/8/8/4k3/5r2/8/4K3/5Q2 w - - 0 1", +400, 37},
	}
	for _, c := range cases {
		pos, err := chess.ParseFEN(c.fen)
		if err != nil {
			t.Fatalf("%s: bad fen: %v", c.name, err)
		}
		got := scaleFactor(pos, c.eg)
		if got != c.want {
			t.Errorf("%s: scaleFactor = %d, want %d", c.name, got, c.want)
		}
	}
}

// TestScaleFactorOppositeBishops checks the pure-OCB branch (18 + 4*passers).
func TestScaleFactorOppositeBishops(t *testing.T) {
	// White light-squared bishop vs black dark-squared bishop, each with one pawn.
	// Both pawns are passed (no opposing pawn ahead), so passers(strong=White)=1 →
	// sf = 18 + 4 = 22.
	pos, err := chess.ParseFEN("8/8/3k4/2b5/2P5/8/4K3/5B2 w - - 0 1")
	if err != nil {
		t.Fatalf("bad fen: %v", err)
	}
	if !oppositeBishops(pos) {
		t.Fatalf("expected opposite bishops")
	}
	got := scaleFactor(pos, +120)
	if got != 22 {
		t.Errorf("pure OCB scaleFactor = %d, want 22", got)
	}
}

// TestScaleFactorInertFullBoard verifies the factor is a no-op (64) at the start
// position — scaling must never touch the middlegame.
func TestScaleFactorInertFullBoard(t *testing.T) {
	pos, err := chess.ParseFEN("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1")
	if err != nil {
		t.Fatalf("bad fen: %v", err)
	}
	if got := scaleFactor(pos, 0); got != scaleNormal {
		t.Errorf("startpos scaleFactor = %d, want %d", got, scaleNormal)
	}
}
