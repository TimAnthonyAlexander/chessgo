package hub

import (
	"testing"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// A midgame-seeded filler must show plausibly-spent clocks (never the pristine
// full base time), while an opening seed keeps full clocks.
func TestFillerStartClocks(t *testing.T) {
	tc := timeControl{Base: 300_000, Inc: 0} // 5+0

	opening, _ := chess.ParseFEN(chess.StartFEN)
	if c := fillerStartClocks(tc, opening); c != [2]int64{tc.Base, tc.Base} {
		t.Fatalf("opening seed should keep full clocks, got %v", c)
	}

	// A believable midgame (both sides ~15 moves deep, White to move).
	mid, err := chess.ParseFEN("r1bq1rk1/pp2bppp/2n2n2/2pp4/3P4/2NBPN2/PP3PPP/R1BQ1RK1 w - - 0 8")
	if err != nil {
		t.Fatalf("parse midgame fen: %v", err)
	}

	floor := tc.Base * 12 / 100
	ceil := tc.Base * 90 / 100
	// Sample repeatedly — the per-side jitter is random, so assert the bounds
	// hold every time and that the two clocks aren't rigidly identical.
	sawDiffer := false
	for i := 0; i < 200; i++ {
		c := fillerStartClocks(tc, mid)
		for _, ms := range c {
			if ms < floor || ms > ceil {
				t.Fatalf("midgame clock %d out of [%d,%d]", ms, floor, ceil)
			}
			if ms == tc.Base {
				t.Fatalf("midgame clock should never be the full base time")
			}
		}
		if c[0] != c[1] {
			sawDiffer = true
		}
	}
	if !sawDiffer {
		t.Fatal("expected the two sides' clocks to differ at least sometimes")
	}
}
