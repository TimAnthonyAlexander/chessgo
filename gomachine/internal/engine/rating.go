package engine

import "time"

// Rating ladder — the rating-first replacement for the 0..10 levels (SPEC §11).
// A target Elo (RatingMin..RatingMax) maps to a weakening config at a FIXED
// 100ms/move budget, so the UI can be a plain rating picker and the bot plays at
// the strength it advertises. Strength falls monotonically as the rating drops:
// the strong end caps search depth; the weak end ranks root moves at a shrinking
// depth and adds eval noise + outright blunders.
//
// Anchoring: full strength @ 100ms ≈ RatingMax (the Stockfish anchor, 2026-06-19).
//
// NOTE: the breakpoints below are a SENSIBLE FIRST DRAFT, not yet calibrated.
// Re-fit them with `bench calibrate` at 100ms and SPRT-spot-check before trusting
// the exact Elo↔config mapping — same discipline as the eval (docs/ENGINE_STRENGTH.md).
const (
	RatingMax = 2720 // full strength @ 100ms
	RatingMin = 700  // shallow + very noisy + frequent blunders

	ratingMoveTime    = 100 * time.Millisecond
	ratingStrongFloor = 2400 // at/above: full search (depth-capped), no noise
)

// configForRating returns the weakening config for a target Elo. clamped to
// [RatingMin, RatingMax].
func configForRating(rating int) LevelConfig {
	if rating > RatingMax {
		rating = RatingMax
	}
	if rating < RatingMin {
		rating = RatingMin
	}

	switch {
	case rating >= 2650:
		// Full strength @ 100ms (depth unbounded; the time budget binds).
		return LevelConfig{Depth: 0, MoveTime: ratingMoveTime}
	case rating >= ratingStrongFloor:
		// Strong but slightly capped: full-quality search to a fixed depth.
		return LevelConfig{Depth: 10, MoveTime: ratingMoveTime}
	default:
		// Weakened: root-move ranking at a shrinking depth + growing noise/blunder.
		t := float64(ratingStrongFloor-rating) / float64(ratingStrongFloor-RatingMin) // 0..1
		depth := int(8 - 6*t + 0.5)                                                   // 8 → 2
		noise := int(220*t*t + 0.5)                                                   // 0 → ~220 (grows faster at the weak end)
		blunder := 0.34 * t                                                           // 0 → ~0.34
		return LevelConfig{Depth: depth, MoveTime: ratingMoveTime, NoiseCp: noise, Blunder: blunder}
	}
}
