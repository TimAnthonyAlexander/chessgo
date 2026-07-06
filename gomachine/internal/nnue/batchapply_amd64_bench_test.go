//go:build goexperiment.simd && amd64

package nnue

import (
	"math/rand"
	"testing"
)

// Isolated amd64 A/B for the int8 threat-column accumulator apply: the arm64
// microbench (batchapply_bench_test.go) is arm64-tagged, so no isolated amd64
// number ever existed — only whole-engine NPS. Seq = K full acc load+store passes
// (one per column, as ftAdd does via addColI8SIMD). Batch = one acc load+store per
// 32-lane block, all K columns folded inside (applyThreatBatchSIMD). Both add the
// same K columns → identical acc; any delta is pure memory-traffic vs compute.
//
// Result (coalla EPYC 9634 / Zen 4, 2026-07-07): Batch is +10–13% SLOWER despite
// far fewer acc load/stores → the kernel is L1-resident + near-peak IPC (5.5–5.9),
// i.e. compute/throughput-bound, NOT memory-bound. Do not ship batch/fuse on amd64.
// See docs/ENGINE_STRENGTH.md §30.3.
const benchAmdH = 512

func makeAmdCols(k, h int) (w0t8 []int8, feats []uint16) {
	rng := rand.New(rand.NewSource(1))
	w0t8 = make([]int8, k*h)
	for i := range w0t8 {
		w0t8[i] = int8(rng.Intn(51) - 25)
	}
	feats = make([]uint16, k)
	for i := range feats {
		feats[i] = uint16(i) // off=0 → column base = i*h
	}
	return
}

func benchAmdApply(b *testing.B, k int, batched bool) {
	w0t8, feats := makeAmdCols(k, benchAmdH)
	acc := make([]int16, benchAmdH)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if batched {
			applyThreatBatchSIMD(acc, w0t8, benchAmdH, nil, feats, 0)
		} else {
			for _, f := range feats {
				base := int(f) * benchAmdH
				addColI8SIMD(acc, w0t8[base:base+benchAmdH])
			}
		}
	}
}

func BenchmarkAmdApplySeqK20(b *testing.B)   { benchAmdApply(b, 20, false) }
func BenchmarkAmdApplyBatchK20(b *testing.B) { benchAmdApply(b, 20, true) }
func BenchmarkAmdApplySeqK40(b *testing.B)   { benchAmdApply(b, 40, false) }
func BenchmarkAmdApplyBatchK40(b *testing.B) { benchAmdApply(b, 40, true) }
