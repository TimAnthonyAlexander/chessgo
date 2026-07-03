package chess

import "testing"

// isNoisy mirrors the quiescence-search keep predicate exactly:
//
//	isCapture(m) || m.Type() == Promotion
//
// where isCapture is "destination square occupied, or en passant". This is the
// same predicate qsearch applies (search/ordering.go isCapture + the qsearch
// filter), quirks included (castling's rook-square destination is occupied, so
// castling is "noisy" here just as it is in qsearch).
func isNoisy(pos *Position, m Move) bool {
	if m.Type() == Promotion || m.Type() == EnPassant {
		return true
	}
	return pos.PieceOn(m.To()) != NoPiece
}

// assertSameCaptures fails if GenerateCaptures does not equal the noisy
// subsequence of GenerateLegal. ORDER-SENSITIVE: GenerateCaptures must emit the
// noisy moves in the exact same relative order the full generator does, so
// swapping qsearch onto it changes neither which moves it searches nor the order
// (a pure NPS refactor).
func assertSameCaptures(t *testing.T, pos *Position) {
	var full, noisy MoveList
	pos.GenerateLegal(&full)
	pos.GenerateCaptures(&noisy)

	var want MoveList
	for i := 0; i < full.count; i++ {
		if isNoisy(pos, full.moves[i]) {
			want.add(full.moves[i])
		}
	}

	mismatch := want.count != noisy.count
	if !mismatch {
		for i := 0; i < want.count; i++ {
			if want.moves[i] != noisy.moves[i] {
				mismatch = true
				break
			}
		}
	}
	if mismatch {
		w := want.moves[:want.count]
		n := noisy.moves[:noisy.count]
		t.Fatalf("GenerateCaptures mismatch (order-sensitive) at %q:\n  filtered-legal(%d): %v\n  captures(%d): %v",
			pos.FEN(), want.count, uciList(w), noisy.count, uciList(n))
	}
}

// walkCompareCaptures compares at pos then recurses through the legal moves.
func walkCompareCaptures(t *testing.T, pos *Position, depth int) {
	assertSameCaptures(t, pos)
	if depth <= 1 {
		return
	}
	var ml MoveList
	pos.GenerateLegal(&ml)
	for i := 0; i < ml.count; i++ {
		var u Undo
		pos.DoMove(ml.moves[i], &u)
		walkCompareCaptures(t, pos, depth-1)
		pos.UndoMove(ml.moves[i], &u)
	}
}

// TestCapturesVsLegalPerftTrees walks every perft position's tree and asserts
// GenerateCaptures equals the noisy subsequence of GenerateLegal at every node.
func TestCapturesVsLegalPerftTrees(t *testing.T) {
	depth := 4
	if testing.Short() {
		depth = 3
	}
	for _, tc := range perftCases {
		pos, err := ParseFEN(tc.fen)
		if err != nil {
			t.Fatalf("%s: ParseFEN: %v", tc.name, err)
		}
		walkCompareCaptures(t, pos, depth)
	}
}

// TestCapturesVsLegalTricky targets the movegen edge cases (en passant
// discovered check, pins on every axis, double check, promotion-with-check,
// castling under attack) for the noisy generator specifically.
func TestCapturesVsLegalTricky(t *testing.T) {
	fens := []string{
		"8/8/8/8/k2Pp2Q/8/8/3K4 b - d3 0 1",
		"8/8/8/8/K2pP2q/8/8/3k4 w - e6 0 1",
		"8/8/8/2k5/2pP4/8/B7/4K3 b - d3 0 1",
		"4k3/8/8/2pP4/8/8/8/4K3 w - c6 0 1",
		"3rk3/8/8/8/8/8/3R4/3K4 w - - 0 1",
		"k7/8/8/8/q3R2K/8/8/8 w - - 0 1",
		"4k3/8/8/8/8/2b5/3P4/4K3 w - - 0 1",
		"4k3/8/8/8/7b/8/5P2/4K3 w - - 0 1",
		"4k3/8/8/8/8/8/3rnb2/3K4 w - - 0 1",
		"4k3/8/8/8/8/8/8/r3K3 w - - 0 1",
		"k7/4P3/8/8/8/8/8/4K3 w - - 0 1",
		"4k3/8/8/8/8/8/6p1/K7 b - - 0 1",
		"r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1",
		"r3k2r/8/8/8/8/8/6n1/R3K2R w KQkq - 0 1",
		// Capture-promotions and push-promotions side by side.
		"1n2k3/P7/8/8/8/8/8/4K3 w - - 0 1",
		"4k3/8/8/8/8/8/6p1/K4N2 b - - 0 1",
	}
	for _, fen := range fens {
		pos, err := ParseFEN(fen)
		if err != nil {
			t.Fatalf("ParseFEN %q: %v", fen, err)
		}
		if !pos.Legal() {
			t.Fatalf("test FEN is illegal (side-not-to-move in check): %q", fen)
		}
		walkCompareCaptures(t, pos, 4)
	}
}

// TestCapturesVsLegalRandom plays pseudo-random legal games from each perft
// start, comparing at every ply — diversifying into endgames, promotions, and
// en passant the fixed trees may not reach.
func TestCapturesVsLegalRandom(t *testing.T) {
	var rng uint64 = 0x9E3779B97F4A7C15
	next := func() uint64 {
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
			assertSameCaptures(t, pos)
			var ml MoveList
			pos.GenerateLegal(&ml)
			if ml.count == 0 {
				break
			}
			m := ml.moves[next()%uint64(ml.count)]
			var u Undo
			pos.DoMove(m, &u)
		}
	}
}
