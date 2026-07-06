package nnue

import (
	"testing"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// TestSplitRefreshBitExact gates the split king-bucket accumulator refresh
// (SetSplitRefresh): on a bucket-crossing king move, it rebuilds ONLY the moving
// side's accumulator half from scratch and deltas the OPPONENT half from the parent.
// This must be int16-for-int16 identical to the from-scratch buildAcc of the child —
// which is the ground truth the default (full dual rebuild) already matches. We drive
// the SAME boundary-crossing king moves as TestKBGenRefreshBoundaries (both colors,
// all four 4×4 grid boundaries + diagonals) with splitRefresh FORCED ON, and also
// prove the refresh predicate actually fired (a same-bucket move would exercise the
// ordinary delta, not the split path).
//
// Run scalar: go test ./internal/nnue/ -run SplitRefresh -v
// Run SIMD:   GOEXPERIMENT=simd ~/go/bin/go1.27rc1 test ./internal/nnue/ -run SplitRefresh -v
func TestSplitRefreshBitExact(t *testing.T) {
	n := loadSmokeOrRandom(t) // moveAware + changedEdges on
	n.SetSplitRefresh(true)
	st := n.NewStack(4)

	sq := func(file, rank int) chess.Square { return chess.Square(rank*8 + file) }
	type tc struct {
		name     string
		fen      string
		mover    chess.Color
		from, to chess.Square
	}
	cases := []tc{
		// ---- WHITE king mover: cross each 4×4 boundary ----
		{"W b3->c3 horiz b|c", "7k/8/8/8/8/1K6/8/8 w - - 0 1", chess.White, sq(1, 2), sq(2, 2)},
		{"W f6->g6 horiz f|g", "8/8/5K2/8/8/8/8/k7 w - - 0 1", chess.White, sq(5, 5), sq(6, 5)},
		{"W e2->e3 vert 2|3", "7k/8/8/8/8/8/4K3/8 w - - 0 1", chess.White, sq(4, 1), sq(4, 2)},
		{"W c6->c7 vert 6|7", "8/8/2K5/8/8/8/8/7k w - - 0 1", chess.White, sq(2, 5), sq(2, 6)},
		{"W d4->e5 diag both", "7k/8/8/8/3K4/8/8/8 w - - 0 1", chess.White, sq(3, 3), sq(4, 4)},
		// ---- BLACK king mover ----
		{"B b3->c3 horiz b|c", "7K/8/8/8/8/1k6/8/8 b - - 0 1", chess.Black, sq(1, 2), sq(2, 2)},
		{"B f6->g6 horiz f|g", "8/8/5k2/8/8/8/8/K7 b - - 0 1", chess.Black, sq(5, 5), sq(6, 5)},
		{"B e2->e3 vert 2|3", "7K/8/8/8/8/8/4k3/8 b - - 0 1", chess.Black, sq(4, 1), sq(4, 2)},
		{"B c6->c7 vert 6|7", "8/8/2k5/8/8/8/8/7K b - - 0 1", chess.Black, sq(2, 5), sq(2, 6)},
		{"B d5->e4 diag both", "8/8/8/3k4/8/8/8/7K b - - 0 1", chess.Black, sq(3, 4), sq(4, 3)},
		// Fully-populated board (all pawns + rooks both sides): the white king crosses
		// g|f, so the opponent's base list must relocate the king AND every other piece's
		// base/threat features must reproduce exactly through the split path.
		{"W g1->f1 full board", "r5k1/pppppppp/8/8/8/8/PPPPPPPP/R5K1 w - - 0 1", chess.White, sq(6, 0), sq(5, 0)},
	}

	for _, c := range cases {
		pos, err := chess.ParseFEN(c.fen)
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		mv := findKingMove(t, pos, c.from, c.to)

		// The split path only runs when the refresh predicate fires; assert it does.
		if !kingMoveNeedsRefresh(pos, mv) {
			t.Fatalf("%s: move does not cross a bucket (split-refresh path would not fire)", c.name)
		}

		// Ground truth: from-scratch child accumulator.
		child := *pos
		var u chess.Undo
		child.DoMove(mv, &u)
		freshW := make([]int16, n.H)
		freshB := make([]int16, n.H)
		n.buildAcc(freshW, freshB, &child)

		// Incremental path with splitRefresh ON (Push → buildSlotFrom → split branch).
		st.Reset(pos)
		st.Push(pos, mv)
		incW := st.data[st.sp].w
		incB := st.data[st.sp].b
		diffs, firstJ := countDiff(incW, freshW, incB, freshB, n.H)
		st.Pop()

		if diffs != 0 {
			t.Errorf("%s: split-refresh incremental != from-scratch (%d int16 slots differ, first white j=%d)",
				c.name, diffs, firstJ)
		} else {
			t.Logf("%-22s split-refresh == from-scratch (2×%d int16 exact)", c.name, n.H)
		}
	}
}
