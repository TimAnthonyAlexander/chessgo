#include "rating.h"
#include "rules.h"
#include "search.h"
#include "eval.h"
#include <algorithm>
#include <cmath>
#include <random>

namespace Rating {

namespace {

// Practicality cap on the root-ranking depth (weakened branch only). gomachine
// ranks EVERY legal move to the full uncapped cfg.Depth (up to ~13 near the
// rating-2599 noise/blunder ceiling) via a single raw negamax call per move
// (search.go:1005). Zugzwang has no equivalent — the only entry point is the
// full iterative-deepening `Search::start`, so ranking N moves means N
// independent ID searches, each noticeably pricier than gomachine's one-shot
// negamax. Capping keeps a live bot move bounded on ordinary hardware.
// gomachine's OWN worstMoveDepth=6 is documented as "deep enough... shallow
// enough that ranking all ~35 moves stays effectively instant" — 8 gives a
// little more headroom while keeping the same "instant" character. This is a
// deliberate, flagged deviation from the source formula (see rating.h).
constexpr int kMaxRankDepth = 8;
constexpr int kWorstMoveDepth = 6;

std::mt19937_64& rng() {
    static std::mt19937_64 gen(std::random_device{}());
    return gen;
}

// Ranks every legal move at `pos` to `depth` plies (from the mover's
// perspective), by playing the move and either statically evaluating (depth
// 0) or running a silent fixed-depth search on the resulting child. Mirrors
// searcher.RootScores' MEANING (per-move independent search, mover-relative
// scores) though not its exact mechanism — see kMaxRankDepth above. `pos`'s
// game history must already be seeded (Rules::seed_history) by the caller;
// each candidate's do_move/undo_move is symmetric so history is left intact.
std::vector<RootMove> root_scores(Search::Context& ctx, Position& pos, int depth, int64_t& nodesOut) {
    MoveList ml;
    Rules::generate_legal(pos, ml);
    std::vector<RootMove> out;
    out.reserve(ml.size());
    for (const ExtMove& em : ml) {
        Move m = em.move;
        StateInfo st;
        pos.do_move(m, st);
        int childScore;
        if (depth - 1 <= 0) {
            childScore = Eval::evaluate(pos); // stm-relative, no further search
        } else {
            Search::Limits lim;
            lim.depth = depth - 1;
            lim.silent = true;
            Search::Result r = Search::start(ctx, pos, lim);
            childScore = r.score;
            nodesOut += r.nodes;
        }
        pos.undo_move(m);
        out.push_back({m, -childScore});
    }
    return out;
}

// Port of engine.pickWeakened: jitter every candidate's score by
// +/-cfg.noiseCp, sort by the JITTERED score, then either take the top (index
// 0) or — with probability cfg.blunder — a uniformly random pick from the
// weaker half of that jitter-sorted list. Reports the CHOSEN move's true
// (pre-noise) score, exactly like gomachine.
WeakResult pick_weakened(const std::vector<RootMove>& roots, const LevelConfig& cfg,
                          int rankDepth, int64_t nodes) {
    if (roots.empty()) return WeakResult{};
    if (roots.size() == 1) {
        return WeakResult{roots[0].move, roots[0].score, rankDepth, nodes, {roots[0].move}};
    }

    std::vector<RootMove> noisy = roots;
    if (cfg.noiseCp > 0) {
        std::uniform_int_distribution<int> jitter(-cfg.noiseCp, cfg.noiseCp);
        for (auto& rm : noisy) rm.score += jitter(rng());
    }
    std::stable_sort(noisy.begin(), noisy.end(),
                      [](const RootMove& a, const RootMove& b) { return a.score > b.score; });

    int pick = 0;
    std::uniform_real_distribution<double> unit(0.0, 1.0);
    if (cfg.blunder > 0.0 && unit(rng()) < cfg.blunder) {
        int lo = static_cast<int>(noisy.size()) / 2;
        std::uniform_int_distribution<int> weak(lo, static_cast<int>(noisy.size()) - 1);
        pick = weak(rng());
    }
    Move chosen = noisy[static_cast<size_t>(pick)].move;

    int trueScore = 0;
    for (const RootMove& rm : roots) {
        if (rm.move == chosen) { trueScore = rm.score; break; }
    }
    return WeakResult{chosen, trueScore, rankDepth, nodes, {chosen}};
}

} // namespace

LevelConfig config_for_rating(int rating) {
    if (rating > RatingMax) rating = RatingMax;
    if (rating < RatingMin) rating = RatingMin;

    // s in [0,1]: 0 at RatingMin (weakest), 1 at RatingMax (full strength).
    double s = double(rating - RatingMin) / double(RatingMax - RatingMin);

    constexpr double kMinMoveTimeMs = 60.0, kMaxMoveTimeMs = 1900.0;
    double ratio = kMaxMoveTimeMs / kMinMoveTimeMs;
    // Go: time.Duration(float64(...)) truncates toward zero — mirror with a
    // plain (int) cast, not a round, to match gomachine's numbers exactly.
    int moveTimeMs = static_cast<int>(kMinMoveTimeMs * std::pow(ratio, s));

    int depth = static_cast<int>(2.0 + 16.0 * s + 0.5);

    int noiseCp = 0;
    double blunder = 0.0;
    if (rating < RatingCleanFloor) {
        double u = double(RatingCleanFloor - rating) / double(RatingCleanFloor - RatingMin);
        noiseCp = static_cast<int>(160.0 * u * u + 0.5);
        blunder = 0.33 * u * u;
    }

    return LevelConfig{depth, moveTimeMs, noiseCp, blunder};
}

WeakResult best_move_for_rating(Search::SearchGroup& group, Position& pos, int rating, int limitDepth,
                                 int limitMoveTimeMs, int64_t limitNodes,
                                 const std::vector<uint64_t>& history) {
    LevelConfig cfg = config_for_rating(rating);

    // Depth -> Nodes -> MoveTime explicit-override precedence, exactly like
    // BestMoveForRatingLimitedAggr (server.go's admin engine-vs-engine UI is
    // the only caller that ever sets more than one).
    int depth = cfg.depth;
    int moveTimeMs = cfg.moveTimeMs;
    int64_t nodes = 0;
    if (limitDepth > 0) {
        depth = limitDepth;
        moveTimeMs = 0;
    } else if (limitNodes > 0) {
        nodes = limitNodes;
        moveTimeMs = 0;
    } else if (limitMoveTimeMs > 0) {
        moveTimeMs = limitMoveTimeMs;
        nodes = 0;
    }

    Rules::seed_history(pos, history);

    if (cfg.noiseCp == 0 && cfg.blunder == 0.0) {
        // Clean (unweakened) search — the full-strength rating path. Fan out
        // across the whole group (Lazy SMP) so a high/max-rating request uses
        // all the group's threads, same as the no-rating full-strength path.
        Search::Limits lim;
        lim.depth = depth;
        lim.movetime = moveTimeMs;
        lim.nodes = nodes;
        lim.silent = true;
        Search::Result r = Search::start_group(group, pos, lim);
        return WeakResult{r.bestMove, r.score, r.depth, r.nodes, r.pv};
    }

    // Weakened ranking: single-threaded on the group's primary Context — extra
    // threads are pointless once noise/blunders dominate the move choice.
    Search::Context& ctx = Search::primary_context(group);

    int rankDepth = depth;
    if (rankDepth < 1) rankDepth = 1;
    if (rankDepth > kMaxRankDepth) rankDepth = kMaxRankDepth;

    int64_t nodesUsed = 0;
    auto roots = root_scores(ctx, pos, rankDepth, nodesUsed);
    return pick_weakened(roots, cfg, rankDepth, nodesUsed);
}

WeakResult best_move_worst(Search::Context& ctx, Position& pos, const std::vector<uint64_t>& history) {
    Rules::seed_history(pos, history);
    int64_t nodesUsed = 0;
    auto roots = root_scores(ctx, pos, kWorstMoveDepth, nodesUsed);
    if (roots.empty()) return WeakResult{};
    RootMove worst = roots[0];
    for (const RootMove& rm : roots)
        if (rm.score < worst.score) worst = rm;
    return WeakResult{worst.move, worst.score, kWorstMoveDepth, nodesUsed, {worst.move}};
}

} // namespace Rating
