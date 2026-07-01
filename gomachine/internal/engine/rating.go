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
// SCALE — this ladder is on the CCRL ruler, not FIDE/human (docs/ENGINE_STRENGTH.md
// §20). RatingMax is the engine's TRUE full strength, which two full-strength CCRL
// matches bracket at 3400–3700 (100–0 vs a ~3400 engine; lost to a ~3700). Full
// strength is a single ceiling config (max depth + time + zero noise) — the number we
// print for it is just a LABEL, and CCRL is the honest one. The old top was 2900, but
// that was the FIDE/human ruler (which runs ~400–600 below CCRL); the SAME ceiling
// config that used to be labelled 2900 is ≈3500 on CCRL. History: 2720→2900 after the
// NNUE ship (+212 Elo @ movetime vs HCE), then →3500 (CCRL re-anchor, 2026-07-01).
//
// Human matchmaking stays FIDE-centered: the hub's backfill and the /bot picker feed
// human-scale ratings through EngineRatingForHuman() below, which maps them onto this
// CCRL ladder preserving playing strength — so live Glicko is untouched by this change.
//
// NOTE: monotonic by construction; only the TOP is CCRL-anchored (via the two matches
// above). Intermediate Elo↔config is a SENSIBLE FIRST DRAFT — re-fit with
// `bench calibrate` + SPRT before trusting the exact numbers.
const (
	RatingMax = 3500 // full strength on the CCRL ruler (top of the ladder; see scale note)
	RatingMin = 700  // shallow + very noisy + frequent blunders

	// The old FIDE/human-scale full-strength label. EngineRatingForHuman maps the
	// human ladder [RatingMin, humanFullStrength] onto the CCRL ladder [RatingMin,
	// RatingMax] so human-facing callers keep producing the exact same play.
	humanFullStrength = 2900

	// Strong end is differentiated by TIME (continuous), because at a fixed budget
	// full strength is only ~depth 13, so integer depth caps (12/13/14) are
	// indistinguishable and the top flat-lines. Move time grows geometrically.
	ratingMinMoveTime = 60 * time.Millisecond   // weakest bot's think time
	ratingMaxMoveTime = 1900 * time.Millisecond // full-strength think time (matches old level 10)

	// At/above this rating, play is clean (zero eval noise + blunders); strength is
	// set purely by time + depth. Below it, noise/blunders grow toward RatingMin.
	// Re-anchored 2200→2600 with the CCRL rescale to hold the same normalized
	// noise-onset position on the wider ladder ((2600-700)/2800 ≈ (2200-700)/2200).
	ratingCleanFloor = 2600
)

// EngineRatingForHuman maps a FIDE/human-scale rating onto the engine's native CCRL
// rating ladder, PRESERVING playing strength: a value that produced strength X on the
// old human scale [RatingMin, humanFullStrength] produces the same X on the CCRL scale
// [RatingMin, RatingMax]. Human matchmaking/Glicko stays FIDE-centered; only the engine
// ladder speaks CCRL, so human-facing callers (hub backfill, the /bot picker) route
// through this and play identically to before the rescale. The admin engine-vs page
// speaks raw CCRL and does NOT convert.
func EngineRatingForHuman(human int) int {
	return RatingMin + (human-RatingMin)*(RatingMax-RatingMin)/(humanFullStrength-RatingMin)
}

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
