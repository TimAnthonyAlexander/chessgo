package nnue

import (
	"math/rand"
	"testing"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// TestKernelsMatchScalar is the bit-exact gate for the kernel seam. It asserts
// that the ACTIVE kernel bindings (addCol/subCol/screluDot — scalar today, NEON
// asm tomorrow) produce byte-for-byte identical results to the in-file scalar
// reference, across widths and randomized inputs spanning the clamp boundaries
// (negative, in-range, > QA). When a SIMD backend is wired in via build tag, it
// is compiled into THIS test too, so a single `go test -tags nnue_neon` run
// proves the asm == scalar before it can ever reach search. Bit-exact is
// non-negotiable: the int forward is bullet-verbatim.
func TestKernelsMatchScalar(t *testing.T) {
	rng := rand.New(rand.NewSource(0xBADC0DE))
	const qa = int32(bulletQA)
	// Widths: the two shipping sizes plus odd/tail lengths so a future SIMD impl
	// can't pass by only handling multiples of its vector width (e.g. 8 int16).
	for _, n := range []int{1, 7, 8, 15, 16, 31, 256, 512, 513} {
		dst := randI16(rng, n)
		src := randI16(rng, n)

		// addCol: compare active binding vs scalar reference on a fresh copy.
		gotAdd := cloneI16(dst)
		refAdd := cloneI16(dst)
		addCol(gotAdd, src)
		addColScalar(refAdd, src)
		assertEqI16(t, "addCol", n, gotAdd, refAdd)

		// subCol.
		gotSub := cloneI16(dst)
		refSub := cloneI16(dst)
		subCol(gotSub, src)
		subColScalar(refSub, src)
		assertEqI16(t, "subCol", n, gotSub, refSub)

		// screluDot: acc spans the clamp boundaries; w is arbitrary int16.
		acc := randClampSpanI16(rng, n, qa)
		w := randI16(rng, n)
		got := screluDot(acc, w, qa)
		ref := screluDotScalar(acc, w, qa)
		if got != ref {
			t.Fatalf("screluDot[n=%d] backend=%q: got %d, want %d", n, kernelBackend, got, ref)
		}
	}
	t.Logf("kernel backend = %q (bit-exact vs scalar across all widths)", kernelBackend)
}

// TestDotF32MatchScalar is the bit-CLOSE gate for the float tail-matmul kernel
// (dotF32). Unlike the integer kernels, float add is non-associative, so a
// vectorized reduction can't be byte-identical to the left-to-right scalar sum;
// the contract is "within a tight tolerance" (MultiNet rounds to int cp, which
// absorbs the drift). On the scalar build dotF32 == dotF32Scalar so it passes
// trivially; on a SIMD build it proves the vector reduction stays in tolerance
// across widths spanning the vector size and its tail.
func TestDotF32MatchScalar(t *testing.T) {
	rng := rand.New(rand.NewSource(0xF10A7))
	for _, n := range []int{1, 3, 4, 7, 8, 15, 16, 31, 32, 33, 64, 1024, 1025} {
		a := randF32(rng, n)
		w := randF32(rng, n)
		got := dotF32(a, w)
		ref := dotF32Scalar(a, w)
		// Tolerance: float32 rounding accumulates ~n·eps·(typical product); the
		// abs term covers small-n, the rel term covers large-n / large-magnitude.
		tol := 1e-3 + 1e-4*absF32(ref)
		if d := absF32(got - ref); d > tol {
			t.Fatalf("dotF32[n=%d] backend=%q: got %g, want %g (|Δ|=%g > tol %g)",
				n, kernelBackend, got, ref, d, tol)
		}
	}
	t.Logf("dotF32 backend = %q (bit-close vs scalar across all widths)", kernelBackend)
}

// TestScreluActivateFMatchScalar gates the elementwise SCReLU activation kernel.
// Unlike dotF32 this has no reduction, so the SIMD backend is BIT-EXACT to the
// scalar reference; inputs deliberately straddle the [0,1] clamp (negative, in
// range, >1) at widths spanning the vector size and tail.
func TestScreluActivateFMatchScalar(t *testing.T) {
	rng := rand.New(rand.NewSource(0x5C4E1))
	for _, n := range []int{1, 3, 4, 7, 8, 15, 16, 31, 32, 256, 512, 513} {
		src := make([]float32, n)
		for i := range src {
			src[i] = float32(rng.NormFloat64())*0.8 + 0.3 // spans <0, [0,1], >1
		}
		got := make([]float32, n)
		ref := make([]float32, n)
		screluActivateF(got, src)
		screluActivateFScalar(ref, src)
		for i := range ref {
			if got[i] != ref[i] {
				t.Fatalf("screluActivateF[n=%d] backend=%q: index %d got %g want %g (src=%g)",
					n, kernelBackend, i, got[i], ref[i], src[i])
			}
		}
	}
	t.Logf("screluActivateF backend = %q (bit-exact vs scalar)", kernelBackend)
}

// TestAddColI8MatchScalar gates the int8-widen-on-add FT kernels (the enriched
// net's int8 threat-column accumulator update). The active backend must be
// byte-identical to the scalar reference for all widths incl. non-multiples of the
// SIMD width, with int8 columns spanning the ±127 extremes — integer widen+add is
// associative, so this is EXACT (no tolerance).
func TestAddColI8MatchScalar(t *testing.T) {
	rng := rand.New(rand.NewSource(0x1817))
	for _, n := range []int{1, 2, 7, 8, 15, 16, 17, 31, 32, 33, 64, 512, 513} {
		src := make([]int8, n)
		for i := range src {
			src[i] = int8(rng.Intn(255) - 127) // [-127,127]
		}
		if n > 1 {
			src[0], src[n-1] = 127, -127 // force the extremes
		}
		base := randI16(rng, n)
		for _, op := range []string{"add", "sub"} {
			got := append([]int16(nil), base...)
			ref := append([]int16(nil), base...)
			if op == "add" {
				addColI8(got, src)
				addColI8Scalar(ref, src)
			} else {
				subColI8(got, src)
				subColI8Scalar(ref, src)
			}
			for i := range got {
				if got[i] != ref[i] {
					t.Fatalf("%sColI8[n=%d,i=%d] backend=%q: got %d want %d", op, n, i, kernelBackend, got[i], ref[i])
				}
			}
		}
	}
	t.Logf("addColI8/subColI8 backend = %q (bit-exact vs scalar, ±127 domain)", kernelBackend)
}

// TestDotU8I8MatchScalar is the bit-exact gate for the int8 L1 matmul kernel.
// Inputs are the PRODUCTION domain: activations a ∈ [0,127] (quantU8 output) and
// weights w ∈ [-127,127]. There the maddubs int16 saturation never fires, so the
// AVX2/AVX512 DotProductPairsSaturated path is exactly the scalar int32 sum; on
// the NEON build dotU8I8 stays scalar so it matches trivially. Widths include the
// real L1 width (1024) plus odd/tail lengths.
func TestDotU8I8MatchScalar(t *testing.T) {
	rng := rand.New(rand.NewSource(0x1238))
	for _, n := range []int{1, 2, 3, 7, 8, 15, 16, 31, 32, 33, 64, 1024} {
		a := make([]uint8, n)
		w := make([]int8, n)
		for i := range a {
			a[i] = uint8(rng.Intn(128))      // [0,127] — the quantU8 domain
			w[i] = int8(rng.Intn(255) - 127) // [-127,127]
		}
		got := dotU8I8(a, w)
		ref := dotU8I8Scalar(a, w)
		if got != ref {
			t.Fatalf("dotU8I8[n=%d] backend=%q: got %d want %d", n, kernelBackend, got, ref)
		}
	}
	t.Logf("dotU8I8 backend = %q (bit-exact vs scalar on [0,127] domain)", kernelBackend)
}

// TestQuantU8I16MatchScalar gates the int8-path FT activation kernel. Inputs span
// the [0,ftQA] clamp (negatives, in-range, > ftQA) at widths including the real 2H
// (1024). The AVX-512 backend must be byte-identical to the scalar reference (all
// values land in [0,int8QA] so the int32→u8 narrow is exact); other backends keep
// the scalar binding and pass trivially.
func TestQuantU8I16MatchScalar(t *testing.T) {
	rng := rand.New(rand.NewSource(0xAC71))
	for _, n := range []int{1, 3, 7, 15, 16, 17, 31, 32, 1024} {
		src := make([]int16, n)
		for i := range src {
			src[i] = int16(rng.Intn(700) - 150) // spans <0, [0,255], >255
		}
		got := make([]uint8, n)
		ref := make([]uint8, n)
		quantU8I16(got, src)
		quantU8I16Scalar(ref, src)
		for i := range ref {
			if got[i] != ref[i] {
				t.Fatalf("quantU8I16[n=%d] backend=%q: index %d got %d want %d (src=%d)",
					n, kernelBackend, i, got[i], ref[i], src[i])
			}
		}
	}
	t.Logf("quantU8I16 backend = %q (bit-exact vs scalar)", kernelBackend)
}

func randF32(rng *rand.Rand, n int) []float32 {
	s := make([]float32, n)
	for i := range s {
		s[i] = float32(rng.NormFloat64()) // ~N(0,1), spans sign
	}
	return s
}

func absF32(x float32) float32 {
	if x < 0 {
		return -x
	}
	return x
}

// TestEvalFromMatchesReference re-derives evalFrom's value from the raw scalar
// loop (no kernel indirection) on real positions, so the seam refactor itself is
// proven equal to the pre-refactor arithmetic. If a future SIMD screluDot drifts,
// the per-half dot in TestKernelsMatchScalar catches it; this catches a wiring
// mistake in evalFrom's two-half split.
func TestEvalFromMatchesReference(t *testing.T) {
	net := RandomNet(99)
	for _, fen := range moveTypeFENs {
		pos := mustFEN(t, fen)
		acc := net.newAccumulator()
		net.build(&acc, pos)
		got := net.evalFrom(&acc, pos.SideToMove(), net.outputBucket(pos))
		want := net.descale(evalFromReference(net, &acc, pos.SideToMove()), net.outputBucket(pos))
		if got != want {
			t.Fatalf("evalFrom %q: got %d, want %d", fen, got, want)
		}
	}
}

// evalFromReference is the original (pre-seam) inlined SCReLU dot, kept as an
// independent oracle for the refactor.
func evalFromReference(n *Net, acc *Accumulator, stm chess.Color) int64 {
	hl := n.HL
	stmHalf, oppHalf := acc.w, acc.b
	if stm == chess.Black {
		stmHalf, oppHalf = acc.b, acc.w
	}
	qa := n.QA
	var out int64
	for i := 0; i < hl; i++ {
		c := int32(stmHalf[i])
		if c < 0 {
			c = 0
		} else if c > qa {
			c = qa
		}
		out += int64(c*c) * int64(n.W1i[i])
	}
	for i := 0; i < hl; i++ {
		c := int32(oppHalf[i])
		if c < 0 {
			c = 0
		} else if c > qa {
			c = qa
		}
		out += int64(c*c) * int64(n.W1i[hl+i])
	}
	return out
}

func randI16(rng *rand.Rand, n int) []int16 {
	s := make([]int16, n)
	for i := range s {
		s[i] = int16(rng.Intn(2001) - 1000)
	}
	return s
}

// randClampSpanI16 returns values deliberately straddling the SCReLU clamp:
// some negative (→0), some in [0,qa], some > qa (→qa).
func randClampSpanI16(rng *rand.Rand, n int, qa int32) []int16 {
	s := make([]int16, n)
	for i := range s {
		s[i] = int16(rng.Intn(int(qa)*3) - int(qa)) // [-qa, 2qa)
	}
	return s
}

func cloneI16(s []int16) []int16 { return append([]int16(nil), s...) }

func assertEqI16(t *testing.T, name string, n int, got, want []int16) {
	t.Helper()
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("%s[n=%d] backend=%q: index %d got %d, want %d", name, n, kernelBackend, i, got[i], want[i])
		}
	}
}

// TestGemvF32MatchScalar gates the output-stationary GEMV SIMD backends bit-close
// to gemvF32Scalar, across input/output lengths and offsets — including outLen not
// a multiple of the SIMD width (1,7,16,17,32,33) so the scalar out-tail is hit.
func TestGemvF32MatchScalar(t *testing.T) {
	rng := rand.New(rand.NewSource(0x6E47))
	type cfg struct{ inLen, outLen, off, pad int }
	for _, c := range []cfg{
		{16, 1, 0, 0}, {16, 7, 2, 3}, {512, 16, 0, 0}, {512, 16, 5, 7},
		{16, 17, 1, 2}, {512, 32, 8, 0}, {32, 4, 0, 1}, {1, 16, 0, 0}, {513, 33, 3, 4},
	} {
		stride := c.off + c.outLen + c.pad
		in := randF32(rng, c.inLen)
		w := randF32(rng, c.inLen*stride)
		got := make([]float32, c.outLen)
		ref := make([]float32, c.outLen)
		gemvF32(got, in, w, stride, c.off)
		gemvF32Scalar(ref, in, w, stride, c.off)
		for o := 0; o < c.outLen; o++ {
			tol := 1e-3 + 1e-4*absF32(ref[o])
			if d := absF32(got[o] - ref[o]); d > tol {
				t.Fatalf("gemvF32[in=%d out=%d off=%d stride=%d] o=%d backend=%q: got %g want %g (|Δ|=%g > tol %g)",
					c.inLen, c.outLen, c.off, stride, o, kernelBackend, got[o], ref[o], d, tol)
			}
		}
	}
	t.Logf("gemvF32 backend = %q (bit-close vs scalar)", kernelBackend)
}
