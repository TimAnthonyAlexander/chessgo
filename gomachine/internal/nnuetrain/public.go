package nnuetrain

import (
	"fmt"

	"github.com/timanthonyalexander/gomachine/internal/chess"
	"github.com/timanthonyalexander/gomachine/internal/nnue"
)

// Sample is the exported alias for one internal training sample, so callers
// (the CLI) can hold a typed slice across the .flat / EPD load branches. Its
// fields stay unexported — callers only pass it back to Train.
type Sample = sample

// FENSample is a labelled position used to build a fixed gradient-check batch
// from FENs alone (no data files). Result is the White-perspective WDL ∈ {0,0.5,1};
// Score is the White-relative teacher eval in centipawns (0 if unknown).
type FENSample struct {
	FEN    string
	Result float64
	Score  float64
}

// sampleFromFEN parses a labelled FEN into an internal training sample, folding
// both the result win-prob and the eval score into the side-to-move frame.
func sampleFromFEN(fs FENSample) (sample, error) {
	pos, err := chess.ParseFEN(fs.FEN)
	if err != nil {
		return sample{}, fmt.Errorf("parse %q: %w", fs.FEN, err)
	}
	stm := pos.SideToMove()
	wp := fs.Result
	score := fs.Score
	if stm == chess.Black {
		wp = 1 - fs.Result
		score = -score
	}
	return sample{
		featsStm:    nnue.AppendFeatures(nil, pos, stm),
		featsOpp:    nnue.AppendFeatures(nil, pos, stm.Opposite()),
		stmScore:    score,
		stmResultWP: wp,
	}, nil
}

// GradCheckFENs builds a fixed batch from labelled FENs and runs the
// finite-difference gradient check (float64). It returns the worst relative
// error and per-parameter detail lines. The CLI uses this as its pre-train gate.
func GradCheckFENs(batch []FENSample, seed int64, nPerLayer int, eps float64) (worst float64, details []string, err error) {
	samples := make([]sample, 0, len(batch))
	for _, b := range batch {
		s, e := sampleFromFEN(b)
		if e != nil {
			return 0, nil, e
		}
		samples = append(samples, s)
	}
	worst, details = GradCheck(samples, seed, nPerLayer, eps)
	return worst, details, nil
}
