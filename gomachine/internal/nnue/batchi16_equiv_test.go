package nnue

import (
	"math/rand"
	"testing"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// TestApplyBatchI16Equiv asserts the int16 batch-apply kernel (applyBatchI16 — the
// NEON kernel under GOEXPERIMENT=simd on arm64, the scalar reference elsewhere)
// produces byte-identical accumulators to an independent per-column sub-then-add
// reference. Exercises several widths incl. non-multiples of 8 (tail path) and
// disjoint / overlapping sub/add lists. Bit-exactness is the whole contract.
func TestApplyBatchI16Equiv(t *testing.T) {
	rng := rand.New(rand.NewSource(0xB16))
	for _, h := range []int{1, 7, 8, 13, 16, 31, 256, 512, 520} {
		const cols = 40
		w0i := make([]int16, cols*h)
		for i := range w0i {
			w0i[i] = int16(rng.Intn(1<<16) - (1 << 15)) // full int16 range → exercises wraparound
		}
		for trial := 0; trial < 20; trial++ {
			nSub := rng.Intn(cols)
			nAdd := rng.Intn(cols)
			subF := make([]uint32, nSub)
			addF := make([]uint32, nAdd)
			for i := range subF {
				subF[i] = uint32(rng.Intn(cols))
			}
			for i := range addF {
				addF[i] = uint32(rng.Intn(cols))
			}

			acc0 := make([]int16, h)
			for i := range acc0 {
				acc0[i] = int16(rng.Intn(1<<16) - (1 << 15))
			}

			// reference: separate per-column sub (parent) then add (child) pass
			ref := make([]int16, h)
			copy(ref, acc0)
			for _, f := range subF {
				for k := 0; k < h; k++ {
					ref[k] -= w0i[int(f)*h+k]
				}
			}
			for _, f := range addF {
				for k := 0; k < h; k++ {
					ref[k] += w0i[int(f)*h+k]
				}
			}

			got := make([]int16, h)
			copy(got, acc0)
			applyBatchI16(got, w0i, h, subF, addF)

			for k := 0; k < h; k++ {
				if got[k] != ref[k] {
					t.Fatalf("h=%d trial=%d lane=%d: batch=%d ref=%d (NOT bit-exact)", h, trial, k, got[k], ref[k])
				}
			}
		}
	}
}

// TestBatchI16EquivEval asserts the int16 directApply path (which routes through
// applyBatchI16 when useI16Batch is on — i.e. the arm64 NEON build) produces
// byte-identical accumulators to the counts multiset-diff path, across a move walk,
// in the prod-like int16 (non-int8FT) move-aware config. On amd64/scalar this
// compares counts vs per-column direct (both per-column); on arm64-SIMD it compares
// counts vs the BATCH kernel — the real end-to-end bit-exact gate for this kernel.
func TestBatchI16EquivEval(t *testing.T) {
	mkNet := func() *EnrichedNet {
		n := NewEnrichedNet(512, 16, 32, 8)
		n.lean = true
		rng := rand.New(rand.NewSource(99))
		for i := range n.W0i {
			n.W0i[i] = int16(rng.Intn(512) - 256)
		}
		for i := range n.B0i {
			n.B0i[i] = int16(rng.Intn(512) - 256)
		}
		n.SetMoveAware(true)
		return n
	}
	n := mkNet()
	if n.int8FT {
		t.Fatal("net is int8FT — this test must exercise the int16 (W0i) directApply path")
	}

	fens := []string{
		chess.StartFEN,
		"r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1",
		"r1bqk2r/pp2bppp/2n1pn2/2pp4/3P1B2/2PBPN2/PP3PPP/RN1QK2R w KQkq - 0 8",
		"8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1",
		"r2q1rk1/pp2ppbp/2np1np1/2p5/2P1P3/2NP1N2/PP2BPPP/R1BQ1RK1 w - - 0 9",
	}
	for _, fen := range fens {
		pos, err := chess.ParseFEN(fen)
		if err != nil {
			t.Fatalf("%s: %v", fen, err)
		}
		n.SetDirectApply(false) // counts multiset-diff reference path
		ref := walkEval(n.NewStack(8), pos)
		n.SetDirectApply(true) // direct → batch kernel on arm64-SIMD (useI16Batch)
		got := walkEval(n.NewStack(8), pos)
		n.SetDirectApply(false)
		if len(ref) != len(got) {
			t.Fatalf("%s: len mismatch %d vs %d", fen, len(ref), len(got))
		}
		for i := range ref {
			if ref[i] != got[i] {
				t.Fatalf("%s idx %d: counts=%d directbatch=%d (NOT bit-exact)", fen, i, ref[i], got[i])
			}
		}
	}
}
