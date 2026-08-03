#include "weakening.h"
#include "types.h" // is_mate_score
#include <cmath>

namespace Weakening {

namespace {

// Beyond this loss/window ratio the weight underflows to 0 anyway; clamping
// keeps std::pow's argument tame when a mate score sits opposite a normal one
// (a loss of ~64000cp would otherwise be raised to the `consistency` power).
constexpr double kMaxRatio = 40.0;

} // namespace

double win_prob(int cp, double scaleC) {
    if (is_mate_score(cp)) return cp > 0 ? 1.0 - 1e-9 : 1e-9;
    if (scaleC < 1.0) scaleC = 1.0;
    // Clamp the exponent so huge eval swings can't overflow std::pow.
    double x = double(cp) / scaleC;
    if (x > 40.0) return 1.0 - 1e-12;
    if (x < -40.0) return 1e-12;
    return 1.0 / (1.0 + std::pow(10.0, -x));
}

SoftmaxConfig curve_for_rating(int rating) {
    SoftmaxConfig cfg;
    if (rating >= RatingFull) return cfg; // windowCp 0 => deterministic best move
    if (rating < RatingMin) rating = RatingMin;

    // u: 0 at RatingFull, 1 at RatingMin.
    const double u = double(RatingFull - rating) / double(RatingFull - RatingMin);

    // Selection width in centipawns. Fitted so that measured average centipawn
    // loss lands near the human ACPL band for the label — `zugzwang ratingtest
    // probe` reports exactly this number, bucketed by how decided the position
    // is, so refit against it rather than guessing.
    cfg.windowCp = 300.0 * std::pow(u, 1.25);

    // Absolute severity bound: roughly a rook at 1200, a bishop at 1600, a pawn
    // and a half at 2000, half a pawn at 2500. A bot may play the occasional bad
    // move for its level; it may never hand over a piece it can plainly see.
    cfg.capCp = 780.0 * std::pow(u, 1.15);

    // 1.5 (weak) .. 2.0 (near full strength). Higher = errors concentrate on
    // genuinely close alternatives instead of spreading over obviously worse
    // ones, which is what stops a strong bot from playing a random legal move in
    // an easy position.
    cfg.consistency = 1.5 + 0.5 * (1.0 - u);
    return cfg;
}

size_t pick(const std::vector<Candidate>& cands, const SoftmaxConfig& cfg, std::mt19937_64& rng) {
    const size_t n = cands.size();
    if (n <= 1) return 0;

    // Best (true) score and its position — the anchor for the cap, the loss
    // measure, and the deterministic fallback.
    size_t bestPos = 0;
    for (size_t i = 1; i < n; ++i)
        if (cands[i].score > cands[bestPos].score) bestPos = i;
    const double bestScore = double(cands[bestPos].score);

    // Never throw away a forced win the search actually found. (We do NOT protect
    // against walking INTO a loss — that's a blunder weak ratings are allowed to
    // make when the ranking depth didn't see it.)
    if (cfg.protectWinningMate && is_mate_score(cands[bestPos].score) && cands[bestPos].score > 0)
        return bestPos;

    // Window off => deterministic best move.
    if (cfg.windowCp <= 0.0) return bestPos;

    // Severity cap, in centipawns: a move may never give away more than capCp
    // relative to the best move. ABSOLUTE — deliberately independent of how far
    // ahead or behind the mover already is, which is the whole fix (see the
    // header note). A move that loses a piece outright is dropped here whether
    // the position is dead level or already +2000.
    const double cap = cfg.capCp > 0.0 ? cfg.capCp : 0.0;
    std::vector<size_t> keep;
    keep.reserve(n);
    for (size_t i = 0; i < n; ++i) {
        if (i == bestPos) { keep.push_back(i); continue; }
        if (cap <= 0.0 || bestScore - double(cands[i].score) <= cap + 1e-9) keep.push_back(i);
    }
    if (keep.size() == 1) return keep[0];

    // Regan-Haworth selection curve: weight = exp(−(loss/windowCp)^c). The best
    // move (loss 0) has weight 1; c > 1 keeps near-best moves ~equiprobable while
    // killing clearly-worse ones. No max-subtraction needed — exponents are <= 0.
    const double w = cfg.windowCp;
    const double c = cfg.consistency > 0.0 ? cfg.consistency : 1.0;
    std::vector<double> p(keep.size());
    double sum = 0.0;
    for (size_t k = 0; k < keep.size(); ++k) {
        double loss = bestScore - double(cands[keep[k]].score);
        if (loss < 0.0) loss = 0.0;
        double ratio = loss / w;
        if (ratio > kMaxRatio) ratio = kMaxRatio;
        p[k] = std::exp(-std::pow(ratio, c));
        sum += p[k];
    }
    if (!(sum > 0.0)) return bestPos; // paranoia: degenerate weights

    std::uniform_real_distribution<double> ud(0.0, sum);
    double r = ud(rng);
    double acc = 0.0;
    for (size_t k = 0; k < keep.size(); ++k) {
        acc += p[k];
        if (r <= acc) return keep[k];
    }
    return keep.back();
}

std::mt19937_64& thread_rng() {
    static thread_local std::mt19937_64 gen(std::random_device{}());
    return gen;
}

} // namespace Weakening
