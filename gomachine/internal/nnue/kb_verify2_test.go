package nnue

import (
	"fmt"
	"testing"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// ============================================================================
// Residual king-bucket verification: Task A (refresh-predicate generalization
// across MANY bucket boundaries, both colors, with the no-refresh counterfactual
// proving the refresh is load-bearing) and Task B (slider-blocker/x-ray threat
// geometry) — both diffed against the INDEPENDENT Rust map_features replica in
// kb_verify_test.go (rustMapFeatures / its own ray gen), never the engine's own
// PseudoAttacks path.
//
// Run scalar: go test ./internal/nnue/ -run 'KBGen|KBBlocker' -v
// Run SIMD:   GOEXPERIMENT=simd ~/go/bin/go1.27rc1 test ./internal/nnue/ -run 'KBGen|KBBlocker' -v
// ============================================================================

// findKingMove locates the legal king move from->to in pos (fatal if absent).
func findKingMove(t *testing.T, pos *chess.Position, from, to chess.Square) chess.Move {
	t.Helper()
	var ml chess.MoveList
	pos.GenerateLegal(&ml)
	for i := 0; i < ml.Len(); i++ {
		m := ml.Get(i)
		if m.From() == from && m.To() == to {
			return m
		}
	}
	t.Fatalf("king move %v->%v not legal (%d legal moves)", from, to, ml.Len())
	return chess.Move(0)
}

// orientedBucket returns the MIRRORED king bucket for sq with Black's perspective
// orientation (^56) applied — the SAME mapping the engine uses in kingMoveNeedsRefresh.
func orientedBucket(sq chess.Square, mover chess.Color) int {
	s := uint16(sq)
	if mover == chess.Black {
		s ^= 56
	}
	return int(mirBucket(s ^ kingMirror(s)))
}

// orientedMir returns the horizontal-mirror mask (7/0) for sq oriented to the mover —
// the second term of the refresh predicate (a d/e-file crossing flips every square).
func orientedMir(sq chess.Square, mover chess.Color) uint16 {
	s := uint16(sq)
	if mover == chess.Black {
		s ^= 56
	}
	return kingMirror(s)
}

// ---- TASK A: refresh-predicate generalization across boundaries ------------

func TestKBGenRefreshBoundaries(t *testing.T) {
	n := loadSmokeOrRandom(t) // moveAware + changedEdges on
	st := n.NewStack(4)

	type tc struct {
		name       string
		fen        string
		mover      chess.Color
		from, to   chess.Square
	}
	sq := func(file, rank int) chess.Square { return chess.Square(rank*8 + file) }
	// file: a=0..h=7 ; rank: 1=0..8=7
	cases := []tc{
		// ---- WHITE king mover ----
		// horizontal file b->c (f>>1 0->1) at rank 3
		{"W b3->c3 horiz b|c", "7k/8/8/8/8/1K6/8/8 w - - 0 1", chess.White, sq(1, 2), sq(2, 2)},
		// horizontal file f->g (f>>1 2->3) at rank 6
		{"W f6->g6 horiz f|g", "8/8/5K2/8/8/8/8/k7 w - - 0 1", chess.White, sq(5, 5), sq(6, 5)},
		// vertical rank 2->3 (r>>1 0->1)
		{"W e2->e3 vert 2|3", "7k/8/8/8/8/8/4K3/8 w - - 0 1", chess.White, sq(4, 1), sq(4, 2)},
		// vertical rank 6->7 (r>>1 2->3)
		{"W c6->c7 vert 6|7", "8/8/2K5/8/8/8/8/7k w - - 0 1", chess.White, sq(2, 5), sq(2, 6)},
		// diagonal crossing BOTH boundaries at once (d4->e5): file d->e, rank4->5
		{"W d4->e5 diag both", "7k/8/8/8/3K4/8/8/8 w - - 0 1", chess.White, sq(3, 3), sq(4, 4)},
		// negative control: WITHIN bucket 0 (a1->b2 both r>>1=0,f>>1=0)
		{"W a1->b2 SAME buck0", "7k/8/8/8/8/8/8/K7 w - - 0 1", chess.White, sq(0, 0), sq(1, 1)},
		// negative control: within bucket 2 (e1->f1)
		{"W e1->f1 SAME buck2", "7k/8/8/8/8/8/8/4K3 w - - 0 1", chess.White, sq(4, 0), sq(5, 0)},

		// ---- BLACK king mover ----
		{"B b3->c3 horiz b|c", "7K/8/8/8/8/1k6/8/8 b - - 0 1", chess.Black, sq(1, 2), sq(2, 2)},
		{"B f6->g6 horiz f|g", "8/8/5k2/8/8/8/8/K7 b - - 0 1", chess.Black, sq(5, 5), sq(6, 5)},
		{"B e2->e3 vert 2|3", "7K/8/8/8/8/8/4k3/8 b - - 0 1", chess.Black, sq(4, 1), sq(4, 2)},
		{"B c6->c7 vert 6|7", "8/8/2k5/8/8/8/8/7K b - - 0 1", chess.Black, sq(2, 5), sq(2, 6)},
		{"B d5->e4 diag both", "8/8/8/3k4/8/8/8/7K b - - 0 1", chess.Black, sq(3, 4), sq(4, 3)},
		{"B a1->b2 SAME buck", "7K/8/8/8/8/8/8/k7 b - - 0 1", chess.Black, sq(0, 0), sq(1, 1)},
		{"B e1->f1 SAME buck", "7K/8/8/8/8/8/8/4k3 b - - 0 1", chess.Black, sq(4, 0), sq(5, 0)},
	}

	fail := false
	for _, c := range cases {
		pos, err := chess.ParseFEN(c.fen)
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		mv := findKingMove(t, pos, c.from, c.to)

		bFrom := orientedBucket(c.from, c.mover)
		bTo := orientedBucket(c.to, c.mover)
		// Refresh needed iff the mirrored bucket changes OR the mirror half flips
		// (king crosses the d/e file) — the whole perspective re-encodes either way.
		wantCross := bFrom != bTo || orientedMir(c.from, c.mover) != orientedMir(c.to, c.mover)

		// (1) predicate matches the table-derived expectation exactly
		gotCross := kingMoveNeedsRefresh(pos, mv)
		if gotCross != wantCross {
			fail = true
			t.Errorf("%s: kingMoveNeedsRefresh=%v want %v (bucket %d->%d)", c.name, gotCross, wantCross, bFrom, bTo)
		}

		// from-scratch child accumulator (the ground truth)
		child := *pos
		var u chess.Undo
		child.DoMove(mv, &u)
		freshW := make([]int16, n.H)
		freshB := make([]int16, n.H)
		n.buildAcc(freshW, freshB, &child)

		// (2) CORRECT incremental path (Push → buildSlotFrom, which refreshes on cross)
		st.Reset(pos)
		st.Push(pos, mv)
		incW := st.data[st.sp].w
		incB := st.data[st.sp].b
		incDiffs, firstJ := countDiff(incW, freshW, incB, freshB, n.H)
		st.Pop()

		// (3) COUNTERFACTUAL no-refresh delta (computeDelta+applyDelta, bypassing the
		// refresh gate) — proves the refresh is LOAD-BEARING on crossings and that the
		// same-bucket delta is correct on non-crossings.
		st.Reset(pos)
		sW, aW, sB, aB := st.computeDelta(pos, mv)
		st.applyDelta(1, 0, sW, aW, sB, aB)
		naiveW := st.data[1].w
		naiveB := st.data[1].b
		naiveDiffs, _ := countDiff(naiveW, freshW, naiveB, freshB, n.H)

		okInc := incDiffs == 0
		// on a crossing, the no-refresh delta MUST diverge; within a bucket it must match.
		okNaive := (wantCross && naiveDiffs > 0) || (!wantCross && naiveDiffs == 0)
		if !okInc {
			fail = true
			t.Errorf("%s: incremental != from-scratch (%d halves differ, first j=%d)", c.name, incDiffs, firstJ)
		}
		if !okNaive {
			fail = true
			t.Errorf("%s: no-refresh counterfactual diffs=%d but wantCross=%v (crossing must diverge, same-bucket must match)",
				c.name, naiveDiffs, wantCross)
		}
		if okInc && okNaive {
			t.Logf("%-22s cross=%-5v bucket %2d->%2d | incremental==fromscratch (2048 int16 exact); no-refresh delta diffs=%d (load-bearing=%v)",
				c.name, wantCross, bFrom, bTo, naiveDiffs, wantCross)
		}
	}
	if !fail {
		t.Logf("PASS KBGen: refresh predicate == table-boundary crossing for every case (both colors, 5 distinct boundaries + within-bucket controls); incremental byte-exact; refresh proven load-bearing on all crossings")
	}
}

// countDiff returns the number of int16 slots (across both halves) where a!=fresh,
// and the first differing index in the White half (or -1).
func countDiff(aW, fW, aB, fB []int16, h int) (int, int) {
	diffs, first := 0, -1
	for j := 0; j < h; j++ {
		if aW[j] != fW[j] {
			diffs++
			if first < 0 {
				first = j
			}
		}
		if aB[j] != fB[j] {
			diffs++
		}
	}
	return diffs, first
}

// ---- TASK B: slider blocker / x-ray threat geometry ------------------------

func TestKBBlockerThreatGeometry(t *testing.T) {
	cases := []struct{ name, fen string }{
		// rook with a FRIENDLY pawn directly in front: rook attacks the pawn (emitted),
		// square beyond (a3) is NOT a target, and the enemy pawn on a4 behind it is NOT
		// reachable (blocked by own pawn).
		{"rook friendly-blocker", "4k3/8/8/8/p7/8/P7/R3K3 w - - 0 1"},
		// rook with empty a2 then an ENEMY pawn on a3: the enemy blocker IS the target,
		// the black rook on a5 BEHIND it is NOT (ray truncates at the first blocker).
		{"rook enemy-blocker+beyond", "4k3/8/8/r7/8/p7/8/R3K3 w - - 0 1"},
		// bishop BLOCKED (c1, blocker bp f4: g5/h6 excluded) alongside bishop UNBLOCKED
		// (f1 sees through 4 empties to the enemy bishop a6) + an edge bishop (a6, no wrap).
		{"bishop blocked+unblocked+edge", "4k3/8/b7/8/5p2/8/8/2B1KB2 w - - 0 1"},
		// queen battery on the a-file (Ra1 behind Qa2): the rook sees ONLY the queen
		// (front piece), the queen sees up to the black rook a6; NO x-ray past the queen
		// for the rook, and NO x-ray past the queen for the black rook (a1 not emitted).
		{"queen battery / x-ray both", "4k3/8/r7/8/8/8/Q7/R3K3 w - - 0 1"},
		// corner bishops (a1 NE-only, h1 NW-only) + corner pawn attack on a1: wrap bait.
		{"corner bishops wrap-bait", "7k/8/8/8/8/8/1p4P1/B3K2b w - - 0 1"},
		// corner rook h1: up-file + left-rank only, no wrap to the a-file from the corner.
		{"corner rook wrap-bait", "7k/8/8/8/8/8/7p/4K2R w - - 0 1"},
		// pin/x-ray: black rook e8 rakes the e-file through the pinned white knight e4;
		// the knight IS the rook's target, e3/e2/e1 (incl. the white king) are NOT (blocked).
		{"pin x-ray through knight", "4r2k/8/8/8/4N3/8/8/4K3 w - - 0 1"},
	}

	filt := func(x []int) []int {
		var o []int
		for _, v := range x {
			if v >= PsqSize {
				o = append(o, v)
			}
		}
		return o
	}
	fail := false
	for _, c := range cases {
		pos, err := chess.ParseFEN(c.fen)
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		rStm, rNtm := rustMapFeatures(pos)
		gtW, rtW := filt(goFeatureSet(pos, chess.White)), filt(rStm)
		gtB, rtB := filt(goFeatureSet(pos, chess.Black)), filt(rNtm)
		oaW, obW := setDiff(gtW, rtW)
		oaB, obB := setDiff(gtB, rtB)
		okW := len(oaW) == 0 && len(obW) == 0
		okB := len(oaB) == 0 && len(obB) == 0
		t.Logf("%-30s Wthreats=%d Bthreats=%d | White eq=%v Black eq=%v", c.name, len(gtW), len(gtB), okW, okB)
		if !okW {
			fail = true
			t.Errorf("%s WHITE-persp mismatch:\n  onlyGo:   %s\n  onlyRust: %s", c.name, decodeThreats(oaW, false), decodeThreats(obW, false))
		}
		if !okB {
			fail = true
			t.Errorf("%s BLACK-persp mismatch:\n  onlyGo:   %s\n  onlyRust: %s", c.name, decodeThreats(oaB, true), decodeThreats(obB, true))
		}
	}
	if !fail {
		t.Logf("PASS KBBlocker: Go threat features == independent Rust ray oracle for every slider-blocker / x-ray / corner case, both perspectives")
	}
}

// decodeThreats renders threat feature indices as attacker/victim/target for a
// mismatch report. idx = PsqSize + (a*12+v)*64 + tsq, where a=relColor*6+type
// (0=own,1=enemy in this perspective) and tsq is oriented (Black: real^56).
func decodeThreats(idxs []int, blackPersp bool) string {
	if len(idxs) == 0 {
		return "(none)"
	}
	names := []string{"P", "N", "B", "R", "Q", "K"}
	decode1 := func(idx int) string {
		rem := idx - PsqSize
		tsq := rem % 64
		av := rem / 64
		v := av % 12
		a := av / 12
		realSq := tsq
		if blackPersp {
			realSq = tsq ^ 56
		}
		aRel, aType := a/6, a%6
		vRel, vType := v/6, v%6
		side := func(rel int) string {
			if rel == 0 {
				return "own"
			}
			return "enemy"
		}
		return fmt.Sprintf("[%d: %s-%s attacks %s-%s @ %s]", idx, side(aRel), names[aType], side(vRel), names[vType], chess.Square(realSq))
	}
	out := ""
	for _, idx := range idxs {
		out += decode1(idx) + " "
	}
	return out
}
