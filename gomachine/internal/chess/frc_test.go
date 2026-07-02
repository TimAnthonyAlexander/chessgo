package chess

import "testing"

// Authoritative Chess960 (Fischer Random) perft positions from Andrew Grant's
// Ethereal FRC suite (Chess Programming Wiki, "Chess960 Perft Results"). The
// castling fields are Shredder-FEN (file letters). These exercise the generalized
// castling generator against real 960 layouts.
var frcPerftCases = []perftCase{
	{"frc1", "bqnb1rkr/pp3ppp/3ppn2/2p5/5P2/P2P4/NPP1P1PP/BQ1BNRKR w HFhf - 2 9",
		[]uint64{21, 528, 12189, 326672, 8146062}},
	{"frc2", "2nnrbkr/p1qppppp/8/1ppb4/6PP/3PP3/PPP2P2/BQNNRBKR w HEhe - 1 9",
		[]uint64{21, 807, 18002, 667366, 16253601}},
	{"frc3", "b1q1rrkb/pppppppp/3nn3/8/P7/1PPP4/4PPPP/BQNNRKRB w GE - 1 9",
		[]uint64{20, 479, 10471, 273318, 6417013}},
	{"frc4", "qbbnnrkr/2pp2pp/p7/1p2pp2/8/P3PP2/1PPP1KPP/QBBNNR1R w hf - 0 9",
		[]uint64{22, 593, 13440, 382958, 9183776}},
	{"frc5", "qnbnr1kr/ppp1b1pp/4p3/3p1p2/8/2NPP3/PPP1BPPP/QNB1R1KR w HEhe - 1 9",
		[]uint64{29, 899, 26578, 824055, 24851983}},
	{"frc6", "1nbbnrkr/p1p1ppp1/3p4/1p3P1p/3Pq2P/8/PPP1P1P1/QNBBNRKR w HFhf - 0 9",
		[]uint64{28, 1120, 31058, 1171749, 34030312}},
}

// TestFRCPerft validates node counts on real Chess960 positions. Depth 5 (up to
// ~34M nodes) runs only in the full (non-short) suite.
func TestFRCPerft(t *testing.T) {
	for _, tc := range frcPerftCases {
		pos, err := ParseFEN(tc.fen)
		if err != nil {
			t.Fatalf("%s: ParseFEN: %v", tc.name, err)
		}
		if !pos.Legal() {
			t.Fatalf("%s: FEN is illegal", tc.name)
		}
		for i, want := range tc.nodes {
			depth := i + 1
			if depth >= 5 && testing.Short() {
				break
			}
			if got := Perft(pos, depth); got != want {
				t.Errorf("%s perft(%d) = %d, want %d", tc.name, depth, got, want)
			}
		}
	}
}

// TestFRCFastVsSlow walks each FRC tree and asserts the pin-aware fast generator
// and the make/unmake slow oracle agree at every node (independent cross-check of
// the generalized castling generation, orthogonal to the perft node counts).
func TestFRCFastVsSlow(t *testing.T) {
	depth := 4
	if testing.Short() {
		depth = 3
	}
	for _, tc := range frcPerftCases {
		pos, err := ParseFEN(tc.fen)
		if err != nil {
			t.Fatalf("%s: ParseFEN: %v", tc.name, err)
		}
		walkCompare(t, pos, depth)
	}
}

// TestFRCFENRoundTrip checks that an FRC position survives FEN serialize→parse:
// the castling rights, the stored rook origins, and the perft(3) count are all
// preserved. (The emitted castling field is X-FEN, so it need not be string-equal
// to a Shredder input, but it must denote the same position.)
func TestFRCFENRoundTrip(t *testing.T) {
	for _, tc := range frcPerftCases {
		pos, err := ParseFEN(tc.fen)
		if err != nil {
			t.Fatalf("%s: ParseFEN: %v", tc.name, err)
		}
		rt, err := ParseFEN(pos.FEN())
		if err != nil {
			t.Fatalf("%s: reparse %q: %v", tc.name, pos.FEN(), err)
		}
		if rt.castling != pos.castling {
			t.Errorf("%s: castling rights changed: %04b -> %04b", tc.name, pos.castling, rt.castling)
		}
		if rt.castleRook != pos.castleRook {
			t.Errorf("%s: rook origins changed: %v -> %v", tc.name, pos.castleRook, rt.castleRook)
		}
		if a, b := Perft(pos, 3), Perft(rt, 3); a != b {
			t.Errorf("%s: perft(3) changed across round-trip: %d -> %d", tc.name, a, b)
		}
	}
}

// TestFRCCastleEdges checks the generalized castling execution on the tricky FRC
// layouts: rook adjacent to the king, the king barely moving, the king NOT moving
// (already on its destination file), and the rook landing on the king's origin
// square. For each we verify the generated castle lands the king/rook on the right
// squares and that make→unmake restores the position exactly.
func TestFRCCastleEdges(t *testing.T) {
	type edge struct {
		name             string
		fen              string
		kingTo, rookTo   Square
		kingFrom, rookFm Square
	}
	edges := []edge{
		// Rook adjacent to king, kingside (Ke1, Rf1): king e1->g1, rook f1->f1.
		{"adjacent-kingside", "4k3/8/8/8/8/8/8/4KR2 w F - 0 1", G1, F1, E1, F1},
		// King on b-file, queenside (Kb1, Ra1): king b1->c1, rook a1->d1.
		{"king-b-file", "4k3/8/8/8/8/8/8/RK6 w A - 0 1", C1, D1, B1, A1},
		// King already on g-file, kingside (Kg1, Rh1): king g1->g1 (no move), rook h1->f1.
		{"king-does-not-move", "4k3/8/8/8/8/8/8/6KR w H - 0 1", G1, F1, G1, H1},
		// Rook lands on the king's origin (Kd1, Ra1, queenside): king d1->c1, rook a1->d1.
		{"rook-onto-king-origin", "4k3/8/8/8/8/8/8/R2K4 w A - 0 1", C1, D1, D1, A1},
	}
	for _, e := range edges {
		pos, err := ParseFEN(e.fen)
		if err != nil {
			t.Fatalf("%s: ParseFEN: %v", e.name, err)
		}
		if !pos.Legal() {
			t.Fatalf("%s: illegal FEN", e.name)
		}
		var ml MoveList
		pos.GenerateLegal(&ml)
		var castle Move
		found := false
		for i := 0; i < ml.Len(); i++ {
			if ml.Get(i).Type() == Castling {
				castle = ml.Get(i)
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("%s: no castling move generated", e.name)
		}
		if castle.From() != e.kingFrom || castle.To() != e.rookFm {
			t.Errorf("%s: castle encoded (%s->%s), want king %s rook %s",
				e.name, castle.From(), castle.To(), e.kingFrom, e.rookFm)
		}

		before := pos.FEN()
		key := pos.key
		var u Undo
		pos.DoMove(castle, &u)

		king := MakePiece(White, King)
		rook := MakePiece(White, Rook)
		if pos.board[e.kingTo] != king {
			t.Errorf("%s: king not on %s after castle (FEN %s)", e.name, e.kingTo, pos.FEN())
		}
		if pos.board[e.rookTo] != rook {
			t.Errorf("%s: rook not on %s after castle (FEN %s)", e.name, e.rookTo, pos.FEN())
		}
		if pos.key != pos.computeKey() {
			t.Errorf("%s: incremental key wrong after castle", e.name)
		}

		pos.UndoMove(castle, &u)
		if got := pos.FEN(); got != before {
			t.Errorf("%s: make/unmake changed FEN: %q -> %q", e.name, before, got)
		}
		if pos.key != key {
			t.Errorf("%s: make/unmake did not restore key", e.name)
		}
	}
}

// TestFRCCastleUCIRoundTrip checks both castling UCI conventions parse back to the
// exact castling move: the canonical king-captures-rook form (CastleUCI) and the
// king-two-square form (String).
func TestFRCCastleUCIRoundTrip(t *testing.T) {
	for _, tc := range frcPerftCases {
		pos, err := ParseFEN(tc.fen)
		if err != nil {
			t.Fatalf("%s: ParseFEN: %v", tc.name, err)
		}
		var ml MoveList
		pos.GenerateLegal(&ml)
		for i := 0; i < ml.Len(); i++ {
			m := ml.Get(i)
			if m.Type() != Castling {
				continue
			}
			if got, ok := pos.ParseUCIMove(m.CastleUCI()); !ok || got != m {
				t.Errorf("%s: CastleUCI %q did not round-trip (ok=%v got=%s)",
					tc.name, m.CastleUCI(), ok, got)
			}
			got, ok := pos.ParseUCIMove(m.String())
			if !ok || got.Type() != Castling {
				t.Errorf("%s: String %q did not parse to a castle (ok=%v)", tc.name, m.String(), ok)
			}
		}
	}
}

// TestFRCZobristConsistency verifies incremental Zobrist updates match a scratch
// recompute after every legal move (including castling) in the FRC positions.
func TestFRCZobristConsistency(t *testing.T) {
	for _, tc := range frcPerftCases {
		pos, err := ParseFEN(tc.fen)
		if err != nil {
			t.Fatalf("%s: ParseFEN: %v", tc.name, err)
		}
		var ml MoveList
		pos.GenerateLegal(&ml)
		for i := 0; i < ml.Len(); i++ {
			m := ml.Get(i)
			var u Undo
			pos.DoMove(m, &u)
			if pos.key != pos.computeKey() {
				t.Errorf("%s: key mismatch after %s", tc.name, m)
			}
			pos.UndoMove(m, &u)
			if pos.key != u.key {
				t.Errorf("%s: key not restored after undo of %s", tc.name, m)
			}
		}
	}
}
