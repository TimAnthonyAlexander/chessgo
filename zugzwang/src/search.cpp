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

using namespace BB;

namespace Search {

std::atomic<bool> Stop{false};

namespace {

Limits limits;
int64_t timeLimitSoft = 0, timeLimitHard = 0;
int64_t nodeCount = 0;
int rootDepthGlobal = 0;

// Tunable pruning toggles (env-configurable for calibration)
struct Tune {
    bool lmp = true, quietSee = true, futility = true, razor = true, nullMove = true, lmr = true;
    bool histPrune = true;
    int  histPruneMargin = 1000; // threshold = -histPruneMargin * depth
    void load() {
        auto off = [](const char* n){ const char* e = getenv(n); return e && e[0]=='0'; };
        if (off("LMP")) lmp = false;
        if (off("QSEE")) quietSee = false;
        if (off("FUT")) futility = false;
        if (off("RAZ")) razor = false;
        if (off("NULL")) nullMove = false;
        if (off("LMR")) lmr = false;
        if (off("HISTPRUNE")) histPrune = false;
        if (const char* e = getenv("HISTPRUNE_MARGIN")) { int v = atoi(e); if (v > 0) histPruneMargin = v; }
    }
} tune;

// Search stack per ply
struct Stack {
    Move  currentMove;
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

void score_moves(const Position& pos, ExtMove* begin, ExtMove* end, Move ttMove,
                 const Stack* ss, Move counter) {
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
            m->score = history[us][from_sq(mv)][to_sq(mv)];
        }
    }
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

    if (inCheck) {
        bestValue = futilityBase = -VALUE_INFINITE;
    } else {
        int staticEval = (ttHit && tte->eval != VALUE_NONE) ? tte->eval : Eval::evaluate(pos);
        bestValue = staticEval;
        if (ttHit && (tte->bound() & (ttValue > staticEval ? BOUND_LOWER : BOUND_UPPER)))
            bestValue = ttValue;
        if (bestValue >= beta) {
            if (!ttHit)
                TT.store(tte, pos.key(), TT.value_to_tt(bestValue, ss->ply), false,
                         BOUND_LOWER, 0, MOVE_NONE, staticEval);
            return bestValue;
        }
        if (bestValue > alpha) alpha = bestValue;
        futilityBase = bestValue + 130;
    }

    // Generate moves: captures/promotions (or all evasions when in check)
    MoveList list;
    if (inCheck) generate<ALL>(pos, list);
    else         generate<CAPTURES>(pos, list);

    Move counter = MOVE_NONE;
    score_moves(pos, list.begin(), list.end(), ttMove, ss, counter);

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
             inCheck ? VALUE_NONE : ss->staticEval);
    return bestValue;
}

template <bool PvNode>
int negamax(Position& pos, Stack* ss, int alpha, int beta, int depth, bool cutNode) {
    bool rootNode = PvNode && ss->ply == 0;

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

    // Static eval
    int eval;
    if (ss->inCheck) {
        eval = ss->staticEval = VALUE_NONE;
    } else if (ttHit) {
        eval = ss->staticEval = (tte->eval != VALUE_NONE) ? tte->eval : Eval::evaluate(pos);
        if (ttValue != VALUE_NONE && (tte->bound() & (ttValue > eval ? BOUND_LOWER : BOUND_UPPER)))
            eval = ttValue;
    } else {
        eval = ss->staticEval = Eval::evaluate(pos);
    }

    bool improving = !ss->inCheck && ss->ply >= 2
                     && (ss - 2)->staticEval != VALUE_NONE
                     && ss->staticEval > (ss - 2)->staticEval;

    // ---- Pruning (non-PV, not in check) ----
    if (!PvNode && !ss->inCheck && !excluded) {
        // Reverse futility pruning
        if (depth <= 8 && eval - 80 * (depth - improving) >= beta && eval < VALUE_MATE_IN_MAX_PLY)
            return eval;

        // Null move pruning
        if (tune.nullMove && depth >= 3 && eval >= beta && (ss - 1)->currentMove != MOVE_NULL
            && pos.non_pawn_material(pos.side_to_move())) {
            int R = 3 + depth / 4 + std::min((eval - beta) / 200, 3);
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
        if (tune.razor && depth <= 3 && eval + 200 * depth <= alpha) {
            int v = qsearch(pos, ss, alpha, alpha + 1);
            if (v <= alpha) return v;
        }
    }

    // Internal iterative reduction: if no TT move at high depth, reduce
    if (depth >= 4 && !ttMove && !rootNode)
        depth--;

    // ---- Move loop ----
    MoveList list;
    generate<ALL>(pos, list);
    Color us = pos.side_to_move();
    Move counter = (ss - 1)->currentMove ? counterMoves[pos.piece_on(to_sq((ss - 1)->currentMove))][to_sq((ss - 1)->currentMove)] : MOVE_NONE;
    score_moves(pos, list.begin(), list.end(), ttMove, ss, counter);

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

        // Late move pruning + futility for quiets at low depth
        if (!rootNode && bestValue > -VALUE_MATE_IN_MAX_PLY && pos.non_pawn_material(us)) {
            if (isQuiet) {
                int lmpLimit = (3 + depth * depth) / (2 - improving);
                if (tune.lmp && moveCount >= lmpLimit && !givesCheck) continue;
                // History pruning: skip a late quiet whose butterfly history is deeply
                // negative, at shallow depth. Orthogonal to LMP (move-count) and quiet-SEE.
                if (tune.histPrune && depth <= 6 && moveCount >= 3 && !givesCheck
                    && history[us][from_sq(m)][to_sq(m)] < -tune.histPruneMargin * depth)
                    continue;
                // Futility pruning
                if (tune.futility && depth <= 6 && !ss->inCheck && !givesCheck
                    && eval + 120 + 90 * depth <= alpha)
                    continue;
                // SEE pruning of quiets
                if (tune.quietSee && depth <= 8 && !pos.see_ge(m, -25 * depth * depth)) continue;
            } else {
                // SEE pruning of captures
                if (depth <= 6 && !givesCheck && !pos.see_ge(m, -90 * depth)) continue;
            }
        }

        // Singular extension
        if (!rootNode && depth >= 8 && m == ttMove && !excluded
            && tte->depth >= depth - 3 && (tte->bound() & BOUND_LOWER)
            && std::abs(ttValue) < VALUE_MATE_IN_MAX_PLY) {
            int singularBeta = ttValue - 2 * depth;
            ss->excludedMove = m;
            int s = negamax<false>(pos, ss, singularBeta - 1, singularBeta, (depth - 1) / 2, cutNode);
            ss->excludedMove = MOVE_NONE;
            if (s < singularBeta) extension = 1;
            else if (singularBeta >= beta) return singularBeta; // multi-cut
        }

        // Check extension
        if (givesCheck && extension == 0 && depth < 12) extension = 1;

        int newDepth = depth - 1 + extension;
        ss->currentMove = m;

        pos.do_move(m, st);

        int score;
        bool doFullSearch;

        // Late Move Reductions
        if (tune.lmr && depth >= 3 && moveCount > 1 + (rootNode ? 1 : 0) && isQuiet) {
            int r = Reductions[std::min(depth, 63)][std::min(moveCount, 63)];
            if (!PvNode) r++;
            if (!improving) r++;
            if (cutNode) r += 1;
            if (givesCheck) r--;
            r -= history[us][from_sq(m)][to_sq(m)] / 8000;
            int d = std::max(1, std::min(newDepth - r, newDepth));
            score = -negamax<false>(pos, ss + 1, -alpha - 1, -alpha, d, true);
            doFullSearch = score > alpha && d < newDepth;
        } else {
            doFullSearch = !PvNode || moveCount > 1;
        }

        if (doFullSearch)
            score = -negamax<false>(pos, ss + 1, -alpha - 1, -alpha, newDepth, !cutNode);

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
            if ((ss - 1)->currentMove)
                counterMoves[pos.piece_on(to_sq((ss - 1)->currentMove))][to_sq((ss - 1)->currentMove)] = bestMove;
        }
    }

    if (!excluded) {
        Bound b = bestValue >= beta ? BOUND_LOWER
                : (PvNode && bestMove) ? BOUND_EXACT : BOUND_UPPER;
        TT.store(tte, pos.key(), TT.value_to_tt(bestValue, ss->ply), PvNode, b, depth,
                 bestMove, ss->inCheck ? VALUE_NONE : ss->staticEval);
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

} // namespace

void init() {
    for (int d = 1; d < 64; ++d)
        for (int m = 1; m < 64; ++m)
            Reductions[d][m] = int(0.85 + std::log(d) * std::log(m) / 2.6);
    Reductions[0][0] = Reductions[0][1] = Reductions[1][0] = 0;
}

void clear() {
    std::memset(history, 0, sizeof(history));
    std::memset(counterMoves, 0, sizeof(counterMoves));
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
            int delta = 18;
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
