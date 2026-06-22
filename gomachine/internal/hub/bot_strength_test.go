package hub

import (
	"testing"

	"github.com/timanthonyalexander/gomachine/internal/engine"
)

// The fill-in bot humanization must weaken the lower/middle ladder (where the
// engine over-performs its advertised rating) while leaving the honest top alone.
func TestHumanizedEngineRatingWeakensLowEnd(t *testing.T) {
	// At/above the clean floor the engine is at-strength: no handicap.
	for _, r := range []int{2200, 2400, 2600, 2900} {
		if got := humanizedEngineRating(r); got != r {
			t.Errorf("displayed %d: expected no handicap, got %d", r, got)
		}
	}

	// We only ever WEAKEN — the effective rating is never above the displayed one,
	// and never drops below the engine's own floor.
	for r := engine.RatingMin; r <= botHandicapFloor; r += 25 {
		got := humanizedEngineRating(r)
		if got > r {
			t.Errorf("displayed %d: strengthened to %d (must only weaken)", r, got)
		}
		if got < engine.RatingMin {
			t.Errorf("displayed %d: effective %d below engine.RatingMin %d", r, got, engine.RatingMin)
		}
	}

	// In the common band the weakening is real (the engine has headroom above its
	// floor here, so the handicap actually lands).
	for _, r := range []int{900, 1100, 1500, 1900, 2100} {
		if got := humanizedEngineRating(r); got >= r {
			t.Errorf("displayed %d: expected a real handicap, got %d", r, got)
		}
	}

	// The headline case from the report: a "1100" bot should be pulled down hard
	// (toward the engine floor), not left playing like ~1500.
	if got := humanizedEngineRating(1100); got > 900 {
		t.Errorf("displayed 1100: expected a strong handicap (<=900), got %d", got)
	}
}

// The EFFECTIVE rating must rise monotonically with the displayed rating, so a
// higher-rated fill-in bot is never weaker than a lower-rated one (the clamp at the
// engine floor must not introduce a reversal).
func TestHumanizedEngineRatingMonotonic(t *testing.T) {
	prev := -1
	for r := engine.RatingMin; r <= engine.RatingMax; r += 25 {
		got := humanizedEngineRating(r)
		if got < prev {
			t.Fatalf("displayed %d: effective %d dropped below a lower rating's %d (non-monotonic)", r, got, prev)
		}
		prev = got
	}
}
