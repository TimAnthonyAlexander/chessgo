#pragma once
// Human-like strength weakening — the shared move-selection model used by every
// zugzwang engine (standard chess + Crazyhouse + Duck + Antichess) when asked to
// play below full strength.
//
// The model is:
//   1. Every legal move is scored (mover-relative cp) by the caller, ALL AT THE
//      SAME SEARCH DEPTH — mixing depths makes the scores incomparable and the
//      selection below meaningless.
//   2. A move's error is its CENTIPAWN LOSS relative to the best move,
//      `loss = bestScore - moveScore`.
//   3. A hard SEVERITY CAP (`capCp`) drops any move losing more than a
//      rating-scaled amount of material outright — the "no free queen"
//      guarantee.
//   4. The survivors are sampled from a Regan-Haworth curve
//      `p(move) ∝ exp(−(loss / windowCp)^consistency)` — so every move is
//      slightly inaccurate, near-best moves are near-equiprobable, and play
//      sharpens smoothly to deterministic as `windowCp` → 0 at full strength.
//
// Combined with a rating-scaled RANKING DEPTH on the caller side (shallow at low
// ratings), blunders become bounded tactical oversights that shrink with rating,
// never dice-roll catastrophes.
//
// ---------------------------------------------------------------------------
// WHY CENTIPAWNS AND NOT WIN PROBABILITY (do not "improve" this back)
// ---------------------------------------------------------------------------
// The predecessor measured a move's error as a WIN-PROBABILITY gap,
// `δ = wp(best) − wp(move)` with `wp(cp) = 1/(1+10^(−cp/350))`, and compared δ
// against a win-prob-scaled window and cap. The intent was sound — a 40cp error
// near equality should matter more than the same 40cp when already +900.
//
// It did not survive contact with decided positions, because `wp` SATURATES.
// Once either side is up about a piece, every non-instantly-losing move maps to
// a win probability within ~1e-4 of the best, so BOTH the cap and the softmax
// were comparing their coefficients against ~0 — and every one of them became a
// no-op simultaneously. `pick()` degenerated to a uniform draw over all legal
// moves. Measured on the shipped engine: a rating-2488 bot in a +1864cp position
// took a free rook 5% of the time across 40 samples and played 26 distinct
// moves; at +2688 and +3077 it never took it at all. A 2488-vs-2488 self-play
// game from a queen-up position threw away >250cp on 40 of its 43 plies. The
// collapse is symmetric — a LOST position saturates `wp` toward 0 just as hard,
// which is why endgame play showed no rating separation whatsoever (a 2488 bot
// and a 1200 bot both lost ~800cp/move at −1089cp).
//
// The failure is structural, not a mistuning: the knobs multiply a quantity that
// is already ~0 in exactly the regime where the bad play happens, so no
// coefficient can reach it. Successive retunes of the window, the exponent, the
// ranking depth and the endgame scaling all left the behaviour untouched for
// precisely this reason.
//
// Centipawn loss does not saturate, is monotone over the whole eval range, and
// is directly calibratable — it is the same unit as ACPL, the standard measure
// of human accuracy, so `windowCp` can be fitted to a target strength instead of
// guessed. `zugzwang ratingtest` measures both.
#include <cstdint>
#include <random>
#include <vector>

namespace Weakening {

// The shared rating ladder bounds. `Rating` (rating.h) re-exports these so the
// standard-chess ladder and the variant ladders cannot drift apart.
constexpr int RatingMin = 700;   // weakest bot on the ladder (below this, clamp)
constexpr int RatingMax = 3500;  // the engine's TRUE full strength (clamp ceiling)
constexpr int RatingFull = 2850; // at/above this, no weakening at all

// One scored candidate move. `score` is mover-relative (higher = better for the
// side to move) in the engine's centipawn / mate-score convention. `index` lets
// the caller map the chosen candidate back to its own move object.
//
// CONTRACT: every candidate in one `pick()` call must have been scored at the
// SAME depth. Scores from different depths are not comparable in centipawns, and
// a shallow score is systematically optimistic — mixing them silently biases
// selection toward whichever moves were searched least.
struct Candidate {
    int index = 0;
    int score = 0;
};

// The strength dial. Both knobs are in CENTIPAWNS, the same unit as the caller's
// scores (pawn == 100 in every zugzwang engine, standard and variant).
struct SoftmaxConfig {
    // Selection width: the cp loss at which a move's weight falls to 1/e of the
    // best move's. Smaller = sharper = stronger. <= 0 => deterministic best move.
    double windowCp = 0.0;
    // Curve exponent c (>= 1). c > 1 keeps near-best moves ~equiprobable (so the
    // bot spreads on genuinely hard positions) while killing clearly-worse moves
    // harder (so it does NOT deviate on easy/obvious ones).
    double consistency = 1.8;
    // Hard safety bound: the most cp a move may EVER give away versus the best,
    // regardless of how far ahead or behind the side to move already is. This is
    // the "no free queen" guarantee and the single most important property of
    // the model — keep it absolute. <= 0 => no cap.
    double capCp = 0.0;
    bool protectWinningMate = true; // never pass up a forced mate the search found
};

// The single shared rating -> selection-config curve, used by standard chess and
// every variant. One curve, one place to tune, so a fix cannot land in three of
// the four engines. Ratings at/above RatingFull return windowCp == 0 (play the
// best move); below RatingMin clamps.
SoftmaxConfig curve_for_rating(int rating);

// Choose a candidate: severity-cap filter, then sample the Regan-Haworth curve.
// Deterministic argmax when windowCp <= 0. `cands` need NOT be sorted. Returns
// the POSITION in `cands` of the chosen candidate (not Candidate::index).
// Empty -> 0.
size_t pick(const std::vector<Candidate>& cands, const SoftmaxConfig& cfg, std::mt19937_64& rng);

// cp -> win probability in (0,1) via a base-10 logistic; mate scores saturate
// near 1 (winning) / 0 (losing). Retained for REPORTING only (eval bars, harness
// output). It must never again drive move selection — see the note above.
double win_prob(int cp, double scaleC);

// A process-wide, thread-safe RNG source for the (concurrent) serve pool: each
// calling thread gets its own generator, so weakened searches on different pool
// contexts never race on one shared std::mt19937_64.
std::mt19937_64& thread_rng();

} // namespace Weakening
