//go:build goexperiment.simd && amd64 && !amd64.v4 && !nnue_neon

package nnue

// amd64 AVX2 SIMD backend for the three NNUE hot kernels, built on Go 1.26's
// experimental simd/archsimd package (GOEXPERIMENT=simd, which auto-sets the
// goexperiment.simd build tag). It repoints the kernel seam (addCol / subCol /
// screluDot in kernels.go) at AVX2-vectorized implementations in init(). This is
// the amd64 counterpart to kernels_simd_arm64.go (NEON); same three kernels,
// same bit-exact semantics, amd64 archsimd intrinsics instead of NEON.
//
// This is the 256-bit AVX2 path, selected for GOAMD64 ≤ v3 (the `!amd64.v4`
// clause). Under GOAMD64=v4 the wider 512-bit AVX-512 backend in
// kernels_simd_amd64_v4.go binds the seam instead; exactly one of the two
// compiles in any build, so they never double-bind.
//
// Build / test / bench (Go 1.26 + experiment REQUIRED; GOAMD64=v3 for AVX2):
//
//	GOEXPERIMENT=simd GOAMD64=v3 go1.26.4 test  ./internal/nnue/
//	GOEXPERIMENT=simd GOAMD64=v3 go1.26.4 test  -race ./internal/nnue/ ./internal/search/
//	GOEXPERIMENT=simd GOAMD64=v3 go1.26.4 vet   ./internal/nnue/
//	GOEXPERIMENT=simd GOAMD64=v3 go1.26.4 test  ./internal/nnue/ -run XXX \
//	    -bench 'EvalIncremental|SCReLUDot|AccumulatorApply' -benchtime 0.5s
//
// The DEFAULT toolchain (go1.25, no experiment) never compiles this file — the
// goexperiment.simd tag is absent — so the shipping scalar seam is untouched.
// The `!nnue_neon` clause keeps this out of the hand-asm PoC build so the two
// backends never double-bind the seam vars in one binary.
//
// AVX2-ONLY: every op below maps to an AVX2 (or earlier) instruction. We
// deliberately avoid the AVX512-only multiplies/shifts that this box also
// happens to support (VPMULLQ Int64x4.Mul, VPSRAQ Int64x4.ShiftAllRight), so the
// binary runs on any AVX2 CPU. The widening int32×int32→int64 product is built
// from VPMULDQ (Int32x8.MulEvenWiden, even lanes) plus a VPSRLQ (AVX2 logical
// 64-bit right shift) to bring the odd lanes into even position — see below.
//
// BIT-EXACT CONTRACT: every kernel here reproduces the scalar reference in
// kernels.go byte-for-byte. TestKernelsMatchScalar asserts equality across
// widths {1,7,8,15,16,31,256,512,513} with kernelBackend == this backend's name.
//
// All three kernels are vectorized:
//
//   - addCol / subCol: int16 Add / Sub, 16 lanes/iter (Int16x16 / VPADDW /
//     VPSUBW) + scalar tail. Integer add/sub is associative ⇒ identical.
//
//   - screluDot: the heavy SCReLU dot. Per element the scalar does
//       c := clamp(int32(acc[i]), 0, qa); out += int64(c*c) * int64(w[i])
//     The vector path reproduces that arithmetic at the SAME int widths,
//     8 elements/iter:
//       1. clamp in int16 via Max(0).Min(qa) — qa=255 ⇒ result in [0,255], so it
//          fits int16 exactly, same value as the scalar int32 clamp.
//       2. sign-extend c int16→int32 (Int16x8.ExtendToInt32, VPMOVSXWD) and
//          square via Int32x8.Mul (VPMULLD). c≤255 ⇒ c*c ≤ 65025 fits int32, so
//          this equals the scalar int32 `c*c` with no overflow.
//       3. sign-extend w int16→int32 (VPMOVSXWD).
//       4. int64(c*c) * int64(w): a true int32×int32→int64 widening multiply.
//          VPMULDQ (MulEvenWiden) multiplies only the EVEN int32 lanes, widening
//          to int64. We run it once on the vectors as-is (even lanes 0,2,4,6) and
//          once after a logical 32-bit right shift inside each 64-bit slot
//          (VPSRLQ), which slides the ODD int32 lanes (1,3,5,7) down into the
//          even positions. MulEvenWiden reads only the low int32 of each 64-bit
//          slot as a *signed* int32, so the logical (zero-fill) shift is correct
//          for both operands: cc≥0 always, and for the possibly-negative w the
//          low 32 bits after the shift are exactly the original odd lane's bit
//          pattern, reinterpreted as signed int32 == the original value. The
//          int64 width is mandatory for bit-exactness (int32×int32 can overflow
//          int32), not an optimization.
//       5. accumulate the int64 lanes; horizontal-sum at the end. int64 add is
//          associative/exact ⇒ reduction order is irrelevant.

import "simd/archsimd"

func init() {
	addCol = addColSIMD
	subCol = subColSIMD
	screluDot = screluDotSIMD
	dotF32 = dotF32SIMD
	screluActivateF = screluActivateFSIMD
	dotU8I8 = dotU8I8SIMD
	kernelBackend = "simd/archsimd-avx2-amd64(addCol,subCol,screluDot,dotF32,screluActivateF,dotU8I8)"
}

// dotU8I8SIMD computes Σ a[i]·w[i] (int32) for MultiNet's int8 L1 matmul via the
// AVX2 VPMADDUBSW (DotProductPairsSaturated, u8×i8 → saturated int16 pairs) then
// VPMADDWD against a vector of 1s (DotProductPairs, int16 pairs → int32), 32
// elements/iter. Bit-identical to dotU8I8Scalar: with activations ≤ int8QA=127 the
// pair sums are ≤127·127·2 = 32258 < 32767 so the int16 saturation NEVER fires
// (the scalar reference models it identically), and the DotProductPairs reduction
// is exact int32. The L1 width (2*H=1024) is a clean multiple of 32; the pair +
// odd tail mirror the scalar reference for any width.
func dotU8I8SIMD(a []uint8, w []int8) int32 {
	n := len(a)
	ones := archsimd.BroadcastInt16x16(1)
	acc := archsimd.BroadcastInt32x8(0)
	i := 0
	for ; i+32 <= n; i += 32 {
		av := archsimd.LoadUint8x32Slice(a[i : i+32])
		wv := archsimd.LoadInt8x32Slice(w[i : i+32])
		pairs := av.DotProductPairsSaturated(wv) // Int16x16 (sat never fires for ≤127)
		acc = acc.Add(pairs.DotProductPairs(ones))
	}
	s := acc.GetLo().Add(acc.GetHi()) // Int32x4
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
// AVX2 Max/Min/Mul, 8 lanes/iter + scalar tail. Bit-exact to the scalar reference.
func screluActivateFSIMD(dst, src []float32) {
	n := len(src)
	zero := archsimd.BroadcastFloat32x8(0)
	one := archsimd.BroadcastFloat32x8(1)
	i := 0
	for ; i+8 <= n; i += 8 {
		x := archsimd.LoadFloat32x8Slice(src[i : i+8]).Max(zero).Min(one)
		x.Mul(x).StoreSlice(dst[i : i+8])
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

// dotF32SIMD computes Σ a[i]·w[i] over float32 slices via AVX2 fused multiply-add
// (VFMADD), 8 lanes/iter. Like the NEON path it uses FOUR independent Float32x8
// accumulators (32 elem/iter) so the FMA dependency chain is broken — a single
// accumulator is latency-bound, four in-flight chains approach throughput. An
// 8-wide tail loop then a scalar tail handle the remainder. Bit-CLOSE (not exact)
// to dotF32Scalar: float add is non-associative ⇒ vector reduction differs by
// float32 rounding only (TestDotF32MatchScalar gate). MultiNet's tail-matmul
// kernel (multilayer.go).
func dotF32SIMD(a, w []float32) float32 {
	n := len(a)
	acc0 := archsimd.BroadcastFloat32x8(0)
	acc1 := archsimd.BroadcastFloat32x8(0)
	acc2 := archsimd.BroadcastFloat32x8(0)
	acc3 := archsimd.BroadcastFloat32x8(0)
	i := 0
	for ; i+32 <= n; i += 32 {
		acc0 = archsimd.LoadFloat32x8Slice(a[i : i+8]).MulAdd(archsimd.LoadFloat32x8Slice(w[i:i+8]), acc0)
		acc1 = archsimd.LoadFloat32x8Slice(a[i+8 : i+16]).MulAdd(archsimd.LoadFloat32x8Slice(w[i+8:i+16]), acc1)
		acc2 = archsimd.LoadFloat32x8Slice(a[i+16 : i+24]).MulAdd(archsimd.LoadFloat32x8Slice(w[i+16:i+24]), acc2)
		acc3 = archsimd.LoadFloat32x8Slice(a[i+24 : i+32]).MulAdd(archsimd.LoadFloat32x8Slice(w[i+24:i+32]), acc3)
	}
	acc := acc0.Add(acc1).Add(acc2.Add(acc3)) // Float32x8
	for ; i+8 <= n; i += 8 {
		acc = archsimd.LoadFloat32x8Slice(a[i : i+8]).MulAdd(archsimd.LoadFloat32x8Slice(w[i:i+8]), acc)
	}
	q := acc.GetLo().Add(acc.GetHi()) // Float32x4
	out := q.GetElem(0) + q.GetElem(1) + q.GetElem(2) + q.GetElem(3)
	for ; i < n; i++ {
		out += a[i] * w[i]
	}
	return out
}

// addColSIMD: dst[j] += src[j], 16 int16 lanes/iter + scalar tail.
func addColSIMD(dst, src []int16) {
	n := len(dst)
	i := 0
	for ; i+16 <= n; i += 16 {
		d := archsimd.LoadInt16x16Slice(dst[i : i+16])
		s := archsimd.LoadInt16x16Slice(src[i : i+16])
		d.Add(s).StoreSlice(dst[i : i+16])
	}
	for ; i < n; i++ {
		dst[i] += src[i]
	}
}

// subColSIMD: dst[j] -= src[j], 16 int16 lanes/iter + scalar tail.
func subColSIMD(dst, src []int16) {
	n := len(dst)
	i := 0
	for ; i+16 <= n; i += 16 {
		d := archsimd.LoadInt16x16Slice(dst[i : i+16])
		s := archsimd.LoadInt16x16Slice(src[i : i+16])
		d.Sub(s).StoreSlice(dst[i : i+16])
	}
	for ; i < n; i++ {
		dst[i] -= src[i]
	}
}

// screluDotSIMD computes Σ_i clamp(acc[i],0,qa)² · w[i] as int64, bit-identical
// to screluDotScalar. Processes 8 elements/iter (one Int16x8 → Int32x8); a
// scalar tail handles the remainder (the test exercises widths 1,7,15,31,513).
func screluDotSIMD(acc, w []int16, qa int32) int64 {
	n := len(acc)
	zero16 := archsimd.BroadcastInt16x8(0)
	qa16 := archsimd.BroadcastInt16x8(int16(qa)) // qa=255 fits int16
	accEven := archsimd.BroadcastInt64x4(0)      // running int64 lanes (even)
	accOdd := archsimd.BroadcastInt64x4(0)       // running int64 lanes (odd)

	i := 0
	for ; i+8 <= n; i += 8 {
		a := archsimd.LoadInt16x8Slice(acc[i : i+8])
		wv := archsimd.LoadInt16x8Slice(w[i : i+8])

		// clamp(a, 0, qa) in int16: Max(0) then Min(qa). qa=255 ⇒ result in
		// [0,255], identical to the scalar int32 clamp.
		c := a.Max(zero16).Min(qa16)

		// square: sign-extend c int16→int32, then c*c as int32 (c≤255 ⇒ ≤65025,
		// fits int32 with no overflow ⇒ == scalar int32 c*c).
		c32 := c.ExtendToInt32() // Int32x8
		cc := c32.Mul(c32)       // Int32x8: c0² .. c7² (all ≥0, ≤65025)

		// widen w int16→int32 (sign-extend).
		w32 := wv.ExtendToInt32() // Int32x8

		// int64(c*c) * int64(w) via VPMULDQ on even lanes, twice:
		//   even lanes 0,2,4,6 directly;
		//   odd lanes 1,3,5,7 slid to even position by a logical 64-bit >>32.
		ccOdd := cc.AsUint64x4().ShiftAllRight(32).AsInt32x8()
		w32Odd := w32.AsUint64x4().ShiftAllRight(32).AsInt32x8()

		accEven = accEven.Add(cc.MulEvenWiden(w32))        // Int64x4
		accOdd = accOdd.Add(ccOdd.MulEvenWiden(w32Odd))    // Int64x4
	}

	// horizontal-sum the int64 lanes (int64 add is exact/associative).
	sum := accEven.Add(accOdd)
	lo := sum.GetLo() // Int64x2
	hi := sum.GetHi() // Int64x2
	out := lo.GetElem(0) + lo.GetElem(1) + hi.GetElem(0) + hi.GetElem(1)

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
