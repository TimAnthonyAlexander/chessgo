#pragma once
// zugzwang's rating -> strength ladder for the HTTP serve layer's `/bestmove`
// `limits.rating` path (and the UCI UCI_Elo option). This is the load-bearing
// bot-strength knob, and the ENGINE owns it end-to-end: callers (website /bot
// picker, hub filler/backfill bots, admin engine-vs-engine, UCI) pass a single
// target rating and the engine decides how to play at that strength. No caller
// does its own strength math.
//
// Weakening model: below full strength every legal move is ranked at a
// rating-scaled depth by ONE MultiPV search (so every move carries a score from
// the same completed iteration — see root_scores), then Weakening::pick()
// (centipawn-loss curve + absolute severity cap) chooses the move — see
// weakening.h. This REPLACES the old gomachine-ported noise/blunder scheme
// (which is why this is no longer a "field-for-field port" of rating.go — it is
// a deliberate redesign).
//
// SCALE: the rating spans RatingMin..RatingMax on the engine's own (CCRL-ish)
// ruler, where RatingMax is the engine's TRUE full strength (~3500 CCRL, see
// zugzwang/docs/CCRL.md). Two regimes:
//   - [RatingMin, RatingFull): WEAKENED — human-like play, calibrated so a given
//     rating plays ~at that strength (SF-UCI-anchored). This band is parameterized
//     off RatingFull (see weak_frac), so it is INDEPENDENT of RatingMax.
//   - [RatingFull, RatingMax]: CLEAN full-strength search, its depth/time budget
//     scaling with the rating up to the engine's maximum at RatingMax. This is a
//     real strength gradient — NOT a flat "everything is full strength" zone.
#include "position.h"
#include "move.h"
#include "search.h"
#include "weakening.h"
#include <cstdint>
#include <vector>

namespace Rating {

// Re-exported from weakening.h so the standard ladder and the variant ladders
// cannot drift apart. RatingMax is the engine's TRUE full strength (~3500 CCRL).
constexpr int RatingMin = Weakening::RatingMin;
constexpr int RatingMax = Weakening::RatingMax;
constexpr int RatingFull = Weakening::RatingFull;

struct LevelConfig {
    int moveTimeMs = 0;        // wall-clock COST CAP for the weakened ranking pass
    int cleanDepth = 0;        // depth for the clean (full-strength) search branch
    int rankDepth = 0;         // MultiPV ranking depth (weakened branch) — tactical sight
    double windowCp = 0.0;     // Regan curve width in CENTIPAWNS — the rating dial
    double consistency = 1.8;  // Regan curve `c` (exponent) — easy/hard error split
    double capCp = 0.0;        // absolute severity cap in cp — the blunder bound
    bool clean = false;        // true => full-strength group search, no weakening
};

// Map a target rating to its strength config (clamped to [RatingMin,RatingMax]).
LevelConfig config_for_rating(int rating);

// Root move + its score from the ranking mover's perspective (higher = better).
struct RootMove {
    Move move = MOVE_NONE;
    int score = 0;
};

// Result of a (possibly weakened) rating-path search: `pv` is the full principal
// variation for a clean search, or a single-element [move] for a weakened one.
struct WeakResult {
    Move move = MOVE_NONE;
    int score = 0;
    int depth = 0;
    int64_t nodes = 0;
    std::vector<Move> pv;
};

// Full `limits.rating` pipeline: config_for_rating + the Depth->Nodes->MoveTime
// explicit-override precedence (admin engine-vs-engine may set an explicit
// budget) + the clean-search-or-weakened-ranking branch. `pos` is mutated and
// restored during ranking. `history` = prior-position Zobrist keys. The clean
// branch fans across the whole `group` (Lazy SMP); the weakened ranking runs
// single-threaded on the group's primary Context.
WeakResult best_move_for_rating(Search::SearchGroup& group, Position& pos, int rating, int limitDepth,
                                 int limitMoveTimeMs, int64_t limitNodes,
                                 const std::vector<uint64_t>& history);

// Single-Context variant of best_move_for_rating for callers without a
// SearchGroup (the UCI UCI_Elo path): the clean branch runs a single-threaded
// Search::start on `ctx` instead of a group fan-out; the weakened branch is
// identical. Same override precedence and semantics otherwise.
WeakResult best_move_for_rating_single(Search::Context& ctx, Position& pos, int rating, int limitDepth,
                                        int limitMoveTimeMs, int64_t limitNodes,
                                        const std::vector<uint64_t>& history);

// "Unlosable" troll bot: the WORST (min-scoring) legal move at a fixed shallow
// depth, ignoring rating entirely.
WeakResult best_move_worst(Search::Context& ctx, Position& pos, const std::vector<uint64_t>& history);

} // namespace Rating
