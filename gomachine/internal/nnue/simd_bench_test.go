package nnue

import (
	"testing"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// These benchmarks measure where 512-wide NNUE inference time goes, so we can
// size the payoff of SIMD-ing the two hot loops (accumulator update + SCReLU
// output dot). Run with:
//
//	go test -run x -bench 'Eval512|Accumulator|SCReLU' -benchmem ./internal/nnue/
//
// Compare the HL=256 vs HL=512 numbers: the gap is roughly what the 512 net
// costs over the 256 net per eval, and the per-loop benchmarks attribute it.

// benchFEN is a typical middlegame (kiwipete) — ~26 pieces, representative of the
// active-feature count the accumulator build/update sees in real search.
const benchFEN = "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1"

// benchNet builds a random net of the given width with the integer view
// populated (the path real inference uses). Random weights are fine — the int
// forward's cost is data-independent (no branches on weight values beyond the
// clamp, which both halves of a position exercise either way).
func benchNet(hl int) *Net { return RandomNetSize(0xC0FFEE, hl) }

// BenchmarkEvalFromScratch measures the full integer forward (build accumulator
// from scratch + evalFrom) at HL=256 and HL=512. This is the from-scratch cost;
// in real search most evals are the incremental path (one Push delta + evalFrom).
func BenchmarkEvalFromScratch(b *testing.B) {
	pos := mustBenchFEN(b)
	for _, hl := range []int{256, 512} {
		n := benchNet(hl)
		acc := n.newAccumulator()
		b.Run(widthName("FromScratch", hl), func(b *testing.B) {
			var sink int
			b.ReportAllocs()
			for i := 0; i < b.N; i++ {
				n.build(&acc, pos)
				sink += n.evalFrom(&acc, pos.SideToMove())
			}
			_ = sink
		})
	}
}

// BenchmarkEvalIncremental measures the realistic in-search cost: one Push (copy
// parent + apply the move delta) followed by evalFrom — the per-node price the
// searcher actually pays. HL=256 vs HL=512.
func BenchmarkEvalIncremental(b *testing.B) {
	pos := mustBenchFEN(b)
	var ml chess.MoveList
	pos.GenerateLegal(&ml)
	m := ml.Get(0)
	for _, hl := range []int{256, 512} {
		n := benchNet(hl)
		st := n.NewStack(8)
		st.Reset(pos)
		b.Run(widthName("Incremental", hl), func(b *testing.B) {
			var sink int
			b.ReportAllocs()
			for i := 0; i < b.N; i++ {
				st.Push(pos, m)
				sink += n.evalFrom(&st.data[st.sp], pos.SideToMove())
				st.Pop()
			}
			_ = sink
		})
	}
}

// BenchmarkAccumulatorApply isolates hot loop #1: a single feature column
// add+sub (both perspective halves) over HL elements. This is the int16 add/sub
// loop SIMD would target first (it's the simplest and runs ~1-4× per move).
func BenchmarkAccumulatorApply(b *testing.B) {
	pos := mustBenchFEN(b)
	for _, hl := range []int{256, 512} {
		n := benchNet(hl)
		acc := n.newAccumulator()
		n.build(&acc, pos)
		const d5 = chess.Square(35) // file d, rank 5
		addCh := featChange{chess.WhiteKnight, d5, true}
		subCh := featChange{chess.WhiteKnight, d5, false}
		b.Run(widthName("Apply", hl), func(b *testing.B) {
			for i := 0; i < b.N; i++ {
				n.apply(&acc, addCh) // +column
				n.apply(&acc, subCh) // -column (keep acc stable across iters)
			}
		})
	}
}

// BenchmarkSCReLUDot isolates hot loop #2: the integer SCReLU output dot
// (evalFrom) over 2*HL elements — clamp, square, multiply by int16 weight,
// accumulate to int64. This is the heavier of the two loops (a multiply-square
// per element) and the one with the most SIMD headroom (NEON SMLAL etc.).
func BenchmarkSCReLUDot(b *testing.B) {
	pos := mustBenchFEN(b)
	for _, hl := range []int{256, 512} {
		n := benchNet(hl)
		acc := n.newAccumulator()
		n.build(&acc, pos)
		b.Run(widthName("Dot", hl), func(b *testing.B) {
			var sink int
			for i := 0; i < b.N; i++ {
				sink += n.evalFrom(&acc, pos.SideToMove())
			}
			_ = sink
		})
	}
}

func mustBenchFEN(b *testing.B) *chess.Position {
	b.Helper()
	pos, err := chess.ParseFEN(benchFEN)
	if err != nil {
		b.Fatalf("parse bench fen: %v", err)
	}
	return pos
}

func widthName(prefix string, hl int) string {
	if hl == 256 {
		return prefix + "/HL=256"
	}
	return prefix + "/HL=512"
}
