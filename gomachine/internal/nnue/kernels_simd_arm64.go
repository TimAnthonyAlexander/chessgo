//go:build goexperiment.simd && arm64 && !nnue_neon

package nnue

// ARM64 NEON SIMD backend for the three NNUE hot kernels, built on Go 1.27's
// experimental simd/archsimd package (GOEXPERIMENT=simd, which auto-sets the
// goexperiment.simd build tag). It repoints the kernel seam (addCol / subCol /
// screluDot in kernels.go) at NEON-vectorized implementations in init().
//
// Build / test / bench (RC toolchain + experiment REQUIRED):
//
//	GOEXPERIMENT=simd go1.27rc1 test  ./internal/nnue/
//	GOEXPERIMENT=simd go1.27rc1 test  -race ./internal/nnue/ ./internal/search/
//	GOEXPERIMENT=simd go1.27rc1 test  ./internal/nnue/ -run XXX \
//	    -bench 'EvalIncremental|SCReLUDot|AccumulatorApply' -benchtime 0.5s
//
// The DEFAULT toolchain (go1.25, no experiment) never compiles this file — the
// goexperiment.simd tag is absent — so the shipping scalar seam is untouched.
// The `!nnue_neon` clause keeps this out of the hand-asm PoC build so the two
// backends never double-bind the seam vars in one binary.
//
// BIT-EXACT CONTRACT: every kernel here reproduces the scalar reference in
// kernels.go byte-for-byte. NEON is baseline-mandatory on arm64, so there is no
// runtime feature gate. TestKernelsMatchScalar asserts equality across widths
// {1,7,8,15,16,31,256,512,513} with kernelBackend == this backend's name.
//
// All three kernels are vectorized:
//
//   - addCol / subCol: int16 Add / Sub, 8 lanes/iter (Int16x8) + scalar tail.
//     Integer add/sub is associative ⇒ any lane order is trivially identical.
//
//   - screluDot: the heavy SCReLU dot. Per element the scalar does
//       c := clamp(int32(acc[i]), 0, qa); out += int64(c*c) * int64(w[i])
//     The vector path reproduces that arithmetic at the SAME int widths:
//       1. clamp in int16 via Max(0).Min(qa)  — qa=255 ⇒ result in [0,255],
//          so it fits int16 exactly, same value as the scalar int32 clamp.
//       2. square via Int16x8.MulWidenLo → Int32x4 (low/high halves through
//          HiToLo). c≤255 ⇒ c*c ≤ 65025 fits int32, == scalar int32 `c*c`.
//       3. widen w int16→int32 (ExtendLo4ToInt32) and do Int32x4.MulWidenLo →
//          Int64x2, i.e. int64(c*c)*int64(w) at int64 width — same as scalar
//          (the int32×int32 product can exceed int32, so the int64 widen is
//          mandatory for bit-exactness, not an optimization).
//       4. accumulate the int64 lanes; horizontal-sum at the end. int64 add is
//          associative/exact ⇒ reduction order is irrelevant.

import "simd/archsimd"

func init() {
	addCol = addColSIMD
	subCol = subColSIMD
	screluDot = screluDotSIMD
	kernelBackend = "simd/archsimd-neon-arm64(addCol,subCol,screluDot)"
}

// addColSIMD: dst[j] += src[j], 8 int16 lanes/iter + scalar tail.
func addColSIMD(dst, src []int16) {
	n := len(dst)
	i := 0
	for ; i+8 <= n; i += 8 {
		d := archsimd.LoadInt16x8(dst[i : i+8])
		s := archsimd.LoadInt16x8(src[i : i+8])
		d.Add(s).Store(dst[i : i+8])
	}
	for ; i < n; i++ {
		dst[i] += src[i]
	}
}

// subColSIMD: dst[j] -= src[j], 8 int16 lanes/iter + scalar tail.
func subColSIMD(dst, src []int16) {
	n := len(dst)
	i := 0
	for ; i+8 <= n; i += 8 {
		d := archsimd.LoadInt16x8(dst[i : i+8])
		s := archsimd.LoadInt16x8(src[i : i+8])
		d.Sub(s).Store(dst[i : i+8])
	}
	for ; i < n; i++ {
		dst[i] -= src[i]
	}
}

// screluDotSIMD computes Σ_i clamp(acc[i],0,qa)² · w[i] as int64, bit-identical
// to screluDotScalar. Processes 8 elements/iter; a scalar tail handles the
// remainder (the test exercises widths 1,7,15,31,513).
func screluDotSIMD(acc, w []int16, qa int32) int64 {
	n := len(acc)
	zero16 := archsimd.BroadcastInt16x8(0)
	qa16 := archsimd.BroadcastInt16x8(int16(qa)) // qa=255 fits int16
	accum := archsimd.BroadcastInt64x2(0)        // 2 running int64 lanes

	i := 0
	for ; i+8 <= n; i += 8 {
		a := archsimd.LoadInt16x8(acc[i : i+8])
		wv := archsimd.LoadInt16x8(w[i : i+8])

		// clamp(a, 0, qa) in int16: Max(0) then Min(qa). qa=255 ⇒ result in
		// [0,255], identical to the scalar int32 clamp.
		c := a.Max(zero16).Min(qa16)

		// square: c*c as int32, low 4 then high 4 lanes (c≤255 ⇒ no overflow).
		ccLo := c.MulWidenLo(c)                 // Int32x4: c0² c1² c2² c3²
		cHi := c.HiToLo()                       //
		ccHi := cHi.MulWidenLo(cHi)             // Int32x4: c4² c5² c6² c7²

		// widen w int16→int32 (sign-extend), low 4 then high 4.
		wLo := wv.ExtendLo4ToInt32()
		wHi := wv.HiToLo().ExtendLo4ToInt32()

		// int64(c*c) * int64(w): int32×int32 → int64 widening multiply, low 2
		// then high 2 of each Int32x4. This is the int64 width the scalar uses.
		p0 := ccLo.MulWidenLo(wLo)              // lanes 0,1
		p1 := ccLo.HiToLo().MulWidenLo(wLo.HiToLo()) // lanes 2,3
		p2 := ccHi.MulWidenLo(wHi)             // lanes 4,5
		p3 := ccHi.HiToLo().MulWidenLo(wHi.HiToLo()) // lanes 6,7

		accum = accum.Add(p0).Add(p1).Add(p2).Add(p3)
	}

	// horizontal-sum the 2 int64 lanes (int64 add is exact/associative).
	out := accum.GetElem(0) + accum.GetElem(1)

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
