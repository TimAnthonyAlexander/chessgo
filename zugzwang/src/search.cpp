#include "search.h"
#include "movegen.h"
#include "eval.h"
#include "nnue.h"
#include "nnue_accumulator.h"
#include "tt.h"
#include "bitboard.h"
#include <chrono>
#include <cstring>
#include <iostream>
#include <algorithm>
#include <cmath>
#include <string>

using namespace BB;

namespace Search {

std::atomic<bool> Stop{false};

namespace {

Limits limits;
int64_t timeLimitSoft = 0, timeLimitHard = 0;
int64_t nodeCount = 0;
int rootDepthGlobal = 0;

// LMR reduction table depends on tune.lmrBase/lmrDiv (D.1), so it's rebuilt
// whenever tune changes — forward-declared here so Tune::load() can call it;
// defined after `Reductions[64][64]` is in scope (search.cpp init()).
void build_reductions();

// Tunable pruning toggles (env-configurable for calibration)
struct Tune {
    bool lmp = true, quietSee = true, futility = true, razor = true, nullMove = true, lmr = true;
    bool corrHist = true;
    bool negExt = true;
    bool rfpSoft = true;
    bool iir = true;  // internal iterative reduction — env IIR=0 to disable (PARITY_GOMACHINE.md C.2)
    // ---- PARITY_GOMACHINE.md D.0/D.1 — ACCEPTED, baked into defaults 2026-07-14 ----
    // (previously env-gated PVGUARD=1/GMCONST=1; now on by default — the env
    // flags below are harmless no-ops that re-assert the same values.)
    bool pvGuard = true;  // D.0: add !PvNode to the LMP/futility/SEE-quiet/capture-SEE block
    bool gmConst = true;  // D.1: gomachine's tuned structural search constants (see load())
    int qsFutMargin = 300;
    // ---- Margin bundle 2 (SF_MARGINS.md #4/#5) — default OFF, SPRT independently ----
    bool nmpCutGate = false;    // NMP gate: cutNode && staticEval >= beta - 18*depth + 350
    bool lmrDepthPrune = false; // quiet futility + SEE-quiet pruning keyed on lmrDepth, not raw depth
    // ---- PARITY_GOMACHINE.md D.2/D.3 — Wave B, ACCEPTED, baked into defaults 2026-07-14 ----
    bool contHist = true; // D.2: continuation history (parent/grandparent-keyed quiet magnitude)
    bool doDeeper = true; // D.3: adaptive do-deeper/do-shallower LMR re-search depth
    // ---- PARITY_GOMACHINE.md D.5/D.7 — Wave C, default OFF, SPRT independently ----
    bool seeQuietLinear = false; // D.5: linear SEE-quiet shape -75*depth, depth<=6 (vs quadratic default)
    bool gmCheckExt = false;     // D.7: gomachine's per-node uncapped in-check depth++ (replaces per-move check ext)
    // ---- SPSA-tunable search margins (UCI spin options, search.cpp <-> uci.cpp) ----
    // Defaults reproduce the pre-tunable literals exactly (see set_tune_option's
    // callers in uci.cpp for the option table incl. min/max).
    int rfpMargin     = 75;   // reverse futility: eval - rfpMargin*(depth-improving) >= beta
    int razorMargin   = 200;  // razoring: eval + razorMargin*depth <= alpha
    int futBase       = 0;    // quiet futility base: eval + futBase + futSlope*depth <= alpha
    int futSlope      = 100;  // quiet futility per-depth slope
    int seeQuietCoeff = 25;   // SEE-quiet pruning: -seeQuietCoeff*depth*depth
    int captSeeCoeff  = 23;   // capture SEE pruning: -captSeeCoeff*depth
    int nmpEvalDiv    = 200;  // null-move R eval term: min((eval-beta)/nmpEvalDiv, 3)
    int singularMargin = 32;  // singular beta: ttValue - singularMargin*depth/16 (32 -> 2*depth, exact)
    // ---- D.1 gomachine structural constants — ACCEPTED, baked into defaults 2026-07-14 ----
    // (previously only applied via env GMCONST=1; not UCI-exposed)
    int captSeeMaxDepth  = 4;      // capture SEE pruning: only at depth <= this
    int singularMinDepth = 5;      // singular extension: only at depth >= this
    int aspInitDelta     = 25;     // aspiration window initial half-width
    int lmrMinMoves      = 4;      // LMR onset: reduce once moveCount > this (+1 at root)
    double lmrBase       = 0.7844; // LMR table: base + log(d)*log(m)/div
    double lmrDiv        = 2.4696;
    void load() {
        auto off = [](const char* n){ const char* e = getenv(n); return e && e[0]=='0'; };
        auto on  = [](const char* n){ const char* e = getenv(n); return e && e[0]=='1'; };
        if (off("LMP")) lmp = false;
        if (off("QSEE")) quietSee = false;
        if (off("FUT")) futility = false;
        if (off("RAZ")) razor = false;
        if (off("NULL")) nullMove = false;
        if (off("LMR")) lmr = false;
        if (off("CORRHIST")) corrHist = false;
        if (off("NEGEXT")) negExt = false;
        if (off("RFPSOFT")) rfpSoft = false;
        if (off("IIR")) iir = false;
        if (const char* e = getenv("QSFUT_MARGIN")) { int v = atoi(e); if (v > 0) qsFutMargin = v; }
        if (on("NMPCUTGATE")) nmpCutGate = true;
        if (on("LMRDEPTHPRUNE")) lmrDepthPrune = true;
        if (on("PVGUARD")) pvGuard = true;
        if (on("CONTHIST")) contHist = true;
        if (on("DODEEPER")) doDeeper = true;
        if (on("SEEQUIETLINEAR")) seeQuietLinear = true;
        if (on("GMCHECKEXT")) gmCheckExt = true;
        if (on("GMCONST")) {
            // PARITY_GOMACHINE.md §D.1 — the structural constants below are now the
            // field DEFAULTS (baked in 2026-07-14), so this block is a redundant
            // no-op re-assertion of the same values; kept so GMCONST=1 stays valid
            // and explicit for anyone still setting it. Structural-only (not
            // UCI-exposed): the 4 UCI-exposed margins this used to clobber
            // (rfpMargin/futBase/futSlope/captSeeCoeff) default to these same
            // gomachine values directly in the field initializers above, so SPSA
            // can still `setoption` them without GMCONST overwriting the value on
            // load().
            gmConst = true;
            captSeeMaxDepth  = 4;
            singularMinDepth = 5;
            aspInitDelta     = 25;
            lmrMinMoves      = 4;
            lmrBase          = 0.7844;
            lmrDiv           = 2.4696;
        }
        build_reductions();
    }
} tune;

// ---- Correction History (CorrHist) ----
// Learns the running bias between the (raw) static eval and the eventual search
// result, keyed by pawn-structure and per-color non-pawn-material patterns
// (Position::pawn_key() / non_pawn_key(), maintained incrementally in
// Position::do_move — see position.h/.cpp). The corrected eval is what search
// pruning (RFP/NMP/razoring/futility) and the `improving` heuristic read;
// Eval::evaluate() itself is never touched, so the `eval` UCI command and the
// golden-eval fixture stay byte-identical. Formula mirrors Stockfish 18
// (src/search.cpp: correction_value / to_corrected_static_eval /
// update_correction_history, src/history.h: StatsEntry::operator<<), scoped
// down to the two table kinds the task asks for (pawn + per-color non-pawn) —
// SF's extra minor-piece and continuation tables are not implemented here.
constexpr int CORR_SIZE  = 16384;       // entries per table (power of two -> mask)
constexpr int CORR_MASK  = CORR_SIZE - 1;
constexpr int CORR_LIMIT = 1024;        // per-entry clamp (SF's CORRECTION_HISTORY_LIMIT)
// SF's blend weights (search.cpp correction_value: 10347/8821/11665/11665/7841
// for pawn/minor/wnp/bnp/cont); we keep the two we implement, applied then
// divided by CORR_APPLY_SHIFT (SF: cv / 131072) to land back in centipawns.
constexpr int CORR_W_PAWN       = 10347;
constexpr int CORR_W_NONPAWN    = 11665;
constexpr int CORR_APPLY_SHIFT  = 131072;
// SF's per-table update weight for the non-pawn tables relative to the pawn
// table (update_correction_history: `bonus * nonPawnWeight / 128`, weight 178;
// the pawn table itself gets the raw `bonus`).
constexpr int CORR_NONPAWN_UPDATE_NUM = 178;
constexpr int CORR_NONPAWN_UPDATE_DEN = 128;

int corrHist[COLOR_NB][CORR_SIZE];             // [stm][pawnKey & mask]
int corrHistNP[COLOR_NB][COLOR_NB][CORR_SIZE]; // [stm][pieceColor][nonPawnKey(pieceColor) & mask]

// SF's history-gravity update (history.h StatsEntry::operator<<): nudge the
// entry toward `bonus`, decaying proportionally so it never leaves ±CORR_LIMIT.
void corrhist_update_entry(int& e, int bonus) {
    bonus = std::max(-CORR_LIMIT, std::min(CORR_LIMIT, bonus));
    e += bonus - e * std::abs(bonus) / CORR_LIMIT;
}

// Weighted, blended correction (centipawns, side-to-move-relative) — SF's
// correction_value(), pawn + white-nonpawn + black-nonpawn terms only.
int correction(const Position& pos) {
    Color stm = pos.side_to_move();
    int pcv   = corrHist[stm][pos.pawn_key() & CORR_MASK];
    int wnpcv = corrHistNP[stm][WHITE][pos.non_pawn_key(WHITE) & CORR_MASK];
    int bnpcv = corrHistNP[stm][BLACK][pos.non_pawn_key(BLACK) & CORR_MASK];
    long long cv = (long long)CORR_W_PAWN * pcv + (long long)CORR_W_NONPAWN * (wnpcv + bnpcv);
    return int(cv / CORR_APPLY_SHIFT);
}

// Applies the learned correction to a raw static eval and clamps well clear of
// mate scores (SF's to_corrected_static_eval). With CorrHist off, returns
// rawEval untouched — CORRHIST=0 must reproduce the pre-CorrHist search exactly.
int corrected_eval(const Position& pos, int rawEval) {
    if (!tune.corrHist) return rawEval;
    int v = rawEval + correction(pos);
    if (v >= VALUE_MATE_IN_MAX_PLY) v = VALUE_MATE_IN_MAX_PLY - 1;
    else if (v <= -VALUE_MATE_IN_MAX_PLY) v = -VALUE_MATE_IN_MAX_PLY + 1;
    return v;
}

// Post-move-loop update (negamax only, never qsearch — SF's
// update_correction_history call site, search.cpp ~1470-1480). `staticEval`
// must be the CORRECTED eval (ss->staticEval), matching SF: by the time SF
// reaches this call ss->staticEval already holds to_corrected_static_eval's
// result, and gomachine's corrhist.go updates toward the same corrected value.
// Guard is SF's exact guard: skip on capture bestMoves, and only trust the
// residual when its sign agrees with whether a move raised alpha at all.
void update_corrhist(const Position& pos, int staticEval, int bestValue, int depth, Move bestMove) {
    if (!tune.corrHist) return;
    if (bestMove != MOVE_NONE && pos.is_capture(bestMove)) return;
    if ((bestValue > staticEval) != (bestMove != MOVE_NONE)) return;
    int bonus = (bestValue - staticEval) * depth / (bestMove != MOVE_NONE ? 10 : 8);
    bonus = std::max(-CORR_LIMIT / 4, std::min(CORR_LIMIT / 4, bonus));
    Color stm = pos.side_to_move();
    corrhist_update_entry(corrHist[stm][pos.pawn_key() & CORR_MASK], bonus);
    int npBonus = bonus * CORR_NONPAWN_UPDATE_NUM / CORR_NONPAWN_UPDATE_DEN;
    corrhist_update_entry(corrHistNP[stm][WHITE][pos.non_pawn_key(WHITE) & CORR_MASK], npBonus);
    corrhist_update_entry(corrHistNP[stm][BLACK][pos.non_pawn_key(BLACK) & CORR_MASK], npBonus);
}

// Search stack per ply
struct Stack {
    Move  currentMove;
    Piece currentPiece; // moving piece of currentMove (D.2 ContHist parent key);
                         // captured BEFORE do_move, meaningless when currentMove
                         // is MOVE_NONE/MOVE_NULL (callers guard on currentMove).
    Move  killers[2];
    int   staticEval;
    int   ply;
    Move  pv[MAX_PLY + 1];
    int   pvLen;
    bool  inCheck;
    Move  excludedMove;
};

// History and counters
int  history[COLOR_NB][64][64];
Move counterMoves[PIECE_NB][64];
Move rootBestMove = MOVE_NONE;
int  rootBestScore = 0;

// ---- Continuation history (PARITY_GOMACHINE.md D.2) ----
// Parent-move-keyed quiet-magnitude tables: [movingPiece][to] of the move played
// at ply-1 (resp. ply-2) -> [movingPiece][to] of the current quiet candidate.
// Packed to a dense [12] piece range (W_PAWN..W_KING -> 0..5, B_PAWN..B_KING ->
// 6..11 via piece_dense() below) rather than raw Piece (0..15, with unused gaps
// at 0/7/8/15) — halves each table to ~1.1 MB. Profiling (coalla, contended box:
// `perf stat -e instructions` showed hoisting alone cut dynamic instruction count
// ~6% but barely moved wall-clock NPS) indicates contHist reads are memory-
// latency-bound, not ALU-bound, so shrinking the footprint (better L2/L3
// residency) is the lever that actually matters — worth the extra piece_dense()
// call at each site. Read/written only when tune.contHist is on; zeroed in
// clear(), never persisted across searches (mirrors `history`'s lifecycle).
constexpr int piece_dense(Piece p) { return (int(p) >> 3) * 6 + (int(p) & 7) - 1; }
constexpr int CONT_PIECE_NB = 12;
int16_t contHist1[CONT_PIECE_NB][SQUARE_NB][CONT_PIECE_NB][SQUARE_NB]; // parent (1-ply)
int16_t contHist2[CONT_PIECE_NB][SQUARE_NB][CONT_PIECE_NB][SQUARE_NB]; // grandparent (2-ply)

// LMR reduction table
int Reductions[64][64];

int64_t elapsed() { return now_ms() - limits.startTime; }

void check_time() {
    if (limits.infinite) return;
    if (limits.nodes && nodeCount >= limits.nodes) Stop = true;
    if (timeLimitHard && elapsed() >= timeLimitHard) Stop = true;
}

// ---- Move ordering ----
constexpr int TT_SCORE       = 1 << 24;
constexpr int GOOD_CAP_SCORE = 1 << 22;
constexpr int KILLER1_SCORE  = 1 << 21;
constexpr int KILLER2_SCORE  = (1 << 21) - 1;
constexpr int COUNTER_SCORE  = 1 << 20;
constexpr int BAD_CAP_SCORE  = -(1 << 22);

const int PieceVal[7] = {0, 100, 320, 330, 500, 900, 20000};

// cont_hist_planes: resolve the two continuation-history "planes" (the
// [PIECE_NB][SQUARE_NB] slab keyed by the parent/grandparent move) ONCE per
// node, rather than re-deriving the parent key and re-validating the
// ancestor move on every candidate move. ch1/ch2 are set to nullptr when the
// corresponding ancestor doesn't exist or was null/none (matches the old
// cont_score guard exactly — a missing ancestor contributes 0). Every read
// site below then collapses to a flat 1-D offset `plane[pc * SQUARE_NB +
// to]` with no bounds/validity recheck and no 4-D index math.
// Caller has verified tune.contHist is on; ch1/ch2 are pointers into the
// live (writable) tables so the same pointers serve both cont-score reads
// and update_cont_hist writes at a node.
inline void cont_hist_planes(const Stack* ss, int16_t*& ch1, int16_t*& ch2) {
    ch1 = ch2 = nullptr;
    if (ss->ply >= 1) {
        const Stack* p = ss - 1;
        if (p->currentMove != MOVE_NONE && p->currentMove != MOVE_NULL)
            ch1 = &contHist1[piece_dense(p->currentPiece)][to_sq(p->currentMove)][0][0];
    }
    if (ss->ply >= 2) {
        const Stack* p = ss - 2;
        if (p->currentMove != MOVE_NONE && p->currentMove != MOVE_NULL)
            ch2 = &contHist2[piece_dense(p->currentPiece)][to_sq(p->currentMove)][0][0];
    }
}

// score_moves_impl: templated on WithContHist so the compiler emits two
// fully separate instantiations rather than one function with a runtime
// branch/extra params threaded through it — <false> compiles to exactly the
// pre-D.2 single-pass loop (the `if constexpr (WithContHist)` block is
// elided entirely, not just skipped at runtime), so the CONTHIST-off path
// (the shipped default) carries zero risk of the contHist plumbing
// perturbing codegen/register allocation. <true> does the contHist read
// inline in the SAME pass instead of a second scan over the movelist — an
// earlier version used a post-pass re-checking ttMove/killers/counter for
// every move a second time, which `perf stat -e instructions` showed cost
// MORE than the packed-table read it was protecting (net regression on the
// CONTHIST=1 path); this version pays the piece_dense()+table-read cost
// exactly once per quiet move and nothing else extra.
template <bool WithContHist>
void score_moves_impl(const Position& pos, ExtMove* begin, ExtMove* end, Move ttMove,
                       const Stack* ss, Move counter, const int16_t* ch1, const int16_t* ch2) {
    Color us = pos.side_to_move();
    for (ExtMove* m = begin; m != end; ++m) {
        Move mv = m->move;
        if (mv == ttMove) { m->score = TT_SCORE; continue; }
        MoveType mt = type_of_move(mv);
        bool cap = pos.is_capture(mv);
        if (cap || mt == PROMOTION) {
            PieceType victim = (mt == EN_PASSANT) ? PAWN : type_of(pos.piece_on(to_sq(mv)));
            PieceType attacker = type_of(pos.moved_piece(mv));
            int mvvlva = PieceVal[victim] * 16 - PieceVal[attacker];
            if (mt == PROMOTION) mvvlva += PieceVal[promotion_type(mv)] * 16;
            bool good = pos.see_ge(mv, -50);
            m->score = (good ? GOOD_CAP_SCORE : BAD_CAP_SCORE) + mvvlva;
        } else if (mv == ss->killers[0]) {
            m->score = KILLER1_SCORE;
        } else if (mv == ss->killers[1]) {
            m->score = KILLER2_SCORE;
        } else if (mv == counter) {
            m->score = COUNTER_SCORE;
        } else {
            int h = history[us][from_sq(mv)][to_sq(mv)];
            if constexpr (WithContHist) {
                int off = piece_dense(pos.moved_piece(mv)) * SQUARE_NB + to_sq(mv);
                if (ch1) h += ch1[off];
                if (ch2) h += ch2[off];
            }
            m->score = h;
        }
    }
}

inline void score_moves(const Position& pos, ExtMove* begin, ExtMove* end, Move ttMove,
                        const Stack* ss, Move counter) {
    score_moves_impl<false>(pos, begin, end, ttMove, ss, counter, nullptr, nullptr);
}

inline void score_moves_cont(const Position& pos, ExtMove* begin, ExtMove* end, Move ttMove,
                             const Stack* ss, Move counter, const int16_t* ch1, const int16_t* ch2) {
    score_moves_impl<true>(pos, begin, end, ttMove, ss, counter, ch1, ch2);
}

// Selection sort: move best remaining to front, return it
Move pick_next(ExtMove*& current, ExtMove* end) {
    ExtMove* best = current;
    for (ExtMove* m = current + 1; m != end; ++m)
        if (m->score > best->score) best = m;
    std::swap(*best, *current);
    return (current++)->move;
}

void update_history(Color us, Move m, int bonus) {
    int& h = history[us][from_sq(m)][to_sq(m)];
    bonus = std::max(-400, std::min(400, bonus));
    h += 32 * bonus - h * std::abs(bonus) / 512;
}

// update_cont_entry: same gravity formula/scale as update_history above (bonus
// clamp ±400, 32*bonus nudge, h*|bonus|/512 self-age) so ContHist magnitudes
// stay comparable to the butterfly table. Entries are int16_t; the formula's own
// gravity already self-bounds well inside int16 range (~±16384 steady-state), so
// the ±32000 clamp below is a defensive backstop, not something normal play hits.
void update_cont_entry(int16_t& h, int bonus) {
    bonus = std::max(-400, std::min(400, bonus));
    int v = int(h) + 32 * bonus - int(h) * std::abs(bonus) / 512;
    v = std::max(-32000, std::min(32000, v));
    h = int16_t(v);
}

// update_cont_hist: credit/penalize one quiet move (pc -> to) in both
// continuation tables via the plane pointers already hoisted for this node by
// cont_hist_planes (ch1/ch2 nullptr <=> no real ancestor at that ply, same
// guard cont_hist_planes applies). Caller has verified tune.contHist is on.
void update_cont_hist(int16_t* ch1, int16_t* ch2, Piece pc, Square to, int bonus) {
    int off = piece_dense(pc) * SQUARE_NB + to;
    if (ch1) update_cont_entry(ch1[off], bonus);
    if (ch2) update_cont_entry(ch2[off], bonus);
}

int qsearch(Position& pos, Stack* ss, int alpha, int beta);

int qsearch(Position& pos, Stack* ss, int alpha, int beta) {
    if ((++nodeCount & 1023) == 0) check_time();
    if (Stop) return 0;

    if (pos.is_draw(ss->ply)) return VALUE_DRAW;
    if (ss->ply >= MAX_PLY) return Eval::evaluate(pos);

    bool inCheck = pos.in_check();
    int bestValue, futilityBase;

    // TT probe
    bool ttHit;
    TTEntry* tte = TT.probe(pos.key(), ttHit);
    int ttValue = ttHit ? TT.value_from_tt(tte->value, ss->ply) : VALUE_NONE;
    Move ttMove = ttHit ? tte->move : MOVE_NONE;

    if (ttHit && tte->depth >= 0) {
        Bound b = tte->bound();
        if (b == BOUND_EXACT
            || (b == BOUND_LOWER && ttValue >= beta)
            || (b == BOUND_UPPER && ttValue <= alpha))
            return ttValue;
    }

    // rawEval is the uncorrected eval we persist to TT (tte->eval is always raw —
    // see negamax for the same invariant — so a later hit can re-apply a possibly
    // updated correction rather than replaying a stale corrected value).
    int rawEval = VALUE_NONE;
    if (inCheck) {
        bestValue = futilityBase = -VALUE_INFINITE;
    } else {
        rawEval = (ttHit && tte->eval != VALUE_NONE) ? tte->eval : Eval::evaluate(pos);
        int staticEval = ss->staticEval = corrected_eval(pos, rawEval);
        bestValue = staticEval;
        if (ttHit && (tte->bound() & (ttValue > staticEval ? BOUND_LOWER : BOUND_UPPER)))
            bestValue = ttValue;
        if (bestValue >= beta) {
            if (!ttHit)
                TT.store(tte, pos.key(), TT.value_to_tt(bestValue, ss->ply), false,
                         BOUND_LOWER, 0, MOVE_NONE, rawEval);
            return bestValue;
        }
        if (bestValue > alpha) alpha = bestValue;
        futilityBase = bestValue + tune.qsFutMargin;
    }

    // Generate moves: captures/promotions (or all evasions when in check)
    MoveList list;
    if (inCheck) generate<ALL>(pos, list);
    else         generate<CAPTURES>(pos, list);

    Move counter = MOVE_NONE;
    if (tune.contHist) {
        int16_t* qsCh1 = nullptr;
        int16_t* qsCh2 = nullptr;
        cont_hist_planes(ss, qsCh1, qsCh2);
        score_moves_cont(pos, list.begin(), list.end(), ttMove, ss, counter, qsCh1, qsCh2);
    } else {
        score_moves(pos, list.begin(), list.end(), ttMove, ss, counter);
    }

    ExtMove* cur = list.begin();
    Move bestMove = MOVE_NONE;
    StateInfo st;
    int moveCount = 0;

    while (cur != list.end()) {
        Move m = pick_next(cur, list.end());
        if (!pos.legal(m)) continue;
        moveCount++;

        bool givesCheck = pos.gives_check(m);
        bool isCapture = pos.is_capture(m);

        // Delta / futility pruning in qsearch (not when in check)
        if (!inCheck && !givesCheck && futilityBase > -VALUE_INFINITE) {
            if (isCapture) {
                PieceType victim = (type_of_move(m) == EN_PASSANT) ? PAWN : type_of(pos.piece_on(to_sq(m)));
                if (futilityBase + PieceVal[victim] <= alpha && !pos.see_ge(m, 1))
                    { if (futilityBase > bestValue) bestValue = futilityBase; continue; }
            }
        }
        // SEE pruning: skip clearly losing captures
        if (!inCheck && isCapture && !pos.see_ge(m, -50)) continue;

        pos.do_move(m, st);
        int score = -qsearch(pos, ss + 1, -beta, -alpha);
        pos.undo_move(m);

        if (Stop) return 0;

        if (score > bestValue) {
            bestValue = score;
            if (score > alpha) {
                bestMove = m;
                if (score >= beta) break;
                alpha = score;
            }
        }
    }

    if (inCheck && bestValue == -VALUE_INFINITE)
        return mated_in(ss->ply); // checkmate

    Bound b = bestValue >= beta ? BOUND_LOWER : BOUND_UPPER;
    TT.store(tte, pos.key(), TT.value_to_tt(bestValue, ss->ply), false, b, 0, bestMove,
             inCheck ? VALUE_NONE : rawEval);
    return bestValue;
}

template <bool PvNode>
int negamax(Position& pos, Stack* ss, int alpha, int beta, int depth, bool cutNode) {
    bool rootNode = PvNode && ss->ply == 0;

    // D.7 (GMCHECKEXT): gomachine's per-node check extension fires here, at node
    // entry, BEFORE the depth<=0 qsearch dispatch and before the TT probe
    // (search.go:1244-1250: `if (pos.InCheck()) depth++` immediately after entering
    // the node) — uncapped, and it always stacks with singular since it mutates the
    // incoming `depth` itself rather than the per-move `extension` local below.
    // Strictly gated behind tune.gmCheckExt so the off (default) path doesn't even
    // pay for the extra pos.in_check() call — zero cost, byte-identical when off.
    if (tune.gmCheckExt && pos.in_check())
        depth++;

    if (depth <= 0) return qsearch(pos, ss, alpha, beta);

    if ((++nodeCount & 1023) == 0) check_time();
    if (Stop) return 0;

    ss->pvLen = 0;
    ss->inCheck = pos.in_check();

    if (!rootNode) {
        if (pos.is_draw(ss->ply)) return VALUE_DRAW;
        if (ss->ply >= MAX_PLY) return ss->inCheck ? VALUE_DRAW : Eval::evaluate(pos);
        // Mate distance pruning
        alpha = std::max(mated_in(ss->ply), alpha);
        beta  = std::min(mate_in(ss->ply + 1), beta);
        if (alpha >= beta) return alpha;
    }

    (ss + 1)->killers[0] = (ss + 1)->killers[1] = MOVE_NONE;
    Move excluded = ss->excludedMove;

    // TT probe
    bool ttHit;
    TTEntry* tte = TT.probe(pos.key(), ttHit);
    int ttValue = ttHit ? TT.value_from_tt(tte->value, ss->ply) : VALUE_NONE;
    Move ttMove = rootNode ? rootBestMove : (ttHit ? tte->move : MOVE_NONE);
    bool ttCapture = ttMove && pos.is_capture(ttMove);

    if (!PvNode && ttHit && !excluded && tte->depth >= depth && ttValue != VALUE_NONE) {
        Bound b = tte->bound();
        if (b == BOUND_EXACT
            || (b == BOUND_LOWER && ttValue >= beta)
            || (b == BOUND_UPPER && ttValue <= alpha))
            return ttValue;
    }

    // Static eval (corrected — §CorrHist). rawEval is the uncorrected value,
    // persisted to TT below so a later hit can re-apply a possibly-updated
    // correction fresh (mirrors SF's unadjustedStaticEval / ttData.eval split);
    // ss->staticEval (read by `improving` and every pruning site here on) is
    // the corrected value, matching SF's ss->staticEval post to_corrected_static_eval.
    int eval;
    int rawEval;
    if (ss->inCheck) {
        rawEval = VALUE_NONE;
        eval = ss->staticEval = VALUE_NONE;
    } else {
        rawEval = (ttHit && tte->eval != VALUE_NONE) ? tte->eval : Eval::evaluate(pos);
        eval = ss->staticEval = corrected_eval(pos, rawEval);
        if (ttHit && ttValue != VALUE_NONE && (tte->bound() & (ttValue > eval ? BOUND_LOWER : BOUND_UPPER)))
            eval = ttValue;
    }

    bool improving = !ss->inCheck && ss->ply >= 2
                     && (ss - 2)->staticEval != VALUE_NONE
                     && ss->staticEval > (ss - 2)->staticEval;

    // ---- Pruning (non-PV, not in check) ----
    if (!PvNode && !ss->inCheck && !excluded) {
        // Reverse futility pruning
        bool quietTT = ttMove != MOVE_NONE && !ttCapture;   // ttCapture computed above at the TT probe
        if (depth <= 8 && !(tune.rfpSoft && quietTT)
            && eval - tune.rfpMargin * (depth - improving) >= beta && eval < VALUE_MATE_IN_MAX_PLY)
            return tune.rfpSoft ? (2 * beta + eval) / 3 : eval;

        // Null move pruning
        // SF_MARGINS.md #5: modern SF only null-moves at expected cut-nodes, with a
        // relaxed eval margin (beta - 18*depth + 350) rather than requiring eval>=beta
        // outright. Gated behind tune.nmpCutGate (default off) — R computation below
        // is unchanged either way.
        bool nmpGate = tune.nmpCutGate
            ? (cutNode && ss->staticEval >= beta - 18 * depth + 350)
            : (eval >= beta);
        if (tune.nullMove && depth >= 3 && nmpGate && (ss - 1)->currentMove != MOVE_NULL
            && pos.non_pawn_material(pos.side_to_move())) {
            int R = 3 + depth / 4 + std::min((eval - beta) / tune.nmpEvalDiv, 3);
            StateInfo st;
            ss->currentMove = MOVE_NULL;
            pos.do_null_move(st);
            int nullScore = -negamax<false>(pos, ss + 1, -beta, -beta + 1, depth - R, !cutNode);
            pos.undo_null_move();
            if (Stop) return 0;
            if (nullScore >= beta) {
                if (nullScore >= VALUE_MATE_IN_MAX_PLY) nullScore = beta;
                return nullScore;
            }
        }

        // Razoring
        if (tune.razor && depth <= 3 && eval + tune.razorMargin * depth <= alpha) {
            int v = qsearch(pos, ss, alpha, alpha + 1);
            if (v <= alpha) return v;
        }
    }

    // Internal iterative reduction: if no TT move at high depth, reduce
    // (C.2: gomachine measured its own IIR dead-flat individually — env IIR=0 to disable)
    if (tune.iir && depth >= 4 && !ttMove && !rootNode)
        depth--;

    // ---- Move loop ----
    MoveList list;
    generate<ALL>(pos, list);
    Color us = pos.side_to_move();
    Move counter = (ss - 1)->currentMove ? counterMoves[pos.piece_on(to_sq((ss - 1)->currentMove))][to_sq((ss - 1)->currentMove)] : MOVE_NONE;
    // Continuation-history plane pointers are constant for every move at this
    // node (they key off the ply-1/ply-2 ancestor, not the candidate move), so
    // hoist them ONCE here rather than re-deriving + re-validating them per
    // candidate in score_moves, per LMR reduction read, and per cutoff update.
    int16_t* ch1 = nullptr;
    int16_t* ch2 = nullptr;
    if (tune.contHist) {
        cont_hist_planes(ss, ch1, ch2);
        score_moves_cont(pos, list.begin(), list.end(), ttMove, ss, counter, ch1, ch2);
    } else {
        score_moves(pos, list.begin(), list.end(), ttMove, ss, counter);
    }

    ExtMove* cur = list.begin();
    int bestValue = -VALUE_INFINITE;
    Move bestMove = MOVE_NONE;
    int moveCount = 0;
    StateInfo st;

    Move quietsSearched[64];
    int quietCount = 0;

    while (cur != list.end()) {
        Move m = pick_next(cur, list.end());
        if (m == excluded) continue;
        if (!pos.legal(m)) continue;
        moveCount++;

        bool isCapture = pos.is_capture(m);
        bool givesCheck = pos.gives_check(m);
        bool isQuiet = !isCapture && type_of_move(m) != PROMOTION;
        int extension = 0;
        // Captured BEFORE do_move empties from_sq(m) — needed both for ss->currentPiece
        // (children key their ContHist off this) and the LMR ContHist read below.
        Piece mover = pos.moved_piece(m);

        // SF_MARGINS.md #4: a cheap post-LMR-reduction depth proxy, computed here
        // (before the pruning block) so the quiet-futility and SEE-quiet checks below
        // can key off it instead of raw depth — lets them prune later/more precisely,
        // matching SF's depth<13 window. Gated behind tune.lmrDepthPrune (default off).
        int lmrDepth = depth;
        if (tune.lmrDepthPrune) {
            int red = Reductions[std::min(depth, 63)][std::min(moveCount, 63)];
            lmrDepth = std::max(depth - red, 0);
        }

        // Late move pruning + futility for quiets at low depth
        // D.0 (PARITY_GOMACHINE.md): every other pruning site above is !PvNode-gated;
        // this block wasn't, so it could prune quiets/captures inside our own PV.
        // Gated behind tune.pvGuard (env PVGUARD, default off) until SPRT'd.
        if (!rootNode && !(tune.pvGuard && PvNode) && bestValue > -VALUE_MATE_IN_MAX_PLY && pos.non_pawn_material(us)) {
            if (isQuiet) {
                int lmpLimit = (3 + depth * depth) / (2 - improving);
                if (tune.lmp && moveCount >= lmpLimit && !givesCheck) continue;
                // Futility pruning
                bool futilityPrune = tune.lmrDepthPrune
                    ? (lmrDepth < 13 && eval + tune.futBase + tune.futSlope * lmrDepth <= alpha)
                    : (depth <= 6 && eval + tune.futBase + tune.futSlope * depth <= alpha);
                if (tune.futility && !ss->inCheck && !givesCheck && futilityPrune)
                    continue;
                // SEE pruning of quiets
                // D.5 (SEEQUIETLINEAR): gomachine's tuned shape is linear (-75*depth,
                // depth<=6) rather than zugzwang's default quadratic (-seeQuietCoeff*
                // depth^2, depth<=8). Checked first so it wins over lmrDepthPrune's
                // shape too when both flags happen to be set (independent SPRT flags,
                // no shipped combination intended).
                bool seeQuietPrune = tune.seeQuietLinear
                    ? (depth <= 6 && !pos.see_ge(m, -75 * depth))
                    : tune.lmrDepthPrune
                        ? !pos.see_ge(m, -tune.seeQuietCoeff * lmrDepth * lmrDepth)
                        : (depth <= 8 && !pos.see_ge(m, -tune.seeQuietCoeff * depth * depth));
                if (tune.quietSee && seeQuietPrune) continue;
            } else {
                // SEE pruning of captures
                if (depth <= tune.captSeeMaxDepth && !givesCheck && !pos.see_ge(m, -tune.captSeeCoeff * depth)) continue;
            }
        }

        // Singular extension
        if (!rootNode && depth >= tune.singularMinDepth && m == ttMove && !excluded
            && tte->depth >= depth - 3 && (tte->bound() & BOUND_LOWER)
            && std::abs(ttValue) < VALUE_MATE_IN_MAX_PLY) {
            int singularBeta = ttValue - tune.singularMargin * depth / 16; // default 32 -> exactly 2*depth
            ss->excludedMove = m;
            int s = negamax<false>(pos, ss, singularBeta - 1, singularBeta, (depth - 1) / 2, cutNode);
            ss->excludedMove = MOVE_NONE;
            if (s < singularBeta) extension = 1;
            else if (singularBeta >= beta) return singularBeta; // multi-cut
            else if (tune.negExt) {
                // ttMove is provably NOT singular — SF's negative extension de-prioritizes a
                // move the TT overrates. Reuses the verification search already run (no new search).
                if (ttValue >= beta) extension = -2;
                else if (cutNode)    extension = -1;
            }
        }

        // Check extension — mutually exclusive with D.7's node-entry gmCheckExt
        // mechanism above (that one already extended `depth` for the whole node;
        // firing this per-move version too would double-extend a single check).
        if (!tune.gmCheckExt && givesCheck && extension == 0 && depth < 12) extension = 1;

        int newDepth = depth - 1 + extension;
        ss->currentMove = m;
        ss->currentPiece = mover;

        pos.do_move(m, st);

        int score;
        bool doFullSearch;
        // Set only when the LMR branch actually reduced (d < newDepth) AND the
        // reduced scout beat alpha — i.e. this doFullSearch is genuinely the
        // post-LMR re-search (gomachine search.go:2703, `reduction > 0`). When
        // doFullSearch instead comes from the plain non-LMR scout (else branch
        // below — every capture/promotion, low-depth move, or early move count),
        // `score` has not been assigned yet, so doDeeper must NOT read it.
        bool wasLMRReduced = false;

        // Late Move Reductions
        if (tune.lmr && depth >= 3 && moveCount > tune.lmrMinMoves + (rootNode ? 1 : 0) && isQuiet) {
            int r = Reductions[std::min(depth, 63)][std::min(moveCount, 63)];
            if (!PvNode) r++;
            if (!improving) r++;
            if (cutNode) r += 1;
            if (givesCheck) r--;
            int hist = history[us][from_sq(m)][to_sq(m)];
            if (tune.contHist) {
                int off = piece_dense(mover) * SQUARE_NB + to_sq(m);
                if (ch1) hist += ch1[off];
                if (ch2) hist += ch2[off];
            }
            r -= hist / 8000;
            int d = std::max(1, std::min(newDepth - r, newDepth));
            score = -negamax<false>(pos, ss + 1, -alpha - 1, -alpha, d, true);
            doFullSearch = score > alpha && d < newDepth;
            wasLMRReduced = doFullSearch;
        } else {
            doFullSearch = !PvNode || moveCount > 1;
        }

        if (doFullSearch) {
            // D.3: adapt the post-LMR re-search depth to how far the reduced
            // scout beat the node's tracked bestValue — a big overshoot re-
            // searches a ply deeper, a bare pass a ply shallower (gomachine
            // search.go:2702-2718). Flat `newDepth` re-search when off, and
            // also when this doFullSearch didn't come from an actual LMR
            // reduction (wasLMRReduced guards against reading `score` before
            // it's assigned — see comment above).
            int rd = newDepth;
            if (tune.doDeeper && wasLMRReduced) {
                if (score > bestValue + 44 + 4 * newDepth) rd = newDepth + 1;
                else if (score < bestValue + newDepth) rd = std::max(1, newDepth - 1);
            }
            score = -negamax<false>(pos, ss + 1, -alpha - 1, -alpha, rd, !cutNode);
        }

        if (PvNode && (moveCount == 1 || score > alpha))
            score = -negamax<true>(pos, ss + 1, -beta, -alpha, newDepth, false);

        pos.undo_move(m);

        if (Stop) return 0;

        if (rootNode && (moveCount == 1 || score > alpha)) {
            rootBestMove = m;
            rootBestScore = score;
        }

        if (score > bestValue) {
            bestValue = score;
            if (score > alpha) {
                bestMove = m;
                if (PvNode) {
                    ss->pv[0] = m;
                    ss->pvLen = (ss + 1)->pvLen + 1;
                    for (int i = 0; i < (ss + 1)->pvLen; ++i)
                        ss->pv[i + 1] = (ss + 1)->pv[i];
                }
                if (PvNode && score < beta) alpha = score;
                else break; // fail high
            }
        }

        if (isQuiet && quietCount < 64) quietsSearched[quietCount++] = m;
    }

    // Checkmate / stalemate
    if (moveCount == 0)
        return excluded ? alpha : (ss->inCheck ? mated_in(ss->ply) : VALUE_DRAW);

    // Update killers / history on beta cutoff
    if (bestMove != MOVE_NONE && bestValue >= beta) {
        if (!pos.is_capture(bestMove) && type_of_move(bestMove) != PROMOTION) {
            if (ss->killers[0] != bestMove) {
                ss->killers[1] = ss->killers[0];
                ss->killers[0] = bestMove;
            }
            int bonus = depth * depth;
            update_history(us, bestMove, bonus);
            for (int i = 0; i < quietCount; ++i)
                if (quietsSearched[i] != bestMove)
                    update_history(us, quietsSearched[i], -bonus);
            if (tune.contHist) {
                // pos is back at the pre-move-loop position here (every iteration
                // above paired do_move with undo_move), so moved_piece() is valid.
                // ch1/ch2 were hoisted once for this node above the move loop —
                // reuse them here instead of re-deriving the parent key.
                update_cont_hist(ch1, ch2, pos.moved_piece(bestMove), to_sq(bestMove), bonus);
                for (int i = 0; i < quietCount; ++i)
                    if (quietsSearched[i] != bestMove)
                        update_cont_hist(ch1, ch2, pos.moved_piece(quietsSearched[i]), to_sq(quietsSearched[i]), -bonus);
            }
            if ((ss - 1)->currentMove)
                counterMoves[pos.piece_on(to_sq((ss - 1)->currentMove))][to_sq((ss - 1)->currentMove)] = bestMove;
        }
    }

    if (!excluded) {
        Bound b = bestValue >= beta ? BOUND_LOWER
                : (PvNode && bestMove) ? BOUND_EXACT : BOUND_UPPER;
        TT.store(tte, pos.key(), TT.value_to_tt(bestValue, ss->ply), PvNode, b, depth,
                 bestMove, ss->inCheck ? VALUE_NONE : rawEval);

        // Correction history update (§CorrHist, negamax only — never qsearch).
        // Excluded (singular-verification) nodes must not teach it either, hence
        // this living inside the same `!excluded` guard as the TT store.
        if (!ss->inCheck)
            update_corrhist(pos, ss->staticEval, bestValue, depth, bestMove);
    }

    return bestValue;
}

void print_pv(Position& pos, Stack* ss, int depth, int score, int64_t nodes) {
    int64_t ms = elapsed();
    int64_t nps = ms > 0 ? nodes * 1000 / ms : 0;
    std::cout << "info depth " << depth << " score ";
    if (is_mate_score(score)) {
        int mateIn = (score > 0 ? (VALUE_MATE - score + 1) : -(VALUE_MATE + score)) / 2;
        std::cout << "mate " << mateIn;
    } else {
        std::cout << "cp " << score;
    }
    std::cout << " nodes " << nodes << " nps " << nps
              << " time " << ms << " hashfull " << TT.hashfull() << " pv";
    for (int i = 0; i < ss->pvLen; ++i)
        std::cout << " " << move_to_uci(ss->pv[i]);
    std::cout << std::endl;
}

// LMR table (D.1: base/divisor swap to gomachine's tuned constants behind GMCONST).
// Rebuilt by Tune::load() every time tune.lmrBase/lmrDiv can change, plus once at
// startup via init() with the compiled-in defaults. Defined here (still inside the
// anonymous namespace) so it satisfies the forward declaration used by Tune::load()
// above — a definition outside the anonymous namespace would be a distinct symbol.
void build_reductions() {
    for (int d = 1; d < 64; ++d)
        for (int m = 1; m < 64; ++m)
            Reductions[d][m] = int(tune.lmrBase + std::log(d) * std::log(m) / tune.lmrDiv);
    Reductions[0][0] = Reductions[0][1] = Reductions[1][0] = 0;
}

} // namespace

// SPSA/UCI hook: map a UCI spin option name to the matching Tune field, clamped
// to the range advertised on `uci` (uci.cpp). Returns false if name is unknown
// (uci.cpp treats that as "not a tune option"). Lives outside the anonymous
// namespace (declared in search.h) but reaches `tune` since anonymous-namespace
// symbols are visible throughout this translation unit.
bool set_tune_option(const std::string& name, int value) {
    auto clamp = [](int v, int lo, int hi) { return std::max(lo, std::min(hi, v)); };
    if      (name == "RfpMargin")      tune.rfpMargin      = clamp(value, 40, 130);
    else if (name == "RazorMargin")    tune.razorMargin    = clamp(value, 100, 350);
    else if (name == "FutBase")        tune.futBase        = clamp(value, 40, 220);
    else if (name == "FutSlope")       tune.futSlope       = clamp(value, 40, 150);
    else if (name == "SeeQuietCoeff")  tune.seeQuietCoeff  = clamp(value, 10, 45);
    else if (name == "CaptSeeCoeff")   tune.captSeeCoeff   = clamp(value, 40, 180);
    else if (name == "NmpEvalDiv")     tune.nmpEvalDiv     = clamp(value, 80, 400);
    else if (name == "SingularMargin") tune.singularMargin = clamp(value, 16, 80);
    else return false;
    return true;
}

void init() {
    build_reductions();
}

void clear() {
    std::memset(history, 0, sizeof(history));
    std::memset(counterMoves, 0, sizeof(counterMoves));
    std::memset(corrHist, 0, sizeof(corrHist));
    std::memset(corrHistNP, 0, sizeof(corrHistNP));
    std::memset(contHist1, 0, sizeof(contHist1));
    std::memset(contHist2, 0, sizeof(contHist2));
    TT.clear();
}

int64_t now_ms() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now().time_since_epoch()).count();
}

static void set_time_limits(const Position& pos) {
    timeLimitSoft = timeLimitHard = 0;
    if (limits.movetime) {
        timeLimitSoft = timeLimitHard = limits.movetime - 5;
        return;
    }
    Color us = pos.side_to_move();
    int t = limits.time[us];
    int inc = limits.inc[us];
    if (t <= 0 && inc <= 0) return; // depth/nodes/infinite mode
    int mtg = limits.movestogo ? limits.movestogo : 30;
    // Reserve a healthy overhead for GUI communication + OS scheduling jitter.
    int overhead = 40;
    int usable = std::max(1, t - overhead);
    // Use most of the increment plus a slice of remaining time.
    int budget = std::max(1, usable / mtg + inc * 3 / 4);
    timeLimitSoft = std::min(budget, usable);
    // Hard cap: never risk the clock — stay well under remaining time.
    timeLimitHard = std::min(usable / 2, budget * 3);
    if (timeLimitHard < 1) timeLimitHard = 1;
    if (timeLimitSoft > timeLimitHard) timeLimitSoft = timeLimitHard;
    if (timeLimitSoft < 1) timeLimitSoft = 1;
}

void start(Position& pos, const Limits& lim) {
    limits = lim;
    tune.load();
    if (limits.startTime == 0) limits.startTime = now_ms();
    Stop = false;
    nodeCount = 0;
    set_time_limits(pos);
    TT.new_search();

    // Attach the incremental NNUE accumulator for the duration of the search. One stack
    // (heap-backed, persists across calls), rebuilt from the root each search; the
    // Position drives push/pop through do_move/undo_move. HCE mode leaves it detached.
    static NNUE::AccStack accStack;
    bool useAcc = NNUE::loaded();
    if (useAcc) { accStack.reset(pos); pos.set_nnue_acc(&accStack); }

    Stack stack[MAX_PLY + 10];
    std::memset(stack, 0, sizeof(stack));
    Stack* ss = stack + 4;
    for (int i = 0; i < MAX_PLY + 10; ++i) stack[i].ply = i - 4;

    rootBestMove = MOVE_NONE;
    int maxDepth = limits.depth ? limits.depth : MAX_PLY - 1;

    int prevScore = 0;
    Move lastBest = MOVE_NONE;
    for (int depth = 1; depth <= maxDepth; ++depth) {
        rootDepthGlobal = depth;

        // Aspiration windows
        int score;
        if (depth <= 4) {
            score = negamax<true>(pos, ss, -VALUE_INFINITE, VALUE_INFINITE, depth, false);
        } else {
            int delta = tune.aspInitDelta;
            int alpha = std::max(prevScore - delta, -VALUE_INFINITE);
            int beta  = std::min(prevScore + delta, VALUE_INFINITE);
            while (true) {
                score = negamax<true>(pos, ss, alpha, beta, depth, false);
                if (Stop) break;
                if (score <= alpha) {
                    beta = (alpha + beta) / 2;
                    alpha = std::max(score - delta, -VALUE_INFINITE);
                } else if (score >= beta) {
                    beta = std::min(score + delta, VALUE_INFINITE);
                } else break;
                delta += delta / 2;
            }
        }

        if (Stop && depth > 1) break;

        prevScore = score;
        lastBest = rootBestMove;
        print_pv(pos, ss, depth, score, nodeCount);

        // Soft time check between iterations
        if (!limits.infinite && timeLimitSoft && elapsed() >= timeLimitSoft) break;
        if (limits.nodes && nodeCount >= limits.nodes) break;
    }

    if (useAcc) pos.set_nnue_acc(nullptr); // detach: eval reverts to from-scratch off-search

    Move best = lastBest != MOVE_NONE ? lastBest : rootBestMove;
    if (best == MOVE_NONE) {
        // Fallback: pick any legal move
        MoveList list; generate<ALL>(pos, list);
        for (auto& m : list) if (pos.legal(m)) { best = m; break; }
    }
    std::cout << "bestmove " << move_to_uci(best) << std::endl;
}

} // namespace Search
