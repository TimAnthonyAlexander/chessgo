package chess

import "testing"

type perftCase struct {
	name  string
	fen   string
	nodes []uint64 // index i = perft(i+1)
}

// Verified node counts from the Chess Programming Wiki (SPEC §5.5).
var perftCases = []perftCase{
	{"startpos", StartFEN,
		[]uint64{20, 400, 8902, 197281, 4865609}},
	{"kiwipete", "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1",
		[]uint64{48, 2039, 97862, 4085603}},
	{"position3", "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1",
		[]uint64{14, 191, 2812, 43238, 674624}},
	{"position4", "r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1",
		[]uint64{6, 264, 9467, 422333}},
	{"position5", "rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8",
		[]uint64{44, 1486, 62379, 2103487}},
	{"position6", "r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10",
		[]uint64{46, 2079, 89890, 3894594}},
}

func TestPerft(t *testing.T) {
	for _, tc := range perftCases {
		pos, err := ParseFEN(tc.fen)
		if err != nil {
			t.Fatalf("%s: ParseFEN: %v", tc.name, err)
		}
		for i, want := range tc.nodes {
			depth := i + 1
			if got := Perft(pos, depth); got != want {
				t.Errorf("%s perft(%d) = %d, want %d", tc.name, depth, got, want)
			}
		}
	}
}

// TestFENRoundTrip checks that parse->serialize is stable.
func TestFENRoundTrip(t *testing.T) {
	for _, tc := range perftCases {
		pos, err := ParseFEN(tc.fen)
		if err != nil {
			t.Fatalf("%s: %v", tc.name, err)
		}
		if got := pos.FEN(); got != tc.fen {
			t.Errorf("%s FEN round-trip = %q, want %q", tc.name, got, tc.fen)
		}
	}
}

// TestZobristConsistency verifies incremental key updates match a from-scratch
// recompute after every legal move in several positions.
func TestZobristConsistency(t *testing.T) {
	for _, tc := range perftCases {
		pos, err := ParseFEN(tc.fen)
		if err != nil {
			t.Fatalf("%s: %v", tc.name, err)
		}
		var ml MoveList
		pos.GenerateLegal(&ml)
		for i := 0; i < ml.Len(); i++ {
			m := ml.Get(i)
			var u Undo
			pos.DoMove(m, &u)
			if pos.key != pos.computeKey() {
				t.Errorf("%s: key mismatch after %s: incr=%x scratch=%x",
					tc.name, m, pos.key, pos.computeKey())
			}
			pos.UndoMove(m, &u)
			if pos.key != u.key {
				t.Errorf("%s: key not restored after undo of %s", tc.name, m)
			}
		}
	}
}
