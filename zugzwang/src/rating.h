#pragma once
// Port of gomachine's rating->strength ladder (internal/engine/rating.go
// configForRating + internal/engine/engine.go BestMoveConfig/pickWeakened/
// BestMoveWorst) for the HTTP serve layer's `/bestmove` `limits.rating` path.
// This IS the load-bearing bot-strength knob (WIRING_RECON.md §A) — the
// formula below is copied field-for-field from rating.go; only the internal
// ranking MECHANISM differs (see root_scores in rating.cpp) because zugzwang
// has no RootScores-equivalent search entry point to call directly.
#include "position.h"
#include "move.h"
#include <cstdint>
#include <vector>

namespace Rating {

constexpr int RatingMax = 3500;
constexpr int RatingMin = 700;
constexpr int RatingCleanFloor = 2600;

struct LevelConfig {
    int depth = 0;
    int moveTimeMs = 0;
    int noiseCp = 0;
    double blunder = 0.0;
};

// Exact port of engine.configForRating: clamp to [RatingMin,RatingMax], move
// time grows geometrically (60ms..1900ms), depth 2..18, noise/blunder only
// below RatingCleanFloor.
LevelConfig config_for_rating(int rating);

// Root move + its score from the ranking mover's perspective (higher=better).
struct RootMove {
    Move move = MOVE_NONE;
    int score = 0;
};

// Result of a (possibly weakened) rating-path search: `pv` is the full
// principal variation for a clean (unweakened) search, or a single-element
// [move] for a weakened one — mirrors gomachine's BestResult.PV exactly
// (server.go's /bestmove response shape doesn't distinguish the two, it just
// serializes whatever PV it got).
struct WeakResult {
    Move move = MOVE_NONE;
    int score = 0;
    int depth = 0;
    int64_t nodes = 0;
    std::vector<Move> pv;
};

// Full `limits.rating` pipeline: config_for_rating + the Depth->Nodes->
// MoveTime explicit-override precedence (mirrors BestMoveForRatingLimitedAggr)
// + clean-search-or-weakened-ranking branch (mirrors BestMoveConfig). `pos`
// is mutated and restored (do_move/undo_move) during ranking, left unchanged
// on return. `history` = prior-position Zobrist keys (current position's key
// is added internally).
WeakResult best_move_for_rating(Position& pos, int rating, int limitDepth,
                                 int limitMoveTimeMs, int64_t limitNodes,
                                 const std::vector<uint64_t>& history);

// "Unlosable" bot: the WORST (min-scoring) legal move at a fixed shallow
// depth, ignoring rating entirely. Mirrors engine.BestMoveWorst
// (worstMoveDepth=6).
WeakResult best_move_worst(Position& pos, const std::vector<uint64_t>& history);

} // namespace Rating
