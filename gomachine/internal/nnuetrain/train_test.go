package nnuetrain

import (
	"testing"

	"github.com/timanthonyalexander/gomachine/internal/chess"
	"github.com/timanthonyalexander/gomachine/internal/nnue"
)

// fixedBatch builds a small, deterministic batch directly from FENs + labels so
// the gradient check never depends on the EPD data files.
func fixedBatch(t *testing.T) []sample {
	t.Helper()
	type row struct {
		fen    string
		result float64 // White-perspective WDL
	}
	rows := []row{
		{"rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", 0.5},
		{"rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1", 1.0},
		{"r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 0 1", 0.0},
		{"8/5k2/8/4P1P1/1p6/7K/8/8 b - - 0 1", 0.0},
		{"rnb1kbnr/pppppppp/8/8/8/8/PPPPPPPP/RNB1KBNR w KQkq - 0 1", 1.0},
		{"8/8/1p1k4/1P6/8/3p3P/1r4P1/5K2 w - - 0 1", 0.0},
		{"r1q1kb1r/6pp/b1p1pn2/2P1Np2/QP6/4P3/P2N2PP/R1BR2K1 b kq - 0 1", 0.5},
		{"8/1P6/3p4/5P2/8/8/K5k1/8 b - - 0 1", 1.0},
	}
	out := make([]sample, 0, len(rows))
	for _, r := range rows {
		pos, err := chess.ParseFEN(r.fen)
		if err != nil {
			t.Fatalf("ParseFEN(%q): %v", r.fen, err)
		}
		stm := pos.SideToMove()
		wp := r.result
		if stm == chess.Black {
			wp = 1 - r.result
		}
		// Give the eval target a distinct, non-degenerate value (not equal to the
		// result win-prob) so the gradient check exercises the λ-blend of two
		// different (q−p) terms, not a collapsed single target.
		out = append(out, sample{
			featsStm:    nnue.AppendFeatures(nil, pos, stm),
			featsOpp:    nnue.AppendFeatures(nil, pos, stm.Opposite()),
			stmScore:    wpToScore(0.5*wp+0.25, DefaultScalingFactor),
			stmResultWP: wp,
		})
	}
	return out
}

// TestTrainInferConsistency asserts the trainer's float64 SCReLU forward
// (converted to cp via ToNet/CpScale=1) matches nnue.Net.Eval for a handful of
// positions — the gate that the training and inference forward compute the same
// function. A small tolerance covers the float64→float32 cast + integer rounding.
func TestTrainInferConsistency(t *testing.T) {
	m := NewModel()
	m.InitRandom(99)
	// Scale up the weights so evals span a meaningful cp range (small init keeps
	// every output near 0, which would pass trivially).
	for i := range m.W1 {
		m.W1[i] *= 20
	}
	net := m.ToNet()
	sc := newScratch()

	fens := []string{
		"rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
		"r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1",
		"8/2k5/3p4/p2P1p2/P2P1P2/8/8/4K3 w - - 0 1",
		"2kr3r/pp1q1ppp/2n1pn2/8/3P4/2N1PN2/PP1Q1PPP/2KR3R b - - 0 1",
		"8/5k2/8/8/3N4/8/2K5/8 w - - 0 1",
	}
	for _, fen := range fens {
		pos, err := chess.ParseFEN(fen)
		if err != nil {
			t.Fatalf("ParseFEN(%q): %v", fen, err)
		}
		stm := pos.SideToMove()
		s := sample{
			featsStm: nnue.AppendFeatures(nil, pos, stm),
			featsOpp: nnue.AppendFeatures(nil, pos, stm.Opposite()),
		}
		trainerCp := m.Eval(s, sc) // CpScale == 1, so raw out is cp
		inferCp := float64(net.Eval(pos))
		if diff := trainerCp - inferCp; diff > 1.0 || diff < -1.0 {
			t.Errorf("train/infer mismatch for %q: trainer %.4f vs infer %.0f (diff %.4f)",
				fen, trainerCp, inferCp, diff)
		}
	}
}

// TestGradientCheck is the Phase-2 gate: analytic gradients must match central
// finite differences (float64) to better than 1e-6 relative error across ~50
// random scalars spanning W0, B0, W1, B1. If this fails, the trainer's backprop
// is wrong and no amount of training is trustworthy.
func TestGradientCheck(t *testing.T) {
	batch := fixedBatch(t)
	const nPerLayer = 16 // 16*3 layer-scalars + B1 = 49 checks
	worst, details := GradCheck(batch, 12345, nPerLayer, 1e-4)
	for _, d := range details {
		t.Log(d)
	}
	t.Logf("worst relative error: %.3e", worst)
	if worst >= 1e-6 {
		t.Fatalf("gradient check FAILED: worst rel err %.3e >= 1e-6", worst)
	}
}
