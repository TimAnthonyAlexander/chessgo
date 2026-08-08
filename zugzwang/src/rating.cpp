#include "rating.h"
#include "rules.h"
#include "search.h"
#include "weakening.h"
#include <cmath>

namespace Rating {

namespace {

constexpr int kWorstMoveDepth = 6;

// Ranks every legal move at `pos` to `rankDepth` plies (mover-relative) with ONE
// MultiPV search over all root moves.
//
// The MultiPV requirement is load-bearing, not an optimisation. Weakening::pick
// measures a move's error as its CENTIPAWN LOSS versus the best move, which is
// only meaningful if every candidate was scored at the same depth. The
// predecessor here ran one independent search per move — a depth-1 pass over all
// of them, then a deep re-rank that ran best-first until a wall-clock budget
// expired — so whenever the clock bound (a Watch filler passes 250ms for ~35
// moves, which never finished) the survivors carried depth-1 scores while the
// top moves carried deep ones. Shallow scores are systematically optimistic, so
// that mix quietly biased selection toward the moves that had been examined
// LEAST. Search::start's MultiPV loop returns every line from the same completed
// iteration (search.h: "identical across every line of one Result"), which is
// exactly the invariant pick() needs, and it is cheaper too — one iterative
// deepening tree with a shared TT instead of N cold ones.
//
// `moveTimeCapMs` is a COST cap only (0 = none): if it binds, the whole ranking
// simply lands at a shallower completed depth, with every move still scored at
// that same depth. `pos`'s history must be seeded by the caller; `pos` is left
// untouched.
std::vector<RootMove> root_scores(Search::Context& ctx, Position& pos, int rankDepth,
                                  int moveTimeCapMs, int64_t& nodesOut) {
    MoveList ml;
    Rules::generate_legal(pos, ml);
    std::vector<RootMove> out;
    if (ml.size() == 0) return out;
    out.reserve(ml.size());

    Search::Limits lim;
    lim.depth = rankDepth < 1 ? 1 : rankDepth;
    lim.movetime = moveTimeCapMs > 0 ? moveTimeCapMs : 0;
    lim.multiPV = static_cast<int>(ml.size()); // clamped to the legal count by start()
    lim.silent = true;
    Search::Result r = Search::start(ctx, pos, lim);
    nodesOut += r.nodes;

    for (const Search::Line& l : r.lines)
        if (!l.pv.empty()) out.push_back({l.pv[0], l.score});

    // Defensive: a search stopped before completing even depth 1 reports no
    // lines. Fall back to the plain legal-move list so the caller still gets a
    // move (all at an equal, if uninformative, score — never a mixed scale).
    if (out.empty())
        for (const ExtMove& em : ml) out.push_back({em.move, 0});

    return out;
}

// Softmax weakening over the ranked moves. Reports the CHOSEN move's true
// (post-ranking) score.
WeakResult pick_weakened(const std::vector<RootMove>& roots, const LevelConfig& cfg,
                         int rankDepth, int64_t nodes) {
    if (roots.empty()) return WeakResult{};
    if (roots.size() == 1)
        return WeakResult{roots[0].move, roots[0].score, rankDepth, nodes, {roots[0].move}};

    std::vector<Weakening::Candidate> cands;
    cands.reserve(roots.size());
    for (size_t i = 0; i < roots.size(); ++i)
        cands.push_back({static_cast<int>(i), roots[i].score});

    Weakening::SoftmaxConfig sc;
    sc.windowCp = cfg.windowCp;
    sc.consistency = cfg.consistency;
    sc.capCp = cfg.capCp;
    sc.protectWinningMate = true;

    size_t pos = Weakening::pick(cands, sc, Weakening::thread_rng());
    const RootMove& chosen = roots[pos];
    return WeakResult{chosen.move, chosen.score, rankDepth, nodes, {chosen.move}};
}

// NOTE — there is deliberately NO phase/endgame scaling here any more.
//
// A previous revision multiplied the selection width by up to 3x, doubled the
// severity cap and cut 3 ply off rankDepth as material came off the board, to
// stop endgames reading as "engine, not human". On a win-probability model that
// had already collapsed in decided positions it did nothing but deepen the
// collapse — and endgames are overwhelmingly decided positions, which is exactly
// why endgame play showed zero rating separation (measured: a 1200 bot and a
// 2488 bot both lost ~800cp/move in a lost king-and-pawns ending, and both
// played 10 distinct moves out of 24 samples in a drawn one).
//
// Under the centipawn model the phase knob is also unnecessary: eval gaps in an
// endgame are naturally small, so a fixed cp window already admits proportionally
// more alternatives there, and rating separation appears on its own (a 200cp
// losing try is 15% likely at 1600 and capped out entirely at 2488). Adding a
// phase multiplier on top would re-introduce the same "worse at the thing the
// user already complained about" behaviour. If measurement ever shows endgames
// playing too precisely at low ratings, widen `windowCp` there — never the cap.

// Smooth ramp helper: 0 at the weak end (rating==RatingMin) -> 1 at RatingFull.
double weak_frac(int rating) {
    double u = double(RatingFull - rating) / double(RatingFull - RatingMin); // 0 at full, 1 at min
    if (u < 0.0) u = 0.0;
    if (u > 1.0) u = 1.0;
    return u;
}

} // namespace

// Public wrapper over the ranking pass above — see rating.h for why a caller
// would want the whole ranked set instead of the ladder's own choice.
std::vector<RootMove> rank_root_moves(Search::Context& ctx, Position& pos, int rankDepth,
                                      int moveTimeCapMs, int64_t& nodesOut) {
    return root_scores(ctx, pos, rankDepth, moveTimeCapMs, nodesOut);
}

LevelConfig config_for_rating(int rating) {
    if (rating > RatingMax) rating = RatingMax;
    if (rating < RatingMin) rating = RatingMin;

    LevelConfig cfg;

    // s in [0,1] over the whole ladder: sets the search budget (time + depth).
    double s = double(rating - RatingMin) / double(RatingMax - RatingMin);

    constexpr double kMinMoveTimeMs = 80.0, kMaxMoveTimeMs = 2000.0;
    cfg.moveTimeMs = static_cast<int>(kMinMoveTimeMs * std::pow(kMaxMoveTimeMs / kMinMoveTimeMs, s));
    cfg.cleanDepth = static_cast<int>(2.0 + 16.0 * s + 0.5);

    if (rating >= RatingFull) {
        cfg.clean = true;
        // At the very top (RatingMax) play ABSOLUTE full strength — no depth cap
        // (a large, unreachable-in-budget bound so only movetime binds) and the
        // full time budget. Nothing whatsoever weakens the maximum-rating engine.
        if (rating >= RatingMax) {
            cfg.cleanDepth = 64;
            cfg.moveTimeMs = static_cast<int>(kMaxMoveTimeMs);
        }
        return cfg;
    }

    // Weakened branch. u: 0 at RatingFull, 1 at RatingMin.
    double u = weak_frac(rating);

    // Ranking depth (tactical sight) — the DOMINANT strength lever and the realistic
    // blunder source: a tactic/refutation beyond rankDepth is unseen at the root, so
    // a move that looks fine shallow but loses deep gets played (exactly how humans
    // err — and it lands on sharp/tactical positions, whose refutations are deep).
    // CRITICAL: this must NOT saturate. The prior `6 + 6·(1-u)` pinned every rating
    // above ~2000 to the depth-10 cap, so a "2021" bot ranked every move to the same
    // depth as a 2849 bot (~2600+ CCRL sight) and only a vanishing softmax window
    // separated them — it held quiet/equal positions flawlessly and never bled. The
    // curve below spans 2 (700) .. 8 (near full) and stays de-saturated across the
    // whole band, so rating actually buys tactical sight. (The old ladder's "honest
    // vs Stockfish UCI_Elo" anchor was the miscalibration source: SF's UCI_Elo ruler
    // is itself badly inflated at the top, which baked in a bot ~hundreds of Elo too
    // strong at its label. Re-anchored self-contained instead — see the harness.)
    //
    // Spans 1..8. It used to start at 2, but the ranking pass got materially
    // STRONGER at a given depth when it became a single MultiPV search (shared
    // TT, real root ordering, every move at the same completed iteration) — the
    // measured effect was that ratings 1000-1800 all lost about the same ~40cp
    // per move in balanced positions, i.e. the bottom of the ladder played far
    // above its label in exactly the quiet opening/middlegame positions that are
    // most visible. One ply off the bottom restores the spread.
    cfg.rankDepth = static_cast<int>(1.0 + 7.0 * (1.0 - u) + 0.5); // 1..8
    if (cfg.rankDepth < 1) cfg.rankDepth = 1;
    if (cfg.rankDepth > 8) cfg.rankDepth = 8;

    // Move selection (window / cap / curve exponent) comes from the ONE shared
    // ladder in weakening.cpp, which standard chess and all three variants use.
    // It was duplicated per engine before, so a fix landed in one and not the
    // others. Tune it there, and measure with `zugzwang ratingtest`.
    Weakening::SoftmaxConfig sel = Weakening::curve_for_rating(rating);
    cfg.windowCp = sel.windowCp;
    cfg.consistency = sel.consistency;
    cfg.capCp = sel.capCp;

    return cfg;
}

namespace {

// Resolved search budget after applying the Depth->Nodes->MoveTime explicit-
// override precedence on top of the rating's ladder config. An explicit budget
// (admin engine-vs-engine) overrides the ladder's time/depth; the rating still
// drives the weakening (window/cap).
struct Budget {
    int cleanDepth;
    int rankDepth;
    int cleanMoveTimeMs; // movetime for the clean branch (0 when depth/nodes bind)
    int rankMoveTimeMs;  // total budget for the weakened ranking pass
    int64_t nodes;
};

Budget resolve_budget(const LevelConfig& cfg, int limitDepth, int limitMoveTimeMs, int64_t limitNodes) {
    Budget b;
    b.cleanDepth = cfg.cleanDepth;
    b.rankDepth = cfg.rankDepth < 2 ? 2 : cfg.rankDepth;
    b.cleanMoveTimeMs = cfg.moveTimeMs;
    b.nodes = 0;

    // The WEAKENED ranking is DEPTH-bound, not clock-bound: the rating sets
    // rankDepth (tactical sight) and that alone determines strength, so a bot
    // plays at its rating regardless of how much think-time the caller grants
    // (extra clock never deepens it past the rating's sight). Default deadline
    // is 0 (none). An explicit movetime is honored only as a COST CAP (fillers
    // pass 250ms), and an explicit depth as a cost CAP on the rating's sight
    // (fillers pass 8) — neither raises strength above the rating.
    b.rankMoveTimeMs = limitMoveTimeMs > 0 ? limitMoveTimeMs : 0;
    if (limitDepth > 0 && limitDepth < b.rankDepth) b.rankDepth = limitDepth;

    // The CLEAN (full-strength) branch keeps the classic Depth->Nodes->MoveTime
    // explicit-override precedence.
    if (limitDepth > 0) {
        b.cleanDepth = limitDepth;
        b.cleanMoveTimeMs = 0;
    } else if (limitNodes > 0) {
        b.nodes = limitNodes;
        b.cleanMoveTimeMs = 0;
    } else if (limitMoveTimeMs > 0) {
        b.cleanMoveTimeMs = limitMoveTimeMs;
    }
    return b;
}

WeakResult run_weakened(Search::Context& ctx, Position& pos, const LevelConfig& cfg, const Budget& b) {
    int64_t nodesUsed = 0;
    auto roots = root_scores(ctx, pos, b.rankDepth, b.rankMoveTimeMs, nodesUsed);
    return pick_weakened(roots, cfg, b.rankDepth, nodesUsed);
}

} // namespace

WeakResult best_move_for_rating(Search::SearchGroup& group, Position& pos, int rating, int limitDepth,
                                 int limitMoveTimeMs, int64_t limitNodes,
                                 const std::vector<uint64_t>& history) {
    LevelConfig cfg = config_for_rating(rating);
    Budget b = resolve_budget(cfg, limitDepth, limitMoveTimeMs, limitNodes);
    Rules::seed_history(pos, history);

    if (cfg.clean) {
        // Full-strength search — fan across the whole group (Lazy SMP).
        Search::Limits lim;
        lim.depth = b.cleanDepth;
        lim.movetime = b.cleanMoveTimeMs;
        lim.nodes = b.nodes;
        lim.silent = true;
        Search::Result r = Search::start_group(group, pos, lim);
        return WeakResult{r.bestMove, r.score, r.depth, r.nodes, r.pv};
    }
    // Weakened ranking on the group's primary Context (extra threads are pointless
    // once the softmax dominates the choice).
    return run_weakened(Search::primary_context(group), pos, cfg, b);
}

WeakResult best_move_for_rating_single(Search::Context& ctx, Position& pos, int rating, int limitDepth,
                                        int limitMoveTimeMs, int64_t limitNodes,
                                        const std::vector<uint64_t>& history) {
    LevelConfig cfg = config_for_rating(rating);
    Budget b = resolve_budget(cfg, limitDepth, limitMoveTimeMs, limitNodes);
    Rules::seed_history(pos, history);

    if (cfg.clean) {
        Search::Limits lim;
        lim.depth = b.cleanDepth;
        lim.movetime = b.cleanMoveTimeMs;
        lim.nodes = b.nodes;
        lim.silent = true;
        Search::Result r = Search::start(ctx, pos, lim);
        return WeakResult{r.bestMove, r.score, r.depth, r.nodes, r.pv};
    }
    return run_weakened(ctx, pos, cfg, b);
}

WeakResult best_move_worst(Search::Context& ctx, Position& pos, const std::vector<uint64_t>& history) {
    Rules::seed_history(pos, history);
    int64_t nodesUsed = 0;
    auto roots = root_scores(ctx, pos, kWorstMoveDepth, 0, nodesUsed);
    if (roots.empty()) return WeakResult{};
    RootMove worst = roots[0];
    for (const RootMove& rm : roots)
        if (rm.score < worst.score) worst = rm;
    return WeakResult{worst.move, worst.score, kWorstMoveDepth, nodesUsed, {worst.move}};
}

} // namespace Rating
