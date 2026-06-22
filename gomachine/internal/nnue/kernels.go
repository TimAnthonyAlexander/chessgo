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
	// screluDot(acc, w, qa): Σ clamp(acc,0,qa)²·w as int64.
	screluDot = screluDotScalar
)
