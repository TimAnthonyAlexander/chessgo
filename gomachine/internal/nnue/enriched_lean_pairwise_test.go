package nnue

import (
	"math"
	"math/rand"
	"os"
	"testing"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// mkLeanPairwiseNet builds a random-weight lean-PAIRWISE net (float source →
// int16 FT + int16 tail), for arithmetic/incremental tests with no net file.
func mkLeanPairwiseNet(seed int64) *EnrichedNet {
	n := NewEnrichedNet(512, 0, 0, 8)
	n.leanPairwise = true
	rng := rand.New(rand.NewSource(seed))
	for i := range n.W0 {
		n.W0[i] = float32(rng.NormFloat64()) * 0.1
	}
	for i := range n.B0 {
		n.B0[i] = float32(rng.NormFloat64()) * 0.1
	}
	n.TW = make([]float32, n.H*n.NB)
	n.TB = make([]float32, n.NB)
	for i := range n.TW {
		n.TW[i] = float32(rng.NormFloat64()) * 0.5
	}
	for i := range n.TB {
		n.TB[i] = float32(rng.NormFloat64()) * 0.1
	}
	n.CpScale = bulletSCALE
	n.quantizeFT()
	n.quantizeLeanPairwiseTail()
	return n
}

// refLeanPairwiseEval is the float ground-truth for the pairwise tail: CReLU each
// FT half-pair (clamp [0,ftQA]/ftQA), multiply, dot with the FLOAT tail weights,
// add bias, scale. evalFromHalvesLeanPairwise must be bit-CLOSE to this (the only
// gap is the int16 TWi PTQ at leanTailQB — random-signed, so it averages tiny).
func refLeanPairwiseEval(n *EnrichedNet, stm, opp []int16, bk int) float64 {
	half := n.H / 2
	inv := 1.0 / float64(ftQA)
	crelu := func(v int16) float64 {
		if v < 0 {
			return 0
		}
		if v > ftQA {
			return float64(ftQA)
		}
		return float64(v)
	}
	sum := float64(n.TB[bk])
	for i := 0; i < half; i++ {
		p := (crelu(stm[i]) * inv) * (crelu(stm[i+half]) * inv)
		sum += p * float64(n.TW[i*n.NB+bk])
	}
	for i := 0; i < half; i++ {
		p := (crelu(opp[i]) * inv) * (crelu(opp[i+half]) * inv)
		sum += p * float64(n.TW[(half+i)*n.NB+bk])
	}
	return sum * float64(n.CpScale)
}

// TestLeanPairwiseArithmetic checks the integer pairwise-dot forward matches the
// float reference on random accumulators. A wrong descale, weight layout, or
// stm/opp split would show up as huge (10s–1000s cp) or wrong-sign errors; the
// tolerance only tolerates int16-PTQ noise.
func TestLeanPairwiseArithmetic(t *testing.T) {
	n := mkLeanPairwiseNet(1)
	rng := rand.New(rand.NewSource(99))
	h := n.H
	stm := make([]int16, h)
	opp := make([]int16, h)
	sc := n.newScratch()
	maxDiff := 0.0
	for s := 0; s < 400; s++ {
		for i := 0; i < h; i++ {
			stm[i] = int16(rng.Intn(1200) - 400) // spans below/within/above the CReLU clamp
			opp[i] = int16(rng.Intn(1200) - 400)
		}
		bk := rng.Intn(n.NB)
		got := n.evalFromHalvesLeanPairwise(stm, opp, bk, &sc)
		want := refLeanPairwiseEval(n, stm, opp, bk)
		diff := math.Abs(float64(got) - want)
		if diff > maxDiff {
			maxDiff = diff
		}
		if diff > 8 {
			t.Fatalf("pairwise arithmetic drift: got=%d want=%.3f diff=%.3f (bk=%d)", got, want, diff, bk)
		}
	}
	t.Logf("lean-pairwise arithmetic: max |int-float| = %.3f cp over 400 random samples", maxDiff)
}

// TestLeanPairwiseIncrementalExact walks every legal move to a fixed depth and
// checks the INCREMENTAL stack eval equals the FROM-SCRATCH eval at each node — the
// pairwise tail is a pure function of the accumulator, and the accumulator is
// maintained by the same (already bit-exact) move-aware push. Any divergence means
// the pairwise tail read the accumulator inconsistently between paths.
func TestLeanPairwiseIncrementalExact(t *testing.T) {
	n := mkLeanPairwiseNet(2)
	n.SetMoveAware(true)
	positions := []struct {
		name, fen string
		depth     int
	}{
		{"startpos", chess.StartFEN, 4},
		{"kiwipete", "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1", 3},
		{"midgame", "r2q1rk1/pp2ppbp/2np1np1/2p5/2P1P3/2NP1N2/PP2BPPP/R1BQ1RK1 w - - 0 9", 3},
	}
	for _, p := range positions {
		pos, err := chess.ParseFEN(p.fen)
		if err != nil {
			t.Fatalf("%s: %v", p.name, err)
		}
		st := n.NewStack(p.depth + 1)
		st.Reset(pos)
		nodes := 0
		walkLeanPairwiseEval(t, n, st, pos, p.depth, &nodes)
		t.Logf("%-9s depth=%d: %d nodes incremental==scratch", p.name, p.depth, nodes)
	}
}

func walkLeanPairwiseEval(t *testing.T, n *EnrichedNet, st *EnrichedStack, pos *chess.Position, depth int, nodes *int) {
	if depth == 0 {
		return
	}
	var ml chess.MoveList
	pos.GenerateLegal(&ml)
	for i := 0; i < ml.Len(); i++ {
		m := ml.Get(i)
		st.Push(pos, m)
		var u chess.Undo
		pos.DoMove(m, &u)

		inc := st.Eval(pos)
		scratch := n.Eval(pos)
		if inc != scratch {
			t.Fatalf("pairwise eval mismatch after %s: inc=%d scratch=%d fen=%q", m, inc, scratch, pos.FEN())
		}
		*nodes++
		walkLeanPairwiseEval(t, n, st, pos, depth-1, nodes)

		pos.UndoMove(m, &u)
		st.Pop()
	}
}

// TestLeanPairwiseLoadSanity loads a real bullet lean-pairwise export (env
// LEAN_PAIRWISE_NET=path) and checks the evals are sane and correctly signed — the
// smoke test to run the moment the 64-sb train produces a net, before any SPRT.
func TestLeanPairwiseLoadSanity(t *testing.T) {
	path := os.Getenv("LEAN_PAIRWISE_NET")
	if path == "" {
		t.Skip("set LEAN_PAIRWISE_NET to a bullet lean-pairwise raw.bin to run")
	}
	n, err := ImportBulletLeanPairwiseNet(path, 512, 8)
	if err != nil {
		t.Fatal(err)
	}
	ev := func(fen string) int {
		pos, err := chess.ParseFEN(fen)
		if err != nil {
			t.Fatalf("fen %q: %v", fen, err)
		}
		return n.Eval(pos)
	}
	start := ev(chess.StartFEN)
	if start < -60 || start > 60 {
		t.Errorf("startpos eval %d cp is implausibly far from 0", start)
	}
	// White up a queen (white to move) should be large positive; the mirror
	// (black up a queen, black to move) should be large positive too (stm-relative).
	wQ := ev("rnb1kbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1")
	bQ := ev("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNB1KBNR b KQkq - 0 1")
	if wQ < 300 {
		t.Errorf("white-up-a-queen eval %d cp too small", wQ)
	}
	if bQ < 300 {
		t.Errorf("black-up-a-queen (btm) eval %d cp too small", bQ)
	}
	t.Logf("lean-pairwise: startpos=%d Wq(wtm)=%d Bq(btm)=%d", start, wQ, bQ)
}
