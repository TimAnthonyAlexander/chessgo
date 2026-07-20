package hub

import (
	"testing"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// boardPieceCount must count only on-board pieces, ignoring empty-run digits,
// rank separators, the trailing FEN fields, and any Crazyhouse [pocket] — across
// every variant that shares the placement field.
func TestBoardPieceCount(t *testing.T) {
	cases := []struct {
		name string
		fen  string
		want int
	}{
		{"opening", chess.StartFEN, 32},
		{"bare kings", "8/8/8/4k3/8/8/4K3/8 w - - 0 1", 2},
		{"KPvK", "8/8/8/4k3/8/4P3/4K3/8 w - - 0 1", 3},
		{"rook endgame", "8/8/8/4k3/8/8/4KP2/6r1 w - - 0 1", 4},
		// A Crazyhouse pocket must NOT inflate the on-board count.
		{"crazyhouse pocket excluded", "4k3/8/8/8/8/8/8/4K3[PPnq] w - - 0 1", 2},
	}
	for _, c := range cases {
		if got := boardPieceCount(c.fen); got != c.want {
			t.Errorf("%s: boardPieceCount(%q) = %d, want %d", c.name, c.fen, got, c.want)
		}
	}
}

// materialSpeedFactor must be ~1.0 at a full board, clamp to 0.40 at/under the
// sparse floor, and stay monotonic in between — fewer pieces never plays slower.
func TestMaterialSpeedFactor(t *testing.T) {
	if f := materialSpeedFactor(32); f < 0.999 || f > 1.001 {
		t.Errorf("full board factor = %v, want ~1.0", f)
	}
	if f := materialSpeedFactor(8); f < 0.399 || f > 0.401 {
		t.Errorf("sparse floor factor = %v, want ~0.40", f)
	}
	if f := materialSpeedFactor(2); f != materialSpeedFactor(8) {
		t.Errorf("below the floor must clamp: %v != %v", f, materialSpeedFactor(8))
	}
	if materialSpeedFactor(40) != materialSpeedFactor(32) {
		t.Error("above a full board must clamp to 1.0")
	}
	prev := 0.0
	for pc := 8; pc <= 32; pc++ {
		f := materialSpeedFactor(pc)
		if f < prev {
			t.Errorf("factor decreased as material grew (pc=%d: %v < %v)", pc, f, prev)
		}
		prev = f
	}
}

// A sparse endgame must yield a shorter think than a full board at the same clock,
// time control, and rating — the "fewer pieces, faster moves" guarantee, verified
// end-to-end through botThinkDelay (opening speed-up excluded by using ply>opening).
func TestBotThinkDelayFasterWithLessMaterial(t *testing.T) {
	tc := timeControl{Base: 300_000, Inc: 0} // 5+0
	const remaining, legal, ply, rating = int64(300_000), 20, 40, 1800
	// Average over many samples to see past botThinkDelay's per-call jitter.
	var fullSum, sparseSum int64
	for i := 0; i < 2000; i++ {
		fullSum += botThinkDelay(tc, remaining, legal, ply, rating, 32, false).Milliseconds()
		sparseSum += botThinkDelay(tc, remaining, legal, ply, rating, 6, false).Milliseconds()
	}
	if sparseSum >= fullSum {
		t.Errorf("sparse endgame not faster: sparseSum=%d fullSum=%d", sparseSum, fullSum)
	}
}

// isObviousMove must flag forced replies and recaptures, and only those.
func TestIsObviousMove(t *testing.T) {
	cases := []struct {
		name       string
		moveUCI    string
		lastMoveTo string
		legalCount int
		want       bool
	}{
		{"forced", "a2a3", "", 1, true},
		{"recapture", "d1d4", "d4", 20, true},          // opponent moved to d4, we take on d4
		{"promotion recapture", "c7c8q", "c8", 20, true},
		{"free choice", "g1f3", "e5", 30, false},        // not landing on the last-touched square
		{"no last move", "e2e4", "", 30, false},
	}
	for _, c := range cases {
		if got := isObviousMove(c.moveUCI, c.lastMoveTo, c.legalCount); got != c.want {
			t.Errorf("%s: isObviousMove(%q,%q,%d) = %v, want %v",
				c.name, c.moveUCI, c.lastMoveTo, c.legalCount, got, c.want)
		}
	}
}

// An obvious move must, on average, be snapped out much faster than a free choice
// in the same position — and humanTempoJitter must actually spread times out.
func TestBotThinkDelayObviousAndJitter(t *testing.T) {
	tc := timeControl{Base: 300_000, Inc: 0} // 5+0
	const remaining, legal, ply, rating, pieces = int64(300_000), 25, 40, 1600, 24

	var obviousSum, freeSum int64
	seen := map[int64]bool{}
	for i := 0; i < 4000; i++ {
		obviousSum += botThinkDelay(tc, remaining, legal, ply, rating, pieces, true).Milliseconds()
		d := botThinkDelay(tc, remaining, legal, ply, rating, pieces, false).Milliseconds()
		freeSum += d
		seen[d] = true
	}
	if obviousSum >= freeSum {
		t.Errorf("obvious moves not faster: obviousSum=%d freeSum=%d", obviousSum, freeSum)
	}
	// Fat-tailed jitter ⇒ many distinct think times, not a near-constant value.
	if len(seen) < 100 {
		t.Errorf("think time too constant: only %d distinct values over 4000 samples", len(seen))
	}
}
