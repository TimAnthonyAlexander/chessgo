//go:build goexperiment.simd

package nnue

import (
	"math/rand"
	"testing"

	"simd/archsimd"
)

// Microbenchmark: apply K int8 threat columns to an int16 accumulator (H wide).
// Sequential = the current path (one full acc load+store pass PER column, as
// ftAdd/ftSub do). Batched = hold each 8-lane acc tile in a register, loop over
// all K columns, store once — turning K acc load+store passes into one.
//
// Both must produce byte-identical accumulators (asserted in TestBatchApplyMatch).
// This de-risks the hot-path rewrite: if batched isn't clearly faster here, the
// integration isn't worth it.

const benchH = 512

func makeCols(k, h int) [][]int8 {
	r := rand.New(rand.NewSource(1))
	cols := make([][]int8, k)
	for i := range cols {
		c := make([]int8, h)
		for j := range c {
			c[j] = int8(r.Intn(255) - 127)
		}
		cols[i] = c
	}
	return cols
}

// seqApplyI8 mirrors K sequential addColI8SIMD calls (the current applyDiff path).
func seqApplyI8(acc []int16, cols [][]int8) {
	for _, c := range cols {
		addColI8SIMD(acc, c)
	}
}

// batchApplyI8 loads each 8-int16 acc tile once, adds all K columns into it, stores
// once. Bit-exact to seqApplyI8 (int16 add is associative). 16-byte int8 loads use
// the low 8 lanes (same widening the per-column kernel uses), guarded by i+16<=n.
func batchApplyI8(acc []int16, cols [][]int8) {
	n := len(acc)
	i := 0
	for ; i+16 <= n; i += 8 {
		d := archsimd.LoadInt16x8(acc[i : i+8])
		for _, c := range cols {
			s := archsimd.LoadInt8x16(c[i : i+16]).ExtendLo8ToInt16()
			d = d.Add(s)
		}
		d.Store(acc[i : i+8])
	}
	for ; i < n; i++ {
		var sum int16
		for _, c := range cols {
			sum += int16(c[i])
		}
		acc[i] += sum
	}
}

func TestBatchApplyMatch(t *testing.T) {
	for _, k := range []int{1, 3, 16, 31, 40} {
		cols := makeCols(k, benchH)
		a1 := make([]int16, benchH)
		a2 := make([]int16, benchH)
		for i := range a1 {
			a1[i] = int16(i*7 - 100)
			a2[i] = a1[i]
		}
		seqApplyI8(a1, cols)
		batchApplyI8(a2, cols)
		for i := range a1 {
			if a1[i] != a2[i] {
				t.Fatalf("k=%d idx=%d: seq=%d batch=%d", k, i, a1[i], a2[i])
			}
		}
	}
}

func benchApply(b *testing.B, k int, batched bool) {
	cols := makeCols(k, benchH)
	acc := make([]int16, benchH)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if batched {
			batchApplyI8(acc, cols)
		} else {
			seqApplyI8(acc, cols)
		}
	}
}

func BenchmarkApplySeqK20(b *testing.B)   { benchApply(b, 20, false) }
func BenchmarkApplyBatchK20(b *testing.B) { benchApply(b, 20, true) }
func BenchmarkApplySeqK40(b *testing.B)   { benchApply(b, 40, false) }
func BenchmarkApplyBatchK40(b *testing.B) { benchApply(b, 40, true) }
