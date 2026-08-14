#include "rating.h"
#include "rules.h"
#include "search.h"
#include "types.h" // is_mate_score
#include "weakening.h"
#include <algorithm>
#include <cmath>

namespace Rating {

namespace {

constexpr int kWorstMoveDepth = 6;

// ---------------------------------------------------------------------------
// SYZYGY ROOT -> SELECTION SCORE
// ---------------------------------------------------------------------------
// Weakening::pick measures a move's error as `bestScore - score` in centipawns.
// In a DTZ-ranked root the score it was handed is the REPORTED score, and
// reported_score() (search.cpp) deliberately collapses that: every certain win
// is the identical VALUE_TB_WIN, every cursed win and every blessed loss is
// VALUE_DRAW. Those are the right numbers to SHOW — a tablebase win is one
// verdict, not a spectrum — and they are useless to select on, because they make
// `loss` exactly 0 for every winning move. The severity cap then filters nothing
// and the softmax samples the winning moves UNIFORMLY, at every rung of the
// ladder. Measured on the reported game position `8/6Pb/5K2/4N3/4k3/8/8/8 w - -
// 71 93`, 30 samples per rung: ratings 800/1600/2400/2800 all spread their picks
// across the same 7 winning moves in the same flat proportions, and e5g6 (one of
// the two DTZ-optimal moves) came up 4/30, 1/30, 5/30, 5/30 — flat, and no
// better than the 1-in-7 a blind draw would give, at every rating. After, same
// four rungs: the two optimal moves take 11/30, 14/30, 30/30, 30/30 of the
// picks — the top two rungs play nothing else, the bottom one is still nearly
// free, which is what a ladder is supposed to look like.
//
// THIS IS THE SATURATION FAILURE FROM weakening.h, IN A NEW PLACE. That
// post-mortem is about win-probability selection: `wp` saturates once either
// side is up a piece, so cap and softmax both multiplied a quantity that was
// already ~0 exactly where the bad play happened, and no coefficient could reach
// it. The shape here is identical — the selection quantity is CONSTANT across
// the moves that matter — and so is the symptom: uniform-random play with zero
// rating separation. It is not fixable by tuning the window or the cap for the
// same reason it was not fixable there. The fix has to restore a real spread to
// the quantity being differenced, which is what this function does.
//
// WHY DTZ PLIES AND NOT tbRank. tbRank is the right ORDERING and it is what the
// full-strength search uses, but it cannot carry a gradient here: zug passes
// rankDTZ=false (TB_ROOT_RANK_DTZ, search.cpp — SF does too), so every certain
// win ranks at exactly MAX_DTZ and the band is flat by construction. DTZ is the
// quantity that actually varies, and it is the one that matters: what loses a
// won ≤5-man ending is not choosing a losing move — the band filter makes that
// impossible — it is WASTING the halfmove clock. Measured mechanism, from a full
// game trace at rating 2000 on that position: every White move stayed a genuine
// TB_WIN, and `rule50 + dtz` still climbed 46 -> 48 -> 50 -> 52 -> 56 ... -> 100
// over 30 moves, two to four plies at a time, until the clock ate the win. A
// move that is Δ plies off the DTZ optimum costs exactly Δ plies of budget, and
// the budget is ~100 plies for the whole conversion. So DTZ ply is the unit the
// error is actually measured in, and every other candidate (rank distance, a
// synthesized cp from the eval) is a proxy for it.
//
// THE MAPPING. Two levels, because the quantity has two levels:
//
//   * BAND (certain win > cursed win > draw > blessed loss > certain loss) is a
//     step of kBandCp, far larger than any rung's severity cap (780cp at the
//     weakest). Trading a certain win for a cursed one is not "a worse move",
//     it is throwing away the game result, and no rung of the ladder may do it.
//     That is today's behaviour (the VALUE_TB_WIN gap already made it
//     unreachable) and this preserves it deliberately.
//   * DTZ inside the band is `kCpPerWastedPly` per ply, clamped to kMaxDtzCp so
//     the within-band term can never reach across a band step.
//
// `-dtz` is "goodness" in every band at once: a winner wants dtz small (fewer
// plies to the zeroing move), a loser wants dtz very negative (a longer
// defence), and a draw is 0. So one linear term serves all five bands, and it
// also restores to this path the "keep pressing" gradient inside the cursed band
// that f4b68e5 removed from REPORTING (correctly — a cursed win is a draw, and
// saying so is not the same as playing for it).
//
// SCALE. kCpPerWastedPly is set from the ladder's own two ends, not guessed:
//   * it must EXCEED the strongest weakened rung's severity cap (10cp at 2800)
//     so that rung is DTZ-deterministic — 2850 and up plays unweakened and
//     converts, and the rung just below it must not fall off a cliff;
//   * it must stay small enough that the weakest rung's window (300cp at 700)
//     still spans the whole spread of a real root, so a 700 bot stays nearly as
//     free as it is today. 25cp/ply puts 12 wasted plies inside that window.
// 25 also makes the ~2-4 ply granularity of real root DTZ spreads (the position
// above offers dtz 15,15,19,19,19,19,23 — Δ ∈ {0,4,8}) land at 100cp and 200cp,
// i.e. squarely inside the ladder's middle rungs rather than under all of them
// or over all of them. Measured end-to-end by ./test/tb_rating.sh; refit there,
// not by reasoning.
constexpr int kCpPerWastedPly = 25;
// The within-band term is clamped so it can never reach across a band step, and
// so a garbage DTZ out of the tables cannot either. 120 plies covers the real
// range comfortably (the longest ≤5-man DTZ is around 100), and the band step is
// set above clamp + the weakest rung's 780cp cap, so the closest two bands ever
// come is 2000cp — no rung of the ladder can trade a certain win for a cursed
// one, a draw for a loss, or any other band swap.
constexpr int kMaxDtzCp = 3000; // 120 plies
constexpr int kBandCp   = 5000; // > kMaxDtzCp + the weakest rung's severity cap

// Selection score for one root move of a DTZ-ranked root. `tbRank`/`tbCursed`
// name the band (rank>0 win, ==0 draw, <0 loss; cursed splits certain from
// spent), `tbDtz` orders inside it. `reported` is the move's reported score and
// is passed through UNCHANGED when it is a real mate: a forced mate the search
// actually found is strictly more information than "tablebase win", it converts
// faster than DTZ does, and Weakening::pick's protectWinningMate must still see
// it. Never called for an unranked root (Search::Result::tbRanked).
int tb_selection_score(int reported, int tbRank, int tbDtz, bool tbCursed) {
    if (is_mate_score(reported)) return reported;

    int band = tbRank > 0 ? (tbCursed ? 1 : 2)
             : tbRank < 0 ? (tbCursed ? -1 : -2)
                          : 0;
    int dtzTerm = std::max(-kMaxDtzCp, std::min(kMaxDtzCp, -tbDtz * kCpPerWastedPly));
    return band * kBandCp + dtzTerm;
}

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

    // `score` is the REPORTED score; `selScore` is what the ladder selects on. They
    // differ only in a Syzygy-DTZ-ranked root — see tb_selection_score() above for
    // why reporting and selection cannot be the same number there.
    for (const Search::Line& l : r.lines)
        if (!l.pv.empty())
            out.push_back({l.pv[0], l.score,
                           r.tbRanked ? tb_selection_score(l.score, l.tbRank, l.tbDtz, l.tbCursed)
                                      : l.score});

    // Defensive: a search stopped before completing even depth 1 reports no
    // lines. Fall back to the plain legal-move list so the caller still gets a
    // move (all at an equal, if uninformative, score — never a mixed scale).
    if (out.empty())
        for (const ExtMove& em : ml) out.push_back({em.move, 0, 0});

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
        cands.push_back({static_cast<int>(i), roots[i].selScore});

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
    // Ranked on selScore for the same reason pick_weakened is: in a DTZ-ranked root
    // every certain loss REPORTS the identical -VALUE_TB_WIN, so `score` cannot tell
    // "mated fastest" from "resists longest" and the worst-move picker would have
    // been choosing between them at random.
    RootMove worst = roots[0];
    for (const RootMove& rm : roots)
        if (rm.selScore < worst.selScore) worst = rm;
    return WeakResult{worst.move, worst.score, kWorstMoveDepth, nodesUsed, {worst.move}};
}

} // namespace Rating
