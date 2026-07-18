#pragma once
// Human-like strength weakening — the shared move-selection model used by every
// zugzwang engine (standard chess + Crazyhouse + Duck) when asked to play below
// full strength. It REPLACES the old gomachine-ported "noise + blunder" scheme
// (uniform cp jitter, then a rare jump to a uniformly-random worse move), which
// produced an unrealistic bimodal profile: near-perfect play punctuated by
// occasional catastrophic moves (hanging a queen for free).
//
// The model here is:
//   1. Every legal move is scored (mover-relative cp) by the caller.
//   2. Scores are mapped to WIN PROBABILITY via a logistic — so a 40cp error
//      near equality matters a lot while the same 40cp when already +900 barely
//      matters (a human relaxes when winning, is sharp near equal).
//   3. A rating-scaled SEVERITY CAP drops any move whose win-prob is more than
//      capDelta below the best — this is the "no free queen" guarantee: a
//      shallow-obvious blunder never survives (its win-prob is far below best),
//      while a deep tactic the shallow ranking didn't see slips through (its
//      score still looks fine), which is exactly how humans blunder.
//   4. A softmax (Boltzmann) sample over the survivors' win-prob with a
//      rating-scaled TEMPERATURE picks the move — so every move is slightly
//      inaccurate, near-equal moves are near-equiprobable (the bot "barely
//      plays the best move"), and consistency rises smoothly as temperature
//      falls toward 0 at full strength.
//
// Combined with a rating-scaled RANKING DEPTH on the caller side (shallow at low
// ratings), the blunders become bounded tactical oversights that shrink with
// rating, never dice-roll catastrophes.
#include <cstdint>
#include <random>
#include <vector>

namespace Weakening {

// One scored candidate move. `score` is mover-relative (higher = better for the
// side to move) in the engine's centipawn / mate-score convention. `index` lets
// the caller map the chosen candidate back to its own move object.
struct Candidate {
    int index = 0;
    int score = 0;
};

// The strength dial. temperature/capDelta are on the win-probability [0,1]
// scale; winProbScale is in centipawns.
struct SoftmaxConfig {
    // Move selection follows the Regan–Haworth human move-probability curve:
    //   p(move) ∝ exp(−(δ / sensitivity)^consistency),  δ = win-prob gap to best.
    // `sensitivity` is the rating dial (smaller = sharper/stronger). `consistency`
    // (c) > 1 sharpens the easy/hard split: near-best moves stay ~equiprobable (so
    // the bot spreads on genuinely hard positions) while clearly-worse moves are
    // killed harder (so it does NOT deviate on easy/obvious ones — the fix for
    // "dumb blunders on easy positions"). c == 1 is a plain win-prob softmax.
    double sensitivity = 0.0;   // in win-prob units; <= 0 => deterministic best
    double consistency = 1.0;   // curve exponent c (>= 1)
    double capDelta = 1.0;      // hard safety: max win-prob a move may sit below best (>= 1 => none)
    double winProbScale = 350.0; // logistic scale C in cp: w = 1 / (1 + 10^(-cp/C))
    bool protectWinningMate = true; // never pass up a forced mate the search found
};

// cp -> win probability in (0,1) via a base-10 logistic; mate scores saturate
// near 1 (winning) / 0 (losing).
double win_prob(int cp, double scaleC);

// Choose a candidate by softmax-over-win-prob after the severity-cap filter.
// Deterministic argmax when temperature <= 0. `cands` need NOT be sorted.
// Returns the POSITION in `cands` of the chosen candidate (not Candidate::index).
// Empty -> 0.
size_t pick(const std::vector<Candidate>& cands, const SoftmaxConfig& cfg, std::mt19937_64& rng);

// A process-wide, thread-safe RNG source for the (concurrent) serve pool: each
// calling thread gets its own generator, so weakened searches on different pool
// contexts never race on one shared std::mt19937_64.
std::mt19937_64& thread_rng();

} // namespace Weakening
