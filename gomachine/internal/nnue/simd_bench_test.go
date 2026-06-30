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
				sink += n.evalFrom(&acc, pos.SideToMove(), n.outputBucket(pos))
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
				sink += n.evalFrom(&st.data[st.sp], pos.SideToMove(), n.outputBucket(pos))
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
				sink += n.evalFrom(&acc, pos.SideToMove(), n.outputBucket(pos))
			}
			_ = sink
		})
	}
}

// BenchmarkMultiDotF32 isolates the MultiNet tail-matmul kernel at the L1 width
// (2*H = 1024) — the dominant per-node cost. It reports the SCALAR reference and
// the ACTIVE (possibly-SIMD) binding side by side, so the speedup is the ratio of
// the two sub-benchmarks in one run.
func BenchmarkMultiDotF32(b *testing.B) {
	const n = 1024
	a := make([]float32, n)
	w := make([]float32, n)
	for i := range a {
		a[i] = float32(i%7) * 0.013
		w[i] = float32((i*3)%11) * 0.007
	}
	b.Run("scalar", func(b *testing.B) {
		var s float32
		for i := 0; i < b.N; i++ {
			s += dotF32Scalar(a, w)
		}
		_ = s
	})
	b.Run("active", func(b *testing.B) {
		var s float32
		for i := 0; i < b.N; i++ {
			s += dotF32(a, w)
		}
		_ = s
	})
}

// BenchmarkMultiTail measures MultiNet's full tail (L1 → L2 → L3 → out) for the
// PoC shape (H=512, D2=16, D3=32) via the active dotF32 binding — the real
// per-node eval cost the movetime regime pays. Compare scalar build vs SIMD build.
func BenchmarkMultiTail(b *testing.B) {
	n := RandomMultiNet(0xC0FFEE, 512, 16, 32, 1)
	ft := make([]float32, 2*n.H)
	for i := range ft {
		ft[i] = float32(i%5) * 0.05 // SCReLU-range activations [0,1)
	}
	l2 := make([]float32, n.D2)
	l3 := make([]float32, n.D3)
	var sink int
	for i := 0; i < b.N; i++ {
		sink += n.tailEval(ft, 0, l2, l3)
	}
	_ = sink
}

// BenchmarkMultiFull measures MultiNet's realistic per-node cost: one Push
// (accumulator copy + float delta) + one Eval (orient + activate + tail), for the
// PoC shape, comparing the FLOAT tail vs the int8-L1 tail. If int8 barely beats
// float here, the accumulator/activation (both float/scalar) dominate — not L1 —
// which is the int16-accumulator (handoff step 2) signal. Compare to v6's
// BenchmarkEvalIncremental/HL=512 for the target per-node eval cost.
func BenchmarkMultiFull(b *testing.B) {
	pos := mustBenchFEN(b)
	var ml chess.MoveList
	pos.GenerateLegal(&ml)
	m := ml.Get(0)
	for _, mode := range []string{"float", "int8"} {
		n := RandomMultiNet(0xC0FFEE, 512, 16, 32, 8)
		n.CpScale = 400
		if mode == "int8" {
			n.QuantizeForInt8()
		}
		st := n.NewStack(8)
		st.Reset(pos)
		b.Run(mode, func(b *testing.B) {
			var sink int
			for i := 0; i < b.N; i++ {
				st.Push(pos, m)
				sink += st.Eval(pos)
				st.Pop()
			}
			_ = sink
		})
	}
}

// BenchmarkMultiAccPush isolates the accumulator Push (copy parent + apply the
// move delta) — the per-node cost that's float+scalar today and would become
// int16+SIMD (addCol/subCol) under handoff step 2.
func BenchmarkMultiAccPush(b *testing.B) {
	pos := mustBenchFEN(b)
	var ml chess.MoveList
	pos.GenerateLegal(&ml)
	m := ml.Get(0)
	n := RandomMultiNet(0xC0FFEE, 512, 16, 32, 8)
	st := n.NewStack(8)
	st.Reset(pos)
	for i := 0; i < b.N; i++ {
		st.Push(pos, m)
		st.Pop()
	}
}

// BenchmarkInt8Components isolates the two int8-path eval costs at the PoC shape
// (H=512 ⇒ 2H=1024 activation, D2=16 L1 outputs): the u8 activation (quantU8I16,
// scalar) and the L1 matmul (16 × dotU8I8 over 1024). Tells us which to SIMD next.
func BenchmarkInt8Components(b *testing.B) {
	const h = 512
	const in1 = 2 * h
	const d2 = 16
	src := make([]int16, in1)
	for i := range src {
		src[i] = int16((i * 37) % 400) // spans the [0,255] clamp
	}
	aq := make([]uint8, in1)
	w8 := make([]int8, d2*in1)
	for i := range w8 {
		w8[i] = int8((i % 255) - 127)
	}
	b.Run("quantU8I16/1024", func(b *testing.B) {
		for i := 0; i < b.N; i++ {
			quantU8I16(aq, src)
		}
	})
	quantU8I16(aq, src)
	b.Run("dotU8I8x16/1024", func(b *testing.B) {
		var s int32
		for i := 0; i < b.N; i++ {
			for o := 0; o < d2; o++ {
				s += dotU8I8(aq, w8[o*in1:o*in1+in1])
			}
		}
		_ = s
	})
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
