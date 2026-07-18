#include "rating.h"
#include "rules.h"
#include "search.h"
#include "weakening.h"
#include <algorithm>
#include <cmath>

namespace Rating {

namespace {

constexpr int kWorstMoveDepth = 6;

// Win-probability logistic scale (cp) for the standard-chess NNUE eval. Larger =
// flatter mapping (a given cp gap is a smaller win-prob gap). Tuned so a ~1 pawn
// edge is a meaningful-but-not-decisive win-prob swing.
constexpr double kWinProbScale = 350.0;

// Ranks every legal move at `pos` to `rankDepth` plies (mover-relative). A cheap
// depth-1 (static-eval) pre-pass orders moves best-first; then a deep re-rank at
// `rankDepth` runs best-first until `totalMoveTimeMs` is spent — so if the clock
// binds, it's the already-weak moves that keep only their shallow score, never
// the strong ones. `pos`'s history must be seeded by the caller; do_move/
// undo_move are symmetric so it's left intact.
std::vector<RootMove> root_scores(Search::Context& ctx, Position& pos, int rankDepth,
                                  int totalMoveTimeMs, int64_t& nodesOut) {
    MoveList ml;
    Rules::generate_legal(pos, ml);
    std::vector<RootMove> out;
    out.reserve(ml.size());

    // Pass 1: a CAPTURE-AWARE base score for every move — a depth-1 search (which
    // resolves the opponent's immediate captures via quiescence at the leaf), NOT
    // a raw static eval. This is load-bearing: moves the time-limited deep pass
    // below doesn't reach keep this base score, and a raw static eval is
    // capture-blind (a piece moved to a hanging square looks fine), so a queen
    // could be sampled into a one-move capture. The depth-1 score sees the hang,
    // so the severity cap in pick_weakened drops it. Used for ordering + floor.
    for (const ExtMove& em : ml) {
        Move m = em.move;
        StateInfo st;
        pos.do_move(m, st);
        Search::Limits base;
        base.depth = 1;
        base.silent = true;
        Search::Result r = Search::start(ctx, pos, base);
        pos.undo_move(m);
        out.push_back({m, -r.score});
        nodesOut += r.nodes;
    }
    if (rankDepth <= 1 || out.size() <= 1) return out;

    // Order best-first so the deep pass covers the strongest moves first.
    std::stable_sort(out.begin(), out.end(),
                     [](const RootMove& a, const RootMove& b) { return a.score > b.score; });

    // Pass 2: deep re-rank until the total budget is spent.
    int64_t deadline = totalMoveTimeMs > 0 ? Search::now_ms() + totalMoveTimeMs : 0;
    for (auto& rm : out) {
        if (deadline > 0 && Search::now_ms() >= deadline) break; // remainder keep static score
        StateInfo st;
        pos.do_move(rm.move, st);
        Search::Limits lim;
        lim.depth = rankDepth - 1;
        lim.silent = true;
        Search::Result r = Search::start(ctx, pos, lim);
        pos.undo_move(rm.move);
        rm.score = -r.score;
        nodesOut += r.nodes;
    }
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
    sc.sensitivity = cfg.sensitivity;
    sc.consistency = cfg.consistency;
    sc.capDelta = cfg.capDelta;
    sc.winProbScale = kWinProbScale;
    sc.protectWinningMate = true;

    size_t pos = Weakening::pick(cands, sc, Weakening::thread_rng());
    const RootMove& chosen = roots[pos];
    return WeakResult{chosen.move, chosen.score, rankDepth, nodes, {chosen.move}};
}

// Game phase 0..24 (0 = bare kings, 24 = full material), the standard
// PhaseInc weights {N,B=1, R=2, Q=4} (mirrors eval.cpp).
int phase_of(const Position& pos) {
    int p = pos.count(WHITE, KNIGHT) + pos.count(BLACK, KNIGHT)
          + pos.count(WHITE, BISHOP) + pos.count(BLACK, BISHOP)
          + 2 * (pos.count(WHITE, ROOK) + pos.count(BLACK, ROOK))
          + 4 * (pos.count(WHITE, QUEEN) + pos.count(BLACK, QUEEN));
    return p > 24 ? 24 : p;
}

// Endgame factor 0..1: 0 in the middlegame (phase >= kPhaseMid), ramping to 1 in
// a deep endgame (phase <= kPhaseEnd).
double endgame_factor(int phase) {
    constexpr double kPhaseMid = 12.0, kPhaseEnd = 3.0;
    double f = (kPhaseMid - phase) / (kPhaseMid - kPhaseEnd);
    return f < 0.0 ? 0.0 : (f > 1.0 ? 1.0 : f);
}

// Phase-aware weakening: eval-softmax barely bites in the endgame (few moves,
// small eval gaps, strong eval + enough depth => technically perfect moves that
// read as "engine, not human"). Endgame skill is a SEPARATE, weaker human skill,
// so as material comes off we calculate shallower (rankDepth down) and wander
// more (temperature up, cap looser) — the capture-aware base pass still blocks
// free hangs. Middlegame play (eg==0) is untouched.
void apply_endgame_scaling(LevelConfig& cfg, const Position& pos) {
    if (cfg.clean) return;
    double eg = endgame_factor(phase_of(pos));
    if (eg <= 0.0) return;
    cfg.sensitivity *= (1.0 + 2.0 * eg);        // wander more among endgame moves
    cfg.consistency = std::max(1.3, cfg.consistency - 0.5 * eg); // less precise technique
    cfg.capDelta = std::min(0.5, cfg.capDelta * (1.0 + 1.0 * eg));
    cfg.rankDepth -= static_cast<int>(3.0 * eg + 0.5); // shallower endgame calculation
    if (cfg.rankDepth < 2) cfg.rankDepth = 2;
}

// Smooth ramp helper: 0 at the weak end (rating==RatingMin) -> 1 at RatingFull.
double weak_frac(int rating) {
    double u = double(RatingFull - rating) / double(RatingFull - RatingMin); // 0 at full, 1 at min
    if (u < 0.0) u = 0.0;
    if (u > 1.0) u = 1.0;
    return u;
}

} // namespace

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

    // Ranking depth (tactical sight): shallow at the weak end, deep near full.
    // This is the realistic BLUNDER source — a tactic beyond rankDepth is unseen,
    // so it can be played; its severity shrinks as depth grows with rating.
    // Ranking depth = the human "horizon" (also the whole-game strength lever;
    // these values anchored ~honestly vs Stockfish's UCI_Elo ladder).
    cfg.rankDepth = static_cast<int>(6.0 + 6.0 * (1.0 - u) + 0.5); // 6..12 (capped below)
    if (cfg.rankDepth < 2) cfg.rankDepth = 2;
    if (cfg.rankDepth > 10) cfg.rankDepth = 10;

    // Sensitivity `s` (Regan curve, win-prob units): the rating dial — smaller =
    // sharper = stronger. Grows toward the weak end.
    cfg.sensitivity = 0.10 * std::pow(u, 1.9);

    // Consistency `c` (Regan curve exponent) > 1: concentrates play on the best in
    // EASY positions (clearly-worse moves killed hard => no dumb easy blunders)
    // while keeping near-best moves ~equiprobable in HARD ones (errors land on
    // hard positions, like a human). Stronger players are more consistent.
    cfg.consistency = 1.8 + 0.5 * (1.0 - u);

    // Severity cap (hard safety, win-prob units): with the c-curve this rarely
    // binds; it guarantees an obviously-losing move never leaks through.
    cfg.capDelta = 0.02 + 0.13 * std::pow(u, 1.6);

    return cfg;
}

namespace {

// Resolved search budget after applying the Depth->Nodes->MoveTime explicit-
// override precedence on top of the rating's ladder config. An explicit budget
// (admin engine-vs-engine) overrides the ladder's time/depth; the rating still
// drives the weakening (temperature/cap).
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
    apply_endgame_scaling(cfg, pos);
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
    apply_endgame_scaling(cfg, pos);
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
