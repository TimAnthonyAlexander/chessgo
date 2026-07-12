//go:build goexperiment.simd && arm64 && !nnue_neon

package nnue

// ARM64 NEON int16 batch-apply kernel — an arm64-ONLY NPS optimization for the
// int16 directApply accumulator path (the prod full-threats config: int16 threat
// FT, so int8FT == false; enriched_acc.go applyDiff's directApply branch).
//
// WHY (arm SIMD profile, docs/profiling 11Jul2026): ~13.5% of runtime sits in
// narrow int16 accumulator load/store (Int16x8.Store 8.4% + LoadInt16x8 5.1%) plus
// addColSIMD/subColSIMD ~9%. The per-column directApply path applies each changed
// column with a SEPARATE pass — load acc tile, add/sub ONE column, store tile — so
// dozens of columns/move = dozens of load+store round-trips over the SAME
// accumulator. This kernel loads each 8-lane tile ONCE, folds ALL sub columns then
// ALL add columns for that tile, and stores ONCE — amortizing the load/store.
//
// BIT-EXACT: same math as the per-column addColSIMD/subColSIMD, only reordered and
// with the intermediate stores dropped. int16 add/sub is associative + commutative
// under two's-complement wraparound (each Int16x8 lane wraps mod 2^16 exactly like
// the scalar int16), so keeping the tile in a register across the whole batch is
// byte-for-byte identical to the sequential per-column passes. Gated by
// TestApplyBatchI16Equiv (kernel vs scalar reference) and TestBatchI16EquivEval
// (end-to-end directApply-on vs counts path). Structural twin of applyThreatBatchSIMD
// (the int8 batch), int16 here instead of int8-widened.
//
// amd64 keeps per-column (useI16Batch == false there): batching was MEASURED WORSE
// on amd64 (compute-bound, ENGINE_STRENGTH §30.3). This file is the ONLY place
// useI16Batch is true, so only the arm64 NEON build changes behavior.

import "simd/archsimd"

const useI16Batch = true

// applyBatchI16 loads each 8-int16-lane accumulator tile once, subtracts every subF
// column and adds every addF column (each column f at w0i[f*h : f*h+h]) into the
// held tile, then stores once. i+8<=h guards each column read from running off w0i;
// the ≤7-element tail is scalar. Bit-exact to the per-column ftSub/ftAdd sequence.
func applyBatchI16(acc, w0i []int16, h int, subF, addF []uint32) {
	i := 0
	for ; i+8 <= h; i += 8 {
		d := archsimd.LoadInt16x8(acc[i : i+8])
		for _, f := range addF {
			b := int(f) * h
			d = d.Add(archsimd.LoadInt16x8(w0i[b+i : b+i+8]))
		}
		for _, f := range subF {
			b := int(f) * h
			d = d.Sub(archsimd.LoadInt16x8(w0i[b+i : b+i+8]))
		}
		d.Store(acc[i : i+8])
	}
	for ; i < h; i++ {
		var d int16
		for _, f := range addF {
			d += w0i[int(f)*h+i]
		}
		for _, f := range subF {
			d -= w0i[int(f)*h+i]
		}
		acc[i] += d
	}
}
