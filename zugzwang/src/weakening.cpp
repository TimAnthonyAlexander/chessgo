#include "weakening.h"
#include "types.h" // is_mate_score
#include <cmath>

namespace Weakening {

double win_prob(int cp, double scaleC) {
    if (is_mate_score(cp)) return cp > 0 ? 1.0 - 1e-9 : 1e-9;
    if (scaleC < 1.0) scaleC = 1.0;
    // Clamp the exponent so huge eval swings can't overflow std::pow.
    double x = double(cp) / scaleC;
    if (x > 40.0) return 1.0 - 1e-12;
    if (x < -40.0) return 1e-12;
    return 1.0 / (1.0 + std::pow(10.0, -x));
}

size_t pick(const std::vector<Candidate>& cands, const SoftmaxConfig& cfg, std::mt19937_64& rng) {
    const size_t n = cands.size();
    if (n <= 1) return 0;

    // Best (true) score and its position — the anchor for the cap and the
    // deterministic fallback.
    size_t bestPos = 0;
    for (size_t i = 1; i < n; ++i)
        if (cands[i].score > cands[bestPos].score) bestPos = i;
    const int bestScore = cands[bestPos].score;

    // Never throw away a forced win the search actually found. (We do NOT protect
    // against walking INTO a loss — that's a blunder weak ratings are allowed to
    // make when the ranking depth didn't see it.)
    if (cfg.protectWinningMate && is_mate_score(bestScore) && bestScore > 0)
        return bestPos;

    const double bestW = win_prob(bestScore, cfg.winProbScale);

    // Severity cap: keep moves whose win-prob drop vs best is within capDelta.
    // Always keep the best. capDelta >= 1 keeps everything. In an already-lost
    // position bestW is small, so the window naturally widens (the bot flails).
    std::vector<size_t> keep;
    keep.reserve(n);
    if (cfg.capDelta >= 1.0) {
        for (size_t i = 0; i < n; ++i) keep.push_back(i);
    } else {
        for (size_t i = 0; i < n; ++i) {
            if (i == bestPos) { keep.push_back(i); continue; }
            double w = win_prob(cands[i].score, cfg.winProbScale);
            if ((bestW - w) <= cfg.capDelta + 1e-12) keep.push_back(i);
        }
    }
    if (keep.size() == 1) return keep[0];

    // Sensitivity off => deterministic best move.
    if (cfg.sensitivity <= 1e-9) return bestPos;

    // Regan–Haworth selection curve: weight = exp(−(δ/s)^c), δ = win-prob gap to
    // best (>= 0). The best move (δ=0) has weight 1; c>1 keeps near-best moves
    // ~equiprobable (spread on hard positions) while killing clearly-worse moves
    // (no deviation on easy ones). No max-subtraction needed — exponents are <= 0.
    const double s = cfg.sensitivity;
    const double c = cfg.consistency > 0.0 ? cfg.consistency : 1.0;
    std::vector<double> p(keep.size());
    double sum = 0.0;
    for (size_t k = 0; k < keep.size(); ++k) {
        double w = win_prob(cands[keep[k]].score, cfg.winProbScale);
        double delta = bestW - w;
        if (delta < 0.0) delta = 0.0;
        p[k] = std::exp(-std::pow(delta / s, c));
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
