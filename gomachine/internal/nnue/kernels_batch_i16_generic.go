//go:build !goexperiment.simd || !arm64 || nnue_neon

package nnue

// Generic (non arm64-SIMD) side of the int16 batch-apply seam.
//
// useI16Batch is COMPILE-TIME false everywhere except the arm64 NEON SIMD build,
// so the directApply call site branch that reaches applyBatchI16 is dead-code-
// eliminated on amd64 / scalar / hand-asm builds — those keep the per-column
// ftSub/ftAdd path BYTE-IDENTICALLY (provably untouched). This was a MEASURED loss
// on amd64 (compute-bound, ENGINE_STRENGTH §30.3), so amd64 must stay per-column.
//
// applyBatchI16 is still defined (never called when useI16Batch is false) as a
// correct SCALAR reference: it lets TestApplyBatchI16Equiv run on any toolchain and
// documents the exact arithmetic the NEON kernel reproduces. Batched == per-column
// because int16 add/sub is associative + commutative under two's-complement
// wraparound, so reordering the sub/add columns and deferring the store is exact.
const useI16Batch = false

// applyBatchI16 (scalar reference): for each accumulator lane, subtract every subF
// column's weight and add every addF column's weight, from the int16 FT table w0i
// (column f at w0i[f*h : f*h+h]). Result is identical to applying each column with a
// separate ftSub/ftAdd pass.
func applyBatchI16(acc, w0i []int16, h int, subF, addF []uint32) {
	for i := 0; i < h; i++ {
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
