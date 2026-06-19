package eval

import (
	"math"
	"testing"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// scoreParams is the linear-model scorer (White perspective), mirroring the one
// the tuner uses, so the test can assert the trace reproduces Evaluate.
func scoreParams(tr Trace, θ []float64) float64 {
	ph := float64(tr.Phase)
	var e float64
	for _, en := range tr.Entries {
		f := int(en.Feat)
		e += float64(en.Coeff) * (ph*θ[2*f] + (24-ph)*θ[2*f+1]) / 24
	}
	return e
}

// TestTraceReproducesEvaluate verifies the coefficient model is faithful: for a
// spread of positions, scoring EvalTrace against DefaultParams() equals
// Evaluate(pos, allTermsOn) in the side-to-move perspective (within taper
// integer-rounding noise). If this drifts, every gradient the tuner computes is
// against the wrong function.
func TestTraceReproducesEvaluate(t *testing.T) {
	fens := []string{
		"rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
		"r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1", // kiwipete
		"8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1",
		"r2q1rk1/pp2bppp/2n1pn2/3p4/3P4/2NBPN2/PP3PPP/R1BQ1RK1 b - - 0 1",
		"8/8/8/4k3/8/3K4/4P3/8 w - - 0 1",
		"6k1/5ppp/8/8/8/8/5PPP/6K1 w - - 0 1",
		"rnbq1rk1/ppp1bppp/4pn2/3p4/2PP4/2N1PN2/PP3PPP/R1BQKB1R w KQ - 0 1",
	}
	cfg := Config{Mobility: true, Pawns: true, KingSafety: true, BishopPair: true}
	θ := DefaultParams()
	for _, fen := range fens {
		pos, err := chess.ParseFEN(fen)
		if err != nil {
			t.Fatalf("parse %q: %v", fen, err)
		}
		want := Evaluate(pos, cfg) // side-to-move perspective
		eWhite := scoreParams(EvalTrace(pos), θ)
		got := eWhite
		if pos.SideToMove() == chess.Black {
			got = -eWhite
		}
		if math.Abs(got-float64(want)) > 1.5 {
			t.Errorf("FEN %s: trace %.2f (stm %.2f) vs Evaluate %d", fen, eWhite, got, want)
		}
	}
}

// TestParamsRoundTrip confirms DefaultParams → ParamsToTables → recombine equals
// the original PeSTO tables + DefaultWeights (no drift from the split/round trip).
func TestParamsRoundTrip(t *testing.T) {
	mgP, egP, w := ParamsToTables(DefaultParams())
	for pt := 0; pt < 6; pt++ {
		for pidx := 0; pidx < 64; pidx++ {
			if got := mgValue[pt] + mgP[pt][pidx]; got != mgValue[pt]+mgPesto[pt][pidx] {
				t.Fatalf("mg pt %d sq %d: %d want %d", pt, pidx, got, mgValue[pt]+mgPesto[pt][pidx])
			}
			if got := egValue[pt] + egP[pt][pidx]; got != egValue[pt]+egPesto[pt][pidx] {
				t.Fatalf("eg pt %d sq %d: %d want %d", pt, pidx, got, egValue[pt]+egPesto[pt][pidx])
			}
		}
	}
	def := DefaultWeights()
	if *w != *def {
		t.Errorf("weights round-trip: %+v want %+v", *w, *def)
	}
}
