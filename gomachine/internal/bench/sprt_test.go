package bench

import (
	"math"
	"testing"
)

func TestEloScoreRoundTrip(t *testing.T) {
	if got := EloToScore(0); math.Abs(got-0.5) > 1e-12 {
		t.Fatalf("EloToScore(0) = %v, want 0.5", got)
	}
	for _, elo := range []float64{-300, -50, -1, 1, 50, 300} {
		got := ScoreToElo(EloToScore(elo))
		if math.Abs(got-elo) > 1e-9 {
			t.Fatalf("round-trip Elo %v → %v", elo, got)
		}
	}
	// Monotonic: more Elo → higher score.
	if !(EloToScore(-100) < EloToScore(0) && EloToScore(0) < EloToScore(100)) {
		t.Fatalf("EloToScore not monotonic")
	}
}

func TestBounds(t *testing.T) {
	lower, upper := Bounds(0.05, 0.05)
	if math.Abs(upper-2.9444389792) > 1e-6 {
		t.Fatalf("upper = %v, want ≈2.9444", upper)
	}
	if math.Abs(lower+2.9444389792) > 1e-6 {
		t.Fatalf("lower = %v, want ≈-2.9444", lower)
	}
}

func TestLLRSign(t *testing.T) {
	// A symmetric result (equal wins/losses, lots of draws) is evidence for H0
	// (no improvement) → LLR should be negative for bounds [0, 5].
	sym := Pentanomial{20, 40, 80, 40, 20} // mean exactly 0.5
	if llr := sym.LLR(0, 5); llr >= 0 {
		t.Fatalf("symmetric sample LLR = %v, want < 0", llr)
	}

	// A patch-favored result (more WW/WD than LL/LDg) is evidence for H1 → LLR > 0.
	favored := Pentanomial{5, 20, 80, 60, 35}
	if llr := favored.LLR(0, 5); llr <= 0 {
		t.Fatalf("favored sample LLR = %v, want > 0", llr)
	}

	// Strictly more wins should not lower the LLR (monotone in the result).
	more := Pentanomial{5, 20, 80, 60, 45}
	if more.LLR(0, 5) <= favored.LLR(0, 5) {
		t.Fatalf("adding wins did not raise LLR")
	}
}

func TestLLRReachesDecision(t *testing.T) {
	// A large, strongly patch-favored sample should accept H1 for [0,5].
	big := Pentanomial{10, 50, 400, 700, 500}
	if d := big.Decide(0, 5, 0.05, 0.05); d != AcceptH1 {
		t.Fatalf("strong sample decided %v (LLR=%.2f), want AcceptH1", d, big.LLR(0, 5))
	}
	// A large, clearly-worse sample should accept H0.
	bad := Pentanomial{500, 700, 400, 50, 10}
	if d := bad.Decide(0, 5, 0.05, 0.05); d != AcceptH0 {
		t.Fatalf("weak sample decided %v (LLR=%.2f), want AcceptH0", d, bad.LLR(0, 5))
	}
}

// Regression: a single pair (or a handful) must neither explode the LLR nor
// trigger a decision — the degenerate-start bug the prior + MinPairs gate fix.
func TestSmallSampleStable(t *testing.T) {
	for _, p := range []Pentanomial{
		{0, 0, 1, 0, 0}, // one DD pair (the case that exploded)
		{1, 0, 0, 0, 0}, // one LL pair
		{0, 0, 0, 0, 1}, // one WW pair
		{2, 0, 3, 0, 2}, // a few mixed
	} {
		llr := p.LLR(0, 5)
		if math.Abs(llr) > 5 {
			t.Errorf("sample %v: |LLR| = %v exploded", p, llr)
		}
		if d := p.Decide(0, 5, 0.05, 0.05); d != Continue {
			t.Errorf("sample %v: decided %v before MinPairs", p, d)
		}
	}
}

func TestEloEstimate(t *testing.T) {
	// Mean 0.5 → 0 Elo.
	sym := Pentanomial{10, 20, 40, 20, 10}
	if elo, _ := sym.Elo(); math.Abs(elo) > 1e-9 {
		t.Fatalf("symmetric Elo = %v, want 0", elo)
	}
	// A winning sample → positive Elo with a finite error bar.
	win := Pentanomial{2, 8, 40, 60, 40}
	elo, err95 := win.Elo()
	if elo <= 0 || math.IsNaN(err95) || err95 <= 0 {
		t.Fatalf("winning sample Elo=%v err95=%v", elo, err95)
	}
}

func TestPentanomialAdd(t *testing.T) {
	var p Pentanomial
	for _, s := range []float64{0, 0.5, 1.0, 1.5, 2.0, 2.0} {
		p.Add(s)
	}
	want := Pentanomial{1, 1, 1, 1, 2}
	if p != want {
		t.Fatalf("Add buckets = %v, want %v", p, want)
	}
	if p.Pairs() != 6 {
		t.Fatalf("Pairs = %d, want 6", p.Pairs())
	}
}
