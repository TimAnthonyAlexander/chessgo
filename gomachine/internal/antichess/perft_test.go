package antichess

import "testing"

// perft counts the leaf nodes at depth `depth` from state s — the standard
// movegen correctness oracle, adapted to Antichess's forced-capture legality.
func perft(s State, depth int) uint64 {
	if depth == 0 {
		return 1
	}
	moves := s.LegalMoves()
	if depth == 1 {
		return uint64(len(moves))
	}
	var nodes uint64
	for _, m := range moves {
		child := s.MakeMove(m)
		nodes += perft(child, depth-1)
	}
	return nodes
}

// Perft counts cross-checked against python-chess's AntichessBoard (Wave 1's
// validated oracle) — the definitive test that forced-capture, promotion
// (including king), and the standard start position are generated correctly.
func TestPerft(t *testing.T) {
	cases := []struct {
		name  string
		fen   string
		depth int
		want  uint64
	}{
		{"start d1", StartFEN, 1, 20},
		{"start d2", StartFEN, 2, 400},
		{"start d3", StartFEN, 3, 8067},
		{"pawn-promo d1", "4k3/P7/8/8/8/8/8/4K3 w - - 0 1", 1, 10},
		{"king-promo-capture d1", "1n2k3/P7/8/8/8/8/8/4K3 w - - 0 1", 1, 5},
	}
	for _, c := range cases {
		st, err := Parse(c.fen)
		if err != nil {
			t.Fatalf("%s: Parse(%q): %v", c.name, c.fen, err)
		}
		if got := perft(st, c.depth); got != c.want {
			t.Errorf("%s: perft(%d) = %d, want %d", c.name, c.depth, got, c.want)
		}
	}
}

// The forced en-passant position has exactly ONE legal move: the en-passant
// capture (every other pseudo-legal move, including all the king's, is
// excluded by the forced-capture rule since a capture exists).
func TestForcedEnPassant(t *testing.T) {
	st, err := Parse("4k3/8/8/8/pP6/8/8/4K3 b - b3 0 1")
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	moves := st.LegalMoves()
	if len(moves) != 1 {
		t.Fatalf("legal moves = %d, want 1 (forced en passant); got %v", len(moves), moves)
	}
	if !moves[0].EP || moves[0].UCI() != "a4b3" {
		t.Errorf("forced move = %+v (%s), want the en-passant capture a4b3", moves[0], moves[0].UCI())
	}
}

// A king may promote (Antichess-only), and doing so is generated whenever any
// other promotion choice is.
func TestKingPromotionGenerated(t *testing.T) {
	st, err := Parse("4k3/P7/8/8/8/8/8/4K3 w - - 0 1")
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	found := false
	for _, m := range st.LegalMoves() {
		if m.UCI() == "a7a8k" {
			found = true
		}
	}
	if !found {
		t.Error("a7a8k (king promotion) not found among legal moves")
	}
}

// Stalemate (or an empty army) on the side to move is a WIN, not a draw —
// Antichess's inverted terminal condition.
func TestStalemateIsAWin(t *testing.T) {
	// White has a single king in the corner, boxed in by its own... actually
	// build a position where White (to move) has literally no legal move: a
	// lone white king fully surrounded by black pawns it cannot capture (no
	// capture available so quiet moves would apply, so instead: no pieces at
	// all is the cleanest trigger).
	st, err := Parse("4k3/8/8/8/8/8/8/8 w - - 0 1")
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if len(st.LegalMoves()) != 0 {
		t.Fatalf("expected no legal moves for a side with no pieces, got %v", st.LegalMoves())
	}
	if got := st.Status(); got != WhiteWin {
		t.Errorf("Status() = %v, want WhiteWin (no pieces -> side to move wins)", got)
	}
}
