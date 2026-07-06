package nnue

import (
	"testing"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// TestFinnyBitExact is the HARD correctness gate for the Finny-table accumulator-refresh
// cache (SetFinny, built on SetSplitRefresh). On every bucket-crossing king move the
// moving side's half is produced by finnyRefreshHalf — either a cold from-scratch build
// or a CACHE HIT that updates a cached half by the feature diff vs the current position.
// The result MUST be int16-for-int16 identical to a from-scratch buildAcc of the child,
// in every case — most importantly on a cache HIT where the board CHANGED between the two
// visits to a bucket (captures / pawn pushes / promotions in between).
//
// We drive a depth-first legal-move walk from a king-active position (both kings can
// cross buckets via normal moves AND castling; pawns on the 7th/2nd give promotions and
// captures), so the persistent per-(perspective,bucket) cache is served across many
// sibling subtrees with different boards — exactly the changed-board-hit case. At EVERY
// node the incremental (split+finny) top-slot accumulator is checked against a fresh
// buildAcc, and we assert the walk actually produced changed-board cache hits.
//
// Run scalar: go test ./internal/nnue/ -run FinnyBitExact -v
// Run SIMD:   GOEXPERIMENT=simd ~/go/bin/go1.27rc1 test ./internal/nnue/ -run FinnyBitExact -v
func TestFinnyBitExact(t *testing.T) {
	n := loadSmokeOrRandom(t) // moveAware + changedEdges on
	n.SetSplitRefresh(true)   // finny builds on the split king-bucket refresh
	n.SetFinny(true)

	const maxDepth = 6
	st := n.NewStack(maxDepth)

	// Kings on e1/e8 with castling rights + rooks; white pawns b7/…, black pawns b2/…
	// → king moves cross buckets (e1->d1, castling to c1/g1, …), plus captures and
	// promotions. A rich, king-active tree that re-crosses buckets from many boards.
	start, err := chess.ParseFEN("r3k2r/pPpp1ppp/8/8/8/8/PpPP1PPP/R3K2R w KQkq - 0 1")
	if err != nil {
		t.Fatalf("parse start: %v", err)
	}
	st.Reset(start)

	// Reused from-scratch oracle buffers (buildAcc fully overwrites each call).
	freshW := make([]int16, n.H)
	freshB := make([]int16, n.H)

	const maxNodes = 400000
	nodes := 0
	kingCross := 0

	var walk func(pos *chess.Position, depth int)
	walk = func(pos *chess.Position, depth int) {
		if depth == 0 || nodes >= maxNodes {
			return
		}
		var ml chess.MoveList
		pos.GenerateLegal(&ml)
		for i := 0; i < ml.Len(); i++ {
			if nodes >= maxNodes {
				return
			}
			m := ml.Get(i)
			crosses := kingMoveNeedsRefresh(pos, m)
			if crosses {
				kingCross++
			}

			st.Push(pos, m) // split+finny refresh fires here on a bucket-crossing king move

			child := *pos
			var u chess.Undo
			child.DoMove(m, &u)
			nodes++

			n.buildAcc(freshW, freshB, &child) // ground truth
			incW := st.data[st.sp].w
			incB := st.data[st.sp].b
			if diffs, firstJ := countDiff(incW, freshW, incB, freshB, n.H); diffs != 0 {
				t.Fatalf("finny incremental != from-scratch: %d int16 slots differ (first white j=%d) at fen=%q (parent %q, move %v, crosses=%v)",
					diffs, firstJ, child.FEN(), pos.FEN(), m, crosses)
			}

			walk(&child, depth-1)
			st.Pop()
		}
	}
	walk(start, maxDepth)

	if st.finnyHit+st.finnyMiss == 0 {
		t.Fatalf("finny refresh path never fired (%d king crosses, %d nodes) — test would not gate anything", kingCross, nodes)
	}
	if st.finnyHitChanged == 0 {
		t.Fatalf("no cache-hit-with-changed-board cases occurred (hits=%d miss=%d) — the critical Finny case was NOT exercised",
			st.finnyHit, st.finnyMiss)
	}
	t.Logf("finny bit-exact over %d nodes (%d king crosses): hits=%d changed-board-hits=%d misses=%d — all int16-identical to from-scratch",
		nodes, kingCross, st.finnyHit, st.finnyHitChanged, st.finnyMiss)
}
