package engine

import (
	"math"
	"time"
)

// Rating ladder — the rating-first replacement for the 0..10 levels (SPEC §11).
// A target Elo (RatingMin..RatingMax) maps to a weakening config so the UI can be
// a plain rating picker and the bot plays at the strength it advertises. Strength
// rises MONOTONICALLY and CONTINUOUSLY with the rating — there is no flat zone:
// every step up buys more thinking time + depth (the strong end) and less eval
// noise + fewer blunders (the weak end).
//
// Anchoring: full strength ≈ RatingMax. Raised 2720→2900 after the NNUE ship
// (2026-06-21): the eval gained +212 Elo @ movetime vs HCE (docs/ENGINE_STRENGTH.md
// §11). The 100ms Stockfish anchor reads ~2765 ± 128 (even vs SF-2800); the top of
// the ladder thinks up to ~1900ms (not 100ms), where the engine is meaningfully
// stronger than that 100ms band — so 2900 at the top is defensible.
//
// NOTE: monotonic by construction, but the absolute Elo↔config mapping is a
// SENSIBLE FIRST DRAFT, not yet calibrated. Re-fit with `bench calibrate` + SPRT
// spot-checks before trusting the exact Elo↔config numbers.
const (
	RatingMax = 2900 // full strength (top of the ladder; see anchoring note above)
	RatingMin = 700  // shallow + very noisy + frequent blunders

	// Strong end is differentiated by TIME (continuous), because at a fixed budget
	// full strength is only ~depth 13, so integer depth caps (12/13/14) are
	// indistinguishable and the top flat-lines. Move time grows geometrically.
	ratingMinMoveTime = 60 * time.Millisecond   // weakest bot's think time
	ratingMaxMoveTime = 1900 * time.Millisecond // full-strength think time (matches old level 10)

	// At/above this rating, play is clean (zero eval noise + blunders); strength is
	// set purely by time + depth. Below it, noise/blunders grow toward RatingMin.
	ratingCleanFloor = 2200
)

// configForRating returns the weakening config for a target Elo, clamped to
// [RatingMin, RatingMax]. Strength is monotonic in the rating across the WHOLE
// range — no flat zone (the old fixed-100ms design flat-lined above ~2650 because
// integer depth was its only strong-end knob; this scales move time instead).
func configForRating(rating int) LevelConfig {
	if rating > RatingMax {
		rating = RatingMax
	}
	if rating < RatingMin {
		rating = RatingMin
	}

	// s ∈ [0,1]: 0 at RatingMin (weakest), 1 at RatingMax (full strength).
	s := float64(rating-RatingMin) / float64(RatingMax-RatingMin)

	// Move time grows geometrically (60ms → 1900ms) — the continuous strong-end
	// knob, so every rating step changes the node budget (no flat top).
	ratio := float64(ratingMaxMoveTime) / float64(ratingMinMoveTime)
	moveTime := time.Duration(float64(ratingMinMoveTime) * math.Pow(ratio, s))

	// Depth cap rises 2 → 18; at the top, 18 is effectively unbounded for these
	// budgets (matches the old level-10 definition), so the time knob binds.
	depth := int(2.0 + 16.0*s + 0.5)

	// Eval noise + outright blunders only below ratingCleanFloor, growing
	// quadratically toward RatingMin (faster at the weak end). Above the floor:
	// clean play, differentiated purely by time + depth.
	noise, blunder := 0, 0.0
	if rating < ratingCleanFloor {
		u := float64(ratingCleanFloor-rating) / float64(ratingCleanFloor-RatingMin) // 0..1
		noise = int(160.0*u*u + 0.5)
		blunder = 0.33 * u * u
	}

	return LevelConfig{Depth: depth, MoveTime: moveTime, NoiseCp: noise, Blunder: blunder}
}
