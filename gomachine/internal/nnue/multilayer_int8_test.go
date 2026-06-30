package nnue

import (
	"math/rand"
	"os"
	"testing"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// pocNetPath is the fully-annealed PoC multilayer net used in the movetime SPRTs.
const pocNetPath = "/checkpoints/chessgo_ml_poc-64/raw.bin"

// TestInt8ClosenessToFloat is the PTQ accuracy gate: int8-L1 MultiNet eval must
// track the float MultiNet eval closely across diverse positions. It's not
// bit-exact (quantization + maddubs saturation), but a large divergence means the
// per-row int8 scale or the descale chain is wrong — PTQ that destroys the eval
// would never survive the fixed-depth SPRT, so catch it cheaply here. Skips if the
// PoC net isn't on this machine.
func TestInt8ClosenessToFloat(t *testing.T) {
	// MULTI_NET overrides the net under test (e.g. an intermediate QAT checkpoint),
	// so the int8-vs-float closeness — an anneal-INDEPENDENT measure of how well the
	// net quantizes — can be sampled early in a long QAT run. QAT should beat the
	// non-QAT PoC's ~6.8 cp.
	path := os.Getenv("MULTI_NET")
	if path == "" {
		path = os.Getenv("HOME") + "/nnue-training/bullet" + pocNetPath
	}
	if _, err := os.Stat(path); err != nil {
		t.Skipf("net not present (%s)", path)
	}
	fnet, err := ImportBulletMultiNet(path, 512, 16, 32)
	if err != nil {
		t.Fatal(err)
	}
	qnet, err := ImportBulletMultiNet(path, 512, 16, 32)
	if err != nil {
		t.Fatal(err)
	}
	qnet.QuantizeForInt8()
	if !qnet.IsInt8() {
		t.Fatal("QuantizeForInt8 did not enable int8 path")
	}

	fens := int8TestFENs(t)
	var n, sumAbs, maxAbs int
	for _, fen := range fens {
		pos, err := chess.ParseFEN(fen)
		if err != nil {
			t.Fatalf("parse %q: %v", fen, err)
		}
		fv := fnet.Eval(pos)
		qv := qnet.Eval(pos)
		d := fv - qv
		if d < 0 {
			d = -d
		}
		sumAbs += d
		if d > maxAbs {
			maxAbs = d
		}
		n++
	}
	mean := float64(sumAbs) / float64(n)
	t.Logf("int8 vs float over %d positions: mean |Δ| = %.2f cp, max |Δ| = %d cp", n, mean, maxAbs)
	// Heuristic gates — generous; the real gate is the fixed-depth SPRT. A broken
	// scale chain diverges by hundreds of cp, far above these.
	if mean > 12 {
		t.Errorf("int8 PTQ mean error %.2f cp too high (scale chain suspect)", mean)
	}
	if maxAbs > 60 {
		t.Errorf("int8 PTQ max error %d cp too high (scale chain suspect)", maxAbs)
	}
}

// TestDotU8I8Consistency checks the maddubs-modelling scalar kernel against a
// plain (non-saturating) int32 reference on inputs that DON'T saturate, proving
// the pairwise structure is correct; then on a hand-built saturating case it
// confirms the int16 clamp fires (so scalar and SIMD agree on the saturating
// semantics, not just the easy case).
func TestDotU8I8Consistency(t *testing.T) {
	rng := rand.New(rand.NewSource(0xD0700))
	for _, nn := range []int{1, 2, 3, 8, 15, 16, 31, 1024} {
		a := make([]uint8, nn)
		w := make([]int8, nn)
		for i := range a {
			a[i] = uint8(rng.Intn(40))    // small ⇒ no pair saturates
			w[i] = int8(rng.Intn(61) - 30) // [-30,30]
		}
		var ref int32
		for i := range a {
			ref += int32(a[i]) * int32(w[i])
		}
		if got := dotU8I8(a, w); got != ref {
			t.Fatalf("dotU8I8[n=%d] backend=%q non-saturating: got %d want %d", nn, kernelBackend, got, ref)
		}
	}
	// Saturating pair: 255*127 + 255*127 = 64770 → clamps to 32767.
	a := []uint8{255, 255}
	w := []int8{127, 127}
	if got := dotU8I8(a, w); got != 32767 {
		t.Fatalf("dotU8I8 saturation: got %d want 32767", got)
	}
}

// int8TestFENs returns a diverse position set: openings, middlegames, tactical
// shots, and low-piece endgames (exercising all material buckets).
func int8TestFENs(t *testing.T) []string {
	t.Helper()
	return []string{
		"rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
		"r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3",
		"r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1",
		"rnbqkb1r/pp2pppp/3p1n2/2pP4/4P3/2N5/PPP2PPP/R1BQKBNR w KQkq - 0 4",
		"r2q1rk1/pp1bbppp/2n1pn2/3p4/3P4/2NBPN2/PPQ2PPP/R1B2RK1 w - - 0 9",
		"8/8/8/4k3/8/4K3/4P3/8 w - - 0 1",
		"8/2k5/8/8/8/4K3/2R5/8 w - - 0 1",
		"8/5k2/8/8/3N4/4K3/8/8 w - - 0 1",
		"6k1/5ppp/8/8/8/8/5PPP/6K1 w - - 0 1",
		"r4rk1/1pp2ppp/p1np1q2/2b1p3/2B1P3/2NP1N2/PPP2PPP/R2Q1RK1 w - - 0 10",
		"2r3k1/pp3ppp/8/8/8/8/PP3PPP/2R3K1 w - - 0 1",
		"8/8/8/3k4/8/3K4/8/3Q4 w - - 0 1",
		"rnb1kbnr/pp1ppppp/8/q1p5/8/2N5/PPPPPPPP/R1BQKBNR w KQkq - 2 3",
		"8/pp4pp/2p5/8/8/2P5/PP4PP/8 w - - 0 1",
	}
}
