package chess

import "testing"

func uciList(ms []Move) []string {
	s := make([]string, len(ms))
	for i, m := range ms {
		s[i] = m.String()
	}
	return s
}

// assertSameMoves fails if the fast and slow generators disagree at pos. The
// comparison is ORDER-SENSITIVE: the fast generator must emit the exact same move
// list in the exact same order, so the search tree (which depends on generation
// order for equal-scored quiets) is unchanged.
func assertSameMoves(t *testing.T, pos *Position) {
	var slow, fast MoveList
	pos.generateLegalSlow(&slow)
	pos.generateLegalFast(&fast)
	mismatch := slow.count != fast.count
	if !mismatch {
		for i := 0; i < slow.count; i++ {
			if slow.moves[i] != fast.moves[i] {
				mismatch = true
				break
			}
		}
	}
	if mismatch {
		s := slow.moves[:slow.count]
		f := fast.moves[:fast.count]
		t.Fatalf("generator mismatch (order-sensitive) at %q:\n  slow(%d): %v\n  fast(%d): %v",
			pos.FEN(), slow.count, uciList(s), fast.count, uciList(f))
	}
}

// walkCompare compares both generators at pos, then recurses through the legal
// moves to `depth`, comparing at every node.
func walkCompare(t *testing.T, pos *Position, depth int) {
	assertSameMoves(t, pos)
	if depth <= 1 {
		return
	}
	var ml MoveList
	pos.generateLegalSlow(&ml)
	for i := 0; i < ml.count; i++ {
		var u Undo
		pos.DoMove(ml.moves[i], &u)
		walkCompare(t, pos, depth-1)
		pos.UndoMove(ml.moves[i], &u)
	}
}

// TestFastVsSlowMovegenPerftTrees walks every perft position's full tree and
// asserts the pin-aware generator emits the exact same move set as the
// make/unmake oracle at every node.
func TestFastVsSlowMovegenPerftTrees(t *testing.T) {
	depth := 4
	if testing.Short() {
		depth = 3
	}
	for _, tc := range perftCases {
		pos, err := ParseFEN(tc.fen)
		if err != nil {
			t.Fatalf("%s: ParseFEN: %v", tc.name, err)
		}
		walkCompare(t, pos, depth)
	}
}

// TestFastVsSlowMovegenTricky targets the classic movegen edge cases — en
// passant discovered check (horizontal pin), pins along every axis, double
// check, and promotion-with-check — that are the usual sources of legal-movegen
// bugs.
func TestFastVsSlowMovegenTricky(t *testing.T) {
	fens := []string{
		// En passant that would expose the king to a horizontal slider (the
		// two-pawns-leave-a-rank discovered check). Both colors.
		"8/8/8/8/k2Pp2Q/8/8/3K4 b - d3 0 1",
		"8/8/8/8/K2pP2q/8/8/3k4 w - e6 0 1",
		"8/8/8/2k5/2pP4/8/B7/4K3 b - d3 0 1",
		// En passant where the capture itself is fine (no pin).
		"4k3/8/8/2pP4/8/8/8/4K3 w - c6 0 1",
		// Pins along file / rank / both diagonals.
		"3rk3/8/8/8/8/8/3R4/3K4 w - - 0 1",
		"k7/8/8/8/q3R2K/8/8/8 w - - 0 1", // white rook pinned on rank 4
		"4k3/8/8/8/8/2b5/3P4/4K3 w - - 0 1",
		"4k3/8/8/8/7b/8/5P2/4K3 w - - 0 1",
		// Single/near-double check on the king.
		"4k3/8/8/8/8/8/3rnb2/3K4 w - - 0 1",
		// In check: block / capture the checker.
		"4k3/8/8/8/8/8/8/r3K3 w - - 0 1",
		// Promotion (white near 8th, black near 1st), kings kept off the check lines.
		"k7/4P3/8/8/8/8/8/4K3 w - - 0 1",
		"4k3/8/8/8/8/8/6p1/K7 b - - 0 1",
		// Castling availability under various attacks.
		"r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1",
		"r3k2r/8/8/8/8/8/6n1/R3K2R w KQkq - 0 1",
	}
	for _, fen := range fens {
		pos, err := ParseFEN(fen)
		if err != nil {
			t.Fatalf("ParseFEN %q: %v", fen, err)
		}
		if !pos.Legal() {
			t.Fatalf("test FEN is illegal (side-not-to-move in check): %q", fen)
		}
		walkCompare(t, pos, 4)
	}
}

// TestFastVsSlowMovegenRandom plays pseudo-random legal games from each perft
// start, comparing both generators at every ply — diversifying into endgames,
// promotions, and en passant the fixed trees may not reach.
func TestFastVsSlowMovegenRandom(t *testing.T) {
	var rng uint64 = 0x9E3779B97F4A7C15
	next := func() uint64 { // xorshift64
		rng ^= rng << 13
		rng ^= rng >> 7
		rng ^= rng << 17
		return rng
	}
	games := 400
	if testing.Short() {
		games = 60
	}
	for g := 0; g < games; g++ {
		start := perftCases[g%len(perftCases)]
		pos, err := ParseFEN(start.fen)
		if err != nil {
			t.Fatalf("ParseFEN: %v", err)
		}
		for ply := 0; ply < 60; ply++ {
			assertSameMoves(t, pos)
			var ml MoveList
			pos.generateLegalSlow(&ml)
			if ml.count == 0 {
				break // checkmate or stalemate
			}
			m := ml.moves[next()%uint64(ml.count)]
			var u Undo
			pos.DoMove(m, &u)
		}
	}
}
