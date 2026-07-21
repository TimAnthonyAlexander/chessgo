package antichess

import "testing"

func mustParse(t *testing.T, fen string) State {
	t.Helper()
	st, err := Parse(fen)
	if err != nil {
		t.Fatalf("Parse(%q): %v", fen, err)
	}
	return st
}

// From the opening the fallback search returns a legal move and does not crash.
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
		}
	}
	if !legal {
		t.Errorf("opening move %s is not legal", res.Move)
	}
}

// A single legal move (forced capture) is returned without searching.
func TestBestMoveForcedSingleMove(t *testing.T) {
	st := mustParse(t, "4k3/8/8/8/pP6/8/8/4K3 b - b3 0 1")
	res := BestMove(st, Limits{Depth: 3, Level: -1})
	if !res.HasMove || res.Move != "a4b3" {
		t.Errorf("BestMove = %+v, want the forced en-passant a4b3", res)
	}
}

// A fixed-depth search is deterministic.
func TestSearchIsDeterministic(t *testing.T) {
	fen := "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3"
	a := BestMove(mustParse(t, fen), Limits{Depth: 3, Level: -1})
	b := BestMove(mustParse(t, fen), Limits{Depth: 3, Level: -1})
	if a.Move != b.Move || a.Score != b.Score {
		t.Errorf("nondeterministic: %s/%d vs %s/%d", a.Move, a.Score, b.Move, b.Score)
	}
}

// The search must never panic and must always choose a move the rules engine
// itself accepts as legal, even in a position dominated by a forced capture
// with five promotion choices (the king-promotion-capture perft position).
func TestSearchChoosesALegalMove(t *testing.T) {
	st := mustParse(t, "1n2k3/P7/8/8/8/8/8/4K3 w - - 0 1")
	res := BestMove(st, Limits{Depth: 4, Level: -1})
	if !res.HasMove {
		t.Fatal("expected a move")
	}
	if _, _, ok := st.Apply(res.Move); !ok {
		t.Fatalf("search chose an illegal move %q", res.Move)
	}
}
