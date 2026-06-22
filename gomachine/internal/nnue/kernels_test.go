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
		got := net.evalFrom(&acc, pos.SideToMove())
		want := net.descale(evalFromReference(net, &acc, pos.SideToMove()))
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
