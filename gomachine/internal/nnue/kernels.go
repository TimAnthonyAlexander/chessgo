package nnue

// The two hot NNUE inference loops, isolated behind a narrow function seam so a
// SIMD (ARM64 NEON) implementation can drop in later without touching the
// accumulator/eval logic. There are exactly two kernels:
//
//   1. addCol / subCol — the feature-transformer update: add (or subtract) one
//      feature's int16 column to/from an int16 accumulator half. Runs ~1–4× per
//      make/unmake (see apply). Pure int16 add/sub over HL elements.
//
//   2. screluDot — the integer SCReLU output dot for ONE perspective half:
//      clamp int16 to [0,QA], square (int32), multiply by the int16 output
//      weight, accumulate into int64, over HL elements. Runs once per half (so
//      twice per eval) and is the heaviest loop (a multiply-square per element).
//
// These are the ONLY two functions a SIMD backend needs to provide. The seam is
// the package-level function VALUES `addCol`, `subCol`, `screluDot` below: the
// scalar build (kernels_generic.go, default) points them at the pure-Go
// implementations; a future `//go:build arm64 && nnue_neon` file can repoint
// them at NEON assembly (kernels_arm64.s + a kernels_arm64.go decl). Because the
// bindings are vars chosen at init by build tag — not a runtime branch in the
// hot loop — there is zero per-call dispatch cost.
//
// BIT-EXACT CONTRACT (non-negotiable): every backend MUST be byte-for-byte
// identical to the scalar reference for all inputs. Integer adds are
// associative, so a correct vectorized add/sub is trivially identical; the dot
// accumulates into int64 with no intermediate rounding, so any correct
// reduction order is identical too (int is exact). TestKernelsMatchScalar
// (kernels_test.go) is the gate that asserts this for any non-scalar build.

// addColScalar adds src[0:n] into dst[0:n] elementwise (int16 wraparound, same
// as Go's +). dst and src are len-n slices (n == net HL).
func addColScalar(dst, src []int16) {
	for j := range dst {
		dst[j] += src[j]
	}
}

// subColScalar subtracts src[0:n] from dst[0:n] elementwise.
func subColScalar(dst, src []int16) {
	for j := range dst {
		dst[j] -= src[j]
	}
}

// addColI8Scalar adds an INT8 weight column into the int16 accumulator, widening
// each int8 to int16 first. This is the enriched net's threat-column update: the
// (huge) threat weight table is stored int8 to halve the per-move addCol memory
// traffic (the dominant cost of the threat accumulator), while the accumulator
// stays int16. Result is identical to an int16 addCol of the widened column, so it
// composes with subCol etc. on the same accumulator.
func addColI8Scalar(dst []int16, src []int8) {
	for j := range dst {
		dst[j] += int16(src[j])
	}
}

// subColI8Scalar subtracts a widened int8 weight column from the int16 accumulator.
func subColI8Scalar(dst []int16, src []int8) {
	for j := range dst {
		dst[j] -= int16(src[j])
	}
}

// screluDotScalar computes Σ_i clamp(acc[i],0,qa)² · w[i] as int64, over the
// whole acc/w slice (len == net HL). This is exactly the per-half body of the
// old evalFrom; summing the two halves (stm then opp) reproduces the int forward
// bit-for-bit. acc is one perspective half; w is the matching W1i sub-slice.
func screluDotScalar(acc, w []int16, qa int32) int64 {
	var out int64
	for i := range acc {
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

// dotF32Scalar computes Σ_i a[i]·w[i] over equal-length float32 slices. This is
// MultiNet's hot tail-matmul kernel (multilayer.go): the multilayer net's
// per-node cost is dominated by L1 = D2 dot-products over the 2*H feature vector
// (16×1024 ≈ 16K mults), so SIMD-ing this dot is the first speed lever for the
// movetime-viability of the multilayer eval (docs/NNUE/INT8_HANDOFF.md step 1).
//
// Unlike the integer kernels above, the bit-exact contract does NOT hold here:
// float add is non-associative, so a vectorized reduction differs from this
// left-to-right scalar sum by a tiny rounding (~1e-5 relative). MultiNet rounds
// its final output to integer centipawns, which absorbs that drift; the gate is
// TestDotF32MatchScalar with a tolerance, not byte-identity.
func dotF32Scalar(a, w []float32) float32 {
	var s float32
	for i := range a {
		s += a[i] * w[i]
	}
	return s
}

// gemvF32Scalar is an OUTPUT-STATIONARY matrix-vector product for the multilayer
// tail: out[o] = Σ_i in[i] · w[i*stride + off + o], for o in [0,len(out)). The
// weight matrix is INPUT-MAJOR (each input i owns a contiguous row; an output
// bucket is the [off:off+len(out)] sub-slice of that row, hence stride/off). This
// replaces the old "one dotF32 per output row" tail, which paid a horizontal
// reduction + indirect call PER OUTPUT (~49× for 512→16→32→1) — ~2.5 µs of pure
// overhead. Output-stationary keeps the output vector resident and loops over
// inputs (broadcast in[i], FMA the contiguous weight row), so there is ONE pass
// and NO per-row reduction. Bias + activation are applied by the caller. Like
// dotF32 this is bit-CLOSE (float add order differs from the old per-row dot), not
// bit-exact — the cp rounding absorbs it.
func gemvF32Scalar(out, in, w []float32, stride, off int) {
	for o := range out {
		out[o] = 0
	}
	for i := 0; i < len(in); i++ {
		x := in[i]
		row := w[i*stride+off : i*stride+off+len(out)]
		for o := range out {
			out[o] += x * row[o]
		}
	}
}

// screluActivateFScalar applies SCReLU (clamp to [0,1], then square) elementwise,
// writing dst[i] = clamp(src[i],0,1)². This is MultiNet's feature-transformer
// activation (evalFromAcc): it turns the 2*H accumulator halves into the float
// tail's input vector. Unlike dotF32 this is a pure elementwise map (no
// reduction), so a SIMD backend is BIT-EXACT to this scalar reference — IEEE
// Max/Min/Mul are deterministic per element. dst and src may be the same length;
// len(dst) == len(src).
func screluActivateFScalar(dst, src []float32) {
	for i := range src {
		x := src[i]
		if x < 0 {
			x = 0
		} else if x > 1 {
			x = 1
		}
		dst[i] = x * x
	}
}

// int8QA is the activation quantization scale: SCReLU outputs ∈ [0,1] map to u8
// in [0, int8QA]. It is 127 (NOT 255) ON PURPOSE: with activations ≤127 and int8
// weights ≤127, a VPMADDUBSW pair sum is ≤ 2·127·127 = 32258 < 32767, so the
// int16 saturation in maddubs CAN NEVER FIRE — the int8 L1 dot is then exact
// (no saturation loss), and scalar == SIMD trivially. At 255 the pair could reach
// 64770 and saturate hard (measured: 14 cp mean / 83 cp max PTQ error); 127
// trades one bit of activation resolution to remove that error entirely.
//
// NOTE: 127 is the conservative *no-VNNI* variant. The mainstream NNUE choice is
// u8∈[0,255] fed to AVX-512-VNNI VPDPBUSD (`dpbusd`), which accumulates straight
// to int32 with NO pairwise saturation (Stormphrax `kFtQBits=8`). We use the
// portable maddubs+madd fallback (runs on AVX2 and the M3/NEON laptop too), for
// which 255 WOULD saturate — so 127 is required for our path, not 255. Raising to
// 255 is only correct if dotU8I8 switches to a non-saturating VNNI dpbusd (and the
// QAT config's activation faux_quantise must move to 255 in lockstep). The matching
// descale lives in QuantizeForInt8 (L1Inv = 1/(int8QA·Sw)).
const int8QA = 127

// quantU8Scalar fuses MultiNet's FT activation and int8 quantization: it writes
// dst[i] = round(clamp(src[i],0,1)² · int8QA) as a u8 in [0,int8QA]. This is the
// SCReLU feature activation (same value screluActivateFScalar produces) scaled to
// the int8 domain and rounded — the u8 input to the int8 L1 matmul (dotU8I8). The
// round is "round half up" via +0.5 (operands are ≥0). len(dst) == len(src).
func quantU8Scalar(dst []uint8, src []float32) {
	for i := range src {
		x := src[i]
		if x < 0 {
			x = 0
		} else if x > 1 {
			x = 1
		}
		q := x * x * int8QA
		dst[i] = uint8(q + 0.5) // q ∈ [0,int8QA]
	}
}

// screluActivateI16Scalar applies SCReLU to the int16 accumulator: it reads
// src[i] (= round(float_act · ftQA)), maps it back to [0,1] (clamp then /ftQA),
// squares it, and writes the float result to dst — the float tail's input. Same
// value the float-source screluActivateF produced, but reading the int16
// accumulator (which the fast int16 Push maintains). len(dst) == len(src).
func screluActivateI16Scalar(dst []float32, src []int16) {
	const inv = float32(1) / ftQA
	for i, v := range src {
		x := float32(v) * inv
		if x < 0 {
			x = 0
		} else if x > 1 {
			x = 1
		}
		dst[i] = x * x
	}
}

// quantU8I16Scalar is the int8-path FT activation, computed in PURE INTEGER (no
// float, no divide — both slow per-element over 2*H): clamp the int16 accumulator
// to [0,ftQA], square (int32), and shift right by ftShift. Because ftQA=255 and
// int8QA=127, ftQA² = 65025 and 65025 >> 9 = 127, i.e. the shift IS the divide by
// ftQA²/int8QA: dst = clamp(acc,0,255)² >> 9 ≈ SCReLU(acc/255)·int8QA ∈ [0,127] —
// the same value (±1) the float screluActivateF→quantU8 chain produced, but with a
// shift the SIMD backend reproduces bit-for-bit. The matching descale (L1Inv =
// 1/(int8QA·Sw)) is unchanged.
const ftShift = 9                  // log2(ftQA²/int8QA) = log2(65025/127) ≈ 9; 255²>>9 = 127
const ftRound = 1 << (ftShift - 1) // 256: round-to-nearest before the shift (floor biased eval ~25cp)

func quantU8I16Scalar(dst []uint8, src []int16) {
	for i, v := range src {
		c := int32(v)
		if c < 0 {
			c = 0
		} else if c > ftQA {
			c = ftQA
		}
		dst[i] = uint8((c*c + ftRound) >> ftShift)
	}
}

// dotU8I8Scalar computes Σ a[i]·w[i] as int32, modeling the AVX2/AVX-512
// VPMADDUBSW+VPMADDWD path EXACTLY so the scalar reference and the SIMD backends
// are bit-identical: VPMADDUBSW forms, per adjacent byte pair, an int16 word
// saturate_int16(a[2k]·w[2k] + a[2k+1]·w[2k+1]) (a unsigned, w signed); VPMADDWD
// then sums those words into int32 (no further saturation). The int16 saturation
// is therefore PART OF THE DEFINED int8 forward (not a hardware artifact to be
// worked around): the int8 net IS this saturating computation, and the float net
// is the thing it approximates (validated by SPRT, not bit-equality). An odd
// trailing element (no pair) contributes a single product (|255·127| < 2^15, so
// no saturation possible).
func dotU8I8Scalar(a []uint8, w []int8) int32 {
	var acc int32
	n := len(a)
	i := 0
	for ; i+2 <= n; i += 2 {
		p := int32(a[i])*int32(w[i]) + int32(a[i+1])*int32(w[i+1])
		if p > 32767 {
			p = 32767
		} else if p < -32768 {
			p = -32768
		}
		acc += p
	}
	if i < n { // odd tail: single product, cannot saturate
		acc += int32(a[i]) * int32(w[i])
	}
	return acc
}

// Kernel seam. These default to the scalar reference; a SIMD backend (e.g.
// kernels_arm64.go behind `//go:build arm64 && nnue_neon`) repoints them in its
// own init() — no duplicate symbols, and the choice is made once at startup, not
// per call. kernelBackend names the active backend for the benchmark/test
// harness to report.
var kernelBackend = "scalar"

var (
	// addCol(dst, src): dst += src, elementwise int16.
	addCol = addColScalar
	// subCol(dst, src): dst -= src, elementwise int16.
	subCol = subColScalar
	// addColI8(dst, src): dst += widen(src), int16 acc += int8 col (threat columns).
	addColI8 = addColI8Scalar
	// subColI8(dst, src): dst -= widen(src), int16 acc -= int8 col.
	subColI8 = subColI8Scalar
	// screluDot(acc, w, qa): Σ clamp(acc,0,qa)²·w as int64.
	screluDot = screluDotScalar
	// dotF32(a, w): Σ a·w as float32 (MultiNet tail matmul; bit-CLOSE, not exact).
	dotF32 = dotF32Scalar
	// gemvF32(out, in, w, stride, off): output-stationary GEMV, input-major weights
	// (enriched tail; bit-CLOSE). out[o] = Σ_i in[i]·w[i*stride+off+o].
	gemvF32 = gemvF32Scalar
	// screluActivateF(dst, src): dst = clamp(src,0,1)² elementwise (bit-exact).
	screluActivateF = screluActivateFScalar
	// quantU8(dst, src): dst = u8 round(clamp(src,0,1)²·255) — SCReLU→int8 domain.
	quantU8 = quantU8Scalar
	// dotU8I8(a, w): Σ a·w int32 via maddubs+madd semantics (sat16 pairs).
	dotU8I8 = dotU8I8Scalar
	// screluActivateI16(dst, src): dst = SCReLU(src/ftQA)² float, from int16 acc.
	screluActivateI16 = screluActivateI16Scalar
	// quantU8I16(dst, src): dst = u8 round(SCReLU(src/ftQA)²·int8QA), from int16 acc.
	quantU8I16 = quantU8I16Scalar
)
