package crazyhouse

import "testing"

func bestMove(t *testing.T, fen string, depth int) Result {
	t.Helper()
	st := mustParse(t, fen)
	return BestMove(st, Limits{Depth: depth, Level: -1})
}

// The bot must find a mate-in-1 delivered by a DROP.
func TestFindsDropMate(t *testing.T) {
	fen := "6k1/5ppp/8/8/8/8/8/4K3[R] w - - 0 1"
	res := bestMove(t, fen, 3)
	if !res.HasMove {
		t.Fatal("no move returned")
	}
	if res.Mate != 1 {
		t.Errorf("Mate = %d, want 1 (score %d, move %s)", res.Mate, res.Score, res.Move)
	}
	next := mustApply(t, mustParse(t, fen), res.Move)
	if next.Status() != WhiteWin {
		t.Errorf("chosen move %s did not mate (status %v)", res.Move, next.Status())
	}
}

// The bot must find a mate-in-1 delivered by a normal PIECE move.
func TestFindsPieceMate(t *testing.T) {
	fen := "6k1/5ppp/8/8/8/8/8/R3K3[] w - - 0 1"
	res := bestMove(t, fen, 3)
	if res.Mate != 1 {
		t.Fatalf("Mate = %d, want 1 (move %s, score %d)", res.Mate, res.Move, res.Score)
	}
	next := mustApply(t, mustParse(t, fen), res.Move)
	if next.Status() != WhiteWin {
		t.Errorf("chosen move %s did not mate (status %v)", res.Move, next.Status())
	}
}

// The bot must grab a hanging queen.
func TestGrabsHangingQueen(t *testing.T) {
	res := bestMove(t, "4k3/8/8/8/3q4/8/8/3RK3[] w - - 0 1", 3)
	if res.Move != "d1d4" {
		t.Errorf("move = %s, want d1d4 (capture the hanging queen)", res.Move)
	}
}

// From the opening the bot returns a legal move and does not crash.
func TestOpeningReturnsLegalMove(t *testing.T) {
	st := mustParse(t, StartFEN)
	res := BestMove(st, Limits{Depth: 3, Level: -1})
	if !res.HasMove {
		t.Fatal("no move from the opening")
	}
	legal := false
	for _, m := range st.LegalMoves() {
		if m.UCI() == res.Move {
			legal = true
			break
		}
	}
	if !legal {
		t.Errorf("opening move %s is not legal", res.Move)
	}
}

// A fixed-depth search is deterministic.
func TestSearchIsDeterministic(t *testing.T) {
	fen := "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R[] w KQkq - 2 3"
	a := bestMove(t, fen, 4)
	b := bestMove(t, fen, 4)
	if a.Move != b.Move || a.Score != b.Score {
		t.Errorf("nondeterministic: %s/%d vs %s/%d", a.Move, a.Score, b.Move, b.Score)
	}
}
