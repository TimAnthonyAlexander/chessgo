package uci

import (
	"strings"
	"testing"
)

// TestGoIllegalPositionNoPanic drives the UCI loop with illegal input positions
// (the side not to move is already in check: the enemy king sits on an open
// file/rank in front of the queen). Before the Legal() guard in handleGo, the
// search generated a king-capturing move and InCheck() indexed the attack
// tables at square 64, panicking with "index out of range [64] with length 64".
// The loop must instead reject the position and emit a null bestmove.
func TestGoIllegalPositionNoPanic(t *testing.T) {
	illegalFENs := []string{
		"4k3/8/8/8/8/8/4Q3/4K3 w - - 0 1", // BK e8 in check from WQ e2 (open e-file)
		"6k1/8/8/8/8/8/6Q1/6K1 w - - 0 1", // BK g8 in check from WQ g2 (open g-file)
	}
	for _, fen := range illegalFENs {
		in := strings.NewReader("uci\nposition fen " + fen + "\ngo depth 8\nquit\n")
		var out strings.Builder
		runIO(in, &out) // must not panic
		got := out.String()
		if !strings.Contains(got, "bestmove 0000") {
			t.Errorf("illegal FEN %q: expected a null bestmove, got:\n%s", fen, got)
		}
	}
}

// TestGoLegalSparseEndgame confirms a legal, sparse KQvK position still searches
// normally and returns a real move (regression guard so the Legal() rejection
// does not over-reach onto legal endgames).
func TestGoLegalSparseEndgame(t *testing.T) {
	in := strings.NewReader("uci\nposition fen 8/8/8/3k4/8/3K4/3Q4/8 w - - 0 1\ngo depth 8\nquit\n")
	var out strings.Builder
	runIO(in, &out)
	got := out.String()
	if !strings.Contains(got, "bestmove ") {
		t.Fatalf("legal KQvK: expected a bestmove line, got:\n%s", got)
	}
	if strings.Contains(got, "bestmove 0000") {
		t.Errorf("legal KQvK: got null bestmove, expected a real move:\n%s", got)
	}
}
