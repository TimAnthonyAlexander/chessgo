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
	dotF32 = dotF32SIMD
	screluActivateF = screluActivateFSIMD
	dotU8I8 = dotU8I8SIMD
	quantU8I16 = quantU8I16SIMD
	kernelBackend = "simd/archsimd-avx512-amd64(addCol,subCol,screluDot,dotF32,screluActivateF,dotU8I8,quantU8I16)"
}

// quantU8I16SIMD is the int8-path FT activation on AVX-512, 16 int16/iter: clamp
// the accumulator to [0,ftQA], widen to int32, square, (·+ftRound)>>ftShift, and
// narrow int32→u8 via VPMOVUSDB (Uint32x16.SaturateToUint8 — no lane crossing, the
// reason this is clean on AVX-512). Bit-identical to quantU8I16Scalar: all values
// stay in [0,127] so the unsigned-saturate narrow is exact, and arithmetic shift
// == logical for the non-negative square. This was the dominant scalar cost
// (~2.5 µs/eval); SIMD makes the multilayer int8 eval movetime-competitive.
func quantU8I16SIMD(dst []uint8, src []int16) {
	n := len(src)
	zero := archsimd.BroadcastInt16x16(0)
	cap255 := archsimd.BroadcastInt16x16(int16(ftQA))
	round := archsimd.BroadcastInt32x16(ftRound)
	i := 0
	for ; i+16 <= n; i += 16 {
		a := archsimd.LoadInt16x16Slice(src[i : i+16])
		c := a.Max(zero).Min(cap255)              // Int16x16 ∈ [0,ftQA]
		c32 := c.ExtendToInt32()                  // Int32x16
		cc := c32.Mul(c32)                        // Int32x16 ∈ [0,ftQA²]
		r := cc.Add(round).ShiftAllRight(ftShift) // (c²+ftRound)>>ftShift ∈ [0,int8QA]
		r.AsUint32x16().SaturateToUint8().StoreSlice(dst[i : i+16])
	}
	for ; i < n; i++ { // scalar tail — identical to quantU8I16Scalar
		c := int32(src[i])
		if c < 0 {
			c = 0
		} else if c > ftQA {
			c = ftQA
		}
		dst[i] = uint8((c*c + ftRound) >> ftShift)
	}
}

// dotU8I8SIMD computes Σ a[i]·w[i] (int32) for MultiNet's int8 L1 matmul via the
// AVX-512 VPMADDUBSW (DotProductPairsSaturated on zmm, u8×i8 → saturated int16)
// then VPMADDWD against 1s (DotProductPairs → int32), 64 elements/iter — the
// widest int8 path, so the L1 dot (2*H=1024) runs in 16 iters. Bit-identical to
// dotU8I8Scalar: activations ≤ int8QA=127 ⇒ pair sums ≤32258 < 32767 ⇒ saturation
// never fires; the int32 reduction is exact.
func dotU8I8SIMD(a []uint8, w []int8) int32 {
	n := len(a)
	ones := archsimd.BroadcastInt16x32(1)
	acc := archsimd.BroadcastInt32x16(0)
	i := 0
	for ; i+64 <= n; i += 64 {
		av := archsimd.LoadUint8x64Slice(a[i : i+64])
		wv := archsimd.LoadInt8x64Slice(w[i : i+64])
		pairs := av.DotProductPairsSaturated(wv) // Int16x32 (sat never fires for ≤127)
		acc = acc.Add(pairs.DotProductPairs(ones))
	}
	s8 := acc.GetLo().Add(acc.GetHi()) // Int32x8
	s := s8.GetLo().Add(s8.GetHi())    // Int32x4
	out := s.GetElem(0) + s.GetElem(1) + s.GetElem(2) + s.GetElem(3)
	for ; i+2 <= n; i += 2 {
		p := int32(a[i])*int32(w[i]) + int32(a[i+1])*int32(w[i+1])
		if p > 32767 {
			p = 32767
		} else if p < -32768 {
			p = -32768
		}
		out += p
	}
	if i < n {
		out += int32(a[i]) * int32(w[i])
	}
	return out
}

// screluActivateFSIMD applies SCReLU (clamp [0,1] then square) elementwise via
// AVX-512 Max/Min/Mul, 16 lanes/iter + scalar tail. Bit-exact to the scalar ref.
func screluActivateFSIMD(dst, src []float32) {
	n := len(src)
	zero := archsimd.BroadcastFloat32x16(0)
	one := archsimd.BroadcastFloat32x16(1)
	i := 0
	for ; i+16 <= n; i += 16 {
		x := archsimd.LoadFloat32x16Slice(src[i : i+16]).Max(zero).Min(one)
		x.Mul(x).StoreSlice(dst[i : i+16])
	}
	for ; i < n; i++ {
		x := src[i]
		if x < 0 {
			x = 0
		} else if x > 1 {
			x = 1
		}
		dst[i] = x * x
	}
}

// dotF32SIMD computes Σ a[i]·w[i] over float32 slices via AVX-512 fused
// multiply-add (VFMADD on zmm), 16 lanes/iter. FOUR independent Float32x16
// accumulators (64 elem/iter) break the FMA dependency chain (single-acc is
// latency-bound). A 16-wide tail loop then a scalar tail handle the remainder.
// Bit-CLOSE (not exact) to dotF32Scalar — float add is non-associative, so the
// vector reduction differs by float32 rounding only (TestDotF32MatchScalar gate).
// MultiNet's tail-matmul kernel (multilayer.go); this is the widest backend, so
// the L1 dot (2*H=1024) runs in 16 FMA iters across 4 chains.
func dotF32SIMD(a, w []float32) float32 {
	n := len(a)
	acc0 := archsimd.BroadcastFloat32x16(0)
	acc1 := archsimd.BroadcastFloat32x16(0)
	acc2 := archsimd.BroadcastFloat32x16(0)
	acc3 := archsimd.BroadcastFloat32x16(0)
	i := 0
	for ; i+64 <= n; i += 64 {
		acc0 = archsimd.LoadFloat32x16Slice(a[i : i+16]).MulAdd(archsimd.LoadFloat32x16Slice(w[i:i+16]), acc0)
		acc1 = archsimd.LoadFloat32x16Slice(a[i+16 : i+32]).MulAdd(archsimd.LoadFloat32x16Slice(w[i+16:i+32]), acc1)
		acc2 = archsimd.LoadFloat32x16Slice(a[i+32 : i+48]).MulAdd(archsimd.LoadFloat32x16Slice(w[i+32:i+48]), acc2)
		acc3 = archsimd.LoadFloat32x16Slice(a[i+48 : i+64]).MulAdd(archsimd.LoadFloat32x16Slice(w[i+48:i+64]), acc3)
	}
	acc := acc0.Add(acc1).Add(acc2.Add(acc3)) // Float32x16
	for ; i+16 <= n; i += 16 {
		acc = archsimd.LoadFloat32x16Slice(a[i : i+16]).MulAdd(archsimd.LoadFloat32x16Slice(w[i:i+16]), acc)
	}
	h8 := acc.GetLo().Add(acc.GetHi()) // Float32x8
	q := h8.GetLo().Add(h8.GetHi())    // Float32x4
	out := q.GetElem(0) + q.GetElem(1) + q.GetElem(2) + q.GetElem(3)
	for ; i < n; i++ {
		out += a[i] * w[i]
	}
	return out
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
