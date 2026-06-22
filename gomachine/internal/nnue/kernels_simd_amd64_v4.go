//go:build goexperiment.simd && amd64.v4 && !nnue_neon

package nnue

// amd64 AVX-512 SIMD backend for the NNUE hot kernels — the 512-bit-wide
// counterpart to kernels_simd_amd64.go (AVX2). Built ONLY under GOAMD64=v4 (the
// amd64.v4 build tag), so it requires an AVX-512-capable CPU (avx512f + avx512bw
// + avx512vl + avx512dq); on the prod box (AMD Zen 4 EPYC) those are all present.
// The AVX2 file now carries `!amd64.v4`, so EXACTLY ONE of the two binds the
// kernel seam (addCol/subCol/screluDot in kernels.go) in any given build.
//
// Build / test / bench (Go 1.26 + experiment + GOAMD64=v4):
//
//	GOEXPERIMENT=simd GOAMD64=v4 go1.26.4 test  ./internal/nnue/
//	GOEXPERIMENT=simd GOAMD64=v4 go1.26.4 test  -race ./internal/nnue/ ./internal/search/
//	GOEXPERIMENT=simd GOAMD64=v4 go1.26.4 test  ./internal/nnue/ -run XXX \
//	    -bench 'SCReLUDot|AccumulatorApply|EvalIncremental' -benchtime 0.5s
//
// vs the AVX2 path: addCol/subCol do 32 int16 lanes/iter (Int16x32, VPADDW/
// VPSUBW on zmm) instead of 16; screluDot does 16 elements/iter (Int16x16 →
// Int32x16) instead of 8, and uses the AVX-512 int64 multiply (Int64x8.Mul =
// VPMULLQ) for the int32×int32→int64 widening instead of the AVX2 even/odd
// VPMULDQ+VPSRLQ dance — wider and simpler.
//
// BIT-EXACT CONTRACT (non-negotiable): identical to addColScalar/subColScalar/
// screluDotScalar in kernels.go for all inputs. clamp is the same int16
// Max(0).Min(qa); c*c is the same int32 product (c≤qa=255 ⇒ ≤65025, no overflow);
// int64(c*c)·int64(w) is a true 64-bit product (VPMULLQ, cc≥0 and w both
// sign-extended) with no rounding; int64 add is associative ⇒ any reduction
// order matches. TestKernelsMatchScalar gates this at widths
// {1,7,8,15,16,31,256,512,513} with kernelBackend == this backend's name.

import "simd/archsimd"

func init() {
	addCol = addColSIMD
	subCol = subColSIMD
	screluDot = screluDotSIMD
	kernelBackend = "simd/archsimd-avx512-amd64(addCol,subCol,screluDot)"
}

// addColSIMD: dst[j] += src[j], 32 int16 lanes/iter + scalar tail.
func addColSIMD(dst, src []int16) {
	n := len(dst)
	i := 0
	for ; i+32 <= n; i += 32 {
		d := archsimd.LoadInt16x32Slice(dst[i : i+32])
		s := archsimd.LoadInt16x32Slice(src[i : i+32])
		d.Add(s).StoreSlice(dst[i : i+32])
	}
	for ; i < n; i++ {
		dst[i] += src[i]
	}
}

// subColSIMD: dst[j] -= src[j], 32 int16 lanes/iter + scalar tail.
func subColSIMD(dst, src []int16) {
	n := len(dst)
	i := 0
	for ; i+32 <= n; i += 32 {
		d := archsimd.LoadInt16x32Slice(dst[i : i+32])
		s := archsimd.LoadInt16x32Slice(src[i : i+32])
		d.Sub(s).StoreSlice(dst[i : i+32])
	}
	for ; i < n; i++ {
		dst[i] -= src[i]
	}
}

// screluDotSIMD computes Σ_i clamp(acc[i],0,qa)² · w[i] as int64, bit-identical
// to screluDotScalar. 16 elements/iter (one Int16x16 → Int32x16); a scalar tail
// handles the remainder (the test exercises widths 1,7,15,31,513).
func screluDotSIMD(acc, w []int16, qa int32) int64 {
	n := len(acc)
	zero16 := archsimd.BroadcastInt16x16(0)
	qa16 := archsimd.BroadcastInt16x16(int16(qa)) // qa=255 fits int16
	acc64 := archsimd.BroadcastInt64x8(0)         // running int64 lanes

	i := 0
	for ; i+16 <= n; i += 16 {
		a := archsimd.LoadInt16x16Slice(acc[i : i+16])
		wv := archsimd.LoadInt16x16Slice(w[i : i+16])

		// clamp(a, 0, qa) in int16: Max(0) then Min(qa). qa=255 ⇒ result in
		// [0,255], identical to the scalar int32 clamp.
		c := a.Max(zero16).Min(qa16) // Int16x16

		// square: sign-extend c int16→int32, then c*c as int32 (c≤255 ⇒ ≤65025,
		// fits int32 ⇒ == scalar int32 c*c).
		c32 := c.ExtendToInt32() // Int32x16
		cc := c32.Mul(c32)       // Int32x16, all ≥0, ≤65025

		// widen w int16→int32 (sign-extend).
		w32 := wv.ExtendToInt32() // Int32x16

		// int64(c*c) · int64(w): sign-extend both int32 halves to int64 and do a
		// true 64-bit multiply (VPMULLQ). cc≥0 ⇒ sign-extend == value; w is the
		// already-sign-extended weight ⇒ exact. |cc·w| ≤ 65025·32767 < 2^31·...
		// well within int64. Equals the scalar int64(c*c)·int64(w) exactly.
		ccLo := cc.GetLo().ExtendToInt64() // Int64x8
		ccHi := cc.GetHi().ExtendToInt64() // Int64x8
		wLo := w32.GetLo().ExtendToInt64() // Int64x8
		wHi := w32.GetHi().ExtendToInt64() // Int64x8
		acc64 = acc64.Add(ccLo.Mul(wLo)).Add(ccHi.Mul(wHi))
	}

	// horizontal-sum the 8 int64 lanes (int64 add is exact/associative).
	s4 := acc64.GetLo().Add(acc64.GetHi()) // Int64x4
	loB := s4.GetLo()                      // Int64x2
	hiB := s4.GetHi()                      // Int64x2
	out := loB.GetElem(0) + loB.GetElem(1) + hiB.GetElem(0) + hiB.GetElem(1)

	// scalar tail — identical arithmetic to screluDotScalar.
	for ; i < n; i++ {
		c := int32(acc[i])
		if c < 0 {
			c = 0
		} else if c > qa {
			c = qa
		}
		out += int64(c*c) * int64(w[i])
	}
	return out
}
