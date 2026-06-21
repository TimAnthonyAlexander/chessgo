package engine

import (
	"testing"
	"time"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// TestBestMoveForRatingLegal: every rating across the ladder returns a legal move
// from a couple of positions (all configs run at the fixed 100ms budget, fast).
func TestBestMoveForRatingLegal(t *testing.T) {
	fens := []string{
		chess.StartFEN,
		"r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4",
		"8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1",
	}
	eng := New(16)
	for _, fen := range fens {
		pos := mustFEN(t, fen)
		for r := RatingMin; r <= RatingMax; r += 250 {
			res := eng.BestMoveForRating(pos, r, nil)
			if res.Move == chess.NullMove {
				t.Errorf("rating %d: null move on %s", r, fen)
				continue
			}
			if _, ok := pos.ParseUCIMove(res.Move.String()); !ok {
				t.Errorf("rating %d: illegal move %s on %s", r, res.Move, fen)
			}
		}
	}
}

// TestConfigForRatingMonotonic: weakening must rise (or hold) as the rating drops
// — noise non-decreasing and blunder non-decreasing as we go down. A rating that
// claimed to be weaker but searched cleaner would be a calibration bug.
func TestConfigForRatingMonotonic(t *testing.T) {
	prevNoise, prevBlunder := -1, -1.0
	for r := RatingMax; r >= RatingMin; r -= 50 {
		c := configForRating(r)
		if prevNoise >= 0 && c.NoiseCp < prevNoise {
			t.Errorf("rating %d: noise %d < previous %d (not monotonic)", r, c.NoiseCp, prevNoise)
		}
		if prevBlunder >= 0 && c.Blunder < prevBlunder {
			t.Errorf("rating %d: blunder %.3f < previous %.3f (not monotonic)", r, c.Blunder, prevBlunder)
		}
		prevNoise, prevBlunder = c.NoiseCp, c.Blunder
	}
}

// TestConfigForRatingNoFlatZone: the bug we just fixed — every step UP the ladder
// must buy MORE search budget (time and/or depth), so the numbers mean something.
// The old fixed-100ms design flat-lined above ~2650 (all the same full strength);
// here, across the clean top band, move time must STRICTLY increase each step.
func TestConfigForRatingNoFlatZone(t *testing.T) {
	// Across the whole ladder, search budget is non-decreasing with rating.
	prevTime, prevDepth := time.Duration(-1), -1
	for r := RatingMin; r <= RatingMax; r += 50 {
		c := configForRating(r)
		if prevTime >= 0 && c.MoveTime < prevTime {
			t.Errorf("rating %d: movetime %v < previous %v (strength went down)", r, c.MoveTime, prevTime)
		}
		if prevDepth >= 0 && c.Depth < prevDepth {
			t.Errorf("rating %d: depth %d < previous %d (strength went down)", r, c.Depth, prevDepth)
		}
		prevTime, prevDepth = c.MoveTime, c.Depth
	}
	// No flat top: in the clean band (no noise/blunder), each 50-pt step must be
	// genuinely stronger via move time — else the slider lies up there.
	for r := ratingCleanFloor; r+50 <= RatingMax; r += 50 {
		lo, hi := configForRating(r), configForRating(r+50)
		if hi.MoveTime <= lo.MoveTime {
			t.Errorf("flat zone at %d→%d: movetime %v not > %v", r, r+50, hi.MoveTime, lo.MoveTime)
		}
	}
}

// TestConfigForRatingClamps: out-of-range ratings clamp instead of going wild.
func TestConfigForRatingClamps(t *testing.T) {
	if configForRating(99999) != configForRating(RatingMax) {
		t.Error("rating above max should clamp to RatingMax")
	}
	if configForRating(-100) != configForRating(RatingMin) {
		t.Error("rating below min should clamp to RatingMin")
	}
}
