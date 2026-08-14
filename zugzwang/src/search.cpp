#include "search.h"
#include "movegen.h"
#include "zug_tb.h"
#include "eval.h"
#include "nnue.h"
#include "nnue_accumulator.h"
#include "tt.h"
#include "bitboard.h"
#include "zobrist.h"
#include <cassert>
#include <chrono>
#include <cstdio>   // NNUE_ASSERT root-ttMove drift report
#include <cstdlib>  // std::abort for the same
#include <cstring>
#include <iostream>
#include <algorithm>
#include <cmath>
#include <memory>
#include <mutex>
#include <condition_variable>
#include <thread>
#include <string>
#include <vector>
#include <unordered_map>
#include "native_thread.h"  // NativeThread: 8MB stacks (SF ~sf18-arm/src/thread_win32_osx.h)

using namespace BB;

namespace Search {

// ---- Pondering (SF thread.cpp:294 / search.cpp:210-216) ----
// One process-wide flag: `go ponder` sets it, `ponderhit` / a new `go` clears it. During
// pondering, check_time() and the ID-loop soft break both early-out on it, so the search
// ignores all time limits and keeps deepening until the GUI sends `ponderhit` (convert to a
// timed search, clock measured from the original `go ponder` startTime) or `stop` (abort).
// A single global is safe: only ONE UCI search runs at a time (uci.cpp's searchThread), and
// the HTTP serve path never ponders (no ponder field in its request contract).
std::atomic<bool> ponderFlag{false};

// Small constants sizing Context's tables — internal linkage is fine here
// (they're only ever used as constant-expression array bounds / values, never
// as a TYPE embedded in Context, so there's no linkage mismatch with
// Context's own external-ish, header-forward-declared identity below).
namespace {
// ---- Correction History (CorrHist) sizing ----
// Learns the running bias between the (raw) static eval and the eventual search
// result, keyed by pawn-structure and per-color non-pawn-material patterns
// (Position::pawn_key() / non_pawn_key(), maintained incrementally in
// Position::do_move — see position.h/.cpp). Formula mirrors Stockfish 18
// (src/search.cpp: correction_value / to_corrected_static_eval /
// update_correction_history, src/history.h: StatsEntry::operator<<), scoped
// down to the two table kinds the task asks for (pawn + per-color non-pawn).
constexpr int CORR_SIZE  = 16384;       // entries per table (power of two -> mask)
constexpr int CORR_MASK  = CORR_SIZE - 1;
constexpr int CORR_LIMIT = 1024;        // per-entry clamp (SF's CORRECTION_HISTORY_LIMIT)
constexpr int CORR_W_PAWN       = 10347;
constexpr int CORR_W_NONPAWN    = 11665;
constexpr int CORR_APPLY_SHIFT  = 131072;
constexpr int CORR_NONPAWN_UPDATE_NUM = 178;
constexpr int CORR_NONPAWN_UPDATE_DEN = 128;

// ---- CorrHist variants (CORRVARIANTS, default OFF, env-gated) ----
// Two extra SF18 corrhist terms, keyed/weighted to match SF exactly
// (src/search.cpp correction_value/update_correction_history,
// src/history.h minor_piece_correction_entry): minor-piece placement (KNIGHT+
// BISHOP of both colors, Position::minor_key()) and own-side continuation
// (own move 2 and 4 plies back, [piece][to]-keyed like zug's contHist1/2
// planes). Gated end-to-end by Context::Tune::corrVariants — OFF reproduces
// today's correction()/update_corrhist() exactly (dead code below the flag).
constexpr int CORR_W_MINOR        = 8821;
constexpr int CORR_W_CONT         = 7841;
constexpr int CORR_MINOR_UP_NUM   = 156;
constexpr int CORR_CONT_NEAR_NUM  = 127; // ss-2 tap
constexpr int CORR_CONT_FAR_NUM   = 59;  // ss-4 tap
constexpr int CORR_VARIANT_UP_DEN = 128;
constexpr int CORR_CONT_FALLBACK  = 8;   // SF's cntcv when the ss-1 move isn't real

// ---- Continuation history (PARITY_GOMACHINE.md D.2) sizing ----
// Packed to a dense [12] piece range (W_PAWN..W_KING -> 0..5, B_PAWN..B_KING ->
// 6..11) rather than raw Piece (0..15, with unused gaps) — halves each table.
constexpr int piece_dense(Piece p) { return (int(p) >> 3) * 6 + (int(p) & 7) - 1; }
constexpr int CONT_PIECE_NB = 12;
} // namespace

// ---- Context: everything a search mutates ----
// One of these is a fully independent "engine instance" — its own TT, its own
// history/killer/countermove/corrhist/continuation-history tables, its own
// LMR table (tune-dependent), its own node counter + stop flag, and its own
// incremental NNUE accumulator stack. Two threads running negamax/qsearch
// against two DIFFERENT Contexts touch no common mutable memory (the NNUE net
// WEIGHTS in nnue_net.cpp are the only thing shared, and those are read-only
// after NNUE::load()). This is the full (private-to-this-TU) definition of
// the type search.h forward-declares as an opaque handle.
struct Context {
    // Tunable pruning toggles (env-configurable for calibration). Nested
    // inside Context (rather than a free-standing type) purely to avoid any
    // external/internal-linkage friction with Context itself.
    struct Tune {
        bool lmp = true, quietSee = true, futility = true, razor = true, nullMove = true, lmr = true;
        bool corrHist = true;
        // CorrHist variants (2026-07-15): minor-piece + own-side continuation
        // corrhist terms (SF18 micv/cntcv). Default OFF; env CORRVARIANTS=1.
        // OFF must reproduce today's correction()/update_corrhist() exactly —
        // no new terms read or written, byte-identical search node counts.
        bool corrVariants = false;
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
        bool nmpCutGate = false;    // NMP gate: cutNode && staticEval >= beta - 18*depth + 350.
                                    // SPRT'd −27 REJECT (OPTIMIZATIONS.md:72, margin bundle 2) — the
                                    // SF gate needs SF's whole NMP rewrite (depth-only R + verification
                                    // search + nmpMinPly), not just the gate bolted onto zug's NMP.
                                    // Default-off because it LOST, not because it's untried.
        bool lmrDepthPrune = false; // quiet futility + SEE-quiet pruning keyed on lmrDepth, not raw depth
        // LMRHIST: reuse the ordering-time butterfly+conthist sum for the LMR reduction
        // read instead of re-reading the tables at move-time. NOT byte-identical — LMR
        // then sees ordering-time history, not history updated by the siblings already
        // searched at this node. Default OFF: a movetime SPRT (coalla, 100ms, LMRHIST=1
        // vs 0, 2026-07-15) measured it WORSE (~-16 Elo, rejecting). That confirms SF's
        // design rationale for recomputing statScore fresh per move: sibling-updated
        // ("fresh") history makes better reductions than ordering-time ("stale") history,
        // and the hoped-for speed win doesn't exist (the LMR re-reads hit L1 — the
        // ordering pass just warmed the planes — so local NPS is flat). Kept as a dormant
        // opt-in, NOT deleted: this is worse for our CURRENT baseline (2-ply conthist,
        // current tree). It warrants a RE-SPRT if that baseline changes in a way that
        // shifts the freshness/read-cost tradeoff — e.g. going to more conthist plies like
        // SF's 5 (heavier per-move reads may outweigh the freshness loss), or a relayout
        // that makes the ordering-pass cold-read the dominant cost. See
        // docs/tasks/open/conthist-fn-to-mt.md.
        bool lmrHistCache = false;
        // ---- PARITY_GOMACHINE.md D.2/D.3 — Wave B, ACCEPTED, baked into defaults 2026-07-14 ----
        bool contHist = true; // D.2: continuation history (parent/grandparent-keyed quiet magnitude)
        // CONTHISTSPLIT (2026-07-15): split contHist1/contHist2 by [inCheck][capture] of the
        // ancestor move that owns the plane, matching SF's ContinuationHistory[2][2][PIECE_NB]
        // [SQUARE_NB] (history.h:150, search.h:294; indexed at do_move time — search.cpp:564
        // `&continuationHistory[ss->inCheck][capture][dirtyPiece.pc][move.to_sq()]`, where
        // ss->inCheck/capture are the MOVER's inCheck and the MOVE's capture-ness, not the
        // child's). Default OFF; env CONTHISTSPLIT=1. OFF forces index [0][0] for every
        // plane lookup — byte-identical to the pre-split single-plane tables. Kept as a
        // standalone 1/2-only flag for isolated A/B; CONTHISTPLIES=1 (below) now also
        // turns on this exact [inCheck][capture] selection — extended to plies 3/4/6 too
        // — as part of the complete SF-faithful port, independent of this flag.
        bool contHistSplit = false;
        // CONTHISTPLIES (2026-07-16): deeper continuation-history plies 3, 4, 6 —
        // matching SF's move-ordering READ set (~sf18-arm/src/movepick.cpp:163-167,
        // `continuationHistory[0..3]` + `[5]` against the {ss-1..ss-6} array built at
        // ~sf18-arm/src/search.cpp:991-993 — i.e. reads ss-1,ss-2,ss-3,ss-4,ss-6 and
        // SKIPS ss-5). Note SF's statScore (search.cpp:1219-1221) only ever reads
        // ss-1/ss-2 (unchanged here — zug's existing contHist1/contHist2 already
        // cover that). Note also that SF's UPDATE loop (update_continuation_histories,
        // search.cpp:1876-1889) actually touches ALL SIX ancestor plies including ss-5
        // (weight 149/1024) despite the function's stale comment claiming "-1,-2,-3,-4,
        // and -6" — verified from the code, not the comment (the loop is
        // `for (i,weight) in {{1,1133},{2,683},{3,312},{4,582},{5,149},{6,474}}` with no
        // skip of i==5). Since zug carries no ply-5 table (matching the ordering READ
        // set exactly, per the task scope), ply 5 is simply not ported here — only
        // the plies zug also reads (3,4,6) get update weights, taken directly from
        // SF's table: 312/1024, 582/1024, 474/1024.
        //
        // PHASE 2 (2026-07-16 revision): CONTHISTPLIES now ALSO applies the
        // [inCheck][capture] split (SF ContinuationHistory[2][2][PIECE_NB][SQUARE_NB],
        // history.h:150 + search.h:294) to plies 3/4/6, not just 1/2 — SF indexes
        // ALL SIX read planes through the same split array (search.cpp:563-564:
        // `&continuationHistory[ss->inCheck][capture][dirtyPiece.pc][move.to_sq()]`,
        // keyed by the MOVER's own inCheck/capture-ness at do_move time — same array
        // for every ply, no unsplit variant exists in SF). The FN-SPRT wash of the
        // plies-only port (49.82%) is hypothesized to be exactly this gap: SF never
        // reads the deeper planes unsplit, so the earlier port tested a shape SF
        // doesn't actually run. CONTHISTPLIES=1 is now the single flag for the
        // complete port: deeper plies AND the split together, reusing the exact
        // selection logic Tune::contHistSplit already validated for 1/2 (see
        // cont_hist_planes) — when contHistPlies is on, ic/cap are computed from
        // p->inCheck/p->didCapture for planes 3/4/6 too, and ALSO for planes 1/2
        // (independent of whether contHistSplit is separately set — one flag now
        // gives the full port; contHistSplit remains available standalone for an
        // isolated 1/2-only A/B). Default OFF; env CONTHISTPLIES=1. OFF path:
        // cont_hist_planes leaves ch3/ch4/ch6 nullptr and (absent contHistSplit)
        // always resolves ch1/ch2 at [0][0], so every read/update site below
        // collapses to its pre-existing ch1/ch2-only [0][0] behavior — provably
        // unchanged node counts (see perft5/d14 verification in the task report).
        bool contHistPlies = false;
        bool captHist = true; // SF capture history: learned capture-ordering table (banked modest +, 2026-07-15)
        int  captHistWeight = 128; // read weight /256 (128 = half weight); SPSA-tunable via CaptHistWeight
        // captHistPrune: build-on captHist (docs/tasks/open/capthist-in-pruning-reduction.md)
        // — feed the same table into (a) the capture-SEE pruning margin and (b) the LMR
        // statScore for captures, not just ordering. Default OFF; env CAPTHISTPRUNE=1.
        bool captHistPrune = false;
        // HISTMARGIN (SF search.cpp:1084-1115): a quiet's OWN history (butterfly+conthist,
        // the cached histScore) drives its pruning, not just its LMR reduction. Two parts,
        // both default-off behind env HISTMARGIN=1: (a) hard history prune — skip a quiet
        // whose histScore < -histPruneCoeff*depth (SF: history < -4083*depth); (b) history
        // shifts the futility + SEE-quiet margin depth (SF: lmrDepth += history/3208), so a
        // good-history quiet gets a LOOSER margin (kept) and a bad-history one TIGHTER
        // (pruned). This is the COMPLETE SF mechanism (bidirectional), not the incomplete
        // hard-prune-only HistPrune that washed in gomachine. Constants SPSA-tunable.
        bool histMargin = false;
        // ADAPTCAPSEE (SF movepick.cpp:236): value-scaled good/bad capture SEE split
        // threshold (-mvvlva/capSeeDiv) instead of the flat -50. Ordering only. env-tunable.
        bool adaptCapSee = false;
        int  capSeeDiv   = 32;
        bool doDeeper = true; // D.3: adaptive do-deeper/do-shallower LMR re-search depth
        // ---- PARITY_GOMACHINE.md D.5/D.7 — Wave C, default OFF, SPRT independently ----
        bool seeQuietLinear = false; // D.5: linear SEE-quiet shape -75*depth, depth<=6 (vs quadratic default)
        bool gmCheckExt = false;     // D.7: gomachine's per-node uncapped in-check depth++ (replaces per-move check ext)
        // ---- SF selectivity Wave 1 (docs/tasks/open/sf18-selectivity-gap.md) — default ON; env FLAG=0 disables ----
        bool probCut   = true;  // #2a: cheap TT-only ProbCut before the move loop
        bool depthDrop = true;  // #11: depth-=2 after an alpha-raising non-decisive PV move
        bool cutoffCnt = true;  // #6:  grandchild fail-high-rate -> extra LMR reduction
        // #4 double/triple singular extension — Wave 5/6, now that ttPv exists. Default
        // ON; env DBLEXT=0 / TRIPLEEXT=0 disable.
        bool dblExt    = true;
        bool tripleExt = false; // Wave 6: 3rd ply for extremely-singular moves — UNTESTED (mixed gate: +1 depth some pos, -2 endgame); opt-in env TRIPLEEXT=1
        // ---- SF selectivity Wave 2 — hindsight ACCEPTED (~+10 Elo); ttCapR/mcLinR
        // DROPPED as an SPRT drag (combined batch washed ~-5, hindsight-alone +10).
        // ttCapR/mcLinR kept as opt-in env for later salvage (mcLinR likely needs a
        // larger divisor than SF's /1024 for zug's small integer r scale).
        bool hindsight = true;  // #8:  priorReduction hindsight depth adjust (ON)
        bool ttCapR    = false; // #3a: +1 LMR reduction when ttMove is a capture (env TTCAPR=1)
        bool mcLinR    = false; // #3b: linear moveCount de-reduction (env MCLINR=1)
        // ---- SF selectivity Wave 3 (move ordering) — MT+FN wash (ordering saturated in zug),
        // dropped to default-OFF, env-kept for a future fixed-nodes re-eval ----
        bool evalHist    = false; // #12: eval-diff quiet-history bump (env EVALHIST=1)
        bool threatOrder = false; // #10: threat-aware quiet move ordering (env THREATORDER=1)
        // ---- SF selectivity Wave 4 — ttPv (#5): former-PV bit persisted in the TT,
        // gates RFP + de-reduces LMR on tactically-live nodes. Default ON; env TTPV=0. ----
        bool ttPvOn      = true;
        // TTPVFAILLOW (2026-07-21, Stormphrax search.cpp:1174): counter zug's flat ttPv LMR
        // de-reduction (r -= 1024) when the position's OWN TT entry already says it fails low
        // (ttHit && ttValue <= alpha) — don't over-trust the blanket ttPv de-reduction on a
        // line the TT calls bad. r += ttPvFailLowR. Default OFF; env TTPVFAILLOW=1.
        bool ttPvFailLow  = false;
        int  ttPvFailLowR = 1024;   // ~1 ply (SP's 1054 in zug's r*1024 units)
        // TTPVRICH (2026-07-25): condition the ttPv LMR de-reduction on WHY the former-PV
        // node is trustworthy, replacing zug's flat r -= 1024. Uses SF's SIGNAL STRUCTURE
        // (search.cpp:1191-1193: base + PvNode + ttValue>alpha + ttDepth>=depth[+cutNode])
        // but with zug-NATIVE, SPSA-tunable magnitudes — NOT SF's 2719/983/922/934/1011,
        // which are tuned to SF's whole tree ([[zug-history-scale-not-sf]] discipline).
        // The (ttValue>alpha) term is the "escape the ttPv reduction trap" reinforcement
        // zug currently lacks (it only has the negative TTPVFAILLOW half). Default OFF;
        // env TTPVRICH=1. OFF path is byte-identical: the else-branch reproduces today's
        // flat -1024 + TTPVFAILLOW exactly. Starts at zug's current base (1024) so SPSA
        // can raise it rather than jumping to SF's magnitude blind.
        // SHIPPED default-on 2026-07-25: LEAN config (de-reduce ONLY the highest-signal
        // ttValue>alpha ttPv nodes) measured +11.3 Elo movetime (LLR 2.01, 2400g) +
        // +11.3 Elo fixed-nodes (LLR 2.29) — two independent methods agree. The naive
        // all-terms config was +12 fixed-nodes but −3 movetime (tree-width tax); trimming
        // to the single promising-term recovers the win at minimal node cost. env
        // TTPVRICH=0 restores the pre-ship flat r-=1024. The pv/deep/cut weights default
        // to 0 (off) but stay SPSA-tunable to salvage more later.
        bool ttPvRich     = true;
        int  ttPvBase     = 1024;   // base de-reduction when ttPv (today's flat value)
        int  ttPvPvW      = 0;      // extra when PvNode (off in shipped lean config)
        int  ttPvPromW    = 1024;   // extra when TT value already beats alpha (the escape term)
        int  ttPvDeepW    = 0;      // extra when TT entry is deep enough to trust (off in lean)
        int  ttPvDeepCutW = 0;      // additional extra on a trusted-deep cutNode (off in lean)
        // ---- SF parity micro-pair (SF search.cpp:883/927) — default ON; independent env kill-switches ----
        // RFPTTHIT (2026-07-21, SF search.cpp:880 `futilityMult = 76 - 23*!ss->ttHit`): drop
        // the RFP margin coefficient by rfpTtHitCoeff on a TT MISS (prune more aggressively
        // when the static eval is not TT-corroborated). Pruning-class. Default OFF; env RFPTTHIT=1.
        bool rfpTtHit      = true;  // SHIPPED default-on 2026-07-21 (combo SPRT +4.6, consistent); env RFPTTHIT=0 kill-switch
        int  rfpTtHitCoeff = 23;    // SF's 23 (its mult 76->53); zug rfpMargin=75 so same delta
        bool rfpOppWorsening = true; // #A: fold opponentWorsening into the RFP/static-null margin (env RFPOW=0)
        int  rfpOwCoeff      = 10;   // flat extra margin when opponentWorsening (~13% of rfpMargin=75, matching
                                     // SF's 331/2474 ratio of its opponentWorsening/improving futility_margin terms)
        bool improvingRelax  = true; // #B: improving |= staticEval >= beta, after NMP (env IMPROVERELAX=0)
        // ---- 4 independent SF-cross-referenced levers — default OFF, env-gated ----
        bool corrMargin = false; // raw (pre-shift) correction magnitude discounts RFP margin + LMR reduction (env CORRMARGIN=1)
        bool rfpDeep    = false; // raise RFP depth cap 8 -> 13, matching SF's depth<14 (env RFPDEEP=1)
        bool razorQuad  = false; // quadratic razoring curve (SF-scaled consts), no depth cap (env RAZORQUAD=1)
        // RAZORTTGATE (2026-07-21, Stormphrax search.cpp:855): don't razor when there's a good
        // QUIET TT move — a stored quiet best hints at real play the static eval is missing, so
        // dropping straight to qsearch is unsafe. Same intuition as RFP's quiet-ttMove gate.
        // Default OFF; env RAZORTTGATE=1. Off → gate always passes → byte-identical.
        bool razorTtGate = false;
        bool negExt3    = false; // negative-extension magnitude -2/-1 -> -3/-2 (env NEGEXT3=1)
        bool singRetScore = false; // singular multi-cut returns verification score, not singularBeta (env SINGRETSCORE=1; SF search.cpp:1160)
        bool aspAdapt     = false; // adaptive aspiration initial delta (prevScore-scaled) + delta/3 widening, not delta/2 (env ASPADAPT=1; SF search.cpp:355,418)
        // ---- 3 independent SF-cross-referenced levers (2026-07-15) — default OFF, env-gated ----
        bool captHistMargin = false; // split of CAPTHISTPRUNE: captHist term in the capture-SEE prune margin ONLY, no LMR-capture-enable (env CAPTHISTMARGIN=1)
        bool allNodeLmr    = false; // SF's allNode self-scaling LMR term: r += r/(depth+1) when !(PvNode||cutNode) (env ALLNODELMR=1; SF search.cpp:1227)
        bool rootDeltaLmr  = false; // aspiration-window-relative LMR term: r -= delta/rootDelta (env ROOTDELTALMR=1; SF search.cpp delta*608/rootDelta)
        // LMRCLUSTER (2026-07-16): corrMargin/allNodeLmr/rootDeltaLmr are a co-dependent
        // unit, not three independent levers — each washed SOLO in isolated SPRTs, but
        // allNodeLmr (r += r/(depth+1)) is a near-no-op until another term first breaks r
        // off an exact 1024 multiple (see the allNodeLmr comment at the read site,
        // search.cpp ~1586-1597). LMRCLUSTER=1 turns all three on together for a single
        // bundle SPRT/SPSA campaign; the three individual flags (CORRMARGIN/ALLNODELMR/
        // ROOTDELTALMR) still work standalone for isolated A/B. Default OFF — OFF must
        // stay byte-identical (none of the three terms fire).
        bool lmrCluster    = false;
        // ---- 2 new SF-ported history ordering tables (2026-07-15) — default OFF, env-gated ----
        bool lowPlyHist   = false; // SF LowPlyHistory: ply<5 butterfly-shaped table, extra ordering weight near the root (env LOWPLYHIST=1; SF history.h/movepick.cpp)
        bool pawnOrderHist = false; // SF PawnHistory: pawn-structure-keyed quiet ordering table (env PAWNORDHIST=1; SF history.h/movepick.cpp)
        // ---- SF TTMoveHistory (2026-07-15) — a single running scalar (SF history.h:216,
        // StatsEntry<int16_t,8192>) that feeds the double-extension margin: a well-trusted
        // ttMove (frequently the actual best move) lowers the margin, a poorly-trusted one
        // raises it. Default OFF; env TTMOVEHIST=1 (SF search.cpp:1144/1162/1420).
        bool ttMoveHist = false;
        // ---- NMPSF (2026-07-15): full SF18 null-move-pruning port (search.cpp
        // "Step 9. Null move search with verification search") — cutNode gate +
        // depth-only R (7+depth/3) + nmpMinPly verification search, all three
        // together. A previous port of the cutNode gate ALONE (nmpCutGate above)
        // washed −27 Elo precisely because it's an incomplete port: SF's relaxed
        // gate only works alongside SF's R and its verification safety net.
        // Default OFF; env NMPSF=1. OFF path must stay byte-identical to today's
        // nullMove/nmpCutGate/nmpEvalDiv mechanism.
        bool nmpSf = false;
        // ---- CAPFUT (2026-07-20, sf-sp-search-backlog.md #1): SF18 capture
        // futility pruning (search.cpp:1064-1072). zug's capture pruning was
        // SEE-only (below); this adds an eval-based futility test — a capture
        // that can't possibly raise alpha even with the captured piece's value
        // added is pruned before the SEE check runs. Gated !givesCheck &&
        // lmrDepth < 7 (SF's exact gate; zug's `lmrDepth` local, already
        // computed above regardless of lmrDepthPrune, is the equivalent depth
        // proxy). Default OFF; env CAPFUT=1. OFF path adds zero cost: the whole
        // block is skipped, capture branch stays byte-identical to today.
        bool capFut = false;
        // ---- HISTDECAY (2026-07-20, sf-sp-search-backlog.md #2): per-search decay
        // of the main butterfly history[] table. PORT-FIDELITY NOTE (verified
        // directly against both trees, not from the backlog doc's summary — see
        // CLAUDE.md "cross-reference Stockfish 18 before implementing"): SF18
        // (~sf18-arm/src/search.cpp:316-319) and Stormphrax (~stormphrax/src/
        // search.cpp:418 `thread.history.age()`, history.h:108-134) both decay
        // mainHistory/butterfly exactly ONCE per iterative_deepening()/searchRoot()
        // call — i.e. once per `go`, aging the history carried over from the
        // PREVIOUS move's search in the same game — NOT once per rootDepth
        // iteration inside the ID loop (an earlier revision of this flag
        // mis-cadenced it per-iteration off the backlog doc's inaccurate framing;
        // corrected 2026-07-20 to match the real SF/SP call site, which sits
        // BEFORE the `for(depth=1;;++depth)`/`while(++rootDepth...)` loop).
        // VERIFIED zug's history[] actually persists across moves within a game
        // (the gap this targets): reset_tables() — the only site that zeroes
        // history[] — is called from `Search::clear()`, which is wired ONLY to
        // the UCI `ucinewgame` command (src/uci.cpp); the `position` and `go`
        // command handlers never touch it. So across a game's sequence of
        // `position ... moves ...` + `go` calls, history[] accumulates fully
        // undecayed today — this flag is not a no-op. Default OFF; env
        // HISTDECAY=1. OFF path: `if (C.tune.histDecay)` guard in start() skips
        // the whole sweep, byte-identical to today.
        bool histDecay = false;
        // ---- CUTOFFGRADE (2026-07-20, sf-sp-search-backlog.md #3): graded
        // cutoffCnt->LMR reduction bump. zug's shipped cutoffCnt mechanism
        // (Tune::cutoffCnt, default ON) fires a single binary +1024 (whole
        // extra ply) when (ss+1)->cutoffCnt > 3. SF18 (~sf18-arm/src/
        // search.cpp:1208-1209, VERIFIED directly against source, not the
        // backlog summary) is graded and fires much earlier: `if
        // ((ss+1)->cutoffCnt > 1) r += 256 + 1024*((ss+1)->cutoffCnt > 2) +
        // 1024*allNode`. This flag ports the graded >1/>2 shape ONLY — the
        // `+1024*allNode` sub-term is deliberately OMITTED, not just gated
        // separately: it's the same allNode angle already explored as part of
        // the LMRCLUSTER bundle (Tune::allNodeLmr/lmrCluster above), which
        // washed as a co-dependent bundle (WASHED W3) and stays tracked
        // there, not duplicated here. Default OFF; env CUTOFFGRADE=1. OFF
        // path: cutoffCnt's existing single `if` branch is untouched,
        // byte-identical.
        bool cutoffGrade = false;
        int  cutoffGradeBase = 256;  // SF's flat >1 term — already in zug's native r
                                      // x1024 fixed-point units (see the LMR r-assembly
                                      // comment), no unit rescale needed.
        int  cutoffGradeStep = 1024; // additional bump at >2 (SF's second x1024 term)
        // ---- POSTLMRCH (2026-07-20, sf-sp-search-backlog.md #4): post-LMR
        // continuation-history bonus. SF18 (~sf18-arm/src/search.cpp:1259,
        // VERIFIED directly) credits update_continuation_histories(ss,
        // movedPiece, to, 1365) once a move's LMR-reduced scout has beaten
        // alpha — fired inside the `value > alpha` branch, AFTER the optional
        // do-deeper/do-shallower re-search, using the ORIGINAL reduced
        // scout's alpha-beating as the trigger regardless of what that
        // re-search finds. zug has nothing that credits a move mid-loop for
        // surviving its own reduction; the `wasLMRReduced` bookkeeping this
        // needs already exists. Bonus scale: zug's update_cont_entry
        // multiplies the incoming `bonus` parameter by 32 before applying it
        // to the int16 entry (whose hard clamp +-32000 sits within ~7% of
        // SF's own ContinuationHistory D=30000), so matching SF's raw
        // entry-level increment of 1365 means passing an incoming bonus of
        // 1365/32 ~= 42.7 -> 43. Default OFF; env POSTLMRCH=1. OFF path: the
        // call site is skipped entirely.
        bool postLmrCh = false;
        int  postLmrChBonus = 43;
        // ---- DRAWJITTER (2026-07-20, sf-sp-search-backlog.md #5): draw-score
        // jitter. See draw_value()'s comment (just above negamax) for the
        // full port-fidelity note, including a backlog correction verified
        // directly against ~sf18-arm/src/search.cpp: SF jitters ONLY the
        // main-search is_draw()/upcoming-repetition sites, NOT qsearch's
        // is_draw() and NOT the stalemate return — both of those stay flat
        // VALUE_DRAW in real SF. Default OFF; env DRAWJITTER=1.
        bool drawJitter = false;
        // ---- CHECKORDER (2026-07-20, sf-sp-search-backlog.md #6): givesCheck
        // quiet-ordering bonus. SF18 movepick.cpp:170 (VERIFIED directly):
        // quiet score += (check_squares(pt) & to && see_ge(m,-75)) * 16384 —
        // SF uses the cheap check_squares bitboard test (direct checks only,
        // no discovered-check detection); zug instead reuses its own
        // pos.gives_check(mv) (already called per move in the search loop,
        // but not during ordering — this flag pays that cost again inside
        // score_moves_impl, gated off by default). SEE margin rescaled from
        // SF's eval scale (pawn=208) to zug's (pawn=100), the same 0.4808
        // ratio CAPFUT uses: -75*0.4808 ~= -36. Bonus magnitude: SF's 16384 is
        // roughly half its own ContinuationHistory D=30000 ceiling; zug's
        // per-table entries self-limit near the same order (~16384, see the
        // HISTDECAY/CAPFUT comments), but zug's quiet score can already sum
        // several such tables (butterfly + up to 5 conthist planes under
        // CONTHISTPLIES) — start conservative, well under a single table's
        // own ceiling, and let SPSA find the level. Default OFF; env
        // CHECKORDER=1.
        bool checkOrder = false;
        int  checkOrderBonus = 4096;
        int  checkOrderSeeMargin = -36;
        // ---- HISTTAPER (2026-07-20, sf-sp-search-backlog.md #8c): late-quiet malus
        // taper. SF18 search.cpp:1841-1850 (VERIFIED directly): the malus applied to
        // each searched-not-best quiet is reduced for moves tried late — with `i` the
        // 1-indexed rank among non-best searched quiets, `if (i>5) actualMalus -=
        // actualMalus*(i-5)/i`. Rationale: a quiet tried very late was never a real
        // best-move candidate, so hammering its history is mostly noise. This is the
        // one #8 sub-part that is FULLY SCALE-INDEPENDENT (a relative shrink of the
        // existing -bonus malus), so zug's ±400 update_history clamp / different
        // history scale don't matter — no SPSA rescale needed to try it faithfully.
        // zug's quietsSearched INCLUDES bestMove (skipped in the loop), so the rank
        // must count non-best quiets, NOT the array index. Default OFF (tMalus == -bonus
        // → byte-identical); env HISTTAPER=1. histTaperK = the SF threshold (5).
        bool histTaper  = false;
        int  histTaperK = 5;
        // ---- HISTTTBONUS (2026-07-20, sf-sp-search-backlog.md #8b): a ttMove-is-best
        // extra history bonus. SF18 search.cpp:1833 (VERIFIED): bonus += 347*(bestMove
        // ==ttMove) on a base bonus whose cap is 1515 (~23%). zug's bonus is depth*depth
        // clamped to ±400 inside update_history, a different scale, so the literal 347
        // does NOT transfer — histTtBonusVal is in zug's pre-clamp bonus units, SPSA to
        // find the level (a large value just saturates at the ±400 clamp, harmless).
        // Applied ONLY to the bestMove's +bonus updates (main/cont/capt), never to the
        // malus. Default OFF (adds 0 → byte-identical); env HISTTTBONUS=1.
        bool histTtBonus    = false;
        int  histTtBonusVal = 90;
        // ---- LMREXT (2026-07-20, sf-sp-search-backlog.md #11): let a strongly-negative
        // accumulated r search DEEPER than newDepth, and give PV nodes +1. SF18
        // search.cpp:1231 (VERIFIED): d = max(1, min(newDepth - r/1024, newDepth+2)) +
        // PvNode; SP search.cpp:1181-1184 mirrors it. zug's clamp
        // `min(newDepth-red, newDepth)` HARD-caps at newDepth, discarding the negative-r
        // signal its own fine terms produce (givesCheck -1024, ttPv -1024, rootDeltaLmr,
        // mcLinR). Safe here: line 2045 re-searches every PV move at full window/newDepth
        // regardless, so PV value is unaffected; when d>=newDepth, doFullSearch is false
        // (no shallow re-search) and doDeeper can't fire (needs d<newDepth) → no
        // double-extend; ss->reduction goes negative but its only reader (hindsight,
        // line ~1498) just fails its >=2/>=3 gates. lmrExtCap = SF's +2 head-room.
        // Default OFF (clamp reverts to min(...,newDepth), no PvNode add → byte-identical).
        // SPRT VERDICT 2026-07-20: REJECT −10.4±12 @805g (LLR −0.77). NOT a wash — a real
        // negative. WHY: zug's fine-resolution negative-r terms (givesCheck −1024, ttPv
        // −1024, rootDeltaLmr, mcLinR) drive r far below 0, and under SF's newDepth+2 cap
        // + PvNode this over-extends late moves, bloating the tree and losing effective
        // depth at fixed movetime. SF's r-magnitudes/damping are calibrated for its own
        // extension cap; they don't transfer to zug's r scale. Kept default-off. A gentler
        // cap (lmrExtCap=1, no PvNode) MIGHT be neutral but isn't worth tuning a loser.
        bool lmrExt    = false;
        int  lmrExtCap = 2;
        // ---- SHUFFLEGUARD (2026-07-20, sf-sp-search-backlog.md #13): suppress the
        // singular extension in a dead rule50 shuffle. SF18 search.cpp:145-152 + gate
        // at 1131 (VERIFIED directly): is_shuffling := !capture && rule50>=10 &&
        // pliesFromNull>6 && ply>=20 && move.from==(ss-2)->cur.to &&
        // (ss-2)->cur.from==(ss-4)->cur.to (a 4-ply single-piece round-trip). zug's
        // singular gate has no shuffle detector, so it burns verification searches
        // singular-extending a ttMove in a repeating drawn position. Default OFF
        // (gate unchanged → byte-identical); env SHUFFLEGUARD=1.
        bool shuffleGuard = false;
        // ---- PCM (2026-07-20, sf-sp-search-backlog.md #10): parent-continuation credit
        // on a FAIL-LOW. SF18 search.cpp:1423-1444 + Stormphrax search.cpp:1398-1424
        // (both VERIFIED directly). Today zug learns ONLY on a beta cutoff; a node that
        // fails low teaches nothing. When THIS node fails low (no bestMove) and the move
        // that led into it (the opponent's (ss-1)->currentMove) was QUIET, that move just
        // refuted our whole subtree — credit it positively in the opponent's (~us)
        // butterfly history, scaled by how *surprising* the refutation was. Minimal
        // faithful port (SP-shaped, no statScore term — zug lacks that field): weight =
        // base + min(depth*depthW, depthMax) + [parent tried this move late] +
        // [our fail-low badly undershot our own static eval] + [ ... undershot the
        // negated parent static eval]. bonus = depth*depth (zug's native shape, ±400
        // clamped in update_history); scaled = bonus*weight/pcmDiv. All SPSA-tunable;
        // thresholds in zug cp (~pawn=100), so SF's 107/65 → ~100/60. Default OFF; env
        // PCM=1. Off path skips the whole block → byte-identical.
        // SPRT VERDICT 2026-07-20: REJECT −8.25±11.6 @811g (LLR −0.65). Real negative.
        // Likely compounding: (a) +36% nodes at fixed movetime → less depth; (b) the
        // weights/pcmDiv are HAND-SET, not SPSA-tuned to zug's history scale, so the
        // fail-low credit magnitude is miscalibrated (over-crediting parents distorts
        // ordering). SPSA of the 9 Pcm* knobs MIGHT rescue it, but −8 is deep — deprioritized.
        // ---- QSMOVECAP (2026-07-20, sf-sp-search-backlog.md #7): cap qsearch captures.
        bool qsMoveCap  = false;
        int  qsMoveCapN = 2;   // SF's threshold (moveCount > 2 → skip)
        // ---- QSCHECKS (2026-07-25, investigation): generate quiet (non-capture)
        // CHECKS at the ENTRY qsearch ply (qdepth==0, !inCheck), SEE>=0, so qsearch
        // can see a quiet checking refutation/mate (e.g. a back-rank Re8#) instead of
        // stand-patting on a net eval that loves the checker's transient material.
        // SF/most engines generate checks at the first qsearch ply; zug currently does
        // not (generate<CAPTURES> only when !inCheck). Default OFF; env QSCHECKS=1.
        // PoC/diagnostic — NOT SPRT-gated for ship. Bounded: qdepth==0 only (child gets
        // qdepth+1 → no recursive quiet-check explosion), SEE>=0, moveCount cap reuse.
        bool qsChecks   = false;
        int  qsChecksN  = 3;   // max quiet checks to try at the entry ply
        bool pcm            = false;
        int  pcmBase        = 260;   // SP pcmBaseWeight
        int  pcmDepthW      = 400;   // SP pcmDepthWeight
        int  pcmDepthMax    = 4018;  // SP pcmDepthMax
        int  pcmParentMcW   = 976;   // SP pcmParentMoveCountWeight (parent moveCount>=8)
        int  pcmSeW         = 1047;  // SP pcmStaticEvalWeight (our static-eval surprise)
        int  pcmParentSeW   = 1023;  // SP pcmParentStaticEvalWeight (parent static-eval surprise)
        int  pcmSeThresh    = 100;   // our-surprise threshold (zug cp)
        int  pcmParentSeThr = 60;    // parent-surprise threshold (zug cp)
        int  pcmDiv         = 4096;  // overall strength divisor (bonus*weight/pcmDiv)
        // ---- RULE50DAMP (2026-07-20, fresh from SF/SP mine): linear eval damping by the
        // 50-move counter. SF evaluate.cpp:83 `v -= v * rule50_count() / 199`; SP
        // eval/eval.cpp:54 `eval = eval*(200 - halfmove)/200` (both VERIFIED). Shrinks the
        // static eval toward 0 as the shuffle counter climbs — the engine stops
        // over-trusting an eval in a position drifting toward a 50-move/rep draw. This is
        // the rule50-ALONE mechanism; the WASHED item (ledger W12, −7.6) was rule50 folded
        // WITH material-output-scaling, a different combo. Single-scalar-compatible (no
        // psqt split needed → works with zug's net).
        // SHIPPED default-ON 2026-07-20: movetime SPRT +7.45±8.7 @1406g, nElo +15.5, LLR
        // 0.75 and RISING (0.17→0.24→0.49→0.75) — monotonically climbing, never-negative,
        // the OPPOSITE of the session's washes (which all decayed from a phantom +15). The
        // one retrain-free win of the batch. Kill-switch: env RULE50DAMP=0. Byte-identical
        // to the old engine only at rule50=0 (early game); damps eval as the shuffle climbs.
        bool rule50Damp    = true;
        int  rule50DampDiv = 199;    // SF's divisor (SP uses 200); higher = gentler
        // ---- EVALCOMPLEXITY (2026-07-24, eval-mine): SF evaluate.cpp:76-78 shrinks the eval
        // toward 0 by nnueComplexity=|psqt-positional| (v -= v*complexity/18236) — a "distrust
        // the static read when the two heads disagree" term. zug's single-scalar net has no
        // psqt/positional split, but |correction()| (the corrhist residual, already computed
        // in corrected_eval) is a cheap always-available proxy for that same uncertainty. Off
        // -> no shrink, byte-identical. env EVALCOMPLEXITY=1. Div in zug's cp corr-scale
        // (|correction| maxes ~263 cp): 2600 -> ~10% max shrink; SPSA-tunable. NOT the washed
        // rule50+material combo (W12) nor RFP #20 (that's a search margin) — this changes the
        // returned static eval value itself, a distinct site/mechanism.
        bool evalComplexity    = false;
        int  evalComplexityDiv = 2600;
        // ---- NMPTTVETO (2026-07-20, fresh, SP search.cpp:872): skip the null-move probe
        // entirely when the TT already says this node fails LOW below beta (upper-bound
        // entry with score < beta) — the probe is doomed, don't spend a search on it. zug's
        // NMP has the cutNode gate (shipped) but no TT-bound veto. Cheap, ttHit/tte/ttValue
        // already in scope at the NMP gate. Default OFF (veto never fires); env NMPTTVETO=1.
        bool nmpTtVeto = false;
        // ---- SINGTTPV (2026-07-23, sf-sp-search-backlog.md #14, SF search.cpp:1119,1127 /
        // SP search.cpp:1081,1097): singular gate/margin ttPv-dependence. SF requires
        // depth >= 6 + ss->ttPv (one ply deeper on a former-PV node) and widens singularBeta
        // by an extra (75*(ttPv && !PvNode))*depth/60 term on top of its base coefficient 53
        // (~1.42x). zug's singular gate is flat `depth >= singularMinDepth` and its margin is
        // `singularMargin*depth/16` (default 35, giving ~2*depth) — no ttPv term in either.
        // Port: +1 to the min-depth gate on a former-PV node, and subtract an extra
        // singTtPvCoeff*depth/16 from singularBeta under the same ttPv&&!PvNode condition.
        // singTtPvCoeff ~= singularMargin*1.42 ~= 35*1.42 ~= 50, matching SF's own
        // base/ttPv-term ratio. Default OFF; env SINGTTPV=1. OFF path: gate and margin
        // exactly as today (the +0/-0 terms vanish).
        bool singTtPv      = false;
        int  singTtPvCoeff = 50;
        // ---- RFPQUAD (2026-07-23, sf-sp-search-backlog.md #20, Stormphrax search.cpp:
        // 838-853): RFP quadratic depth term. SP's RFP margin is `rfpLinear(85)*depth +
        // rfpQuad(7)*depth² - ...` — zug's is purely linear (rfpMargin*(depth-improving),
        // search.cpp ~1912). Port: add rfpQuadCoeff*depth*depth on top. SP's quad/linear
        // ratio is 7/85 ~= 0.082; applied to zug's rfpMargin default (84) gives
        // ~84*0.082 ~= 6.9 -> a conservative first-cut rfpQuadCoeff of 4 (the term grows as
        // depth², so even a modest coefficient compounds fast toward zug's RFP depth cap of
        // 8-13). Default OFF; env RFPQUAD=1. OFF path: term is 0, margin unchanged.
        bool rfpQuad      = false;
        int  rfpQuadCoeff = 4;
        // ---- NONLMRRED (2026-07-23, sf-sp-search-backlog.md #12, SF search.cpp:1263-1273):
        // non-LMR fallback reduction. SF computes a single accumulated `r` (x1024 units) for
        // EVERY move regardless of whether it takes the LMR branch or the plain full-depth
        // "Step 18" branch; moves that skip LMR still get `newDepth -= (r>3957) +
        // (r>5654 && newDepth>2)` shaved off (plus `r += 1140` first when there's no ttMove).
        // zug's non-LMR else-branch (search.cpp ~2414, `doFullSearch = !PvNode ||
        // moveCount>1`) searches at plain newDepth — it never computes `r` outside the LMR
        // gate. Port: when a move takes the non-LMR path, compute a LOCAL duplicate of the
        // same r formula the LMR branch uses (same fine terms, same tables — see the
        // r-assembly at search.cpp ~2304-2402) and shave newDepth by the same two coarse
        // thresholds. Implemented as a self-contained duplicate, NOT a hoist, per the task's
        // risk guidance: the existing LMR branch's r computation is completely untouched, so
        // its byte-identical behavior can't regress from this change. Thresholds start at
        // SF's own values (already x1024-scale-compatible with zug's r convention). Default
        // OFF; env NONLMRRED=1. OFF path: the non-LMR full-search call is unchanged (rd
        // stays newDepth).
        bool nonLmrRed    = false;
        int  nonLmrNoTtR  = 1140;
        int  nonLmrT1     = 3957;
        int  nonLmrT2     = 5654;
        // ---- OPTIMISM (2026-07-23, sf-sp-search-backlog.md #17, Stormphrax search.cpp:
        // 463-468 + eval/eval.cpp:32-67): single-scalar root-score-driven optimism, blended
        // additively into corrected_eval. SP tracks a running averageScore per root iteration
        // and derives a saturating scalar `optimismScale*avg/(|avg|+optimismStretch)`, applied
        // +side-to-move at the root / -other; SP then blends
        // `optimism*(optBase + npMat*optMatScale/1024)` into the eval — crucially no
        // psqt/positional split needed (unlike SF's version, the reason optimism was shelved
        // before — see eval-postproc-optimism-rule50.md). zug's net is exactly SP's
        // single-scalar shape, so this reopens that door.
        // Calibration (conservative, first cut — SPSA later): optimismScale=120,
        // optimismStretch=100 saturate the raw optimism term at +-120 as |avg| grows large
        // (SP's own 147/101). optBase=64 plus a material-proportional optMatScale=20 (read as
        // npMat*optMatScale/1024) and optDiv=800 together cap the additive eval nudge at
        // ~9.6cp (near-zero non-pawn material) to ~19cp (full non-pawn material) at
        // optimism's own saturation point — a modest tilt, not a rewrite of the eval. Default
        // OFF; env OPTIMISM=1. OFF path: corrected_eval is unchanged (optimism_term is never
        // called), and the running-average update in the ID loop is skipped entirely.
        bool optimism        = false;
        int  optimismScale   = 120;
        int  optimismStretch = 100;
        int  optBase         = 64;
        int  optMatScale     = 20;
        int  optDiv          = 800;
        // ---- PIECETOHIST (2026-07-24, Stormphrax history.h:211 m_pieceTo / tunable.h
        // movepickPieceToWeight=426, searchPieceToWeight=469, lmrPieceToWeight=379,
        // maxPieceToHistory=16220): standalone [piece][to] quiet-history table — no
        // from-square, no ancestor conditioning (distinct from both zug's [color][from]
        // [to] butterfly table and the ancestor-keyed contHist1/2/3/4/6 planes). SP reads
        // it blended near-equal to butterfly at three independent sites (movepick.cpp:249
        // ordering weight 426 vs butterfly's 425; search.cpp:1013 main-search statScore
        // composite 469 vs 481; LMR search.cpp:1155 379 vs 446) and updates it in
        // lockstep with butterfly everywhere butterfly updates (history.h:144-149
        // updateMainHistory, called from updateQuietScore alongside the conthist update).
        // zug has no such table at all. Port: a single Context::pieceToHist
        // [CONT_PIECE_NB][SQUARE_NB] table (piece_dense() x to-square, matching
        // captHist's leading dims; no threat-bit sub-dims — zug's own
        // tPawn/tMinor/tRook threat-ordering bonus is a separate existing mechanism,
        // kept out of this port to stay reviewable), read into the SAME quiet-history
        // composite zug already assembles for ordering (score_moves_impl) and for the
        // LMR reduction (both the cached-histScore reuse path and the two hand-rolled
        // hist/hist2 fresh-recompute blocks in negamax), and written in lockstep with
        // the main butterfly update via update_piece_to_hist — same gravity idiom as
        // update_cont_entry (zug's OWN ±400-bonus/±32000-clamp scale, not SP's raw
        // magnitudes, matching every other port in this file). pieceToWeight: read as
        // pieceToHist*pieceToWeight/256; 256 (weight 1.0) lands the term at butterfly's
        // own implicit (unweighted) scale — SP's own three read sites all cluster
        // pieceTo's weight within ~10% of butterfly's own (426:425, 469:481, 379:446),
        // so a flat ~1:1 blend is a faithful simplification of SP's per-site distinct
        // -but-similar weights, not a divergence from them. Default OFF; env
        // PIECETOHIST=1. OFF path: the table is never read or written (memset-only, in
        // reset_tables) -> byte-identical.
        bool pieceToHist   = false;
        int  pieceToWeight = 256;
        // PIECETOLMR: fold pieceToHist into the LMR reduction reads too (not just
        // ordering). v1 did this unconditionally and lost -25 Elo: adding pieceTo to
        // zug's UN-normalized history sum inflates `hist`, so LMR under-reduces good-
        // history quiets -> tree bloat -> lost movetime depth (SP normalizes ÷1024;
        // zug does not). Default OFF -> PIECETOHIST=1 is now ORDERING-ONLY, which
        // can't inflate LMR. env PIECETOLMR=1 to also feed LMR (v1 behavior).
        bool pieceToLmr    = false;
        // ---- CONTHISTBASE (2026-07-24, Stormphrax history.h:151-177 updateConthist /
        // 58-60 updateWithBase): blended-base gravity for continuation-history updates.
        // zug's update_cont_entry (and hence every ch1/ch2/ch3/ch4/ch6 write via
        // update_cont_hist) is self-referential: `h += 32*bonus - h*|bonus|/512` — the
        // gravity DECAY term reads the entry's OWN stored value. SP's updateConthist
        // instead computes a single shared `base` — a weighted blend of butterfly +
        // pieceTo + the ply-1/2/4/6 conthist entries AT THAT SAME (piece,to) site — and
        // uses THAT in the decay term instead of each entry's own value (updateWithBase:
        // `value += bonus - base*|bonus|/max`), for every one of ch1/ch2/ch4/ch6. Weights
        // (SP tunable.h): contBaseButterflyWeight=211, contBasePieceToWeight=101,
        // contBaseCont1Weight=929, contBaseCont2Weight=917, contBaseCont4Weight=553,
        // contBaseCont6Weight=320, base = (sum of weight*value)/1024. zug's ch3 (an
        // SF-sourced addition — SP has no ply-3 conthist table at all) is NOT part of
        // the base blend and keeps its existing self-referential update untouched
        // regardless of this flag. The pieceTo term is included ONLY when
        // Tune::pieceToHist is ALSO on (dropped, not renormalized, otherwise — matching
        // SP's own fixed /1024 divisor regardless of which weights are in play; the
        // missing ~101/1024 contribution is a minor share of the blend, not worth a
        // dynamic renormalization SP itself doesn't do). Default OFF; env
        // CONTHISTBASE=1. OFF path: update_cont_hist's base computation is skipped
        // entirely and every ch1/ch2/ch4/ch6 write uses the exact original
        // self-referential update_cont_entry call -> byte-identical.
        bool conthistBase           = false;
        int  conthistBaseButterflyW = 211;
        int  conthistBasePieceToW   = 101;
        int  conthistBaseCont1W     = 929;
        int  conthistBaseCont2W     = 917;
        int  conthistBaseCont4W     = 553;
        int  conthistBaseCont6W     = 320;
        // ---- QSTTQUIET (2026-07-24, Stormphrax search.cpp:1556-1566): search a
        // TT-suggested QUIET move in qsearch, not just captures. zug's qsearch
        // unconditionally generate<CAPTURES>()s when !inCheck (this file's qsearch,
        // ~line 1756), so a stored quiet ttMove — even one the TT already verified
        // doesn't fail low here — is otherwise completely invisible to qsearch. Light
        // port (no movegen restructure): search that ONE move explicitly, right before
        // the capture loop, folding its score into bestValue/alpha/bestMove exactly like
        // any other qsearch move. Gate (see the qsearch call site for the exact
        // condition): !inCheck, ttHit, a real non-capture ttMove that also isn't a
        // promotion (matches zug's own isQuiet convention used throughout main search —
        // ~line 2253, !isCapture && type_of_move(m)!=PROMOTION — rather than SP's
        // isNoisy(), which folds queen promos into "noisy" but leaves under-promotions
        // "quiet", an asymmetry not worth carrying over), the TT bound isn't UPPER (an
        // upper-bound entry already says this position fails low here, so the move
        // isn't a trustworthy signal), and the move is legal. zug's qsearch carries no
        // PvNode flag (unlike SP's templated qsearch<kPvNode>), so the gate simply
        // omits SP's `!kPvNode` term. Never double-searched: a real quiet/non-promotion
        // ttMove can never appear in the CAPTURES-only movelist already generated
        // (movegen.cpp:31,46,55,62 gate quiet pushes and push-promotions out of
        // GenType::CAPTURES — only CAPTURING promotions survive there). Default OFF;
        // env QSTTQUIET=1. OFF path: the whole block is skipped, qsearch is
        // byte-identical to today.
        bool qsTtQuiet = false;
        // ---- FULLPROBCUT (2026-07-25, SF18 search.cpp:935-981, VERIFIED directly against
        // ~sf18-arm/src, tag sf_18): the REAL capture-loop ProbCut, separate from and
        // additional to the cheap TT-only variant above (Tune::probCut) — both are
        // independently switchable and neither depends on the other being on. For every
        // capture whose SEE clears probCutBeta-eval: verify with a zero-window qsearch at
        // [probCutBeta-1,probCutBeta]; if that holds, confirm with a reduced-depth
        // search<NonPV>(probCutDepth) at the same window; a move that clears probCutBeta
        // there lets this node return early (a previous move up the tree is refuted) and
        // stores a LOWER-bound TT entry at probCutDepth+1.
        //
        // GATE (search.cpp:939-943, read from source — the real gate has NO explicit
        // !PvNode, since IIR just above it (`!allNode`, i.e. PvNode||cutNode) already
        // fires at PV nodes too in this SF version): `depth>=3 && !is_decisive(beta) &&
        // !(ttValue valid && ttValue < probCutBeta)`. zug adds !PvNode anyway (matching the
        // cheap variant's own convention just below) — returning early here skips this
        // node's ss->pv/pvLen bookkeeping, which SF's own PV machinery tolerates via
        // update_pv but zug's simpler fixed pv[] array does not; not worth the risk for an
        // opt-in test flag. depth>=3 (NOT the task brief's "depth>=5" paraphrase — the
        // verified source is unambiguous and structural/depth terms port as-is).
        //
        // SCALE (critical — NOT a blanket x0.4808): probCutBeta's additive terms are
        // VALUE-scale constants added to a cp value, so they shrink by the usual ratio
        // (SF pawn=208, zug pawn=100): 235*0.4808~=113, 63*0.4808~=30. probCutDepth's
        // divisor (315, SF search.cpp:948, dividing the cp-scale (staticEval-beta)) shrinks
        // the SAME way — 315*0.4808~=151 — because a divisor of a cp difference must shrink
        // together with the smaller cp values it divides to preserve the same ply-reduction
        // for an equivalent chess-meaningful swing. depth structural constants (5, clamp
        // 0..depth) port as-is.
        bool fullProbCut = false;
        // ---- SYZYGY (2026-07-20): Syzygy tablebase probing — WDL at internal nodes +
        // DTZ at the root. Ported from gomachine. SHIPPED default-ON, path-presence gated:
        // every hook also requires TB::loaded(), so a box WITHOUT a resolvable `syzygy/`
        // dir is byte-identical (no-op) — safe everywhere. Kill-switch: env SYZYGY=0.
        // Evidence: on the 1305 <=5-man Lichess puzzles it's 100% correct (== search, which
        // already solves simple endgames) but ~55x FASTER (4s vs 221s) — banks clock time
        // in real games + instant perfect endgames on the website. Movetime SPRT is flat
        // (+1.1@621g) precisely because fixed-time ignores the speedup and search already
        // plays these perfectly; the value is real-clock / long-TC / vs-non-TB-opponents,
        // exactly gomachine's rationale for shipping it default-on.
        bool syzygy = true;
        // ---- TBROOTRANK (2026-08-14): Syzygy ROOT DTZ ranking, SF-style
        // (~sf18-arm/src/syzygy/tbprobe.cpp:1603/1717 + search.cpp:341-350). SHIPPED
        // default-ON: this is a correctness fix, not a strength experiment. Without it the
        // HTTP serve path (the whole website: /bestmove, /candidates, /analyze,
        // /analyze-game, bot games, engine-vs-engine) had NO access to DTZ at all —
        // TB::probe_root was reachable only from Search::start_smp, i.e. UCI — and
        // WDL-in-search's flat ±(VALUE_TB_WIN - ply) made every winning move tie, so won
        // ≤5-man endings were shuffled into 50-move draws on the site while the eval bar
        // read +314.96. Gate: test/tb_conversion.sh, serve path 1/24 → 24/24.
        //
        // Subordinate to `syzygy` (TB off ⇒ this cannot fire) and to TB::loaded(), so a box
        // with no resolvable syzygy/ dir is byte-identical either way. Kill-switch:
        // env TBROOTRANK=0, which restores the flat-WDL behaviour exactly.
        bool tbRootRank = true;
        // ---- TBWDLSF (2026-08-14): the IN-SEARCH WDL probe, ported onto SF's Step 5
        // (~sf18-arm/src/search.cpp:801-853). SHIPPED default-ON, and like TBROOTRANK this
        // is a correctness fix rather than a strength experiment. The old block was wrong
        // in three independent ways and each one is a real, reproduced misbehaviour:
        //   1. no `rule50_count() == 0` gate. WDL answers "won with a FRESH clock", so a
        //      win the halfmove counter has already eaten still read as a full win — the
        //      dead-drawn KNPvKB that reported +314.96 for 16 moves in the reported game.
        //   2. cursed win / blessed loss were folded into a flat draw, so the search could
        //      not prefer a spent win (where the opponent still has 50 moves to err) over
        //      a real draw, and — worse — scored it with the wrong BOUND.
        //   3. the verdict was a hard `return`, amputating the subtree unconditionally.
        //      SF returns only when the bound actually cuts and otherwise keeps the value
        //      as an alpha raise (LOWER) or a maxValue ceiling (UPPER) and searches on.
        // Subordinate to `syzygy` and TB::loaded(), so a box with no resolvable syzygy/
        // dir is byte-identical either way. Kill-switch: env TBWDLSF=0, which restores the
        // old flat/ungated probe byte-for-byte (see the block in negamax).
        bool tbWdlSf = true;
        // ---- Move Overhead (2026-07-20): reserved per-move slack (ms) for GUI/OS/network
        // latency, subtracted from remaining time in set_time_limits' clock branch. UCI
        // spin option "Move Overhead" (SF/SP default 10; zug ships 40 = the old hardcoded
        // literal, so DEFAULT is byte-identical). Only read on the clock path (wtime/btime),
        // which the UCI/CCRL path uses; the website's rating-only requests never reach it.
        int  moveOverhead = 40;
        // ---- Contempt (2026-07-20, Stormphrax opts.h:40 / eval.cpp:25): a cp bias added to
        // the (corrected) static eval from the ROOT side's perspective, so the engine avoids
        // simplifying into equal/drawish lines when it believes it's the stronger side. UCI
        // spin option "Contempt" (default 0 = OFF = byte-identical; SF18 has NO contempt, only
        // the anti-blindness draw jitter zug already has as DRAWJITTER). Applied via the
        // per-Context contempt[] array set once at start(); NOT an SPRT/self-play strength
        // lever (net-neutral-to-slightly-negative in symmetric self-play) — it's a knob for
        // asymmetric-strength play (CCRL below-peer, vs weaker fields).
        int  contempt = 0;
        // ---- TIMEMAN (2026-07-20): dynamic time management — Stormphrax-style base
        // allocation (usable/mtg + inc*0.94, soft/hard scales) PLUS per-iteration soft-limit
        // scaling by best-move stability and eval trend (limit.cpp:34-102). SHIPPED default-ON:
        // real-clock (TC 8+0.08) SPRT +28.15 ±8.61 Elo, nElo +64.53, LLR 2.95 ACCEPT @1200g.
        // Only affects the clock (wtime/btime) path — movetime/depth/nodes/infinite stay
        // byte-identical (movetime returns before tmScaled is set), so the movetime SPRT and
        // golden/bench are unchanged. Kill-switch: env TIMEMAN=0.
        bool timeMan = true;
        // ---- NODEEFFORT (2026-07-24, SF search.cpp:487-508/1308/1346, sf_18 cb3d4ee):
        // two more TIMEMAN-style multiplicative factors on the per-iteration soft-limit
        // scale, layered on top of the Stormphrax stability/eval-trend scale above:
        //   highBestMoveEffort — shrink the budget (x0.76) once the current best root
        //   move has soaked up >=93.34% of this search's total nodes (SF's nodesEffort
        //   >= 93340, a per-100000 ratio — a structural node-count fraction, not a cp
        //   value, so SF's threshold is ported unchanged, no value-scale rescale).
        //   bestMoveInstability — 1.02 + 2.14*(decaying count of this-iteration PV
        //   flips) — extend the budget while the root PV keeps changing.
        // Requires TIMEMAN (nested inside its C.tmScaled per-iteration block below) —
        // real-clock only, matching TIMEMAN's own scope. SF's third factor, fallingEval
        // (bestPreviousAverageScore across MOVES in the game + a 4-iteration score
        // ring-buffer) was NOT ported here (fabricating that state wasn't "sound, minimal
        // plumbing" at the time) — it is now ported separately as Tune::tmFalling below,
        // once the minimal state (Context::bestPreviousAverageScore + a start()-local
        // ring buffer) was worked out. Default OFF; env NODEEFFORT=1.
        bool nodeEffort = false;
        // ---- TMFALLING (2026-07-25, SF18 search.cpp:487-508/240/296-299, VERIFIED directly
        // against ~sf18-arm/src, tag sf_18): the two deferred TIMEMAN pieces (see the
        // Tune::timeMan comment above — this note also used to live on Tune::nodeEffort,
        // moved here now that both parts are actually ported):
        //   (a) fallingEval — a further multiplicative per-iteration soft-limit factor,
        //   independent of and layered alongside the Stormphrax stability/eval-trend scale
        //   and NODEEFFORT's two factors: a falling score (vs. both the PREVIOUS search's
        //   blended root average AND this search's own score 4 iterations back) EXTENDS the
        //   budget. Needs two pieces of state: Context::bestPreviousAverageScore (persisted
        //   across searches within one game — a fast /2 EMA of the root score, SF's
        //   mainThread->bestPreviousAverageScore, reset only at ucinewgame like
        //   ttMoveHistory) and a start()-local 4-slot ring buffer (SF's iterValue[4], pure
        //   per-search state, never needs to persist across `go` calls). See the exact
        //   formula + scale derivation at the start() call site.
        //   (b) ply-growth base allocation — SF timeman.cpp:106-134 grows the base time
        //   allocation with game ply (pow(ply+2.95,0.46)) and damps it by banked time
        //   (log10 scale). SF's own optScale/maxScale/timeLeft machinery is a different time
        //   model built around per-move-horizon percentages zug doesn't compute, so only the
        //   ply/log-time SHAPE is ported, as a bounded multiplier on zug's existing flat
        //   usable/mtg+inc*0.94 base — see set_time_limits() for the exact formula.
        // Both real-clock only (nested inside timeMan/tmScaled — TIMEMAN must also be on).
        // Default OFF; env TMFALLING=1.
        bool tmFalling = false;
        // ---- TTCUTBONUS (2026-07-20, SF search.cpp:759-776 + Stormphrax search.cpp:682-698):
        // on the non-PV TT-cutoff fast path (where no move loop runs at this node), credit a
        // quiet ttMove that fails high (ttValue>=beta) with a depth-scaled history+conthist
        // bonus, and penalize the previous ply's early quiet (SF: (ss-1) moveCount<4, not a
        // capture). Learns ordering from repeated transpositions — a signal class distinct
        // from zug's post-search cutoff credit (fresh cutoffs) and PCM (fail-low credit). Both
        // SF18 and Stormphrax independently do this; genuinely un-ported in zug. Default OFF;
        // env TTCUTBONUS=1, movetime-SPRT gated.
        //
        // SCALE (critical): SF's raw constants (132*depth-72 bonus, 2060 malus) are for SF's
        // history clamp (~±7000). zug clamps the BONUS ITSELF to ±400 in update_history/
        // update_cont_entry, so SF magnitudes saturate every update on the most-frequent path
        // (TT cutoffs) and swamp the real-search signal — a v1 that used them lost -28 Elo.
        // The faithful port matches the RELATIONSHIP SF has (TT-cutoff bonus == real-cutoff
        // bonus == stat_bonus): use zug's OWN native cutoff scale here, depth*depth (the exact
        // value zug's real-cutoff block at ~search.cpp:2331 uses), and a depth-scaled malus.
        //
        // MARGIN SWEEP: bonus = depth*depth * bonusNum/bonusDen; prev-ply malus =
        // (depth+1)^2 * malusNum/malusDen. Defaults 1/1 reproduce the plain depth*depth form
        // that measured -2.3 (neutral). malusNum=0 → bonus-only (isolate whether the malus is
        // the drag); bonusDen>1 → gentler bonus (a cheap cache-hit signal may deserve less
        // weight than an earned real-search cutoff). Exposed as env + UCI spin so the sweet
        // spot can be A/B'd + SPSA'd — the -28→-2 swing on scale alone proves it's live.
        bool ttCutBonus     = false;
        int  ttCutBonusNum  = 1, ttCutBonusDen = 1;
        int  ttCutMalusNum  = 1, ttCutMalusDen = 1;
        // NOTE (2026-07-20): CUTNODEEXT (SP search.cpp:1131 `cutnode |= extension<0`)
        // researched + DEFERRED — SP modifies function-scope cutnode, which in zug leaks
        // into the next move iteration + the fail-low PCM/allNode reads. A safe port needs
        // a per-move local threaded through the LMR r-bump + full-search cutNode arg; not
        // worth the bug risk for a speculative SP-only one-liner right now. See backlog.
        // ---- SPSA-tunable search margins (UCI spin options, search.cpp <-> uci.cpp) ----
        // Defaults reproduce the pre-tunable literals exactly (see set_tune_option's
        // callers in uci.cpp for the option table incl. min/max).
        int rfpMargin     = 84;   // reverse futility: eval - rfpMargin*(depth-improving) >= beta (SPSA 2026-07-21: 75→84)
        int razorMargin   = 222;  // razoring: eval + razorMargin*depth <= alpha (SPSA 2026-07-21: 200→222)
        int futBase       = 0;    // quiet futility base: eval + futBase + futSlope*depth <= alpha
        int futSlope      = 107;  // quiet futility per-depth slope (SPSA 2026-07-21: 100→107)
        // FUTSFTERMS (2026-07-21, SF search.cpp:1097 futilityValue): two extra terms added to
        // the futility value → prune LESS when (a) no move has raised alpha yet at this node
        // (futNoMoveBonus, SF's 161→77 at zug's 0.4808 pawn scale) and (b) the raw static eval
        // already clears alpha (futAlphaBonus, SF's 85→41). Both are cheap in-scope reads
        // (bestMove, alpha). Default OFF; env FUTSFTERMS=1, UCI Fut{NoMove,Alpha}Bonus for SPSA.
        bool futSfTerms     = false;
        int  futNoMoveBonus = 77;
        int  futAlphaBonus  = 41;
        int seeQuietCoeff = 17;   // SEE-quiet pruning: -seeQuietCoeff*depth*depth (SPSA 2026-07-21: 25→17)
        int captSeeCoeff  = 23;   // capture SEE pruning: -captSeeCoeff*depth
        int nmpEvalDiv    = 120;  // null-move R eval term: min((eval-beta)/nmpEvalDiv, 3) (SPSA 2026-07-21: 200→120)
        int singularMargin = 35;  // singular beta: ttValue - singularMargin*depth/16 (SPSA 2026-07-21: 32→35)
        // HISTMARGIN constants (only read when histMargin on; anchored to zug's history
        // scale, where the LMR read treats hist/8000 as ~1 ply). histPruneCoeff: hard-prune
        // a quiet whose histScore < -histPruneCoeff*depth. histMarginDiv: shift the
        // futility/SEE margin depth by histScore/histMarginDiv (good hist -> looser).
        int histPruneCoeff = 4000;
        int histMarginDiv  = 4000;
        // ---- LMPHIST (2026-07-21, Stormphrax search.cpp:1032 `lmpHistoryScale`): scale the
        // LMP move-count limit by THIS quiet's own history — a surprisingly-good-history late
        // move gets more room before LMP prunes it, a bad-history one less. Pruning-class
        // lever (distinct from ordering). lmpLimit += histScore/lmpHistDiv, floored so the
        // first moves are never pruned. div anchored to zug's hist scale (histPruneCoeff=4000
        // ≈ 1 unit), so a ~±8000 histScore shifts the count by ~±2.
        // SHIPPED default-ON 2026-07-21: movetime SPRT consistently positive across the whole
        // run (+22@142g → +13.7@1240g → +6.7@2124g; decaying off the phantom but never crossing
        // 0, pentanomial wins-favored). Kill-switch env LMPHIST=0. lmpHistDiv (4000, untuned) is
        // an SPSA target. default-on CHANGES the search; LMPHIST=0 reproduces the old baseline.
        bool lmpHist    = true;
        int  lmpHistDiv = 4000;
        // ---- LMRCLUSTER fine-term constants (2026-07-16) — UCI-exposed for joint SPSA.
        // Defaults reproduce the pre-tunable literals exactly; only read when the owning
        // flag (corrMargin/allNodeLmr/rootDeltaLmr, or the LMRCLUSTER bundle) is on, so
        // these are no-ops at their defaults on the OFF path regardless of value. ----
        int rootDeltaCoeff = 608;   // ROOTDELTALMR: r -= delta*rootDeltaCoeff/max(1,rootDelta) (SF search.cpp:1737, 608)
        int corrMarginDiv  = 30370; // CORRMARGIN (LMR term only): r -= abs(correction_raw)/corrMarginDiv (SF search.cpp:1197, 30370)
        int allNodeDiv     = 1;     // ALLNODELMR: r += r/(depth+allNodeDiv) at allNodes (SF search.cpp:1228 uses depth+1 -> allNodeDiv=1)
        int dblExtMargin   = 64;    // double-extension verification margin (search.cpp singular block; was a bare 64)
        // SINGCORRMARGIN (2026-07-21, SF search.cpp:1140 / SP search.cpp:1097): high
        // |correctionValue| (an uncertain static eval) SHRINKS the double-extension margin, so
        // the engine double-extends a singular move more readily when its eval is untrustworthy.
        // Both SF and SP corroborate. Reuses correction_raw() (same scale as the shipped
        // corrMargin /174665). dblMargin -= |corr|/singCorrDiv. Default OFF; env SINGCORRMARGIN=1.
        bool singCorrMargin = true;  // SHIPPED default-on 2026-07-21 (combo SPRT +4.6, consistent); env SINGCORRMARGIN=0 kill-switch
        int  singCorrDiv    = 230673; // SF's divisor (its correctionValue scale == zug's)
        // ---- CAPFUT constants (only read when capFut on) — scaled from SF search.cpp:1071
        // `staticEval + 232 + 217*lmrDepth + PieceValue[captured] + 131*captHist/1024`.
        // BASE/SLOPE: SF's additive/per-lmrDepth terms are in SF's eval scale (PawnValue=208,
        // types.h:185); zug's eval/PieceVal scale is pawn=100, ratio 100/208 ~= 0.4808:
        // 232*0.4808 ~= 111.5 -> 112, 217*0.4808 ~= 104.3 -> 104. PieceVal[victim] is used
        // directly (zug's own material table, already pawn=100 — no rescale needed).
        // HistCoeff/divisor: SF's captHist term is captHist/1024 against
        // CapturePieceToHistory's hard clamp (history.h:142, D=10692); zug's captHist
        // (search.cpp captHist[] table) has no hard clamp but self-limits to ~16384 in
        // steady state (same steady-state figure used by CAPTHISTPRUNE's margin/320
        // derivation above) — ratio 16384/10692 ~= 1.532. Keeping SF's /1024 divisor,
        // solve the coefficient so the term's max swing scales the same way BASE/SLOPE
        // did: K = 131 * 0.4808 / 1.532 ~= 41. (Sanity: term maxes at 16384*41/1024 ~=
        // 656, vs the ratio-consistent target 1367.8[SF max]*0.4808/1.532 ~= 655.6 —
        // matches to within rounding.)
        int capFutBase      = 112;
        int capFutSlope     = 104;
        int capFutHistCoeff = 41;   // read as captHist * capFutHistCoeff / 1024
        // ---- HISTDECAY constants (only read when histDecay on) ----
        // zug's history[] self-ages only on a touched entry via update_history's
        // gravity term (h += 32*bonus - h*|bonus|/512, bonus clamped +-400) and
        // self-limits to ~+-16384 in steady state (see update_cont_entry comment
        // above, same formula/scale). That gravity does nothing to UNTOUCHED
        // entries, which is exactly what this flag targets. SF's per-slot analog
        // is (h-68)*3/4+68 in SF's +-7183-clamped scale (floor ratio 68/7183 ~=
        // 0.0095, decay factor 0.75); Stormphrax ages butterfly by 977/1024 ~=
        // 0.954 (gentler, no floor). Both apply their decay ONCE per search --
        // this flag now matches that cadence exactly (moved out of the ID loop
        // and into start(), before it; see start()'s HISTDECAY comment), so an
        // SF/SP-like rate is the right default rather than the much-gentler
        // rate an earlier per-iteration revision of this flag needed. Floor:
        // zug's scale is symmetric about 0 (unlike SF's mainHistoryDefault=68
        // asymmetric floor), so a proportional floor is ~0 -- pure geometric
        // decay toward 0 (no separate floor constant; add one only if SPRT
        // wants it). Num/den: default 3/4, directly SF's decay factor (0.75) --
        // now that the cadence matches SF's exactly, SF's own constant is the
        // natural starting point (Stormphrax's gentler 977/1024 ~= 0.954 is the
        // other reference; both UCI-tunable for SPSA regardless).
        int histDecayNum = 3;
        int histDecayDen = 4;
        // ---- D.1 gomachine structural constants — ACCEPTED, baked into defaults 2026-07-14 ----
        // (previously only applied via env GMCONST=1; not UCI-exposed)
        int captSeeMaxDepth  = 4;      // capture SEE pruning: only at depth <= this
        int singularMinDepth = 5;      // singular extension: only at depth >= this
        int aspInitDelta     = 25;     // aspiration window initial half-width
        int lmrMinMoves      = 4;      // LMR onset: reduce once moveCount > this (+1 at root)
        double lmrBase       = 0.7844; // LMR table: base + log(d)*log(m)/div
        double lmrDiv        = 2.4696;
        // lmrBase/lmrDiv are UCI-exposed too (uci.cpp "LmrBase"/"LmrDiv"), but UCI `spin`
        // options are integers and these are sub-1-precision doubles: the wire value is
        // the double x10000 (LMRBASE_SCALE below), e.g. default 0.7844 <-> spin value 7844.
        // set_tune_option_impl divides back by the scale; SPSA drives the integer spin.
        // load() applies env overrides but does NOT rebuild the LMR table
        // itself (that needs the owning Context's Reductions array, which
        // Tune has no access to) — every load() call site must follow up
        // with build_reductions(ctx); see start().
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
            if (on("CORRVARIANTS")) corrVariants = true;
            if (off("NEGEXT")) negExt = false;
            if (off("RFPSOFT")) rfpSoft = false;
            if (off("IIR")) iir = false;
            if (const char* e = getenv("QSFUT_MARGIN")) { int v = atoi(e); if (v > 0) qsFutMargin = v; }
            if (on("NMPCUTGATE")) nmpCutGate = true;
            if (on("LMRDEPTHPRUNE")) lmrDepthPrune = true;
            if (on("LMRHIST")) lmrHistCache = true;
            if (on("PVGUARD")) pvGuard = true;
            if (on("CONTHIST")) contHist = true;
            if (on("CONTHISTSPLIT")) contHistSplit = true;
            if (on("CONTHISTPLIES")) contHistPlies = true;
            if (off("CAPTHIST")) captHist = false; // default-on now; kill-switch for A/B
            if (on("CAPTHISTPRUNE")) captHistPrune = true;
            if (on("HISTMARGIN")) histMargin = true;
            if (const char* e = getenv("HISTPRUNECOEFF")) histPruneCoeff = atoi(e);
            if (const char* e = getenv("HISTMARGINDIV"))  histMarginDiv  = atoi(e);
            if (on("ADAPTCAPSEE")) adaptCapSee = true;
            if (const char* e = getenv("CAPSEEDIV")) capSeeDiv = atoi(e);
            if (on("DODEEPER")) doDeeper = true;
            if (on("SEEQUIETLINEAR")) seeQuietLinear = true;
            if (on("GMCHECKEXT")) gmCheckExt = true;
            if (off("PROBCUT")) probCut = false;
            if (off("DEPTHDROP")) depthDrop = false;
            if (off("CUTOFFCNT")) cutoffCnt = false;
            if (off("DBLEXT")) dblExt = false;
            if (on("TRIPLEEXT")) tripleExt = true;
            if (off("HINDSIGHT")) hindsight = false;
            if (on("TTCAPR")) ttCapR = true;
            if (on("MCLINR")) mcLinR = true;
            if (on("EVALHIST")) evalHist = true;
            if (on("THREATORDER")) threatOrder = true;
            if (off("TTPV")) ttPvOn = false;
            if (off("RFPOW")) rfpOppWorsening = false;
            if (const char* e = getenv("RFPOW_COEFF")) { int v = atoi(e); if (v >= 0) rfpOwCoeff = v; }
            if (off("IMPROVERELAX")) improvingRelax = false;
            if (on("CORRMARGIN")) corrMargin = true;
            if (on("RFPDEEP")) rfpDeep = true;
            if (on("RAZORQUAD")) razorQuad = true;
            if (on("RAZORTTGATE")) razorTtGate = true;
            if (off("SINGCORRMARGIN")) singCorrMargin = false; // shipped default-on; kill-switch
            if (const char* e = getenv("SINGCORRDIV")) { int v = atoi(e); if (v > 0) singCorrDiv = v; }
            if (on("TTPVFAILLOW")) ttPvFailLow = true;
            if (const char* e = getenv("TTPVFAILLOWR")) { int v = atoi(e); if (v >= 0) ttPvFailLowR = v; }
            if (on("TTPVRICH")) ttPvRich = true;
            if (off("TTPVRICH")) ttPvRich = false;   // kill-switch: restore pre-ship flat r-=1024
            if (const char* e = getenv("TTPVBASE"))     { int v = atoi(e); if (v >= 0) ttPvBase     = v; }
            if (const char* e = getenv("TTPVPVW"))      { int v = atoi(e); if (v >= 0) ttPvPvW      = v; }
            if (const char* e = getenv("TTPVPROMW"))    { int v = atoi(e); if (v >= 0) ttPvPromW    = v; }
            if (const char* e = getenv("TTPVDEEPW"))    { int v = atoi(e); if (v >= 0) ttPvDeepW    = v; }
            if (const char* e = getenv("TTPVDEEPCUTW")) { int v = atoi(e); if (v >= 0) ttPvDeepCutW = v; }
            if (on("FUTSFTERMS")) futSfTerms = true;
            if (const char* e = getenv("FUTNOMOVEBONUS")) { int v = atoi(e); if (v >= 0) futNoMoveBonus = v; }
            if (const char* e = getenv("FUTALPHABONUS"))  { int v = atoi(e); if (v >= 0) futAlphaBonus = v; }
            if (on("NEGEXT3")) negExt3 = true;
            if (on("SINGRETSCORE")) singRetScore = true;
            if (on("ASPADAPT")) aspAdapt = true;
            if (on("CAPTHISTMARGIN")) captHistMargin = true;
            if (on("ALLNODELMR")) allNodeLmr = true;
            if (on("ROOTDELTALMR")) rootDeltaLmr = true;
            // LMRCLUSTER: bundle switch for the co-dependent corrMargin/allNodeLmr/
            // rootDeltaLmr trio — sets all three individual flags together (each also
            // stays settable standalone via its own env var above).
            if (on("LMRCLUSTER")) { lmrCluster = true; corrMargin = true; allNodeLmr = true; rootDeltaLmr = true; }
            if (on("LOWPLYHIST")) lowPlyHist = true;
            if (on("PAWNORDHIST")) pawnOrderHist = true;
            if (on("TTMOVEHIST")) ttMoveHist = true;
            if (on("NMPSF")) nmpSf = true;
            if (on("CAPFUT")) capFut = true;
            if (on("HISTDECAY")) histDecay = true;
            if (const char* e = getenv("HISTDECAYNUM")) { int v = atoi(e); if (v > 0) histDecayNum = v; }
            if (const char* e = getenv("HISTDECAYDEN")) { int v = atoi(e); if (v > 0) histDecayDen = v; }
            if (on("CUTOFFGRADE")) cutoffGrade = true;
            if (const char* e = getenv("CUTOFFGRADEBASE")) cutoffGradeBase = atoi(e);
            if (const char* e = getenv("CUTOFFGRADESTEP")) cutoffGradeStep = atoi(e);
            if (on("POSTLMRCH")) postLmrCh = true;
            if (const char* e = getenv("POSTLMRCHBONUS")) postLmrChBonus = atoi(e);
            if (on("DRAWJITTER")) drawJitter = true;
            if (on("CHECKORDER")) checkOrder = true;
            if (const char* e = getenv("CHECKORDERBONUS")) checkOrderBonus = atoi(e);
            if (const char* e = getenv("CHECKORDERSEEMARGIN")) checkOrderSeeMargin = atoi(e);
            if (on("HISTTAPER")) histTaper = true;
            if (const char* e = getenv("HISTTAPERK")) { int v = atoi(e); if (v >= 0) histTaperK = v; }
            if (on("HISTTTBONUS")) histTtBonus = true;
            if (const char* e = getenv("HISTTTBONUSVAL")) histTtBonusVal = atoi(e);
            if (on("LMREXT")) lmrExt = true;
            if (const char* e = getenv("LMREXTCAP")) { int v = atoi(e); if (v >= 0) lmrExtCap = v; }
            if (on("SHUFFLEGUARD")) shuffleGuard = true;
            if (on("QSMOVECAP")) qsMoveCap = true;
            if (const char* e = getenv("QSMOVECAPN")) { int v = atoi(e); if (v >= 1) qsMoveCapN = v; }
            if (on("QSCHECKS")) qsChecks = true;
            if (const char* e = getenv("QSCHECKSN")) { int v = atoi(e); if (v >= 1) qsChecksN = v; }
            if (off("RULE50DAMP")) rule50Damp = false; // shipped default-on; kill-switch
            if (const char* e = getenv("RULE50DAMPDIV")) { int v = atoi(e); if (v > 0) rule50DampDiv = v; }
            if (on("EVALCOMPLEXITY")) evalComplexity = true;
            if (const char* e = getenv("EVALCOMPLEXITYDIV")) { int v = atoi(e); if (v > 0) evalComplexityDiv = v; }
            if (on("NMPTTVETO")) nmpTtVeto = true;
            if (on("SINGTTPV")) singTtPv = true;
            if (const char* e = getenv("SINGTTPVCOEFF")) { int v = atoi(e); if (v >= 0) singTtPvCoeff = v; }
            if (on("RFPQUAD")) rfpQuad = true;
            if (const char* e = getenv("RFPQUADCOEFF")) { int v = atoi(e); if (v >= 0) rfpQuadCoeff = v; }
            if (on("NONLMRRED")) nonLmrRed = true;
            if (const char* e = getenv("NONLMRNOTTR")) { int v = atoi(e); if (v >= 0) nonLmrNoTtR = v; }
            if (const char* e = getenv("NONLMRT1")) { int v = atoi(e); if (v >= 0) nonLmrT1 = v; }
            if (const char* e = getenv("NONLMRT2")) { int v = atoi(e); if (v >= 0) nonLmrT2 = v; }
            if (on("OPTIMISM")) optimism = true;
            if (const char* e = getenv("OPTIMISMSCALE"))   { int v = atoi(e); if (v >= 0) optimismScale = v; }
            if (const char* e = getenv("OPTIMISMSTRETCH")) { int v = atoi(e); if (v >= 1) optimismStretch = v; }
            if (const char* e = getenv("OPTBASE"))         { int v = atoi(e); if (v >= 0) optBase = v; }
            if (const char* e = getenv("OPTMATSCALE"))     { int v = atoi(e); if (v >= 0) optMatScale = v; }
            if (const char* e = getenv("OPTDIV"))          { int v = atoi(e); if (v > 0) optDiv = v; }
            if (on("PIECETOHIST")) pieceToHist = true;
            if (const char* e = getenv("PIECETOWEIGHT")) { int v = atoi(e); if (v >= 0) pieceToWeight = v; }
            if (on("PIECETOLMR")) pieceToLmr = true;
            if (on("CONTHISTBASE")) conthistBase = true;
            if (const char* e = getenv("CONTHISTBASEBUTTERFLYW")) { int v = atoi(e); if (v >= 0) conthistBaseButterflyW = v; }
            if (const char* e = getenv("CONTHISTBASEPIECETOW"))   { int v = atoi(e); if (v >= 0) conthistBasePieceToW   = v; }
            if (const char* e = getenv("CONTHISTBASECONT1W"))     { int v = atoi(e); if (v >= 0) conthistBaseCont1W     = v; }
            if (const char* e = getenv("CONTHISTBASECONT2W"))     { int v = atoi(e); if (v >= 0) conthistBaseCont2W     = v; }
            if (const char* e = getenv("CONTHISTBASECONT4W"))     { int v = atoi(e); if (v >= 0) conthistBaseCont4W     = v; }
            if (const char* e = getenv("CONTHISTBASECONT6W"))     { int v = atoi(e); if (v >= 0) conthistBaseCont6W     = v; }
            if (on("QSTTQUIET")) qsTtQuiet = true;
            if (on("FULLPROBCUT")) fullProbCut = true;
            if (off("SYZYGY")) syzygy = false; // shipped default-on; kill-switch (path-gated by TB::loaded())
            if (off("TBROOTRANK")) tbRootRank = false; // shipped default-on; kill-switch
            if (off("TBWDLSF")) tbWdlSf = false; // shipped default-on; kill-switch (restores the old flat probe)
            if (const char* e = getenv("MOVEOVERHEAD")) { int v = atoi(e); if (v >= 0) moveOverhead = v; }
            if (const char* e = getenv("CONTEMPT")) contempt = atoi(e); // cp; 0 = off
            if (off("TIMEMAN")) timeMan = false; // shipped default-on (+28 Elo TC-SPRT); kill-switch
            if (on("NODEEFFORT")) nodeEffort = true; // opt-in: node-effort/instability TIMEMAN scaling
            if (on("TMFALLING")) tmFalling = true; // opt-in: fallingEval + ply-growth TIMEMAN pieces
            if (on("TTCUTBONUS")) ttCutBonus = true;
            if (off("LMPHIST")) lmpHist = false; // shipped default-on (movetime SPRT positive); kill-switch
            if (const char* e = getenv("LMPHISTDIV")) { int v = atoi(e); if (v > 0) lmpHistDiv = v; }
            if (off("RFPTTHIT")) rfpTtHit = false; // shipped default-on; kill-switch
            if (const char* e = getenv("RFPTTHITCOEFF")) { int v = atoi(e); if (v >= 0) rfpTtHitCoeff = v; }
            if (const char* e = getenv("TTCUTBONUSNUM")) { int v = atoi(e); if (v >= 0) ttCutBonusNum = v; }
            if (const char* e = getenv("TTCUTBONUSDEN")) { int v = atoi(e); if (v >= 1) ttCutBonusDen = v; }
            if (const char* e = getenv("TTCUTMALUSNUM")) { int v = atoi(e); if (v >= 0) ttCutMalusNum = v; }
            if (const char* e = getenv("TTCUTMALUSDEN")) { int v = atoi(e); if (v >= 1) ttCutMalusDen = v; }
            if (on("PCM")) pcm = true;
            if (const char* e = getenv("PCMBASE"))        pcmBase        = atoi(e);
            if (const char* e = getenv("PCMDEPTHW"))       pcmDepthW      = atoi(e);
            if (const char* e = getenv("PCMDEPTHMAX"))     pcmDepthMax    = atoi(e);
            if (const char* e = getenv("PCMPARENTMCW"))    pcmParentMcW   = atoi(e);
            if (const char* e = getenv("PCMSEW"))          pcmSeW         = atoi(e);
            if (const char* e = getenv("PCMPARENTSEW"))    pcmParentSeW   = atoi(e);
            if (const char* e = getenv("PCMSETHRESH"))     pcmSeThresh    = atoi(e);
            if (const char* e = getenv("PCMPARENTSETHR"))  pcmParentSeThr = atoi(e);
            if (const char* e = getenv("PCMDIV"))          { int v = atoi(e); if (v > 0) pcmDiv = v; }
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
            // A4 (2026-07-21, formula audit): SF/SP have no small-depth cap on capture-SEE
            // pruning; zug caps at depth<=4. Env override to test raising/removing it (the
            // margin captSeeCoeff*depth self-limits). Applied last so it wins over GMCONST.
            if (const char* e = getenv("CAPTSEEMAXDEPTH")) { int v = atoi(e); if (v >= 1) captSeeMaxDepth = v; }
        }
    };

    TranspositionTable& tt;   // default_context() binds this to the pre-existing
                               // global `TT` (tt.h); pool contexts own theirs.
    std::atomic<bool>&  stop; // default_context() binds this to the UCI stop
                               // signal (request_stop()); pool contexts own theirs.

    Tune tune;
    int  history[COLOR_NB][64][64] = {};
    Move counterMoves[PIECE_NB][64] = {};
    int  corrHist[COLOR_NB][CORR_SIZE] = {};
    int  corrHistNP[COLOR_NB][COLOR_NB][CORR_SIZE] = {};
    // CorrHist variants (CORRVARIANTS): minor-piece placement table, keyed
    // like corrHist above but by Position::minor_key(); and an own-side
    // continuation table keyed [piece][to] like zug's contHist1/2 planes
    // below. Both read/written only when Tune::corrVariants is on.
    int  corrHistMinor[COLOR_NB][CORR_SIZE] = {};
    int  corrHistCont[CONT_PIECE_NB][SQUARE_NB] = {};
    // CONTHISTSPLIT: leading [inCheck][capture] dims (SF ContinuationHistory[2][2][...]),
    // keyed off the ANCESTOR move that owns the plane (see cont_hist_planes). OFF (default)
    // always indexes [0][0] here, so these are byte-identical to the pre-split single-plane
    // tables in that slice — the [1][*]/[*][1] slices simply stay untouched/zero.
    int16_t contHist1[2][2][CONT_PIECE_NB][SQUARE_NB][CONT_PIECE_NB][SQUARE_NB] = {}; // parent (1-ply)
    int16_t contHist2[2][2][CONT_PIECE_NB][SQUARE_NB][CONT_PIECE_NB][SQUARE_NB] = {}; // grandparent (2-ply)
    // CONTHISTPLIES: deeper plies 3, 4, 6 (SF's ordering-read set minus ply 5 — see
    // Tune::contHistPlies above for the full SF citation). PHASE 2 (2026-07-16): now
    // carry the SAME leading [inCheck][capture] split dims as contHist1/contHist2
    // (SF ContinuationHistory[2][2][PIECE_NB][SQUARE_NB], history.h:150 + search.h:294;
    // indexed at do_move time by the ancestor's OWN inCheck/capture-ness, search.cpp:
    // 563-564) — SF has no unsplit variant of these planes, so this is required for a
    // faithful port, not an optional retrofit. Always allocated (like contHist1/2)
    // regardless of the flag; only read/written when Tune::contHistPlies is on
    // (cont_hist_planes leaves the pointers null otherwise, same guard as before —
    // the added [2][2] dims are simply inert extra zeroed memory on the OFF path).
    // ~4.5 MB each (2*2*12*64*12*64*2 bytes, 4x the phase-1 flat-table size) — see
    // task report for the added-memory total.
    int16_t contHist3[2][2][CONT_PIECE_NB][SQUARE_NB][CONT_PIECE_NB][SQUARE_NB] = {}; // 3-ply
    int16_t contHist4[2][2][CONT_PIECE_NB][SQUARE_NB][CONT_PIECE_NB][SQUARE_NB] = {}; // 4-ply
    int16_t contHist6[2][2][CONT_PIECE_NB][SQUARE_NB][CONT_PIECE_NB][SQUARE_NB] = {}; // 6-ply
    // Capture history (SF CapturePieceToHistory): learned capture-ordering magnitude,
    // keyed [movedPieceDense][to][capturedType]. Read in score_moves' capture branch,
    // updated on beta cutoff (bonus to the cutoff capture, malus to searched-not-best
    // captures). Gated by Tune::captHist. ~10 KB.
    int16_t captHist[CONT_PIECE_NB][SQUARE_NB][PIECE_TYPE_NB] = {};
    // PIECETOHIST (Stormphrax history.h:211 m_pieceTo): standalone [piece][to]
    // quiet-history table — no from-square, no ancestor conditioning (distinct from
    // both C.history[color][from][to] and the ancestor-keyed contHist1/2/3/4/6 planes
    // above). Sized like captHist's leading dims (piece_dense() x to-square), no
    // threat-bit sub-dims. Gated by Tune::pieceToHist; OFF path never reads or writes
    // it (memset-only, in reset_tables below) -> byte-identical. ~1.5 KB.
    int16_t pieceToHist[CONT_PIECE_NB][SQUARE_NB] = {};
    // Low-ply history (SF LowPlyHistory): a second butterfly-shaped table keyed
    // additionally by ss->ply, valid only for ply<5 — near the root, the same
    // from/to pair recurs across ID iterations far more than deep in the tree,
    // so a ply-scoped table gives a sharper ordering signal than the global
    // butterfly table alone. Gated by Tune::lowPlyHist. 5*64*64*4B = ~80 KB.
    int  lowPly[5][64][64] = {};
    // Pawn-structure history (SF PawnHistory): quiet ordering keyed by pawn_key
    // (masked to PAWN_HIST_SIZE) x moving-piece x to-square — captures the idea
    // that a quiet move's value is often pawn-structure-dependent (outposts,
    // levers) in a way the plain butterfly table can't see. Gated by
    // Tune::pawnOrderHist. int16_t[8192][12][64] = ~12.6 MB per Context.
    int16_t pawnOrderHist[8192][CONT_PIECE_NB][64] = {};
    int  Reductions[64][64] = {};

    Limits  limits;
    int64_t timeLimitSoft = 0, timeLimitHard = 0;
    // TIMEMAN: true only for a real clock-mode (wtime/btime) search with time management on,
    // i.e. the one case where start()'s ID loop dynamically scales timeLimitSoft by best-move
    // stability + eval trend. False for movetime/depth/nodes/infinite (soft break stays exact).
    bool    tmScaled = false;
    int     contempt[COLOR_NB] = {0, 0}; // Contempt bias (raw cp) per color, set once at start()
                                          // from Tune::contempt: +C for the root side, -C for the
                                          // opponent, so indexing by pos.side_to_move() flips the
                                          // sign correctly down the negamax tree (Stormphrax).
    int64_t nodeCount = 0;
    int     rootDepthGlobal = 0;
    // Lazy-SMP worker index (0 for the main/UCI/single-thread path; set per worker by
    // run_lazy_smp). SMPDIV=1 staggers each worker's initial aspiration delta by
    // threadIdx%8 so the threads diverge into different parts of the tree (SF
    // search.cpp:355). Default 0 → no diversity → byte-identical when the flag is off.
    int     threadIdx = 0;
    Move    rootBestMove = MOVE_NONE;
    int     rootBestScore = 0;
    // ---- Root move list + MultiPV (SF search.h:85-110, search.cpp:302-441) ----
    // Every legal root move, rebuilt at start() entry and carried across every ID
    // iteration of that one search. Re-sorted (STABLY, descending by score) after
    // each root search so rootMoves[0] is always the current best line — which is
    // exactly what makes rootMoves[pvIdx].pv[0] a drop-in for the old scalar
    // `rootBestMove` as the root ttMove (SF search.cpp:707).
    std::vector<RootMove> rootMoves;
    // Clamped to max(1, min(limits.multiPV, rootMoves.size())) in start(). 1 for
    // every legacy caller -> the pvIdx loop runs exactly once with pvIdx==0, where
    // the root-move filter, the TT-store guard and the per-line window seeding are
    // all provable no-ops, so the searched tree is byte-identical to pre-MultiPV.
    int     multiPV = 1;
    int     pvIdx   = 0;
    // ---- Syzygy root-rank grouping (SF search.cpp:341-350) ----
    // [pvFirst, pvLast) is the contiguous run of rootMoves sharing the CURRENT line's
    // tbRank. Every root sort and the root move filter are confined to it, which is
    // what makes the DTZ rank strictly dominate the search score: a lower-ranked move
    // is never even searched for this line, so it can never become the best move.
    // Recomputed per depth iteration, and per PV line once the previous group is
    // exhausted.
    //
    // BYTE IDENTITY: with no DTZ ranking every tbRank is 0, so the first group is the
    // WHOLE list — pvFirst==0 and pvLast==rootMoves.size() for every line — and all
    // three consumers reduce to exactly the ranges they used before this existed.
    int     pvFirst = 0;
    int     pvLast  = 0;
    // ---- Syzygy root config (SF Tablebases::Config, ~sf18-arm/src/syzygy/tbprobe.h:41) ----
    // rootInTB: the root's moves carry real DTZ ranks and tbScores.
    // tbCardinality: the piece count at or below which the IN-SEARCH WDL probe may fire.
    //   Seeded to TB::max_pieces() (exactly the old hardcoded gate) and zeroed once DTZ
    //   ranking succeeds, mirroring SF tbprobe.cpp:1764-1766. That zeroing is the point:
    //   inside a DTZ-ranked root every child is a TB hit, and WDL's flat ±(VALUE_TB_WIN -
    //   ply) would make every winning move tie, collapsing the search to move ordering.
    //   With it off the search runs on real eval and can actually find the mate, while the
    //   rank grouping guarantees it can only ever choose among moves that keep the win.
    bool    tbRootInTB    = false;
    int     tbCardinality = 0;
    // NODEEFFORT (SF search.cpp:1308/1346/487-508, sf_18): the per-root-move
    // node-count accrual now lives in RootMove::effort (SF's own home for it),
    // replacing the old `unordered_map<Move,int64_t> rootMoveEffort` — same values,
    // same lifetime (accumulates across every completed iteration of ONE start()
    // call, since rootMoves is rebuilt per call), just stored next to the move it
    // belongs to. Still written ONLY when Tune::nodeEffort is on. This counter is
    // the matching this-iteration best-move-change count (SF's Worker::bestMoveChanges),
    // read by start()'s ID loop to scale the TIMEMAN per-iteration soft limit.
    int     rootBestMoveChangesIter = 0;
    // OPTIMISM (backlog #17): root side-to-move + a running EMA of the completed root
    // score across ID iterations, both reset in start() and consumed only by
    // optimism_term()/corrected_eval() when Tune::optimism is on. Harmless (never read,
    // and the ID-loop update is skipped) when the flag is off.
    Color   rootStm = WHITE;
    int     rootAvgScore = 0;
    bool    rootAvgInit = false;
    int     rootDelta = 0; // ROOTDELTALMR: root aspiration window width (beta-alpha), reset
                            // immediately before every root negamax<true> call, including each
                            // aspiration re-search after widening (SF search.cpp:374, inside the
                            // `while (true)` re-search loop, not before it).
    // TTMOVEHIST: SF's ttMoveHistory (search.h:297) — a single running scalar,
    // gravity-updated toward ±8192 (SF's StatsEntry<int16_t,8192> D-clamp). Reset
    // per new-game (reset_tables), same lifetime as history/corrHist below, since
    // that's where SF actually resets it too (Search::Worker::clear(), search.cpp:594
    // — "usually before a new game", not per-iteration).
    int     ttMoveHistory = 0;
    // TMFALLING (a): SF's mainThread->bestPreviousAverageScore (search.h:252,
    // search.cpp:240) — a fast /2 EMA of the root's completed score, carried from the
    // END of one start() call into the START of the next (same cross-search lifetime
    // as ttMoveHistory just above — reset only in reset_tables(), at ucinewgame).
    // VALUE_INFINITE sentinel (matches SF's own "never searched yet" marker,
    // thread.cpp:262): on first use the fallingEval formula naturally saturates to its
    // own ceiling clamp, exactly like SF's, so no special-case branch is needed at the
    // read site. Only ever written/read when Tune::tmFalling is on; harmless dead field
    // otherwise.
    int     bestPreviousAverageScore = VALUE_INFINITE;
    // NMPSF: SF's Worker::nmpMinPly (search.h:335) — the null-move verification
    // recursion guard. 0 = verification not in progress (NMP allowed everywhere);
    // while a verification search is running it holds ss->ply + 3*(depth-R)/4 so
    // nested nodes with ply < nmpMinPly skip NMP (search.cpp Step 9). Only ever
    // touched when tune.nmpSf is on; harmless dead field otherwise.
    int     nmpMinPly = 0;

    NNUE::AccStack accStack; // per-search incremental accumulator (was a
                              // function-local `static` — one shared instance
                              // for ALL searches — before this change; fine
                              // single-threaded but a straight-up data race
                              // once two searches could run concurrently).

    Context(TranspositionTable& ttRef, std::atomic<bool>& stopRef) : tt(ttRef), stop(stopRef) {}
};

// ---- SearchGroup: the unit of Lazy SMP ----
// K worker Contexts, ONE shared TranspositionTable, and ONE shared stop flag.
// Every worker Context is constructed bound to *this* group's tt + stop (so
// all K cooperate through the one table, exactly as the UCI smpContexts bind
// to the global ::TT + smpStop). workerPtrs caches the raw Context* in worker
// order for run_lazy_smp(). Owned by the serve GroupPool (below); defined in
// namespace Search (non-anon) so it matches search.h's `struct SearchGroup`
// forward declaration — callers only ever see it as an opaque handle.
struct SearchGroup {
    std::unique_ptr<TranspositionTable> tt;
    std::unique_ptr<std::atomic<bool>> stop;
    std::vector<std::unique_ptr<Context>> contexts; // K workers (own the storage)
    std::vector<Context*> workerPtrs;               // same K, raw, in worker order
};

namespace {

// Search stack per ply — already local to one search's call tree (allocated
// on start()'s stack frame, threaded through via the `ss` pointer), so this
// needs no isolation of its own.
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
    int   cutoffCnt; // #6: count of beta-cutoffs seen at this node; read one ply up in LMR
    int   reduction; // #8: how much the move leading OUT of this node was LMR-reduced (SF ss->reduction)
    bool  didCapture; // #12: was currentMove a capture? (read one ply down)
    bool  ttPv;       // #5: this node is (or descends from) a PV — gates RFP, de-reduces LMR
    int   moveCount;  // #10 PCM: this node's live move-loop counter, read one ply down
};

// Locate a root move's RootMove entry (SF's `*std::find(rootMoves.begin(),
// rootMoves.end(), move)` at search.cpp:1306). Linear over the legal root moves
// (<=~100, and only ever at ply 0), so the cost is invisible next to a root
// subtree search. Returns nullptr only if `m` is not a root move, which cannot
// happen for a move the root move loop actually tried.
static inline RootMove* find_root_move(Context& C, Move m) {
    for (RootMove& rm : C.rootMoves)
        if (rm.move == m) return &rm;
    return nullptr;
}

// ---- Syzygy root-ranking policy constants ----
//
// TB_ROOT_USE_RULE50 is SF's `Syzygy50MoveRule` UCI option (default true). zug has no such
// option and no reason for one: every game this engine plays — website, UCI, CCRL — is
// played under the 50-move rule, and turning it off would make the ranking claim wins the
// arbiter would score as draws. Named rather than inlined so the one place it is decided
// is findable.
constexpr bool TB_ROOT_USE_RULE50 = true;

// TB_ROOT_RANK_DTZ is SF's `rankDTZ`: does the DTZ distance also order moves INSIDE the
// certain-win band, or do all certain wins rank equally? SF passes false for the search
// (~sf18-arm/src/thread.cpp:313) and true only when extending a finished PV out to mate
// (~sf18-arm/src/search.cpp:2075). zug passes false too, and the reason is worth writing
// down because the obvious objection — "zug's search cannot tell winning moves apart, so
// it needs DTZ to break the tie" — was true before this change and is not true after it.
//
// It was true because WDL-in-search returned a flat ±(VALUE_TB_WIN - ply) for every move
// in a ≤5-man position: the search was blind by construction. Zeroing C.tbCardinality (SF
// tbprobe.cpp:1764-1766, done in start() below) removes exactly that blindness — inside a
// DTZ-ranked root the search now runs on the real NNUE eval and real mate detection, which
// is the same footing SF's search stands on when SF passes false.
//
// And the safety property does not depend on the search at all. A move ranks in the
// certain band only if `dtz + cnt50 <= 99`, i.e. only if the position AFTER it still
// satisfies dtz + rule50 <= 99 — so every move the root filter leaves in play preserves a
// genuine TB_WIN, whichever one the search picks. Progress is forced too: cnt50 rises by
// one every non-zeroing ply while the band's ceiling stays at 99, so the admissible dtz
// falls monotonically and the group empties into a zeroing move (or mate) before the
// halfmove clock can reach 100. false therefore costs nothing in correctness and buys the
// thing SF wants it for: freedom to prefer a mate it can actually see over a line that is
// merely one ply closer to the next capture.
constexpr bool TB_ROOT_RANK_DTZ = false;

// Advance the tbRank group window to cover pvIdx, if the previous group is exhausted
// (SF search.cpp:343-350, verbatim). Called at the top of every PV line.
//
// BYTE IDENTITY: with no DTZ ranking all tbRanks are 0, so the very first call (pvIdx==0,
// pvLast==0) walks pvLast all the way to rootMoves.size() and pvFirst stays 0 — the
// window IS the whole list for every line, exactly the ranges that existed before.
static inline void advance_rank_group(Context& C) {
    if (C.pvIdx != C.pvLast) return;
    int n = static_cast<int>(C.rootMoves.size());
    C.pvFirst = C.pvLast;
    for (C.pvLast++; C.pvLast < n; C.pvLast++)
        if (C.rootMoves[C.pvLast].tbRank != C.rootMoves[C.pvFirst].tbRank) break;
    // Terminal root: rootMoves is EMPTY but the ID loop still runs one root negamax for
    // its mated_in()/VALUE_DRAW return (see start()'s "case 2"). SF returns before this
    // point in that case; zug does not, so clamp rather than hand the sorts an iterator
    // one past a zero-length vector.
    if (C.pvLast > n) C.pvLast = n;
}

// Re-rank the root moves the CURRENT line and every later line IN THIS RANK GROUP may
// still use (SF search.cpp:383, `stable_sort(rootMoves.begin()+pvIdx, rootMoves.begin()+
// pvLast)`). The sort MUST be stable: everything except the new PV (and, at moveCount==1,
// the first move) was just reset to -VALUE_INFINITE, and stability is what preserves last
// iteration's ordering for all of them. The [0, pvIdx) prefix is the already-emitted lines
// and is deliberately frozen; [pvLast, end) is the strictly lower-ranked groups and must
// stay below this one no matter what the search scored them.
static inline void sort_root_moves(Context& C) {
    std::stable_sort(C.rootMoves.begin() + C.pvIdx, C.rootMoves.begin() + C.pvLast);
}

// Re-rank the lines ALREADY EMITTED IN THIS RANK GROUP, [pvFirst, pvIdx], once this
// line's aspiration loop has settled on an exact score (SF search.cpp:424,
// `stable_sort(rootMoves.begin() + pvFirst, rootMoves.begin() + pvIdx + 1)`; pvFirst is
// 0 for every position that is not DTZ-ranked at the root).
//
// This is what keeps the reported lines monotone. Line k is searched with its OWN
// aspiration window, and its exact score can land ABOVE line k-1's — line k-1's
// score came from a search that was still ordering the remaining moves off shallow,
// reduced estimates (root LMR, and zug's DEPTHDROP shrinking depth for later root
// moves), so it under-rates them. Without this sort the line keeps its slot and the
// analysis board renders line 3 as better than line 2. Verified against SF18 on
// r1bq2r1/b4pk1/p1pp1p2/1p2pP2/1P2P1PB/3P4/1PPQ2P1/R3K2R w KQ: SF is strictly
// descending, zug was not, at every DEPTHDROP setting.
//
// BYTE IDENTITY: at multiPV==1 pvIdx is always 0, so this sorts a one-element range
// — a no-op, and the single-PV tree is untouched.
static inline void sort_emitted_lines(Context& C) {
    std::stable_sort(C.rootMoves.begin() + C.pvFirst, C.rootMoves.begin() + C.pvIdx + 1);
}

// SF search.cpp:1019 root filter: is `m` still in play for the CURRENT PV line,
// i.e. in rootMoves[pvIdx..pvLast)? Everything before pvIdx has already been emitted
// as an earlier line and must not be searched again; everything from pvLast on is in a
// STRICTLY LOWER Syzygy rank group and must not be searched for this line at all — that
// exclusion is what makes DTZ dominate, since a move the root loop never tries can never
// raise alpha and become C.rootBestMove.
static inline bool root_move_in_play(Context& C, Move m) {
    return std::count(C.rootMoves.begin() + C.pvIdx, C.rootMoves.begin() + C.pvLast, m) > 0;
}

// Is the root filter capable of excluding anything at all? Only when an earlier line has
// been emitted (pvIdx > 0) or a lower-ranked group exists (pvLast < size).
//
// BYTE IDENTITY: this is the guard that keeps the single-PV, non-TB search free of the
// filter entirely. rootMoves holds EVERY legal root move and pvLast is its size, so at
// pvIdx==0 the count over the whole list is 1 for every move the root loop can reach —
// the filter could not skip anything, and is never even called.
static inline bool root_filter_active(const Context& C) {
    return C.pvIdx != 0 || C.pvLast < static_cast<int>(C.rootMoves.size());
}

// The score to REPORT for one root move (SF search.cpp:2138-2139: `bool tb =
// worker.tbConfig.rootInTB && std::abs(v) <= VALUE_TB; v = tb ? rootMoves[i].tbScore : v`).
//
// This is a PRESENTATION override and nothing else. The search runs on real scores from
// end to end — prevScore, the aspiration seeds, TIMEMAN, OPTIMISM and the root sort all
// keep reading rm.score, unchanged. What changes is only what a caller is told (the UCI
// `info` line, the serve layer's eval object), because inside a DTZ-ranked root the
// tablebase knows the position's true value exactly and the search's own number is an
// eval of something already decided.
//
// A real MATE score survives: SF's `std::abs(v) <= VALUE_TB` guard admits only non-mate
// scores, which in zug's constants (types.h:72-76, VALUE_TB_WIN sits BELOW
// VALUE_MATE_IN_MAX_PLY exactly so TB scores cannot masquerade as mates) is precisely
// !is_mate_score(v). A found forced mate is strictly more information than "tablebase
// win" and must not be overwritten by it.
//
// THE CURSED BAND REPORTS A DRAW (rm->tbCursed — zug DEPARTS from SF here, deliberately).
// tbScore is three different kinds of number depending on which branch of SF's expression
// produced it (tbprobe.cpp:1669-1677, ported verbatim in zug_tb.cpp):
//   * ±VALUE_TB_WIN, a certain win/loss  — the position's true value under the 50-move rule;
//   * VALUE_DRAW                          — the position's true value under the 50-move rule;
//   * the 1..50cp cursed-win / blessed-loss band — NOT a value at all. SF's own comment
//     ("assign at least 1 cp to cursed wins and let it grow to 49 cp as the position gets
//     closer to a real win") describes an ORDERING INCENTIVE. Under the 50-move rule a
//     cursed win IS a draw: that is what "cursed" means.
// So the override is kept in every band — the tablebase is the authority on a ≤5-man root,
// and that does not stop being true when the win is spent — but in the cursed band it
// reports the tablebase's actual verdict, VALUE_DRAW, instead of the incentive. Reporting
// the incentive is what made `8/3k1KPb/8/8/8/5N2/8/8 b - - 98 106` print -47 above a PV
// (Be4 g8=Q Bd5 Kxg8 …) that walks into the 50-move draw and ends in bare KN vs K.
//
// WHY NOT "just report the search score" in this band. Measured, on this exact position:
// -109, then -64 on a re-run. A DTZ-ranked root zeroes C.tbCardinality (SF
// tbprobe.cpp:1764, ported at the ranking call site), which switches the in-search WDL
// probe off for the whole search — so inside a ranked root the search is the one authority
// with NO tablebase knowledge at all, and its number is an NNUE count of a knight it will
// never mate with. That is the +314.96 bug one order of magnitude smaller, and it is not
// even stable across runs. The search is only the better authority where it can see the
// draw, and here it structurally cannot.
//
// A found MATE still outranks all three branches, and is now checked FIRST so that
// precedence holds in the cursed band too. The search is rule50-aware, so a mate it
// reports fits inside the halfmove clock by construction and is strictly more information
// than "drawn by the 50-move rule".
//
// ORDERING IS UNAFFECTED IN EVERY BAND. tbRank still sorts the root and still drives the
// [pvFirst, pvLast) group filter, so the engine keeps preferring the cursed win that
// minimizes dtz + cnt50 — it presses exactly as hard as before, it just no longer claims
// half a pawn for it. This is a reporting change and nothing else.
//
// UCI is included here, unlike the JSON `tb` tag (serve_json.h), which UCI is deliberately
// exempt from. That exemption exists because a GUI has nowhere to put a second field and
// expects the large cp for a verdict; it says nothing about the cursed band, where both
// the old number and the new one are near zero and only one of them is true.
//
// BYTE IDENTITY: returns v untouched whenever the root was not DTZ-ranked.
static inline int reported_score(const Context& C, int v, const RootMove* rm) {
    if (!C.tbRootInTB || rm == nullptr) return v;
    if (v == -VALUE_INFINITE) v = VALUE_ZERO; // SF search.cpp:2135-2136
    if (is_mate_score(v)) return v;
    return rm->tbCursed ? VALUE_DRAW : rm->tbScore;
}

// #13 is_shuffling (SF18 search.cpp:145-152, VERIFIED): a dead 4-ply single-piece
// round-trip in a rule50 shuffle, where singular-extending the ttMove is wasted
// depth. Guards on ply>=20 so (ss-2)/(ss-4) are always valid frames; also rejects
// null-move ancestors (a null currentMove's from/to are meaningless) — SF relies on
// its Move::null()==(0,0) making the square-equality naturally false, zug guards
// explicitly for the same effect.
static inline bool is_shuffling(Move m, Stack* ss, const Position& pos) {
    if (pos.is_capture(m) || pos.rule50_count() < 10) return false;
    if (pos.plies_from_null() <= 6 || ss->ply < 20) return false;
    Move c2 = (ss - 2)->currentMove, c4 = (ss - 4)->currentMove;
    if (c2 == MOVE_NONE || c2 == MOVE_NULL || c4 == MOVE_NONE || c4 == MOVE_NULL) return false;
    return from_sq(m) == to_sq(c2) && from_sq(c2) == to_sq(c4);
}

void build_reductions(Context& C) {
    for (int d = 1; d < 64; ++d)
        for (int m = 1; m < 64; ++m)
            C.Reductions[d][m] = int(C.tune.lmrBase + std::log(d) * std::log(m) / C.tune.lmrDiv);
    C.Reductions[0][0] = C.Reductions[0][1] = C.Reductions[1][0] = 0;
}

void reset_tables(Context& C) {
    std::memset(C.history, 0, sizeof(C.history));
    std::memset(C.counterMoves, 0, sizeof(C.counterMoves));
    std::memset(C.corrHist, 0, sizeof(C.corrHist));
    std::memset(C.corrHistNP, 0, sizeof(C.corrHistNP));
    std::memset(C.corrHistMinor, 0, sizeof(C.corrHistMinor));
    std::memset(C.corrHistCont, 0, sizeof(C.corrHistCont));
    std::memset(C.contHist1, 0, sizeof(C.contHist1));
    std::memset(C.contHist2, 0, sizeof(C.contHist2));
    std::memset(C.contHist3, 0, sizeof(C.contHist3));
    std::memset(C.contHist4, 0, sizeof(C.contHist4));
    std::memset(C.contHist6, 0, sizeof(C.contHist6));
    std::memset(C.captHist, 0, sizeof(C.captHist));
    std::memset(C.pieceToHist, 0, sizeof(C.pieceToHist));
    std::memset(C.lowPly, 0, sizeof(C.lowPly));
    std::memset(C.pawnOrderHist, 0, sizeof(C.pawnOrderHist));
    C.ttMoveHistory = 0;
    C.bestPreviousAverageScore = VALUE_INFINITE; // TMFALLING (a): same reset scope as ttMoveHistory
    C.nmpMinPly = 0;
    C.tt.clear();
}

bool set_tune_option_impl(Context& C, const std::string& name, int value) {
    auto clamp = [](int v, int lo, int hi) { return std::max(lo, std::min(hi, v)); };
    auto& tune = C.tune;
    if      (name == "RfpMargin")      tune.rfpMargin      = clamp(value, 40, 130);
    else if (name == "RazorMargin")    tune.razorMargin    = clamp(value, 100, 350);
    else if (name == "FutBase")        tune.futBase        = clamp(value, 40, 220);
    else if (name == "FutSlope")       tune.futSlope       = clamp(value, 40, 150);
    else if (name == "SeeQuietCoeff")  tune.seeQuietCoeff  = clamp(value, 10, 45);
    else if (name == "CaptSeeCoeff")   tune.captSeeCoeff   = clamp(value, 40, 180);
    else if (name == "NmpEvalDiv")     tune.nmpEvalDiv     = clamp(value, 80, 400);
    else if (name == "SingularMargin") tune.singularMargin = clamp(value, 16, 80);
    else if (name == "CaptHistWeight") tune.captHistWeight = clamp(value, 16, 512);
    // ---- HISTMARGIN constants (only read when histMargin on) ----
    else if (name == "HistPruneCoeff") tune.histPruneCoeff = clamp(value, 1000, 40000);
    else if (name == "HistMarginDiv")  tune.histMarginDiv  = clamp(value, 1000, 40000);
    // ---- LMRCLUSTER fine-term tunables (2026-07-16) ----
    else if (name == "RootDeltaCoeff") tune.rootDeltaCoeff = clamp(value, 200, 1200);
    else if (name == "CorrMarginDiv")  tune.corrMarginDiv  = clamp(value, 10000, 100000);
    else if (name == "AllNodeDiv")     tune.allNodeDiv     = clamp(value, 1, 6);
    else if (name == "DblExtMargin")   tune.dblExtMargin   = clamp(value, 20, 130);
    // ---- CAPFUT constants (2026-07-20, only read when capFut on) ----
    else if (name == "CapFutBase")      tune.capFutBase      = clamp(value, 0, 220);
    else if (name == "CapFutSlope")     tune.capFutSlope     = clamp(value, 20, 200);
    else if (name == "CapFutHistCoeff") tune.capFutHistCoeff = clamp(value, 0, 120);
    // ---- HISTDECAY constants (2026-07-20, only read when histDecay on) ----
    else if (name == "HistDecayNum") tune.histDecayNum = clamp(value, 1, 32);
    else if (name == "HistDecayDen") tune.histDecayDen = clamp(value, 2, 64);
    // ---- CUTOFFGRADE constants (2026-07-20, only read when cutoffGrade on) ----
    else if (name == "CutoffGradeBase") tune.cutoffGradeBase = clamp(value, 0, 2048);
    else if (name == "CutoffGradeStep") tune.cutoffGradeStep = clamp(value, 0, 2048);
    // ---- POSTLMRCH constant (2026-07-20, only read when postLmrCh on) ----
    else if (name == "PostLmrChBonus") tune.postLmrChBonus = clamp(value, 0, 400);
    // ---- CHECKORDER constants (2026-07-20, only read when checkOrder on) ----
    else if (name == "CheckOrderBonus")     tune.checkOrderBonus     = clamp(value, 0, 20000);
    else if (name == "CheckOrderSeeMargin") tune.checkOrderSeeMargin = clamp(value, -100, 0);
    // ---- HISTTAPER / HISTTTBONUS constants (2026-07-20) ----
    else if (name == "HistTaperK")     tune.histTaperK     = clamp(value, 0, 32);
    else if (name == "HistTtBonusVal") tune.histTtBonusVal = clamp(value, 0, 400);
    else if (name == "LmrExtCap")      tune.lmrExtCap      = clamp(value, 0, 4);
    // ---- PCM constants (2026-07-20, only read when pcm on) ----
    else if (name == "PcmBase")        tune.pcmBase        = clamp(value, -1024, 1024);
    else if (name == "PcmDepthW")      tune.pcmDepthW      = clamp(value, 0, 768);
    else if (name == "PcmDepthMax")    tune.pcmDepthMax    = clamp(value, 2048, 8192);
    else if (name == "PcmParentMcW")   tune.pcmParentMcW   = clamp(value, 0, 2048);
    else if (name == "PcmSeW")         tune.pcmSeW         = clamp(value, 0, 2048);
    else if (name == "PcmParentSeW")   tune.pcmParentSeW   = clamp(value, 0, 2048);
    else if (name == "PcmSeThresh")    tune.pcmSeThresh    = clamp(value, 40, 240);
    else if (name == "PcmParentSeThr") tune.pcmParentSeThr = clamp(value, 40, 240);
    else if (name == "PcmDiv")         tune.pcmDiv         = clamp(value, 512, 16384);
    else if (name == "QsMoveCapN")     tune.qsMoveCapN     = clamp(value, 1, 8);
    else if (name == "Rule50DampDiv")  tune.rule50DampDiv  = clamp(value, 80, 400);
    else if (name == "EvalComplexityDiv") tune.evalComplexityDiv = clamp(value, 400, 20000);
    else if (name == "MoveOverhead")   tune.moveOverhead   = clamp(value, 0, 5000);
    else if (name == "Contempt")       tune.contempt       = clamp(value, -1000, 1000);
    else if (name == "TtCutBonusNum")  tune.ttCutBonusNum  = clamp(value, 0, 8);
    else if (name == "TtCutBonusDen")  tune.ttCutBonusDen  = clamp(value, 1, 8);
    else if (name == "TtCutMalusNum")  tune.ttCutMalusNum  = clamp(value, 0, 8);
    else if (name == "TtCutMalusDen")  tune.ttCutMalusDen  = clamp(value, 1, 8);
    else if (name == "LmpHistDiv")     tune.lmpHistDiv     = clamp(value, 500, 40000);
    else if (name == "RfpTtHitCoeff")  tune.rfpTtHitCoeff  = clamp(value, 0, 60);
    else if (name == "SingCorrDiv")    tune.singCorrDiv    = clamp(value, 40000, 800000);
    else if (name == "FutNoMoveBonus") tune.futNoMoveBonus = clamp(value, 0, 200);
    else if (name == "FutAlphaBonus")  tune.futAlphaBonus  = clamp(value, 0, 200);
    else if (name == "TtPvFailLowR")   tune.ttPvFailLowR   = clamp(value, 0, 2048);
    // TTPVRICH coefficients (only read when env/opt TTPVRICH=1) — conditioned ttPv LMR
    // de-reduction; x1024 = plies. Ranges bracket zug's current 1024 up toward SF's magnitudes.
    else if (name == "TtPvBase")       tune.ttPvBase       = clamp(value, 0, 3072);
    else if (name == "TtPvPvW")        tune.ttPvPvW        = clamp(value, 0, 1536);
    else if (name == "TtPvPromW")      tune.ttPvPromW      = clamp(value, 0, 1536);
    else if (name == "TtPvDeepW")      tune.ttPvDeepW      = clamp(value, 0, 1536);
    else if (name == "TtPvDeepCutW")   tune.ttPvDeepCutW   = clamp(value, 0, 1536);
    // ---- SINGTTPV / RFPQUAD / NONLMRRED / OPTIMISM constants (2026-07-23, sf-sp-search-
    // backlog.md #14/#20/#12/#17) — only read when the owning flag is on. ----
    else if (name == "SingTtPvCoeff")  tune.singTtPvCoeff  = clamp(value, 0, 200);
    else if (name == "RfpQuadCoeff")   tune.rfpQuadCoeff   = clamp(value, 0, 30);
    else if (name == "NonLmrNoTtR")    tune.nonLmrNoTtR    = clamp(value, 0, 4096);
    else if (name == "NonLmrT1")       tune.nonLmrT1       = clamp(value, 0, 12288);
    else if (name == "NonLmrT2")       tune.nonLmrT2       = clamp(value, 0, 12288);
    else if (name == "OptimismScale")    tune.optimismScale    = clamp(value, 0, 400);
    else if (name == "OptimismStretch")  tune.optimismStretch  = clamp(value, 1, 400);
    else if (name == "OptBase")          tune.optBase          = clamp(value, 0, 400);
    else if (name == "OptMatScale")      tune.optMatScale      = clamp(value, 0, 200);
    else if (name == "OptDiv")           tune.optDiv           = clamp(value, 100, 4000);
    // ---- PIECETOHIST / CONTHISTBASE constants (2026-07-24, only read when the owning
    // flag is on) — Stormphrax history.h pieceTo/conthist-base blend weights. ----
    else if (name == "PieceToWeight")          tune.pieceToWeight          = clamp(value, 0, 2048);
    else if (name == "ConthistBaseButterflyW") tune.conthistBaseButterflyW = clamp(value, 0, 4096);
    else if (name == "ConthistBasePieceToW")   tune.conthistBasePieceToW   = clamp(value, 0, 4096);
    else if (name == "ConthistBaseCont1W")     tune.conthistBaseCont1W     = clamp(value, 0, 4096);
    else if (name == "ConthistBaseCont2W")     tune.conthistBaseCont2W     = clamp(value, 0, 4096);
    else if (name == "ConthistBaseCont4W")     tune.conthistBaseCont4W     = clamp(value, 0, 4096);
    else if (name == "ConthistBaseCont6W")     tune.conthistBaseCont6W     = clamp(value, 0, 4096);
    // LmrBase/LmrDiv: wire value is the double x LMR_DOUBLE_SCALE (search.h) — see the
    // Tune::lmrBase/lmrDiv comment. Clamp in wire units, convert on the way in.
    else if (name == "LmrBase")        tune.lmrBase        = clamp(value, 3000, 15000) / double(LMR_DOUBLE_SCALE);
    else if (name == "LmrDiv")         tune.lmrDiv         = clamp(value, 15000, 40000) / double(LMR_DOUBLE_SCALE);
    else return false;
    return true;
}

// SF's history-gravity update (history.h StatsEntry::operator<<): nudge the
// entry toward `bonus`, decaying proportionally so it never leaves ±CORR_LIMIT.
void corrhist_update_entry(int& e, int bonus) {
    bonus = std::max(-CORR_LIMIT, std::min(CORR_LIMIT, bonus));
    e += bonus - e * std::abs(bonus) / CORR_LIMIT;
}

// TTMOVEHIST: same gravity idiom as corrhist_update_entry, but toward SF's
// ttMoveHistory D-clamp (8192, StatsEntry<int16_t,8192>) instead of CORR_LIMIT.
// zug's stat is a plain int (no int16 overflow risk), so no extra clamp needed.
constexpr int TTMOVEHIST_D = 8192;
void ttmovehist_update(int& e, int bonus) {
    bonus = std::max(-TTMOVEHIST_D, std::min(TTMOVEHIST_D, bonus));
    e += bonus - e * std::abs(bonus) / TTMOVEHIST_D;
}

// CORRVARIANTS: own-side continuation-corrhist term (SF's cntcv) — sum of
// corrHistCont at ss-2 and ss-4 (two of MY OWN previous moves; ply parity
// means ss-2/ss-4 share side-to-move with ss), keyed [piece][to] exactly
// like zug's contHist1/contHist2 planes (cont_hist_planes above). Falls back
// to CORR_CONT_FALLBACK, matching SF's cntcv fallback, when either tap isn't
// a real move (near the root, or a null move sits within the last 4 plies).
inline int corr_hist_cont_term(const Context& C, const Stack* ss) {
    const Stack* p2 = ss - 2;
    const Stack* p4 = ss - 4;
    bool valid2 = ss->ply >= 2 && p2->currentMove != MOVE_NONE && p2->currentMove != MOVE_NULL;
    bool valid4 = ss->ply >= 4 && p4->currentMove != MOVE_NONE && p4->currentMove != MOVE_NULL;
    if (!valid2 || !valid4) return CORR_CONT_FALLBACK;
    return C.corrHistCont[piece_dense(p2->currentPiece)][to_sq(p2->currentMove)]
         + C.corrHistCont[piece_dense(p4->currentPiece)][to_sq(p4->currentMove)];
}

// Weighted, blended correction (centipawns, side-to-move-relative) — SF's
// correction_value(): pawn + white-nonpawn + black-nonpawn always; minor-piece
// + own-side continuation ADDITIONALLY when Tune::corrVariants is on (OFF is
// byte-identical to the pre-CORRVARIANTS sum — no new table read at all).
int correction(const Context& C, const Position& pos, const Stack* ss) {
    Color stm = pos.side_to_move();
    int pcv   = C.corrHist[stm][pos.pawn_key() & CORR_MASK];
    int wnpcv = C.corrHistNP[stm][WHITE][pos.non_pawn_key(WHITE) & CORR_MASK];
    int bnpcv = C.corrHistNP[stm][BLACK][pos.non_pawn_key(BLACK) & CORR_MASK];
    long long cv = (long long)CORR_W_PAWN * pcv + (long long)CORR_W_NONPAWN * (wnpcv + bnpcv);
    if (C.tune.corrVariants) {
        int mcv   = C.corrHistMinor[stm][pos.minor_key() & CORR_MASK];
        int cntcv = corr_hist_cont_term(C, ss);
        cv += (long long)CORR_W_MINOR * mcv + (long long)CORR_W_CONT * cntcv;
    }
    return int(cv / CORR_APPLY_SHIFT);
}

// Raw (pre-shift) blended correction sum — unit-identical to SF's
// correctionValue (same weights, same CORR_APPLY_SHIFT denominator SF calls
// CorrectionHistoryScale), used by CORRMARGIN as an uncertainty discount fed
// directly into margins (SF search.cpp futility_margin and the LMR
// reduction), rather than through correction()'s already-shifted cp.
long long correction_raw(const Context& C, const Position& pos, const Stack* ss) {
    Color stm = pos.side_to_move();
    int pcv   = C.corrHist[stm][pos.pawn_key() & CORR_MASK];
    int wnpcv = C.corrHistNP[stm][WHITE][pos.non_pawn_key(WHITE) & CORR_MASK];
    int bnpcv = C.corrHistNP[stm][BLACK][pos.non_pawn_key(BLACK) & CORR_MASK];
    long long cv = (long long)CORR_W_PAWN * pcv + (long long)CORR_W_NONPAWN * (wnpcv + bnpcv);
    if (C.tune.corrVariants) {
        int mcv   = C.corrHistMinor[stm][pos.minor_key() & CORR_MASK];
        int cntcv = corr_hist_cont_term(C, ss);
        cv += (long long)CORR_W_MINOR * mcv + (long long)CORR_W_CONT * cntcv;
    }
    return cv;
}

// OPTIMISM (backlog #17, Stormphrax search.cpp:463-468 + eval/eval.cpp:32-67): a small
// per-side non-pawn-material figure feeding the material-proportional half of the
// optimism blend (SP's npMat). Values mirror the PieceVal[7] table defined later in this
// file (search.cpp: N=320,B=330,R=500,Q=900) — duplicated here as a tiny local helper so
// optimism_term can sit next to corrected_eval, ahead of PieceVal's own declaration.
static inline int optimism_non_pawn_material(const Position& pos, Color c) {
    return 320 * pos.count(c, KNIGHT) + 330 * pos.count(c, BISHOP)
         + 500 * pos.count(c, ROOK)   + 900 * pos.count(c, QUEEN);
}

// SP's saturating single-scalar optimism, additively blended: `optimism =
// optimismScale*avg/(|avg|+optimismStretch)` (avg = C.rootAvgScore, a running EMA of the
// completed root score across ID iterations — see the ID loop's update, only maintained
// when Tune::optimism is on), then `term = optimism*(optBase + npMat*optMatScale/1024) /
// optDiv`, signed + for the root side to move, - for the opponent (SP: +side-to-move at
// the root / -other). Only called from corrected_eval when Tune::optimism is on.
int optimism_term(const Context& C, const Position& pos) {
    int avg = C.rootAvgScore;
    if (avg == 0) return 0;
    int optimism = C.tune.optimismScale * avg / (std::abs(avg) + C.tune.optimismStretch);
    Color us = pos.side_to_move();
    int npMat = optimism_non_pawn_material(pos, us);
    int factor = C.tune.optBase + npMat * C.tune.optMatScale / 1024;
    int term = optimism * factor / C.tune.optDiv;
    return (us == C.rootStm) ? term : -term;
}

// Applies the learned correction to a raw static eval and clamps well clear of
// mate scores (SF's to_corrected_static_eval). With CorrHist off, returns
// rawEval untouched — CORRHIST=0 must reproduce the pre-CorrHist search exactly.
// NOTE: OPTIMISM (below) is applied inside this same corrHist-gated block — like
// RULE50DAMP above it, it is a no-op whenever CorrHist is off (an existing, documented
// interaction of this function's early-return shape, not a new gap).
int corrected_eval(const Context& C, const Position& pos, const Stack* ss, int rawEval) {
    if (!C.tune.corrHist) return rawEval;
    int corr = correction(C, pos, ss);
    int v = rawEval + corr;
    // EVALCOMPLEXITY (see Tune::evalComplexity): distrust the static read when the corrhist
    // residual is large — shrink v toward 0 by |corr| (proxy for SF's nnueComplexity). Off
    // -> no change (v == rawEval + correction(...), byte-identical to before this edit).
    if (C.tune.evalComplexity) v -= v * std::abs(corr) / C.tune.evalComplexityDiv;
    // #3 RULE50DAMP (see Tune::rule50Damp): shrink eval as the shuffle counter climbs.
    if (C.tune.rule50Damp) v -= v * pos.rule50_count() / C.tune.rule50DampDiv;
    // OPTIMISM: off -> optimism_term is never called, byte-identical.
    if (C.tune.optimism) v += optimism_term(C, pos);
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
void update_corrhist(Context& C, const Position& pos, const Stack* ss, int staticEval, int bestValue, int depth, Move bestMove) {
    if (!C.tune.corrHist) return;
    if (bestMove != MOVE_NONE && pos.is_capture(bestMove)) return;
    if ((bestValue > staticEval) != (bestMove != MOVE_NONE)) return;
    int bonus = (bestValue - staticEval) * depth / (bestMove != MOVE_NONE ? 10 : 8);
    bonus = std::max(-CORR_LIMIT / 4, std::min(CORR_LIMIT / 4, bonus));
    Color stm = pos.side_to_move();
    corrhist_update_entry(C.corrHist[stm][pos.pawn_key() & CORR_MASK], bonus);
    int npBonus = bonus * CORR_NONPAWN_UPDATE_NUM / CORR_NONPAWN_UPDATE_DEN;
    corrhist_update_entry(C.corrHistNP[stm][WHITE][pos.non_pawn_key(WHITE) & CORR_MASK], npBonus);
    corrhist_update_entry(C.corrHistNP[stm][BLACK][pos.non_pawn_key(BLACK) & CORR_MASK], npBonus);
    if (C.tune.corrVariants) {
        int minorBonus = bonus * CORR_MINOR_UP_NUM / CORR_VARIANT_UP_DEN;
        corrhist_update_entry(C.corrHistMinor[stm][pos.minor_key() & CORR_MASK], minorBonus);
        // Continuation taps: update the SAME ss-2/ss-4 planes the read above
        // consults, keyed by that ply's own [piece][to] (not gated on the
        // read's "both taps valid" check — SF updates each tap independently
        // whenever the move at that ply was real).
        if (ss->ply >= 2) {
            const Stack* p2 = ss - 2;
            if (p2->currentMove != MOVE_NONE && p2->currentMove != MOVE_NULL) {
                int nearBonus = bonus * CORR_CONT_NEAR_NUM / CORR_VARIANT_UP_DEN;
                corrhist_update_entry(C.corrHistCont[piece_dense(p2->currentPiece)][to_sq(p2->currentMove)], nearBonus);
            }
        }
        if (ss->ply >= 4) {
            const Stack* p4 = ss - 4;
            if (p4->currentMove != MOVE_NONE && p4->currentMove != MOVE_NULL) {
                int farBonus = bonus * CORR_CONT_FAR_NUM / CORR_VARIANT_UP_DEN;
                corrhist_update_entry(C.corrHistCont[piece_dense(p4->currentPiece)][to_sq(p4->currentMove)], farBonus);
            }
        }
    }
}

int64_t elapsed(const Context& C) { return now_ms() - C.limits.startTime; }

void check_time(Context& C) {
    if (C.limits.infinite) return;
    if (ponderFlag.load(std::memory_order_relaxed)) return; // never stop while pondering (SF search.cpp:1961)
    if (C.limits.nodes && C.nodeCount >= C.limits.nodes) C.stop = true;
    if (C.timeLimitHard && elapsed(C) >= C.timeLimitHard) C.stop = true;
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
// CONTHISTPLIES: also hoist the ss-3/ss-4/ss-6 plane pointers (SF's ordering-read
// set minus ply 5 — see Tune::contHistPlies for the SF citation). Only computed
// when the flag is on; otherwise ch3/ch4/ch6 stay nullptr, so every downstream
// read/update site (guarded by `if (chN)`) is a no-op, exactly like a missing
// ancestor at ply 1/2 already is. PHASE 2 (2026-07-16): these three now carry the
// SAME [inCheck][capture] split as ch1/ch2 (contHist3/4/6 grew the [2][2] leading
// dims — see the Context declarations above) — SF indexes every read plane
// (1,2,3,4,6) through one split array, so a faithful "deeper plies" port must
// split them too. `splitOn` below is shared by ch1..ch6: contHistPlies=1 turns
// the split on for ALL SIX planes in one shot (independent of contHistSplit),
// so CONTHISTPLIES alone gives the complete SF-faithful port; contHistSplit
// remains available standalone for an isolated 1/2-only split A/B.
inline void cont_hist_planes(Context& C, const Stack* ss, int16_t*& ch1, int16_t*& ch2,
                              int16_t*& ch3, int16_t*& ch4, int16_t*& ch6) {
    ch1 = ch2 = nullptr;
    ch3 = ch4 = ch6 = nullptr;
    // CONTHISTSPLIT / CONTHISTPLIES: [inCheck][capture] of the plane-owning ancestor
    // move itself — p->inCheck is whether p (the node that MADE the move) was in
    // check, p->didCapture is whether that move was a capture (both set at
    // move-make time, search.cpp ~1051/1468; mirrors SF's ss->inCheck/capture
    // captured at do_move — search.cpp:563-564). Neither flag set -> forces [0][0],
    // matching the pre-split single-plane table exactly.
    bool splitOn = C.tune.contHistSplit || C.tune.contHistPlies;
    if (ss->ply >= 1) {
        const Stack* p = ss - 1;
        if (p->currentMove != MOVE_NONE && p->currentMove != MOVE_NULL) {
            int ic  = (splitOn && p->inCheck) ? 1 : 0;
            int cap = (splitOn && p->didCapture) ? 1 : 0;
            ch1 = &C.contHist1[ic][cap][piece_dense(p->currentPiece)][to_sq(p->currentMove)][0][0];
        }
    }
    if (ss->ply >= 2) {
        const Stack* p = ss - 2;
        if (p->currentMove != MOVE_NONE && p->currentMove != MOVE_NULL) {
            int ic  = (splitOn && p->inCheck) ? 1 : 0;
            int cap = (splitOn && p->didCapture) ? 1 : 0;
            ch2 = &C.contHist2[ic][cap][piece_dense(p->currentPiece)][to_sq(p->currentMove)][0][0];
        }
    }
    if (!C.tune.contHistPlies) return;
    // contHistPlies is on here (early-returned above otherwise), so splitOn is
    // unconditionally true for these three planes too — same [inCheck][capture]
    // selection as ch1/ch2, just spelled directly since the guard is already known.
    if (ss->ply >= 3) {
        const Stack* p = ss - 3;
        if (p->currentMove != MOVE_NONE && p->currentMove != MOVE_NULL) {
            int ic  = p->inCheck ? 1 : 0;
            int cap = p->didCapture ? 1 : 0;
            ch3 = &C.contHist3[ic][cap][piece_dense(p->currentPiece)][to_sq(p->currentMove)][0][0];
        }
    }
    if (ss->ply >= 4) {
        const Stack* p = ss - 4;
        if (p->currentMove != MOVE_NONE && p->currentMove != MOVE_NULL) {
            int ic  = p->inCheck ? 1 : 0;
            int cap = p->didCapture ? 1 : 0;
            ch4 = &C.contHist4[ic][cap][piece_dense(p->currentPiece)][to_sq(p->currentMove)][0][0];
        }
    }
    if (ss->ply >= 6) {
        const Stack* p = ss - 6;
        if (p->currentMove != MOVE_NONE && p->currentMove != MOVE_NULL) {
            int ic  = p->inCheck ? 1 : 0;
            int cap = p->didCapture ? 1 : 0;
            ch6 = &C.contHist6[ic][cap][piece_dense(p->currentPiece)][to_sq(p->currentMove)][0][0];
        }
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
// HIST_NONE marks an ExtMove whose LMR history sum was NOT cached during ordering
// (ttMove/killer/counter/capture) — the LMR read recomputes for those. Out of the
// legitimate butterfly+conthist range (~±48k), so it can never collide with a real sum.
constexpr int HIST_NONE = -1000000000;

template <bool WithContHist>
void score_moves_impl(Context& C, const Position& pos, ExtMove* begin, ExtMove* end, Move ttMove,
                       const Stack* ss, Move counter, const int16_t* ch1, const int16_t* ch2,
                       const int16_t* ch3, const int16_t* ch4, const int16_t* ch6,
                       U64 tPawn, U64 tMinor, U64 tRook) {
    Color us = pos.side_to_move();
    // LOWPLYHIST hoist: ss->ply (hence the flag/ply gate, the C.lowPly[ss->ply]
    // plane, and the 1+ss->ply divisor) is constant across every move scored at
    // this node — score_moves_impl is one call per node. Do the gate + plane
    // pointer + divisor ONCE here, not per move. lpPlane == nullptr <=> the
    // per-move code below adds nothing, collapsing to the exact original
    // condition `C.tune.lowPlyHist && ss->ply < 5`.
    const int (*lpPlane)[64] = nullptr;
    int lpDen = 0;
    if (C.tune.lowPlyHist && ss->ply < 5) {
        lpPlane = C.lowPly[ss->ply];
        lpDen = 1 + ss->ply;
    }
    for (ExtMove* m = begin; m != end; ++m) {
        Move mv = m->move;
        // Default: not cached. Overwritten below only for general quiets (the else
        // branch). Under if constexpr so the WithContHist=false instantiation is
        // byte-for-byte unchanged.
        if constexpr (WithContHist) m->histScore = HIST_NONE;
        if (mv == ttMove) { m->score = TT_SCORE; continue; }
        MoveType mt = type_of_move(mv);
        bool cap = pos.is_capture(mv);
        if (cap || mt == PROMOTION) {
            PieceType victim = (mt == EN_PASSANT) ? PAWN : type_of(pos.piece_on(to_sq(mv)));
            PieceType attacker = type_of(pos.moved_piece(mv));
            int mvvlva = PieceVal[victim] * 16 - PieceVal[attacker];
            if (mt == PROMOTION) mvvlva += PieceVal[promotion_type(mv)] * 16;
            // Capture history: learned ordering within the good/bad-capture bucket. Read
            // at captHistWeight/256 (default 128 = half weight; house gravity trends to
            // ±16k, so /2 keeps it under a queen's MVV term ~14k → MVV stays primary for
            // big captures, history breaks ties / reorders similar-value captures, SF's
            // balance). SPSA-tunable. Real captures (`cap`) only, not non-capture
            // promotions. Well inside the ±(1<<22) bucket gap even at the max weight.
            if (C.tune.captHist && cap)
                mvvlva += C.captHist[piece_dense(pos.moved_piece(mv))][to_sq(mv)][victim]
                          * C.tune.captHistWeight / 256;
            // ADAPTCAPSEE (SF movepick.cpp:236): good/bad-capture split threshold scales
            // with the capture's own value (mvvlva incl. captHist) — a big/high-history
            // capture may lose more SEE and still sort as "good" (speculative sac), a small
            // one very little. zug default is a flat -50. Ordering only, no pruning change.
            // Default off (env ADAPTCAPSEE=1); off-path byte-identical.
            bool good = C.tune.adaptCapSee
                ? pos.see_ge(mv, -std::max(mvvlva / C.tune.capSeeDiv, 20))
                : pos.see_ge(mv, -50);
            m->score = (good ? GOOD_CAP_SCORE : BAD_CAP_SCORE) + mvvlva;
        } else if (mv == ss->killers[0]) {
            m->score = KILLER1_SCORE;
        } else if (mv == ss->killers[1]) {
            m->score = KILLER2_SCORE;
        } else if (mv == counter) {
            m->score = COUNTER_SCORE;
        } else {
            int h = C.history[us][from_sq(mv)][to_sq(mv)];
            // PIECETOHIST: independent of WithContHist — Tune::pieceToHist is a
            // separate flag from Tune::contHist, so this must apply whichever
            // score_moves_impl instantiation runs (score_moves or score_moves_cont).
            // Default off -> byte-identical (the read/multiply is simply skipped).
            if (C.tune.pieceToHist)
                h += C.pieceToHist[piece_dense(pos.moved_piece(mv))][to_sq(mv)] * C.tune.pieceToWeight / 256;
            if constexpr (WithContHist) {
                int off = piece_dense(pos.moved_piece(mv)) * SQUARE_NB + to_sq(mv);
                if (ch1) h += ch1[off];
                if (ch2) h += ch2[off];
                // CONTHISTPLIES: ch3/ch4/ch6 are only non-null when Tune::contHistPlies
                // is on (cont_hist_planes), so this is a no-op on the default-off path.
                if (ch3) h += ch3[off];
                if (ch4) h += ch4[off];
                if (ch6) h += ch6[off];
                m->histScore = h; // cache butterfly+conthist (== the LMR read) before threat bonus
            }
            if (tPawn | tMinor | tRook) {
                PieceType pt = type_of(pos.moved_piece(mv));
                U64 lesser = (pt == QUEEN) ? tRook
                           : (pt == ROOK)  ? tMinor
                           : (pt == KNIGHT || pt == BISHOP) ? tPawn : 0ULL;
                if (lesser) {
                    if (lesser & (1ULL << from_sq(mv))) h += PieceVal[pt] * 8; // escaping a lesser attacker
                    if (lesser & (1ULL << to_sq(mv)))   h -= PieceVal[pt] * 8; // walking into one
                }
            }
            // LOWPLYHIST (SF LowPlyHistory): extra ordering weight for the same
            // from/to pair recurring near the root (ply<5). SF reads
            // 8*table[ply][m.raw()]/(1+ply); zug's butterfly read is unweighted
            // (no outer /256-ish scale like SF's statScore), so we apply half of
            // SF's numerator (4, not 8) to land in a comparable magnitude band.
            // Per-move cost is now just a hoisted-pointer read (lpPlane, set up
            // once per node above) plus a switch on lpDen (also node-invariant —
            // same case every iteration, so the branch predictor nails it after
            // the first move and it never mispredicts within a node). Each case's
            // divisor is a compile-time LITERAL, so the compiler emits a shift
            // (1,2,4) or an exact magic-multiply (3,5) with correct C++
            // truncating-toward-zero semantics for negative x — no runtime idiv,
            // byte-identical to the original `4*x/(1+ss->ply)` for every x.
            if (lpPlane) {
                int x = lpPlane[from_sq(mv)][to_sq(mv)];
                switch (lpDen) {
                    case 1: h += 4 * x / 1; break;
                    case 2: h += 4 * x / 2; break;
                    case 3: h += 4 * x / 3; break;
                    case 4: h += 4 * x / 4; break;
                    case 5: h += 4 * x / 5; break;
                }
            }
            // PAWNORDHIST (SF PawnHistory): pawn-structure-keyed quiet ordering,
            // unweighted (matches zug's unweighted butterfly read).
            if (C.tune.pawnOrderHist)
                h += C.pawnOrderHist[pos.pawn_key() & 8191][piece_dense(pos.moved_piece(mv))][to_sq(mv)];
            // CHECKORDER (SF movepick.cpp:170, sf-sp-search-backlog.md #6): bonus
            // for a quiet move that gives check and doesn't lose material outright
            // (light SEE test). pos.gives_check(mv) is a real (not cheap-bitboard)
            // check test — see Tune::checkOrder for the SF-vs-zug cost note. Ordering
            // only, no pruning change. Default off; env CHECKORDER=1.
            if (C.tune.checkOrder && pos.gives_check(mv) && pos.see_ge(mv, C.tune.checkOrderSeeMargin))
                h += C.tune.checkOrderBonus;
            m->score = h;
        }
    }
}

inline void score_moves(Context& C, const Position& pos, ExtMove* begin, ExtMove* end, Move ttMove,
                        const Stack* ss, Move counter, U64 tPawn, U64 tMinor, U64 tRook) {
    score_moves_impl<false>(C, pos, begin, end, ttMove, ss, counter, nullptr, nullptr,
                             nullptr, nullptr, nullptr, tPawn, tMinor, tRook);
}

inline void score_moves_cont(Context& C, const Position& pos, ExtMove* begin, ExtMove* end, Move ttMove,
                             const Stack* ss, Move counter, const int16_t* ch1, const int16_t* ch2,
                             const int16_t* ch3, const int16_t* ch4, const int16_t* ch6,
                             U64 tPawn, U64 tMinor, U64 tRook) {
    score_moves_impl<true>(C, pos, begin, end, ttMove, ss, counter, ch1, ch2, ch3, ch4, ch6,
                            tPawn, tMinor, tRook);
}

// Selection sort: move best remaining to front, return it
Move pick_next(ExtMove*& current, ExtMove* end) {
    ExtMove* best = current;
    for (ExtMove* m = current + 1; m != end; ++m)
        if (m->score > best->score) best = m;
    std::swap(*best, *current);
    return (current++)->move;
}

void update_history(Context& C, Color us, Move m, int bonus) {
    int& h = C.history[us][from_sq(m)][to_sq(m)];
    bonus = std::max(-400, std::min(400, bonus));
    h += 32 * bonus - h * std::abs(bonus) / 512;
}

// HISTDECAY (sf-sp-search-backlog.md #2; see Tune::histDecay for the full
// rationale + verified port-fidelity note): sweep the ENTIRE main butterfly
// history[] table toward 0, called exactly ONCE per start() call (before the
// ID loop begins -- see the call site in start()) when C.tune.histDecay is
// on. This ages whatever this Context's history[] carried over from its
// previous search (the previous move in the same game), matching SF18
// (search.cpp:316-319) and Stormphrax (search.cpp:418 `history.age()`) both
// in cadence (once per search, not per depth) and in scope (main/butterfly
// history only -- conthist/capthist/corrhist untouched, same as both
// references). Pure geometric decay (num/den); integer division truncates
// toward zero so repeated application converges to exactly 0 rather than
// oscillating or getting stuck off-zero.
void decay_history_table(Context& C) {
    const int num = C.tune.histDecayNum, den = C.tune.histDecayDen;
    for (int c = 0; c < COLOR_NB; ++c)
        for (int f = 0; f < 64; ++f)
            for (int t = 0; t < 64; ++t) {
                int& h = C.history[c][f][t];
                h = (h * num) / den;
            }
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

// CONTHISTBASE (see Tune::conthistBase): same formula as update_cont_entry, except
// the gravity DECAY term reads an externally-supplied `base` (a cross-table blend)
// instead of the entry's own stored value h — Stormphrax's updateWithBase vs update
// (history.h:54-60). Structurally identical to update_cont_entry otherwise (same
// ±400 bonus clamp, same 32*bonus nudge, same ±32000 backstop clamp).
void update_cont_entry_based(int16_t& h, int bonus, int base) {
    bonus = std::max(-400, std::min(400, bonus));
    int v = int(h) + 32 * bonus - base * std::abs(bonus) / 512;
    v = std::max(-32000, std::min(32000, v));
    h = int16_t(v);
}

// update_piece_to_hist (PIECETOHIST, see Tune::pieceToHist): credit/penalize one
// quiet move's standalone [piece][to] entry, via zug's own gravity idiom (same as
// update_cont_entry — zug's ±400-bonus/±32000-clamp scale, not SP's raw magnitudes).
// Caller has verified tune.pieceToHist is on and the move is a real quiet (not a
// capture/promotion).
void update_piece_to_hist(Context& C, Piece pc, Square to, int bonus) {
    update_cont_entry(C.pieceToHist[piece_dense(pc)][to], bonus);
}

// update_cont_hist: credit/penalize one quiet move (pc -> to) in both
// continuation tables via the plane pointers already hoisted for this node by
// cont_hist_planes (ch1/ch2 nullptr <=> no real ancestor at that ply, same
// guard cont_hist_planes applies). Caller has verified tune.contHist is on.
// (No Context param needed — ch1/ch2 are already Context-resolved pointers.)
// CONTHISTPLIES: ch3/ch4/ch6 (nullptr unless Tune::contHistPlies is on, same
// guard as ch1/ch2) get SF's own per-ply update weight applied to `bonus`
// before the gravity nudge, taken verbatim from SF's conthist_bonuses table
// (~sf18-arm/src/search.cpp:1877-1878: {{1,1133},{2,683},{3,312},{4,582},
// {5,149},{6,474}}, each applied as bonus*weight/1024). zug's ch1/ch2 apply
// the raw `bonus` unweighted (an existing, unchanged convention — not SF's
// 1133/683), so ch3/ch4/ch6 use SF's weight/1024 fraction directly against
// that same raw-bonus scale rather than re-deriving a ratio relative to
// ch1's implicit weight; this is the smallest, most reviewable mapping that
// doesn't touch ch1/ch2 or open a re-tune of them. Ply 5's weight (149/1024)
// is unused — zug has no ply-5 table (see Tune::contHistPlies). SF's flat
// "+88 * (i<2)" term (search.cpp:1887) only applies to i=1,2, so it's
// correctly omitted for the deeper plies here too.
//
// CONTHISTBASE (see Tune::conthistBase for the full citation/weights): when on,
// ch1/ch2/ch4/ch6 (NOT ch3 — SP has no ply-3 conthist table at all) are updated
// against a shared cross-table `base` instead of each entry's own value. Needs
// Context& (to read C.history/C.pieceToHist/C.tune) plus the move's color/from-
// square (Color us, Square from) that plain ch-pointer arithmetic didn't previously
// require — threaded through every call site below only for this flag; the pointers
// (ch1..ch6) and pc/to/bonus keep their original meaning.
void update_cont_hist(Context& C, int16_t* ch1, int16_t* ch2, int16_t* ch3, int16_t* ch4, int16_t* ch6,
                       Color us, Square from, Piece pc, Square to, int bonus) {
    int off = piece_dense(pc) * SQUARE_NB + to;
    if (C.tune.conthistBase) {
        long long base = (long long)C.history[us][from][to] * C.tune.conthistBaseButterflyW;
        if (C.tune.pieceToHist)
            base += (long long)C.pieceToHist[piece_dense(pc)][to] * C.tune.conthistBasePieceToW;
        if (ch1) base += (long long)ch1[off] * C.tune.conthistBaseCont1W;
        if (ch2) base += (long long)ch2[off] * C.tune.conthistBaseCont2W;
        if (ch4) base += (long long)ch4[off] * C.tune.conthistBaseCont4W;
        if (ch6) base += (long long)ch6[off] * C.tune.conthistBaseCont6W;
        int b = int(base / 1024);
        if (ch1) update_cont_entry_based(ch1[off], bonus, b);
        if (ch2) update_cont_entry_based(ch2[off], bonus, b);
        if (ch4) update_cont_entry_based(ch4[off], bonus * 582 / 1024, b);
        if (ch6) update_cont_entry_based(ch6[off], bonus * 474 / 1024, b);
    } else {
        if (ch1) update_cont_entry(ch1[off], bonus);
        if (ch2) update_cont_entry(ch2[off], bonus);
        if (ch4) update_cont_entry(ch4[off], bonus * 582 / 1024);
        if (ch6) update_cont_entry(ch6[off], bonus * 474 / 1024);
    }
    // ch3 (SF-sourced, no SP analog) always uses its existing self-referential
    // update regardless of CONTHISTBASE — see the comment above.
    if (ch3) update_cont_entry(ch3[off], bonus * 312 / 1024);
}

// update_capt_hist: credit/penalize one CAPTURE (pc captures a `victim`-type piece on
// `to`) in the capture-history table, via the same int16 gravity as continuation history.
// Caller has verified tune.captHist and that the move is a real capture (victim valid).
void update_capt_hist(Context& C, Piece pc, Square to, PieceType victim, int bonus) {
    update_cont_entry(C.captHist[piece_dense(pc)][to][victim], bonus);
}

// update_low_ply_hist: SF LowPlyHistory update (SF history.h/movepick.cpp),
// via zug's exact house gravity idiom (same clamp/scale as update_history).
// SF scales this entry's bonus by 805/1024 relative to its normal stat_bonus;
// applied here to zug's raw bonus (depth*depth, same value update_history
// gets) before the gravity nudge. Caller has verified tune.lowPlyHist and
// ply<5.
void update_low_ply_hist(Context& C, int ply, Move m, int bonus) {
    int& h = C.lowPly[ply][from_sq(m)][to_sq(m)];
    bonus = bonus * 805 / 1024;
    bonus = std::max(-400, std::min(400, bonus));
    h += 32 * bonus - h * std::abs(bonus) / 512;
}

// update_pawn_order_hist: SF PawnHistory update (SF history.h/movepick.cpp),
// via the same int16 gravity as ContHist/CaptHist. SF applies an asymmetric
// win/lose scale to the bonus (905/1024 winner, 505/1024 loser) before the
// gravity nudge — mirrored here on the sign of the incoming (already +/-
// depth*depth) bonus. Caller has verified tune.pawnOrderHist.
void update_pawn_order_hist(Context& C, const Position& pos, Piece pc, Square to, int bonus) {
    int scaled = bonus * (bonus > 0 ? 905 : 505) / 1024;
    update_cont_entry(C.pawnOrderHist[pos.pawn_key() & 8191][piece_dense(pc)][to], scaled);
}

int qsearch(Context& C, Position& pos, Stack* ss, int alpha, int beta, int qdepth = 0);

int qsearch(Context& C, Position& pos, Stack* ss, int alpha, int beta, int qdepth) {
    if ((++C.nodeCount & 1023) == 0) check_time(C);
    if (C.stop) return 0;

    if (pos.is_draw(ss->ply)) return VALUE_DRAW;
    if (ss->ply >= MAX_PLY) return Eval::evaluate(pos);

    bool inCheck = pos.in_check();
    int bestValue, futilityBase;

    // TT probe
    bool ttHit;
    TTEntry* tte = C.tt.probe(pos.key(), ttHit);
    int ttValue = ttHit ? C.tt.value_from_tt(tte->value, ss->ply) : VALUE_NONE;
    Move ttMove = ttHit ? tte->move : MOVE_NONE;

    if (ttHit && tte->depth >= 0) {
        Bound b = tte->bound();
        if (b == BOUND_EXACT
            || (b == BOUND_LOWER && ttValue >= beta)
            || (b == BOUND_UPPER && ttValue <= alpha))
            return ttValue;
    }

    // Cuckoo upcoming-repetition (SF #15, ~sf18-arm/src/search.cpp:1504-1510):
    // qsearch has no rootNode (SF's static_assert(nodeType != Root) — zug's
    // qsearch is likewise never called at the root). Default-off (CUCKOO=1).
    if (Zobrist::cuckoo_enabled() && alpha < VALUE_DRAW && pos.upcoming_repetition(ss->ply)) {
        alpha = VALUE_DRAW;
        if (alpha >= beta) return alpha;
    }

    // rawEval is the uncorrected eval we persist to TT (tte->eval is always raw —
    // see negamax for the same invariant — so a later hit can re-apply a possibly
    // updated correction rather than replaying a stale corrected value).
    int rawEval = VALUE_NONE;
    if (inCheck) {
        bestValue = futilityBase = -VALUE_INFINITE;
    } else {
        rawEval = (ttHit && tte->eval != VALUE_NONE) ? tte->eval : Eval::evaluate(pos);
        // Contempt (Stormphrax eval.cpp:25): bias the corrected static eval from the root
        // side's POV. C.contempt[stm] is +C for the root color, -C for the opponent, so
        // indexing by the current side-to-move flips the sign correctly at every ply.
        // Default 0 → +0 → byte-identical. (Terminal draws/mates below bypass this, as in SP.)
        int staticEval = ss->staticEval = corrected_eval(C, pos, ss, rawEval) + C.contempt[pos.side_to_move()];
        bestValue = staticEval;
        if (ttHit && (tte->bound() & (ttValue > staticEval ? BOUND_LOWER : BOUND_UPPER)))
            bestValue = ttValue;
        if (bestValue >= beta) {
            if (!ttHit)
                C.tt.store(tte, pos.key(), C.tt.value_to_tt(bestValue, ss->ply), false,
                           BOUND_LOWER, 0, MOVE_NONE, rawEval);
            return bestValue;
        }
        if (bestValue > alpha) alpha = bestValue;
        futilityBase = bestValue + C.tune.qsFutMargin;
    }

    // Generate moves: captures/promotions (or all evasions when in check)
    MoveList list;
    if (inCheck) generate<ALL>(pos, list);
    else         generate<CAPTURES>(pos, list);

    Move counter = MOVE_NONE;
    if (C.tune.contHist) {
        int16_t* qsCh1 = nullptr;
        int16_t* qsCh2 = nullptr;
        int16_t* qsCh3 = nullptr;
        int16_t* qsCh4 = nullptr;
        int16_t* qsCh6 = nullptr;
        cont_hist_planes(C, ss, qsCh1, qsCh2, qsCh3, qsCh4, qsCh6);
        score_moves_cont(C, pos, list.begin(), list.end(), ttMove, ss, counter,
                          qsCh1, qsCh2, qsCh3, qsCh4, qsCh6, 0, 0, 0);
    } else {
        score_moves(C, pos, list.begin(), list.end(), ttMove, ss, counter, 0, 0, 0);
    }

    ExtMove* cur = list.begin();
    Move bestMove = MOVE_NONE;
    StateInfo st;
    int moveCount = 0;

    // QSTTQUIET (see Tune::qsTtQuiet for the full citation): search a TT-suggested
    // QUIET move here, not just captures — generate<CAPTURES> above never enumerates
    // it. Fires before the capture loop (matching SP's TT-move-first ordering), folds
    // straight into bestValue/alpha/bestMove exactly like any other qsearch move, and
    // sets qsTtQuietCutoff so the capture loop is skipped entirely on a beta cutoff
    // (mirroring the loop's own `if (score >= beta) break;`, just without a loop to
    // break out of yet). Never double-searched: see the flag comment for why a real
    // quiet/non-promotion ttMove can never also be in `list`.
    // qdepth == 0 bounds this to the ENTRY qsearch node of each line: the recursion
    // below passes qdepth+1, and the capture loop passes qdepth unchanged, so once a
    // quiet has been taken (qdepth>0) no further quiet is searched. Without this bound,
    // quiet moves don't reduce material like captures do, so a chain of TT-quiet moves
    // recurses unboundedly -> the engine stalls (observed: "stalled/disconnected @g120").
    bool qsTtQuietCutoff = false;
    if (qdepth == 0 && !inCheck && C.tune.qsTtQuiet && ttHit && ttMove != MOVE_NONE
        && !pos.is_capture(ttMove) && type_of_move(ttMove) != PROMOTION
        && tte->bound() != BOUND_UPPER && pos.pseudo_legal(ttMove) && pos.legal(ttMove)) {
        pos.do_move(ttMove, st);
        C.tt.prefetch(pos.key());
        int score = -qsearch(C, pos, ss + 1, -beta, -alpha, qdepth + 1);
        pos.undo_move(ttMove);
        if (C.stop) return 0;
        if (score > bestValue) {
            bestValue = score;
            if (score > alpha) {
                bestMove = ttMove;
                if (score >= beta) qsTtQuietCutoff = true;
                else alpha = score;
            }
        }
    }

    while (!qsTtQuietCutoff && cur != list.end()) {
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
        // #7 qsearch move-count cap (SF search.cpp:1638 `if (moveCount > 2) continue`;
        // SP search.cpp:1579 `if (legalMoves >= 2) break`). zug searches EVERY legal
        // capture; both reference engines cap after the first few (captures are ordered
        // MVV-LVA/SEE-first, so late ones rarely matter). Gated !inCheck — evasions must
        // never be capped or we'd miss the only escape and mis-score mate. Default OFF
        // (never fires) → byte-identical. env QSMOVECAP=1, QSMOVECAPN (SF=2).
        if (C.tune.qsMoveCap && !inCheck && moveCount > C.tune.qsMoveCapN) continue;

        pos.do_move(m, st);
        C.tt.prefetch(pos.key());
        int score = -qsearch(C, pos, ss + 1, -beta, -alpha, qdepth);
        pos.undo_move(m);

        if (C.stop) return 0;

        if (score > bestValue) {
            bestValue = score;
            if (score > alpha) {
                bestMove = m;
                if (score >= beta) break;
                alpha = score;
            }
        }
    }

    // QSCHECKS (diagnostic, default OFF): at the entry qsearch ply, also try quiet
    // (non-capture) moves that give check and don't lose material (SEE>=0). Lets qsearch
    // see a quiet checking refutation/mate the CAPTURES-only list can't enumerate.
    // Child is searched at qdepth+1 so it never generates quiet checks again (no
    // explosion). Skipped once we already have a beta cutoff.
    if (C.tune.qsChecks && qdepth == 0 && !inCheck && !qsTtQuietCutoff && bestValue < beta) {
        MoveList clist;
        generate<ALL>(pos, clist);
        int checksTried = 0;
        for (ExtMove* it = clist.begin(); it != clist.end() && checksTried < C.tune.qsChecksN; ++it) {
            Move m = it->move;
            if (pos.is_capture(m) || type_of_move(m) == PROMOTION) continue; // captures/promos already covered
            if (m == ttMove) continue;                                       // QSTTQUIET may have searched it
            if (!pos.gives_check(m)) continue;
            if (!pos.legal(m)) continue;
            if (!pos.see_ge(m, 0)) continue;                                 // don't chase material-losing checks
            checksTried++;
            pos.do_move(m, st);
            C.tt.prefetch(pos.key());
            int score = -qsearch(C, pos, ss + 1, -beta, -alpha, qdepth + 1);
            pos.undo_move(m);
            if (C.stop) return 0;
            if (score > bestValue) {
                bestValue = score;
                if (score > alpha) {
                    bestMove = m;
                    if (score >= beta) break;
                    alpha = score;
                }
            }
        }
    }

    if (inCheck && bestValue == -VALUE_INFINITE)
        return mated_in(ss->ply); // checkmate

    Bound b = bestValue >= beta ? BOUND_LOWER : BOUND_UPPER;
    C.tt.store(tte, pos.key(), C.tt.value_to_tt(bestValue, ss->ply), false, b, 0, bestMove,
               inCheck ? VALUE_NONE : rawEval);
    return bestValue;
}

// DRAWJITTER (SF search.cpp:127, sf-sp-search-backlog.md #5): value_draw(nodes) =
// VALUE_DRAW-1+(nodes&2) cycles {-1,+1} on a node-count parity bit, avoiding a flat
// draw score so move-ordering/TT ties around draws break deterministically-but-not-
// flatly, dodging some 3-fold search instability. VERIFIED against ~sf18-arm/src/
// search.cpp directly (not the backlog's summary): SF applies this ONLY at the
// main-search is_draw()/upcoming_repetition sites (search.cpp:630-635,676-678) —
// qsearch's OWN is_draw() return (search.cpp:1538: `... : VALUE_DRAW`) and the
// stalemate/no-legal-moves return (search.cpp:1411: `... : VALUE_DRAW`) are BOTH
// flat, unjittered VALUE_DRAW in real SF; only the repetition-draw path (and the
// upcoming-repetition cuckoo short-circuit, which zug doesn't have — backlog #15,
// separate/unimplemented) gets the jitter. So the single faithful port site is
// zug's main-negamax non-root is_draw() return below — zug's qsearch is_draw
// (search.cpp ~1218) and the stalemate return are intentionally left untouched.
// (An earlier reading of the backlog implied qsearch should jitter too; that is
// not what SF's source actually does — a backlog correction.) Default OFF; env
// DRAWJITTER=1. OFF path: returns the same flat VALUE_DRAW as before.
inline int draw_value(Context& C) {
    return C.tune.drawJitter ? (VALUE_DRAW - 1 + int(C.nodeCount & 2)) : VALUE_DRAW;
}

// INCHKEVAL env kill-switch (default off), read once. When on, a node in check keeps a
// real staticEval (propagated from (ss-2)) instead of VALUE_NONE, so the improving /
// opponentWorsening chain survives across check sequences (SF search.cpp:716).
static bool inchk_eval_enabled() {
    static const bool v = []{ const char* e = std::getenv("INCHKEVAL"); return e && e[0] == '1'; }();
    return v;
}

template <bool PvNode>
int negamax(Context& C, Position& pos, Stack* ss, int alpha, int beta, int depth, bool cutNode) {
    bool rootNode = PvNode && ss->ply == 0;
    bool allNode  = !(PvNode || cutNode); // ALLNODELMR (SF search.cpp): neither PV nor cut -> "all" node

    // D.7 (GMCHECKEXT): gomachine's per-node check extension fires here, at node
    // entry, BEFORE the depth<=0 qsearch dispatch and before the TT probe
    // (search.go:1244-1250: `if (pos.InCheck()) depth++` immediately after entering
    // the node) — uncapped, and it always stacks with singular since it mutates the
    // incoming `depth` itself rather than the per-move `extension` local below.
    // Strictly gated behind tune.gmCheckExt so the off (default) path doesn't even
    // pay for the extra pos.in_check() call — zero cost, byte-identical when off.
    if (C.tune.gmCheckExt && pos.in_check())
        depth++;

    // A PvNode child re-searched with newDepth<=0 dispatches straight to qsearch,
    // which never touches ss->pv/pvLen — so without resetting it here the parent
    // would copy a STALE (now-illegal) pv line from a prior use of this stack slot
    // into its own PV (the "Illegal PV move" fastchess warnings + glitched
    // /candidates/analyze-game arrows). Search-neutral: pvLen feeds only PV
    // reporting, never a pruning/ordering decision, so node counts are unchanged.
    ss->pvLen = 0;
    if (depth <= 0) return qsearch(C, pos, ss, alpha, beta);

    if ((++C.nodeCount & 1023) == 0) check_time(C);
    if (C.stop) return 0;

    ss->pvLen = 0;
    ss->inCheck = pos.in_check();

    if (!rootNode) {
        if (pos.is_draw(ss->ply)) return draw_value(C); // DRAWJITTER — see draw_value() comment
        if (ss->ply >= MAX_PLY) return ss->inCheck ? VALUE_DRAW : Eval::evaluate(pos);
        // Mate distance pruning
        alpha = std::max(mated_in(ss->ply), alpha);
        beta  = std::min(mate_in(ss->ply + 1), beta);
        if (alpha >= beta) return alpha;
    }

    (ss + 1)->killers[0] = (ss + 1)->killers[1] = MOVE_NONE;
    if (C.tune.cutoffCnt) (ss + 2)->cutoffCnt = 0; // #6: reset grandchild's counter (SF search.cpp:699)
    Move excluded = ss->excludedMove;

    // TT probe
    bool ttHit;
    TTEntry* tte = C.tt.probe(pos.key(), ttHit);
    int ttValue = ttHit ? C.tt.value_from_tt(tte->value, ss->ply) : VALUE_NONE;
    // Root ttMove is the CURRENT PV line's own best move (SF search.cpp:707,
    // `ttData.move = rootNode ? rootMoves[pvIdx].pv[0] : ...`), not one global
    // best move — under MultiPV each line must be ordered by its own head move.
    //
    // BYTE IDENTITY at pvIdx==0: rootMoves is stable-sorted descending after every
    // root search, so rootMoves[0] is the highest-scoring root move, which is exactly
    // the move the old scalar `C.rootBestMove` held (both are "the last move that was
    // moveCount==1 or beat alpha", and alpha rises monotonically so that move has the
    // max score). The one place they used to differ is BEFORE any root move has been
    // searched — zug's rootBestMove is MOVE_NONE there while SF's RootMove ctor
    // pre-seeds pv[0] with the move itself — hence the -VALUE_INFINITE "never scored"
    // guard, which reproduces zug's MOVE_NONE exactly on iteration 1.
    //
    // The empty-rootMoves case is a TERMINAL root (checkmate/stalemate): the ID loop
    // still runs one root negamax there, because its mated_in()/VALUE_DRAW return is
    // load-bearing for the Result (see start()'s "case 2" comment) — it just never
    // enters the move loop.
    Move ttMove;
    if (rootNode) {
        ttMove = MOVE_NONE;
        if (!C.rootMoves.empty()) {
            const RootMove& rm = C.rootMoves[C.pvIdx];
            if (rm.score != -VALUE_INFINITE) ttMove = rm.pv[0];
        }
#ifdef NNUE_ASSERT
        // The identity claim above, checked in the validation build. NDEBUG is on in
        // every build here, so assert() would compile away — abort explicitly, in the
        // same style as the accumulator drift check (nnue_accumulator.cpp:717).
        // multiPV==1 only: that is the identity claim being protected. Under MultiPV
        // the emitted-prefix sort (sort_emitted_lines, SF search.cpp:424) can promote a
        // later line above line 0, so rootMoves[0] legitimately stops tracking the
        // scalar rootBestMove — which is SF's behaviour too (its bestmove IS
        // rootMoves[0].pv[0], re-ranked and all).
        if (C.multiPV == 1 && C.pvIdx == 0 && ttMove != C.rootBestMove) {
            std::fprintf(stderr,
                "root ttMove drift: rootMoves[0].pv[0]=%s rootBestMove=%s depth=%d fen=%s\n",
                move_to_uci(ttMove).c_str(), move_to_uci(C.rootBestMove).c_str(),
                depth, pos.fen().c_str());
            std::abort();
        }
#endif
    } else {
        ttMove = ttHit ? tte->move : MOVE_NONE;
    }
    bool ttCapture = ttMove && pos.is_capture(ttMove);
    // #5 ttPv: this node counts as "PV-descended" if it is a PvNode or the TT entry
    // was flagged PV. Preserved (not recomputed) on singular-verification re-entry.
    ss->ttPv = excluded ? ss->ttPv : (PvNode || (ttHit && tte->is_pv()));

    if (!PvNode && ttHit && !excluded && tte->depth >= depth && ttValue != VALUE_NONE) {
        Bound b = tte->bound();
        if (b == BOUND_EXACT
            || (b == BOUND_LOWER && ttValue >= beta)
            || (b == BOUND_UPPER && ttValue <= alpha)) {
            // TTCUTBONUS (SF search.cpp:759-776 / SP search.cpp:682-698): credit history on
            // this cache-hit fast path (no move loop runs here). A quiet ttMove that fails
            // high gets a depth-scaled bonus; the previous ply's early quiet gets a malus.
            // pseudo_legal() guards against a colliding TT move indexing tables out of range.
            if (C.tune.ttCutBonus && ttValue >= beta && ttMove != MOVE_NONE && !ttCapture
                && type_of_move(ttMove) != PROMOTION && pos.pseudo_legal(ttMove)) {
                // zug-native scale (see Tune::ttCutBonus): depth*depth, matching zug's
                // real-cutoff bonus — NOT SF's raw magnitudes (which saturate zug's ±400
                // per-update clamp). update_history/update_cont_entry clamp internally, so
                // large depths degrade gracefully exactly as the real-cutoff block does.
                int bonus = depth * depth * C.tune.ttCutBonusNum / C.tune.ttCutBonusDen;
                if (bonus > 0) update_history(C, pos.side_to_move(), ttMove, bonus);
                // PIECETOHIST: mirrors the butterfly bonus above in lockstep (SP
                // updateMainHistory updates butterfly+pieceTo together). ttMove is
                // already verified quiet (!ttCapture && !PROMOTION) by the outer gate.
                if (C.tune.pieceToHist && bonus > 0)
                    update_piece_to_hist(C, pos.moved_piece(ttMove), to_sq(ttMove), bonus);
                if (C.tune.contHist && bonus > 0) {
                    int16_t *ch1, *ch2, *ch3, *ch4, *ch6;
                    cont_hist_planes(C, ss, ch1, ch2, ch3, ch4, ch6);
                    update_cont_hist(C, ch1, ch2, ch3, ch4, ch6, pos.side_to_move(), from_sq(ttMove),
                                     pos.moved_piece(ttMove), to_sq(ttMove), bonus);
                }
                // Prev-ply early-quiet penalty (SF: (ss-1)->moveCount < 4 && !priorCapture),
                // depth-scaled like zug's own quiet malus (-(depth+1)^2), not SF's flat 2060.
                // malusNum=0 disables it (bonus-only variant).
                int malus = (depth + 1) * (depth + 1) * C.tune.ttCutMalusNum / C.tune.ttCutMalusDen;
                if (malus > 0 && (ss - 1)->currentMove != MOVE_NONE
                    && (ss - 1)->currentMove != MOVE_NULL && (ss - 1)->moveCount < 4
                    && !(ss - 1)->didCapture) {
                    // PIECETOHIST: same lockstep mirror as the bonus above. Extra
                    // promotion exclusion (the surrounding gate doesn't have one) so the
                    // table only ever sees genuine quiets, matching zug's own isQuiet
                    // convention (search.cpp ~2253) rather than SF's bare !priorCapture.
                    if (C.tune.pieceToHist && type_of_move((ss - 1)->currentMove) != PROMOTION)
                        update_piece_to_hist(C, (ss - 1)->currentPiece,
                                             to_sq((ss - 1)->currentMove), -malus);
                    if (C.tune.contHist) {
                        int16_t *p1, *p2, *p3, *p4, *p6;
                        cont_hist_planes(C, ss - 1, p1, p2, p3, p4, p6);
                        update_cont_hist(C, p1, p2, p3, p4, p6, ~pos.side_to_move(),
                                         from_sq((ss - 1)->currentMove), (ss - 1)->currentPiece,
                                         to_sq((ss - 1)->currentMove), -malus);
                    }
                }
            }
            return ttValue;
        }
    }

    // Cuckoo upcoming-repetition (SF #15, ~sf18-arm/src/search.cpp:629-634): one
    // move away from a claimable 3-fold repetition — short-circuit to a draw
    // score before the move loop, same as SF. Default-off (CUCKOO=1).
    if (Zobrist::cuckoo_enabled() && !rootNode && alpha < VALUE_DRAW
        && pos.upcoming_repetition(ss->ply)) {
        alpha = VALUE_DRAW; // or draw_value(C) if DRAWJITTER's node-parity jitter is ever extended here
        if (alpha >= beta) return alpha;
    }

    // bestValue / maxValue are declared HERE, not at the move loop, because Step 5 below
    // can seed both — SF declares them at node entry and initializes them in Step 1
    // (~sf18-arm/src/search.cpp:647, :662-663). maxValue is the tablebase CEILING: a
    // probe that says "this node is lost" but whose value did not fall below alpha does
    // not get to end the node, it gets to cap it, and the cap is applied once at the very
    // bottom (search.cpp:1455-1456 / the `std::min` just before the ttPv propagation).
    //
    // BYTE IDENTITY: with the probe never firing, bestValue is still -VALUE_INFINITE when
    // the move loop starts and maxValue is still VALUE_INFINITE, so the closing
    // `std::min(bestValue, maxValue)` is the identity. Everything between here and the
    // move loop that can return early (RFP, null move, ProbCut) is `!PvNode`-gated, and
    // Step 5 only ever seeds bestValue/alpha under PvNode — so a seeded value can never
    // be silently discarded by one of those returns.
    int bestValue = -VALUE_INFINITE;
    int maxValue  = VALUE_INFINITE;

    // ---- Step 5. Syzygy WDL-in-search (~sf18-arm/src/search.cpp:801-853) ----
    //
    // In a TB-cardinality position with no castling, ask the WDL tables what this node is
    // worth. Gates, and what each one is actually for:
    //   * ply > 0          — the root is owned by the DTZ ranking, not by WDL.
    //   * !excluded        — SF's !excludedMove: a singular verification must measure the
    //                        SEARCH, not short-circuit to a table.
    //   * castling_rights()== 0 and popcount <= C.tbCardinality — Fathom preconditions.
    //   * rule50_count() == 0 — SF search.cpp:809. THE fix. The WDL tables answer "is this
    //     won starting from a fresh halfmove clock"; they know nothing about the clock the
    //     game actually carries. zug calls tb_probe_wdl_impl directly, which skips the
    //     rule50 != 0 refusal Fathom's own wrapper performs (src/syzygy/tbprobe.h:220-223),
    //     so without this gate a win the counter has already eaten reads +2 = full win.
    //     That is how a dead-drawn KNPvKB reported +314.96 for 16 consecutive moves.
    //   * !ss->inCheck     — zug's own gate, NOT SF's (SF probes in check too). Kept: it is
    //     orthogonal to all three defects being fixed here, it only ever removes probes,
    //     and dropping it would be an unmeasured behaviour change riding along on a
    //     correctness fix. Worth revisiting on its own with its own SPRT.
    //
    // NOT ported: SF's probeDepth half of the gate,
    // `(piecesCount < cardinality || depth >= tbConfig.probeDepth)` (search.cpp:808).
    // It is dead code at zug's configuration, twice over. SF's cardinality comes from
    // the SyzygyProbeLimit option, default 7 (~sf18-arm/src/engine.cpp:136), and when
    // that exceeds MaxCardinality — 5 here, which is what is on disk — SF itself sets
    // probeDepth = 0 (tbprobe.cpp:1736-1740), making the clause vacuous. Even pinning
    // SyzygyProbeLimit to exactly 5 leaves probeDepth at its default 1
    // (engine.cpp:132), and this block only ever runs at depth >= 1, since `depth <= 0`
    // dispatched to qsearch at the top of negamax. zug's C.tbCardinality is always
    // TB::max_pieces(), so there is no configuration in which the clause can decide
    // anything. Porting it would add a branch that is provably never false.
    //
    // C.tbCardinality (SF's Tablebases::Config::cardinality, set in start()) is
    // TB::max_pieces() — the old hardcoded gate — EXCEPT when the root was DTZ-ranked,
    // where SF zeroes it (tbprobe.cpp:1764-1766) and so does zug. Inside a DTZ-ranked root
    // this probe is actively harmful: every child is a TB hit, every winning move returns
    // the same flat ±(VALUE_TB_WIN - ply), and the search degenerates to move ordering —
    // which is precisely how a won ending gets shuffled into a 50-move draw. The root
    // ranking already guarantees only win-preserving moves are searched, so the search's
    // job here is to find the MATE, and for that it needs the real eval.
    if (C.tune.syzygy && TB::loaded() && ss->ply > 0 && !ss->inCheck && !excluded
        && pos.castling_rights() == 0
        && (!C.tune.tbWdlSf || pos.rule50_count() == 0)
        && BB::popcount(pos.pieces()) <= C.tbCardinality) {
        int wdl;  // SF WDLScore scale: -2 loss, -1 blessed loss, 0 draw, +1 cursed, +2 win
        if (TB::probe_wdl(pos, wdl)) {
            if (!C.tune.tbWdlSf) {
                // ---- LEGACY, TBWDLSF=0 ----------------------------------------------
                // The pre-2026-08-14 block, byte-for-byte: no rule50 gate, cursed/blessed
                // folded to a flat draw, and an unconditional return. probe_wdl's old
                // +1/0/-1 normalization is reproduced exactly by the ±2 comparisons (it
                // mapped TB_WIN→+1 and TB_LOSS→-1 and everything else→0, i.e. the two
                // extremes of the five-valued scale and nothing between them).
                if (wdl >= 2)  return VALUE_TB_WIN - ss->ply;
                if (wdl <= -2) return -VALUE_TB_WIN + ss->ply;
                return VALUE_DRAW;
            }

            // drawScore is SF's `tbConfig.useRule50 ? 1 : 0` (search.cpp:821). zug plays
            // every game under the 50-move rule and has no option to say otherwise — see
            // TB_ROOT_USE_RULE50, which is the same decision for the root ranking — so
            // this is 1, and the `!= 1` arms below are dead by construction, not by luck.
            constexpr int drawScore = TB_ROOT_USE_RULE50 ? 1 : 0;

            // SF's `Value tbValue = VALUE_TB - ss->ply` (search.cpp:825). SF's VALUE_TB is
            // the top of its tablebase band (VALUE_MATE - MAX_PLY - 1); zug's is
            // VALUE_TB_WIN (types.h:76), which is the value this block already returned.
            // NOT a raw magnitude copy — see the same substitution in zug_tb.cpp.
            const int tbValue = VALUE_TB_WIN - ss->ply;

            // search.cpp:827-830. The middle arm is the whole point of keeping five
            // values: a cursed win scores VALUE_DRAW + 2*(+1)*1 = +2cp on zug's pawn=100
            // scale (types.h), i.e. barely above a dead draw. It is not a win — the
            // halfmove clock has already taken that — but it is still the side of the draw
            // you want to be on, because the defender has to keep finding moves for 50 of
            // them. Blessed loss is the mirror at -2cp.
            int value = wdl < -drawScore ? -tbValue
                      : wdl >  drawScore ?  tbValue
                                         : VALUE_DRAW + 2 * wdl * drawScore;

            Bound b = wdl < -drawScore ? BOUND_UPPER
                    : wdl >  drawScore ? BOUND_LOWER
                                       : BOUND_EXACT;

            // search.cpp:836-845. THE OTHER HALF OF THE FIX: return only when the bound
            // genuinely cuts. The old code returned unconditionally, which amputated the
            // subtree — a "this node is lost" verdict that does not fall below alpha still
            // ended the node, so the search never got to find out how the loss is defended
            // (or that the PV runs somewhere else entirely).
            //
            // Stored depth is SF's `std::min(MAX_PLY - 1, depth + 6)`: a table verdict is
            // exact regardless of depth, so it is worth more than the depth that produced
            // it — but not infinitely more, hence the +6 rather than MAX_PLY. ttPv/eval
            // follow the house convention at zug's other store sites.
            if (b == BOUND_EXACT || (b == BOUND_LOWER ? value >= beta : value <= alpha)) {
                C.tt.store(tte, pos.key(), C.tt.value_to_tt(value, ss->ply),
                           C.tune.ttPvOn ? ss->ttPv : PvNode, b,
                           std::min(MAX_PLY - 1, depth + 6), MOVE_NONE, VALUE_NONE);
                return value;
            }

            // search.cpp:847-853. Non-cutting bound in a PV node: keep it as information
            // instead of throwing it away. LOWER raises the floor (and alpha); UPPER
            // becomes the ceiling applied at the bottom of the node.
            if (PvNode) {
                if (b == BOUND_LOWER) {
                    bestValue = value;
                    alpha     = std::max(alpha, bestValue);
                } else {
                    maxValue = value;
                }
            }
        }
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
        // INCHKEVAL: keep a real staticEval through checks by propagating (ss-2)'s, so
        // improving/opponentWorsening don't reset to "unknown" for plies after a check
        // (SF search.cpp:716). Default off → VALUE_NONE, byte-identical.
        if (inchk_eval_enabled() && ss->ply >= 2 && (ss - 2)->staticEval != VALUE_NONE)
            eval = ss->staticEval = (ss - 2)->staticEval;
        else
            eval = ss->staticEval = VALUE_NONE;
    } else {
        rawEval = (ttHit && tte->eval != VALUE_NONE) ? tte->eval : Eval::evaluate(pos);
        eval = ss->staticEval = corrected_eval(C, pos, ss, rawEval) + C.contempt[pos.side_to_move()]; // Contempt (see qsearch site)
        if (ttHit && ttValue != VALUE_NONE && (tte->bound() & (ttValue > eval ? BOUND_LOWER : BOUND_UPPER)))
            eval = ttValue;
    }

    bool improving = !ss->inCheck && ss->ply >= 2
                     && (ss - 2)->staticEval != VALUE_NONE
                     && ss->staticEval > (ss - 2)->staticEval;

    // opponentWorsening (SF search.cpp:751): true if our static eval looks better
    // for us than the negated static eval one ply up — i.e. the opponent's own
    // move made their position worse than expected. Hoisted out of the #8
    // hindsight block below (was local to it) so the RFP margin further down can
    // also read it (SF folds it into futility_margin, search.cpp:883); guarded
    // like every other (ss-1)-reading site here with !rootNode + staticEval
    // validity, since the padded sentinel stack entries are zero-initialized,
    // not VALUE_NONE (see start()'s `memset(stack, 0, ...)`).
    bool opponentWorsening = !rootNode && !ss->inCheck
                              && ss->staticEval != VALUE_NONE && (ss - 1)->staticEval != VALUE_NONE
                              && ss->staticEval > -(ss - 1)->staticEval;

    // #8 hindsight (SF search.cpp:754-757): a heavily-reduced parent move may have
    // under-searched this node — extend if the position isn't worsening for us,
    // reduce further if the stacked static-eval swing says the reduction was fine.
    // Reads (ss-1)->reduction = how much the move that led here was LMR-reduced.
    if (C.tune.hindsight && !rootNode && !ss->inCheck
        && ss->staticEval != VALUE_NONE && (ss - 1)->staticEval != VALUE_NONE) {
        int priorReduction = (ss - 1)->reduction;
        if (priorReduction >= 3 && !opponentWorsening)
            depth++;
        else if (priorReduction >= 2 && depth >= 2
                 && ss->staticEval + (ss - 1)->staticEval > 173)
            depth--;
    }

    // #12 (SF search.cpp:859): eval-diff quiet-history bump. A static-eval swing in
    // the opponent's favor after a QUIET parent move retroactively credits that move
    // for the opponent — a dense ordering signal that needs no search result. The
    // parent move was played by ~stm, so bump that color's butterfly history.
    if (C.tune.evalHist && !ss->inCheck
        && (ss - 1)->currentMove != MOVE_NONE && (ss - 1)->currentMove != MOVE_NULL
        && !(ss - 1)->didCapture && !(ss - 1)->inCheck
        && ss->staticEval != VALUE_NONE && (ss - 1)->staticEval != VALUE_NONE) {
        int evalBonus = std::max(-209, std::min(167, -((ss - 1)->staticEval + ss->staticEval))) + 59;
        update_history(C, ~pos.side_to_move(), (ss - 1)->currentMove, evalBonus);
        // PIECETOHIST: mirrors the butterfly bump above in lockstep. Extra promotion
        // exclusion (this block's own gate only checks !didCapture) so the table only
        // ever sees genuine quiets, matching zug's own isQuiet convention.
        if (C.tune.pieceToHist && type_of_move((ss - 1)->currentMove) != PROMOTION)
            update_piece_to_hist(C, (ss - 1)->currentPiece, to_sq((ss - 1)->currentMove), evalBonus);
    }

    // ---- Pruning (non-PV, not in check) ----
    if (!PvNode && !ss->inCheck && !excluded) {
        // Reverse futility pruning
        bool quietTT = ttMove != MOVE_NONE && !ttCapture;   // ttCapture computed above at the TT probe
        // #A opponentWorsening fold (SF search.cpp:876-890): SF's futility_margin
        // subtracts a fixed-point (2474*improving + 331*opponentWorsening)*mult/1024
        // term. zug's RFP margin is a flat rfpMargin*(depth-improving); add a small
        // flat rfpOwCoeff on top when opponentWorsening, sized to the same ratio SF
        // uses between its two terms (331/2474 ~ 0.134 of the improving weight ->
        // 0.134*75 ~ 10), so this stays a conservative nudge, not a rewrite of the
        // margin's shape.
        int rfpOwTerm = (C.tune.rfpOppWorsening && opponentWorsening) ? C.tune.rfpOwCoeff : 0;
        // CORRMARGIN (SF search.cpp futility_margin): a large |correctionValue| means
        // the static eval is less trustworthy, so relax (widen) the RFP margin rather
        // than pruning on an uncertain eval. Off -> corrMarginTerm is 0, no-op.
        int corrMarginTerm = C.tune.corrMargin
            ? (int)(std::abs(correction_raw(C, pos, ss)) / 174665) : 0;
        int rfpDepthCap = C.tune.rfpDeep ? 13 : 8; // RFPDEEP: SF's depth<14 vs zug's depth<=8
        // RFPTTHIT: SF drops futilityMult by 23 on a TT miss (!ttHit) → prune more when the
        // eval is uncorroborated. Off → rfpCoeff == rfpMargin → byte-identical.
        int rfpCoeff = C.tune.rfpMargin - ((C.tune.rfpTtHit && !ttHit) ? C.tune.rfpTtHitCoeff : 0);
        // RFPQUAD (backlog #20): Stormphrax-shape quadratic depth term on top of the linear
        // margin. Off -> 0, byte-identical.
        int rfpQuadTerm = C.tune.rfpQuad ? C.tune.rfpQuadCoeff * depth * depth : 0;
        if (depth <= rfpDepthCap && !(C.tune.rfpSoft && quietTT) && !(C.tune.ttPvOn && ss->ttPv)
            && eval - rfpCoeff * (depth - improving) - rfpQuadTerm - rfpOwTerm - corrMarginTerm >= beta
            && eval < VALUE_MATE_IN_MAX_PLY)
            return C.tune.rfpSoft ? (2 * beta + eval) / 3 : eval;

        // Null move pruning
        // SF_MARGINS.md #5: modern SF only null-moves at expected cut-nodes, with a
        // relaxed eval margin (beta - 18*depth + 350) rather than requiring eval>=beta
        // outright. Gated behind tune.nmpCutGate (default off) — R computation below
        // is unchanged either way.
        //
        // NMPSF (default off, env NMPSF=1): SF18's COMPLETE Step-9 mechanism —
        // cutNode gate + depth-only R + nmpMinPly verification search — ported
        // together (~sf18-arm/src/search.cpp:892-925). A prior port of the cutNode
        // gate ALONE (nmpCutGate above) washed −27 Elo; SF's gate is only sound
        // paired with SF's R and its verification safety net, which is why this is
        // one atomic mechanism switch, not another independent sub-toggle. When
        // nmpSf is on, it fully REPLACES the block below (nmpCutGate/nmpEvalDiv/
        // the depth>=3 + eval>=beta gate are all SF-legacy zug mechanics and take
        // no part in the SF path); when off, the existing path runs completely
        // unchanged (byte-identical node counts).
        if (C.tune.nmpSf) {
            // Gate (SF search.cpp:893-894): cutNode && ss->staticEval >= beta -
            // 18*depth + 350 && !excludedMove && non-pawn material && ss->ply >=
            // nmpMinPly && !is_loss(beta). The two cp constants (18, 350) are
            // scaled from SF's pawn=208 cp scale to zug's pawn=100 scale by
            // *100/208 ~ 0.4808: 18 -> 8.65 -> 9, 350 -> 168.3 -> 168. R and the
            // ply/depth thresholds below are depth/ply-only and stay unscaled.
            // cutNode implies !PvNode (SF asserts !(PvNode && cutNode)), and this
            // whole block already sits inside the enclosing `!PvNode` guard.
            if (C.tune.nullMove && cutNode && ss->staticEval >= beta - 9 * depth + 168
                && !excluded && pos.non_pawn_material(pos.side_to_move())
                && ss->ply >= C.nmpMinPly && beta > -VALUE_MATE_IN_MAX_PLY
                && !(C.tune.nmpTtVeto && ttHit && tte->bound() == BOUND_UPPER && ttValue < beta)) {
                // R (SF search.cpp:899): depth-only dynamic reduction, no eval term.
                int R = 7 + depth / 3;
                StateInfo st;
                ss->currentMove = MOVE_NULL;
                ss->didCapture = false;
                pos.do_null_move(st);
                int nullValue = -negamax<false>(C, pos, ss + 1, -beta, -beta + 1, depth - R, false);
                pos.undo_null_move();
                if (C.stop) return 0;

                // Do not return unproven mate scores (SF search.cpp:906-907).
                if (nullValue >= beta && nullValue < VALUE_MATE_IN_MAX_PLY) {
                    // Shallow or already-inside-a-verification: take the cutoff
                    // unverified, exactly like SF (search.cpp:909-910).
                    if (C.nmpMinPly || depth < 16)
                        return nullValue;

                    assert(!C.nmpMinPly);  // recursive verification is not allowed

                    // Verification search (SF search.cpp:914-923): re-search THIS
                    // node (same ss/ply, no move made) at reduced depth with NMP
                    // disabled from here up to nmpMinPly, cutNode=false. Only take
                    // the null-move cutoff if the verification also fails high.
                    C.nmpMinPly = ss->ply + 3 * (depth - R) / 4;
                    int v = negamax<false>(C, pos, ss, beta - 1, beta, depth - R, false);
                    C.nmpMinPly = 0;

                    if (v >= beta)
                        return nullValue;
                }
            }
        } else {
            bool nmpGate = C.tune.nmpCutGate
                ? (cutNode && ss->staticEval >= beta - 18 * depth + 350)
                : (eval >= beta);
            if (C.tune.nullMove && depth >= 3 && nmpGate && (ss - 1)->currentMove != MOVE_NULL
                && pos.non_pawn_material(pos.side_to_move())) {
                int R = 3 + depth / 4 + std::min((eval - beta) / C.tune.nmpEvalDiv, 3);
                StateInfo st;
                ss->currentMove = MOVE_NULL;
                ss->didCapture = false;
                pos.do_null_move(st);
                int nullScore = -negamax<false>(C, pos, ss + 1, -beta, -beta + 1, depth - R, !cutNode);
                pos.undo_null_move();
                if (C.stop) return 0;
                if (nullScore >= beta) {
                    if (nullScore >= VALUE_MATE_IN_MAX_PLY) nullScore = beta;
                    return nullScore;
                }
            }
        }

        // #B improving relax (SF search.cpp:927), right after the null-move step:
        // a static eval that already clears beta at this (non-PV, not-in-check,
        // non-excluded) node is itself a sign the position is fine for us, even
        // absent the (ss-2) comparison `improving` is normally built from — loosens
        // the LMP move-count limit and skips the "!improving -> r++" LMR bump a
        // little further down. Placed inside this block (not hoisted to file scope
        // like opponentWorsening) so staticEval is guaranteed valid here (in-check
        // nodes hold VALUE_NONE, which would otherwise spuriously satisfy >= beta).
        if (C.tune.improvingRelax) improving = improving || (ss->staticEval >= beta);

        // Razoring
        // RAZORQUAD (SF search.cpp: eval < alpha - 485 - 281*depth*depth, no depth
        // cap): SF-scaled quadratic curve (SF consts x0.481, zug/SF pawn-value ratio
        // 100/208). Off keeps the exact linear form + depth<=3 cap, byte-identical.
        bool razorCond = C.tune.razorQuad
            ? (eval < alpha - 233 - 135 * depth * depth)
            : (depth <= 3 && eval + C.tune.razorMargin * depth <= alpha);
        // RAZORTTGATE: skip razoring when the TT move is a quiet (non-capture, non-promotion).
        bool razorTtOk = !C.tune.razorTtGate || ttMove == MOVE_NONE || ttCapture
                         || type_of_move(ttMove) == PROMOTION;
        if (C.tune.razor && razorCond && razorTtOk) {
            int v = qsearch(C, pos, ss, alpha, alpha + 1);
            if (v <= alpha) return v;
        }
    }

    // Internal iterative reduction: if no TT move at high depth, reduce
    // (C.2: gomachine measured its own IIR dead-flat individually — env IIR=0 to disable)
    if (C.tune.iir && depth >= 4 && !ttMove && !rootNode)
        depth--;

    // FULLPROBCUT (see Tune::fullProbCut for the full gate/scale citation): the real
    // capture-loop ProbCut (SF search.cpp:935-981, Step 11), ported ahead of the cheap
    // TT-only variant below, matching SF's own order (Step 11 before Step 12's "small
    // ProbCut idea"). Independent flag — works whether the cheap variant is on or off.
    if (C.tune.fullProbCut && !PvNode && !ss->inCheck && !excluded && depth >= 3
        && std::abs(beta) < VALUE_MATE_IN_MAX_PLY
        && !(ttHit && ttValue != VALUE_NONE && ttValue < beta + 113 - 30 * improving)) {
        int probCutBeta  = beta + 113 - 30 * improving;
        int probCutDepth = std::clamp(depth - 5 - (eval - beta) / 151, 0, depth);

        MoveList pcList;
        generate<CAPTURES>(pos, pcList);
        score_moves(C, pos, pcList.begin(), pcList.end(), ttMove, ss, MOVE_NONE, 0, 0, 0);
        ExtMove* pcCur = pcList.begin();
        StateInfo pcSt;
        while (pcCur != pcList.end()) {
            Move m = pick_next(pcCur, pcList.end());
            if (m == excluded || !pos.legal(m)) continue;
            if (!pos.see_ge(m, probCutBeta - eval)) continue;

            pos.do_move(m, pcSt);
            C.tt.prefetch(pos.key());
            int value = -qsearch(C, pos, ss + 1, -probCutBeta, -probCutBeta + 1);
            if (value >= probCutBeta && probCutDepth > 0)
                value = -negamax<false>(C, pos, ss + 1, -probCutBeta, -probCutBeta + 1,
                                         probCutDepth, !cutNode);
            pos.undo_move(m);
            if (C.stop) return 0;

            if (value >= probCutBeta) {
                C.tt.store(tte, pos.key(), C.tt.value_to_tt(value, ss->ply), ss->ttPv,
                           BOUND_LOWER, probCutDepth + 1, m, rawEval);
                if (std::abs(value) < VALUE_MATE_IN_MAX_PLY)
                    return value - (probCutBeta - beta);
            }
        }
    }

    // #2a ProbCut, cheap TT-only variant (SF search.cpp:985-989): a stored LOWER
    // bound already far above beta at near-equal depth is enough to fail high here
    // without a move loop. Fires where the exact-depth TT cutoff above (which needs
    // tte->depth >= depth) can't, because it accepts a shallower entry (depth-4).
    if (C.tune.probCut && !PvNode && !ss->inCheck && !excluded && depth >= 3
        && ttHit && ttValue != VALUE_NONE && (tte->bound() & BOUND_LOWER)
        && tte->depth >= depth - 4 && ttValue >= beta + 418
        && std::abs(beta) < VALUE_MATE_IN_MAX_PLY
        && std::abs(ttValue) < VALUE_MATE_IN_MAX_PLY)
        return beta + 418;

    // ---- Move loop ----
    MoveList list;
    generate<ALL>(pos, list);
    Color us = pos.side_to_move();
    // #10: cumulative enemy-attack bitboards (pawns; +knights/bishops; +rooks),
    // used to reward quiets escaping a lesser attacker and penalize entering one.
    U64 threatByPawn = 0, threatByMinor = 0, threatByRook = 0;
    if (C.tune.threatOrder) {
        Color them = ~us;
        U64 occ = pos.pieces();
        U64 bb = pos.pieces(them, PAWN);
        while (bb) threatByPawn |= pawn_attacks(them, pop_lsb(bb));
        threatByMinor = threatByPawn;
        bb = pos.pieces(them, KNIGHT);
        while (bb) threatByMinor |= KnightAttacks[pop_lsb(bb)];
        bb = pos.pieces(them, BISHOP);
        while (bb) threatByMinor |= bishop_attacks(pop_lsb(bb), occ);
        threatByRook = threatByMinor;
        bb = pos.pieces(them, ROOK);
        while (bb) threatByRook |= rook_attacks(pop_lsb(bb), occ);
    }
    Move counter = (ss - 1)->currentMove ? C.counterMoves[pos.piece_on(to_sq((ss - 1)->currentMove))][to_sq((ss - 1)->currentMove)] : MOVE_NONE;
    // Continuation-history plane pointers are constant for every move at this
    // node (they key off the ply-1/ply-2 ancestor, not the candidate move), so
    // hoist them ONCE here rather than re-deriving + re-validating them per
    // candidate in score_moves, per LMR reduction read, and per cutoff update.
    int16_t* ch1 = nullptr;
    int16_t* ch2 = nullptr;
    int16_t* ch3 = nullptr;
    int16_t* ch4 = nullptr;
    int16_t* ch6 = nullptr;
    if (C.tune.contHist) {
        cont_hist_planes(C, ss, ch1, ch2, ch3, ch4, ch6);
        score_moves_cont(C, pos, list.begin(), list.end(), ttMove, ss, counter, ch1, ch2, ch3, ch4, ch6,
                          threatByPawn, threatByMinor, threatByRook);
    } else {
        score_moves(C, pos, list.begin(), list.end(), ttMove, ss, counter,
                    threatByPawn, threatByMinor, threatByRook);
    }

    ExtMove* cur = list.begin();
    // bestValue/maxValue are declared up at Step 5 (the Syzygy WDL probe), which may
    // already have seeded them — see the comment there. bestValue is -VALUE_INFINITE at
    // this point in every search that did not hit a tablebase, which is what it always was.
    Move bestMove = MOVE_NONE;
    int moveCount = 0;
    StateInfo st;

    Move quietsSearched[64];
    int quietCount = 0;
    Move capturesSearched[64];
    int captureCount = 0;

    while (cur != list.end()) {
        Move m = pick_next(cur, list.end());
        if (m == excluded) continue;
        if (!pos.legal(m)) continue;
        // MultiPV + Syzygy-rank root filter (SF search.cpp:1019): skip root moves already
        // emitted as an earlier PV line, and root moves in a lower DTZ rank group.
        // Guarded on root_filter_active() so the ordinary single-PV search never even
        // evaluates it — see root_move_in_play() for why that is an identity, not an
        // approximation.
        if (rootNode && root_filter_active(C) && !root_move_in_play(C, m)) continue;
        moveCount++;
        ss->moveCount = moveCount; // #10 PCM: a child reads (ss-1)->moveCount to learn
                                   // how late its parent tried the move that led into it.

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
        if (C.tune.lmrDepthPrune) {
            int red = C.Reductions[std::min(depth, 63)][std::min(moveCount, 63)];
            lmrDepth = std::max(depth - red, 0);
        }

        // Late move pruning + futility for quiets at low depth
        // D.0 (PARITY_GOMACHINE.md): every other pruning site above is !PvNode-gated;
        // this block wasn't, so it could prune quiets/captures inside our own PV.
        // Gated behind tune.pvGuard (env PVGUARD, default off) until SPRT'd.
        if (!rootNode && !(C.tune.pvGuard && PvNode) && bestValue > -VALUE_MATE_IN_MAX_PLY && pos.non_pawn_material(us)) {
            if (isQuiet) {
                int lmpLimit = (3 + depth * depth) / (2 - improving);
                // LMPHIST: widen/narrow the limit by this move's cached history (SP
                // search.cpp:1032). Floored at 2 so moveCount 1 is never LMP-pruned.
                if (C.tune.lmpHist) {
                    int hs = (cur - 1)->histScore;
                    if (hs != HIST_NONE) lmpLimit = std::max(2, lmpLimit + hs / C.tune.lmpHistDiv);
                }
                if (C.tune.lmp && moveCount >= lmpLimit && !givesCheck) continue;
                // HISTMARGIN (SF search.cpp:1084-1115): use THIS quiet's own history
                // (cached histScore = butterfly+conthist; HIST_NONE for killers/counters,
                // which are not history-pruned). (a) hard prune on very negative history;
                // (b) shift the futility/SEE margin depth by history so good-history quiets
                // get a looser margin (kept) and bad-history ones a tighter one (pruned).
                int futDepth = C.tune.lmrDepthPrune ? lmrDepth : depth;
                int seeDepth = depth;
                if (C.tune.histMargin) {
                    int hs = (cur - 1)->histScore;
                    if (hs != HIST_NONE) {
                        if (hs < -C.tune.histPruneCoeff * depth && !givesCheck) continue; // (a)
                        int shift = hs / C.tune.histMarginDiv;                             // (b)
                        futDepth = std::max(futDepth + shift, 0);
                        seeDepth = std::max(seeDepth + shift, 0);
                    }
                }
                // Futility pruning. FUTSFTERMS adds SF's two futility-value terms (prune less
                // with no bestMove yet / when staticEval already clears alpha). Off → 0 → identical.
                int futSfAdj = C.tune.futSfTerms
                    ? (C.tune.futNoMoveBonus * (bestMove == MOVE_NONE) + C.tune.futAlphaBonus * (eval > alpha))
                    : 0;
                bool futilityPrune = C.tune.lmrDepthPrune
                    ? (futDepth < 13 && eval + C.tune.futBase + C.tune.futSlope * futDepth + futSfAdj <= alpha)
                    : (C.tune.histMargin
                        ? (futDepth <= 6 && eval + C.tune.futBase + C.tune.futSlope * futDepth + futSfAdj <= alpha)
                        : (depth <= 6 && eval + C.tune.futBase + C.tune.futSlope * depth + futSfAdj <= alpha));
                if (C.tune.futility && !ss->inCheck && !givesCheck && futilityPrune)
                    continue;
                // SEE pruning of quiets
                // D.5 (SEEQUIETLINEAR): gomachine's tuned shape is linear (-75*depth,
                // depth<=6) rather than zugzwang's default quadratic (-seeQuietCoeff*
                // depth^2, depth<=8). Checked first so it wins over lmrDepthPrune's
                // shape too when both flags happen to be set (independent SPRT flags,
                // no shipped combination intended).
                bool seeQuietPrune = C.tune.seeQuietLinear
                    ? (depth <= 6 && !pos.see_ge(m, -75 * depth))
                    : C.tune.lmrDepthPrune
                        ? !pos.see_ge(m, -C.tune.seeQuietCoeff * lmrDepth * lmrDepth)
                        : C.tune.histMargin
                            ? (seeDepth <= 8 && !pos.see_ge(m, -C.tune.seeQuietCoeff * seeDepth * seeDepth))
                            : (depth <= 8 && !pos.see_ge(m, -C.tune.seeQuietCoeff * depth * depth));
                if (C.tune.quietSee && seeQuietPrune) continue;
            } else {
                // CAPFUT (SF search.cpp:1064-1072, sf-sp-search-backlog.md #1):
                // eval-based futility pruning for captures — a capture that can't
                // raise alpha even after adding the captured piece's value (plus a
                // capHist-scaled adjustment) is pruned before the SEE check below
                // ever runs. SF's exact gate: !givesCheck && lmrDepth < 7. `lmrDepth`
                // here is the same local computed above (raw `depth` unless
                // lmrDepthPrune is also on). Constants: see Tune::capFutBase/
                // capFutSlope/capFutHistCoeff comment for the pawn=100 / captHist
                // steady-state derivation. Default OFF; env CAPFUT=1 — OFF, this
                // whole block is skipped and the capture branch is byte-identical
                // to before.
                if (C.tune.capFut && !givesCheck && lmrDepth < 7) {
                    PieceType capFutVictim = (type_of_move(m) == EN_PASSANT)
                        ? PAWN : type_of(pos.piece_on(to_sq(m)));
                    int futilityValue = eval + C.tune.capFutBase
                        + C.tune.capFutSlope * lmrDepth + PieceVal[capFutVictim]
                        + C.tune.capFutHistCoeff
                          * C.captHist[piece_dense(mover)][to_sq(m)][capFutVictim] / 1024;
                    if (futilityValue <= alpha) continue;
                }

                // SEE pruning of captures
                // captHistPrune (build-on captHist, SF search.cpp:1077: margin =
                // max(166*depth + captHist/29, 0)): add a captHist-scaled term to zug's
                // flat coeff*depth margin. K=320 derivation: SF's max history swing is
                // its hard D-clamp (StatsEntry<int16_t,10692>), so captHist/29 maxes at
                // 10692/29 ~= 368.7, i.e. ~2.22x its per-depth coefficient (166). Zug's
                // captHist has no D-clamp but self-limits to ~16384 in steady state
                // (search.cpp:455's "house gravity trends to ~16k"); solving the same
                // 2.22 ratio against captSeeCoeff's default (23) gives
                // 16384/(2.22*23) ~= 320.
                int margin = C.tune.captSeeCoeff * depth;
                // CAPTHISTMARGIN: split of captHistPrune isolating just the margin
                // term (a) below, without the LMR-capture-enable (b) further down
                // (that bundle measured negative, likely due to (b)) — env-gated
                // independently so CAPTHISTMARGIN=1 alone tests (a) only.
                if (C.tune.captHistPrune || C.tune.captHistMargin) {
                    PieceType victim = (type_of_move(m) == EN_PASSANT)
                        ? PAWN : type_of(pos.piece_on(to_sq(m)));
                    margin += C.captHist[piece_dense(mover)][to_sq(m)][victim] / 320;
                    margin = std::max(margin, 0); // SF clamps the same way (search.cpp:1077)
                }
                if (depth <= C.tune.captSeeMaxDepth && !givesCheck && !pos.see_ge(m, -margin)) continue;
            }
        }

        // Singular extension
        // SINGTTPV (backlog #14): a former-PV node needs one more ply of depth before the
        // gate opens (SF: depth >= 6 + ss->ttPv). Off -> +0, byte-identical gate.
        if (!rootNode && depth >= C.tune.singularMinDepth + ((C.tune.singTtPv && ss->ttPv) ? 1 : 0)
            && m == ttMove && !excluded
            && tte->depth >= depth - 3 && (tte->bound() & BOUND_LOWER)
            && std::abs(ttValue) < VALUE_MATE_IN_MAX_PLY
            && !(C.tune.shuffleGuard && is_shuffling(m, ss, pos))) {
            int singularBeta = ttValue - C.tune.singularMargin * depth / 16; // default 32 -> exactly 2*depth
            // SINGTTPV margin term (SF search.cpp:1127 / SP search.cpp:1097): widen the
            // margin further on a former-PV, non-PV node. Off -> no-op, byte-identical.
            if (C.tune.singTtPv && ss->ttPv && !PvNode)
                singularBeta -= C.tune.singTtPvCoeff * depth / 16;
            ss->excludedMove = m;
            int s = negamax<false>(C, pos, ss, singularBeta - 1, singularBeta, (depth - 1) / 2, cutNode);
            ss->excludedMove = MOVE_NONE;
            if (s < singularBeta) {
                extension = 1;
                // #4 (SF search.cpp:1143): a SECOND ply only for a move that fails
                // verification by a wide margin, at a non-PV node. SF's raw margins
                // (negative for non-captures → double-extend routinely) explode zug's
                // tree ~2 plies without SF's corrVal/cutoffCnt damping, so this uses a
                // conservative POSITIVE margin and no triple tier. env DBLEXT=0.
                // TTMOVEHIST (SF search.cpp:1144): a well-trusted ttMove (high running
                // ttMoveHistory) lowers the double-ext margin — easier to double-extend;
                // a poorly-trusted one raises it. Conservative first cut: +-8192 swings
                // the base margin (default 64, DblExtMargin) by +-12 (~19%). Off -> plain
                // dblExtMargin, byte-identical to the old bare-64 literal at the default.
                int dblMargin = C.tune.ttMoveHist ? (C.tune.dblExtMargin - C.ttMoveHistory * 12 / TTMOVEHIST_D) : C.tune.dblExtMargin;
                // SINGCORRMARGIN: shrink the margin when the eval is uncertain (SF/SP).
                if (C.tune.singCorrMargin)
                    dblMargin -= (int)(std::abs(correction_raw(C, pos, ss)) / C.tune.singCorrDiv);
                if (C.tune.dblExt && !PvNode && s < singularBeta - dblMargin) {
                    extension = 2;
                    // TRIPLEEXT full margin (2026-07-24, SF search.cpp:1145-1146, sf_18
                    // cb3d4ee): tripleMargin = 73 + 302*PvNode - 248*!ttCapture +
                    // 90*ss->ttPv - corrValAdj - (ss->ply*2 > rootDepth*3)*50, corrValAdj =
                    // |correctionValue|/230673 (search.cpp:1142). SCALE: 73/302/248/90/50
                    // are SF-value-scale (pawn=208) bonuses/penalties compared against
                    // singularBeta-value, which in zug is cp-scale (pawn=100, ratio
                    // ~0.4808) -> 35/145/119/43/24. corrValAdj's divisor (230673) is
                    // already zug-scale-correct (matches SINGCORRMARGIN's singCorrDiv,
                    // see comment above). ss->ply / rootDepth are structural ply counts,
                    // ported as-is; C.rootDepthGlobal is zug's rootDepth (ID-loop depth,
                    // set once per iteration — search.cpp:3586-ish). PvNode is always
                    // false in this branch (outer `!PvNode` gate above) so its term is
                    // inert here; kept for formula fidelity.
                    // FLOOR: unlike SF, zug's dblMargin deliberately dropped SF's raw
                    // PvNode/!ttCapture swing (see the dblMargin comment above — porting
                    // it unguarded "explode[s] zug's tree ~2 plies"). Applying the same
                    // -119 !ttCapture swing here without a floor could push tripleMargin
                    // BELOW dblMargin for a quiet ttMove with no ttPv bonus (35-119 = -84
                    // vs dblMargin's ~52-76) — since this whole branch already satisfies
                    // `s < singularBeta - dblMargin`, a tripleMargin < dblMargin would
                    // make the triple tier fire on EVERY double extension, collapsing the
                    // "rare 3rd ply for an extremely-singular move" design. Floor at
                    // dblMargin + 16 (a small structural gap, not a value-scale constant)
                    // to keep the tiers strictly ordered.
                    if (C.tune.tripleExt) {
                        int corrValAdj = (int)(std::abs(correction_raw(C, pos, ss)) / C.tune.singCorrDiv);
                        int tripleMargin = 35 + 145 * (PvNode ? 1 : 0) - 119 * !ttCapture
                                          + 43 * (ss->ttPv ? 1 : 0) - corrValAdj
                                          - ((ss->ply * 2 > C.rootDepthGlobal * 3) ? 24 : 0);
                        tripleMargin = std::max(tripleMargin, dblMargin + 16);
                        if (s < singularBeta - tripleMargin) extension = 3;
                    }
                }
            }
            else if (singularBeta >= beta) {
                // TTMOVEHIST malus (SF search.cpp:1162): multi-cut means the ttMove
                // ISN'T singular after all — a mild malus to the running stat.
                if (C.tune.ttMoveHist)
                    ttmovehist_update(C.ttMoveHistory, std::max(-400 - 100 * depth, -4000));
                // SF search.cpp:1160: `else if (value >= beta && !is_decisive(value)) return value;`
                // — returns the singular-verification search score `value`, not the margin
                // `singularBeta`. `s` above is zug's equivalent verification score.
                if (C.tune.singRetScore && !is_mate_score(s)) return s;
                return singularBeta; // multi-cut
            }
            else if (C.tune.negExt) {
                // ttMove is provably NOT singular — SF's negative extension de-prioritizes a
                // move the TT overrates. Reuses the verification search already run (no new search).
                // NEGEXT3: SF's magnitudes are -3/-2 vs zug's default -2/-1.
                if (ttValue >= beta) extension = C.tune.negExt3 ? -3 : -2;
                else if (cutNode)    extension = C.tune.negExt3 ? -2 : -1;
            }
        }

        // Check extension — mutually exclusive with D.7's node-entry gmCheckExt
        // mechanism above (that one already extended `depth` for the whole node;
        // firing this per-move version too would double-extend a single check).
        if (!C.tune.gmCheckExt && givesCheck && extension == 0 && depth < 12) extension = 1;

        int newDepth = depth - 1 + extension;
        ss->currentMove = m;
        ss->currentPiece = mover;
        ss->didCapture = isCapture;

        // NODEEFFORT (SF search.cpp:1308): snapshot this Context's node count before
        // searching a root move, so the delta below can be attributed to it (SF's
        // `rm.effort += nodes - nodeCount`). Off, or not the root, -> stays 0 and the
        // read below is skipped entirely — no cost on the byte-identical-off path.
        int64_t nodeEffortBefore = (rootNode && C.tune.nodeEffort) ? C.nodeCount : 0;

        pos.do_move(m, st);
        C.tt.prefetch(pos.key());

        int score;
        bool doFullSearch;
        // Set only when the LMR branch actually reduced (d < newDepth) AND the
        // reduced scout beat alpha — i.e. this doFullSearch is genuinely the
        // post-LMR re-search (gomachine search.go:2703, `reduction > 0`). When
        // doFullSearch instead comes from the plain non-LMR scout (else branch
        // below — every capture/promotion, low-depth move, or early move count),
        // `score` has not been assigned yet, so doDeeper must NOT read it.
        bool wasLMRReduced = false;
        // NONLMRRED (backlog #12): 0/1/2-ply coarse reduction applied to the non-LMR
        // full-search depth below, computed inside the `else` branch. 0 (no-op) unless
        // Tune::nonLmrRed is on AND this move actually took the non-LMR path.
        int nonLmrRedPlies = 0;

        // Late Move Reductions
        // captHistPrune extends LMR to captures too (SF applies the same reduction
        // formula to every move, capture or quiet — zug's default gate is isQuiet-only).
        bool lmrEligible = isQuiet || (C.tune.captHistPrune && isCapture);
        if (C.tune.lmr && depth >= 3 && moveCount > C.tune.lmrMinMoves + (rootNode ? 1 : 0) && lmrEligible) {
            // r is x1024 fixed-point (SF search.cpp convention: newDepth - r/1024).
            // Every adjustment below is scaled to x1024 units so that, with all
            // fine-resolution flags off, r/1024 reproduces the old whole-ply r
            // EXACTLY (byte-identical) — see the final `red = r / 1024` below.
            int r = C.Reductions[std::min(depth, 63)][std::min(moveCount, 63)] * 1024;
            if (!PvNode) r += 1024;
            if (!improving) r += 1024;
            if (cutNode) r += 1024;
            if (C.tune.ttCapR && ttCapture) r += 1024;           // #3a (SF): ttMove-is-capture reduction
            if (C.tune.mcLinR) r -= (moveCount * 73 / 1024) * 1024; // #3b (SF): linear moveCount de-reduction (old whole-ply value, then x1024)
            if (givesCheck) r -= 1024;
            // #5 ttPv (SF): a former-PV node is tactically live — search its late
            // moves a little more carefully (reduce one ply less).
            if (C.tune.ttPvOn && ss->ttPv) {
                if (C.tune.ttPvRich) {
                    // Conditioned de-reduction (SF-structure, zug-native magnitudes):
                    // trust a former-PV node MORE when the TT itself corroborates the line.
                    int d = C.tune.ttPvBase;
                    if (PvNode)                       d += C.tune.ttPvPvW;
                    if (ttHit && ttValue > alpha)     d += C.tune.ttPvPromW;   // TT already likes it → escape the trap
                    if (ttHit && tte->depth >= depth) d += C.tune.ttPvDeepW + (cutNode ? C.tune.ttPvDeepCutW : 0);
                    r -= d;
                    // Negative half (folds in TTPVFAILLOW): TT says this ttPv node fails low → trust less.
                    if (ttHit && ttValue <= alpha)    r += C.tune.ttPvFailLowR;
                } else {
                    r -= 1024;
                    // TTPVFAILLOW: undo part of that de-reduction when this node's TT says it fails low.
                    if (C.tune.ttPvFailLow && ttHit && ttValue <= alpha) r += C.tune.ttPvFailLowR;
                }
            }
            // #6 (SF): a child that fails high a lot means siblings here are unlikely
            // to matter — reduce them harder.
            if (C.tune.cutoffCnt) {
                if (C.tune.cutoffGrade) {
                    // CUTOFFGRADE (SF search.cpp:1208-1209, VERIFIED): graded form,
                    // fires at >1, escalates at >2. allNode sub-term deliberately
                    // omitted — see Tune::cutoffGrade for why. SF's literal 256/1024
                    // are already in zug's native r x1024 convention (straight port).
                    if ((ss + 1)->cutoffCnt > 1)
                        r += C.tune.cutoffGradeBase + C.tune.cutoffGradeStep * ((ss + 1)->cutoffCnt > 2);
                } else if ((ss + 1)->cutoffCnt > 3) {
                    r += 1024;
                }
            }
            // cur was post-incremented by pick_next, so (cur-1) is THIS move's ExtMove.
            // With LMRHIST on, reuse the ordering-time butterfly+conthist sum for general
            // quiets instead of re-reading the conthist tables (NOT byte-identical: this
            // is the ordering-time value, not the move-time value — sibling subtree
            // cutoffs may have updated the tables since).
            int hist;
            if (!isQuiet) {
                // Capture reaching LMR — only possible when captHistPrune gated
                // lmrEligible above. Mirrors SF's capture statScore (search.cpp:1216):
                // 868*PieceValue[captured]/128 + captHist[...]. K=29 derivation: SF's
                // PieceValue term maxes at 868*QueenValue/128 = 17209, ~1.61x its
                // captHist D-clamp (10692). Zug's captHist self-limits to ~16384
                // (search.cpp:455); solving the same 1.61 ratio against zug's QueenVal
                // (900) gives K = 1.61*16384/900 ~= 29.
                PieceType victim = (type_of_move(m) == EN_PASSANT)
                    ? PAWN : type_of(pos.piece_on(to_sq(m)));
                hist = PieceVal[victim] * 29 + C.captHist[piece_dense(mover)][to_sq(m)][victim];
            } else if (C.tune.lmrHistCache && C.tune.contHist && (cur - 1)->histScore != HIST_NONE) {
                hist = (cur - 1)->histScore;
            } else {
                hist = C.history[us][from_sq(m)][to_sq(m)];
                // PIECETOHIST: same term score_moves_impl folds into its ordering/
                // histScore composite — see Tune::pieceToHist. Default off -> no-op.
                if (C.tune.pieceToHist && C.tune.pieceToLmr)
                    hist += C.pieceToHist[piece_dense(mover)][to_sq(m)] * C.tune.pieceToWeight / 256;
                if (C.tune.contHist) {
                    int off = piece_dense(mover) * SQUARE_NB + to_sq(m);
                    if (ch1) hist += ch1[off];
                    if (ch2) hist += ch2[off];
                    // CONTHISTPLIES: no-op (ch3/ch4/ch6 stay null) unless the flag is on.
                    if (ch3) hist += ch3[off];
                    if (ch4) hist += ch4[off];
                    if (ch6) hist += ch6[off];
                }
            }
            r -= (hist / 8000) * 1024;                            // old whole-ply value, then x1024
            // CORRMARGIN (SF search.cpp LMR reduction term): a large raw correction
            // means the eval driving this reduction decision is less trustworthy —
            // reduce less. Now that r is natively x1024, this is SF's exact term
            // (search.cpp: r -= std::abs(correctionValue) / 30370, correctionValue
            // being SF's raw pre-shift correction sum). Off -> no-op (corrMargin
            // default false).
            if (C.tune.corrMargin)
                r -= (int)(std::abs(correction_raw(C, pos, ss)) / C.tune.corrMarginDiv);
            // ALLNODELMR (SF search.cpp:1227): an "all" node (neither PV nor cut) is
            // expected to fail low on every move — reduce late moves progressively
            // harder the deeper we are. Self-ratio term: r is genuinely perturbed now
            // (verified live — stacks with CORRMARGIN to change node counts), unlike
            // the pre-x1024 port where it was a hard no-op. Tested in ISOLATION on
            // startpos/tactical positions it still nets to the same node count as
            // baseline: with no other fine term active, r stays an exact multiple of
            // 1024, so floor(r/1024) only moves when the bump reaches a full extra
            // 1024 — which only happens once the already-accumulated reduction k
            // exceeds depth (k >= depth+1), a regime std::max(1, newDepth-red) already
            // clamps to d=1 on both sides. Real effect requires another fine term
            // (CORRMARGIN/ROOTDELTALMR) to first break r off an exact 1024 multiple.
            if (C.tune.allNodeLmr && allNode) r += r / (depth + C.tune.allNodeDiv);
            // ROOTDELTALMR (SF search.cpp:1737: r -= delta * 608 / rootDelta, its r
            // being x1024): reduce less when this node's alpha-beta window is wide
            // relative to the root's aspiration window (this line is more "PV-like"
            // than its ancestors suggest). delta<=rootDelta holds structurally, the
            // same way it does in SF: every recursive call in negamax passes a
            // sub-window of its parent's (-alpha-1,-alpha / -beta,-alpha / null-move
            // and singular probes are all width<=parent), so window width is
            // non-increasing with depth; and C.rootDelta is re-synced to beta-alpha
            // immediately before *every* root negamax<true> call, including each
            // aspiration re-search after widening (see the ID loop below), so it
            // always matches the outermost window of the tree currently being
            // walked. Together these guarantee delta<=C.rootDelta for the whole
            // search, so the ratio saturates at 608 (x1024 units, ~0.59 ply) — far
            // less coarse than the old whole-ply `delta/rootDelta` term. The
            // std::max(1, ...) is only a divide-by-zero guard (SF never sees
            // rootDelta==0 since the aspiration window is always >0 wide).
            if (C.tune.rootDeltaLmr) {
                int delta = beta - alpha;
                r -= delta * C.tune.rootDeltaCoeff / std::max(1, C.rootDelta);
            }
            int red = r / 1024;
            int d;
            if (C.tune.lmrExt)
                d = std::max(1, std::min(newDepth - red, newDepth + C.tune.lmrExtCap)) + (PvNode ? 1 : 0);
            else
                d = std::max(1, std::min(newDepth - red, newDepth));
            ss->reduction = newDepth - d;
            score = -negamax<false>(C, pos, ss + 1, -alpha - 1, -alpha, d, true);
            ss->reduction = 0;
            doFullSearch = score > alpha && d < newDepth;
            wasLMRReduced = doFullSearch;
        } else {
            doFullSearch = !PvNode || moveCount > 1;
            // NONLMRRED (backlog #12, SF search.cpp:1263-1273): moves that skip the LMR
            // branch above still get a coarse reduction from a LOCALLY re-derived `r` —
            // SF computes ONE `r` per move and reads it in both branches, but this is
            // implemented as a self-contained duplicate (not a hoist out of the LMR `if`
            // above) so the LMR branch's own byte-identical-off behavior can't regress.
            // Every term here mirrors the LMR branch's r-assembly exactly (same tables,
            // same flags); only the final step differs — SF thresholds r into a 0/1/2-ply
            // depth cut instead of a per-ply `r/1024` reduction. Off, or when this move
            // didn't reach the non-LMR path, nonLmrRedPlies stays 0 (no-op).
            if (C.tune.nonLmrRed && doFullSearch) {
                int r2 = C.Reductions[std::min(depth, 63)][std::min(moveCount, 63)] * 1024;
                if (!PvNode) r2 += 1024;
                if (!improving) r2 += 1024;
                if (cutNode) r2 += 1024;
                if (C.tune.ttCapR && ttCapture) r2 += 1024;
                if (C.tune.mcLinR) r2 -= (moveCount * 73 / 1024) * 1024;
                if (givesCheck) r2 -= 1024;
                if (C.tune.ttPvOn && ss->ttPv) r2 -= 1024;
                if (C.tune.ttPvFailLow && ss->ttPv && ttHit && ttValue <= alpha) r2 += C.tune.ttPvFailLowR;
                if (C.tune.cutoffCnt) {
                    if (C.tune.cutoffGrade) {
                        if ((ss + 1)->cutoffCnt > 1)
                            r2 += C.tune.cutoffGradeBase + C.tune.cutoffGradeStep * ((ss + 1)->cutoffCnt > 2);
                    } else if ((ss + 1)->cutoffCnt > 3) {
                        r2 += 1024;
                    }
                }
                int hist2;
                if (!isQuiet) {
                    PieceType victim = (type_of_move(m) == EN_PASSANT)
                        ? PAWN : type_of(pos.piece_on(to_sq(m)));
                    hist2 = PieceVal[victim] * 29 + C.captHist[piece_dense(mover)][to_sq(m)][victim];
                } else if (C.tune.lmrHistCache && C.tune.contHist && (cur - 1)->histScore != HIST_NONE) {
                    hist2 = (cur - 1)->histScore;
                } else {
                    hist2 = C.history[us][from_sq(m)][to_sq(m)];
                    // PIECETOHIST: same term as the LMR-branch hist assembly above.
                    if (C.tune.pieceToHist && C.tune.pieceToLmr)
                        hist2 += C.pieceToHist[piece_dense(mover)][to_sq(m)] * C.tune.pieceToWeight / 256;
                    if (C.tune.contHist) {
                        int off = piece_dense(mover) * SQUARE_NB + to_sq(m);
                        if (ch1) hist2 += ch1[off];
                        if (ch2) hist2 += ch2[off];
                        if (ch3) hist2 += ch3[off];
                        if (ch4) hist2 += ch4[off];
                        if (ch6) hist2 += ch6[off];
                    }
                }
                r2 -= (hist2 / 8000) * 1024;
                if (C.tune.corrMargin)
                    r2 -= (int)(std::abs(correction_raw(C, pos, ss)) / C.tune.corrMarginDiv);
                if (C.tune.allNodeLmr && allNode) r2 += r2 / (depth + C.tune.allNodeDiv);
                if (C.tune.rootDeltaLmr) {
                    int delta = beta - alpha;
                    r2 -= delta * C.tune.rootDeltaCoeff / std::max(1, C.rootDelta);
                }
                // SF search.cpp:1265: bump r when there's no ttMove, then (1273) threshold
                // it into the 0/1/2-ply cut applied to the plain full-depth search below.
                if (!ttMove) r2 += C.tune.nonLmrNoTtR;
                nonLmrRedPlies = (r2 > C.tune.nonLmrT1) + (r2 > C.tune.nonLmrT2 && newDepth > 2);
            }
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
            if (C.tune.doDeeper && wasLMRReduced) {
                if (score > bestValue + 44 + 4 * newDepth) rd = newDepth + 1;
                else if (score < bestValue + newDepth) rd = std::max(1, newDepth - 1);
            } else if (C.tune.nonLmrRed && !wasLMRReduced) {
                // NONLMRRED: apply the coarse 0/1/2-ply cut computed in the else branch
                // above. wasLMRReduced is false here by construction (mutually exclusive
                // with the doDeeper branch, which requires wasLMRReduced), and
                // nonLmrRedPlies is 0 unless the flag is on — SF doesn't floor this at 1
                // either (its Depth is signed; a negative/zero result falls straight into
                // qsearch, exactly zug's `depth <= 0` entry check), so no clamp here.
                rd = newDepth - nonLmrRedPlies;
            }
            score = -negamax<false>(C, pos, ss + 1, -alpha - 1, -alpha, rd, !cutNode);
            // POSTLMRCH (SF search.cpp:1259, VERIFIED — see Tune::postLmrCh for the
            // full port-fidelity note): credit this move's continuation history for
            // surviving its LMR reduction. Gated on wasLMRReduced ALONE, matching SF
            // exactly — wasLMRReduced already encodes "the original reduced scout's
            // score beat alpha" (set above, before `score` was just reassigned by the
            // re-search on this line), so re-checking `score > alpha` here would
            // wrongly test the POST-re-search value instead. ch1..ch6 are the same
            // plane pointers hoisted once for this node (nullptr, hence a no-op, when
            // contHist is off — update_cont_hist already null-checks each). Default
            // off; env POSTLMRCH=1.
            if (C.tune.postLmrCh && wasLMRReduced)
                update_cont_hist(C, ch1, ch2, ch3, ch4, ch6, us, from_sq(m), mover, to_sq(m), C.tune.postLmrChBonus);
        }

        if (PvNode && (moveCount == 1 || score > alpha))
            score = -negamax<true>(C, pos, ss + 1, -beta, -alpha, newDepth, false);

        pos.undo_move(m);

        if (C.stop) return 0;

        // ---- Per-root-move bookkeeping (SF search.cpp:1305-1352) ----
        // Every root move that finishes its search updates its own RootMove: the node
        // cost it drew, a running average of its score, and — if it is this line's PV
        // move — its score and full PV. A move that neither is moveCount==1 nor beats
        // alpha is reset to -VALUE_INFINITE so the STABLE sort in the ID loop pushes
        // only the new PV to the front and leaves every other move's relative order
        // untouched (SF's own comment at 1349-1352).
        //
        // BYTE IDENTITY: none of this feeds a pruning/ordering decision inside the
        // tree. The only value read back by the searched tree is rootMoves[pvIdx].pv[0]
        // as the root ttMove, which reproduces C.rootBestMove exactly (see the TT-probe
        // comment above); rootBestMove/rootBestScore are still maintained verbatim.
        RootMove* rmp = rootNode ? find_root_move(C, m) : nullptr;
        if (rmp) { // rootNode, and `m` is (always) one of the generated legal root moves
            RootMove& rm = *rmp;

            // SF search.cpp:1308: unconditional for every root move, BEFORE the
            // new-best-move check — matches SF's ordering exactly. Kept gated on the
            // NODEEFFORT flag (the only consumer) so the default path is unchanged;
            // effort accumulates across every iteration of this start() call, since
            // rootMoves itself is rebuilt per call.
            if (C.tune.nodeEffort) rm.effort += C.nodeCount - nodeEffortBefore;

            // SF search.cpp:1310-1311. Seeds the aspiration window for pvIdx>0 lines
            // ONLY — line 0 deliberately keeps zug's prevScore seeding (see the ID loop).
            rm.avgScore = rm.avgScore != -VALUE_INFINITE ? (score + rm.avgScore) / 2 : score;

            if (moveCount == 1 || score > alpha) {
                rm.score = score;
                // SF search.cpp:1336-1343: pv[0] is this move, the tail is the child's
                // PV. Identical construction to zug's own ss->pv copy a few lines below
                // (same (ss+1)->pv, same moment), so rootMoves[0].pv == ss->pv whenever
                // the search finished in-window — which is the only state ever published.
                rm.pv.assign(1, m);
                for (int i = 0; i < (ss + 1)->pvLen; ++i) rm.pv.push_back((ss + 1)->pv[i]);

                // SF search.cpp:1346: a later move (moveCount>1) overtaking alpha counts as
                // a PV change this iteration — the raw signal behind bestMoveInstability.
                // SF restricts it to line 0 (`&& !pvIdx`); zug's time management only ever
                // ran single-PV, so keep it exactly that way.
                // Both of these describe LINE 0 (the actual best move of the search) —
                // a pvIdx>0 line's alpha-raiser is the best of the *remaining* moves and
                // must never clobber them. pvIdx is always 0 at multiPV==1, so the guard
                // is inert on the single-PV path.
                if (C.pvIdx == 0) {
                    if (C.tune.nodeEffort && moveCount > 1) ++C.rootBestMoveChangesIter;
                    C.rootBestMove = m;
                    C.rootBestScore = score;
                }
            } else {
                rm.score = -VALUE_INFINITE;
            }
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
                if (PvNode && score < beta) {
                    alpha = score;
                    // #11 (SF search.cpp:1380): once a good non-decisive move is in,
                    // shrink remaining depth for later moves (they increasingly just
                    // fail low against the tighter window).
                    if (C.tune.depthDrop && depth > 2 && depth < 14
                        && std::abs(score) < VALUE_MATE_IN_MAX_PLY)
                        depth -= 2;
                }
                else {
                    // #6: track this node's beta-cutoff count for the LMR bump above.
                    if (C.tune.cutoffCnt) ss->cutoffCnt += ((extension < 2) || PvNode);
                    break; // fail high
                }
            }
        }

        if (isQuiet && quietCount < 64) quietsSearched[quietCount++] = m;
        else if (isCapture && captureCount < 64) capturesSearched[captureCount++] = m;
    }

    // Checkmate / stalemate
    if (moveCount == 0)
        return excluded ? alpha : (ss->inCheck ? mated_in(ss->ply) : VALUE_DRAW);

    // Update killers / history on beta cutoff
    if (bestMove != MOVE_NONE && bestValue >= beta) {
        // TTMOVEHIST (SF search.cpp:1420): reward the running stat when the ttMove
        // held up as bestMove, penalize when some other move cut instead. SF gates
        // this on !PvNode only (fires whenever bestMove is set, not just on a beta
        // cutoff); this block only runs on cutoff, so it's a subset of SF's site —
        // still the natural spot since bestMove/ttMove/PvNode are all in scope here.
        if (C.tune.ttMoveHist && !PvNode)
            ttmovehist_update(C.ttMoveHistory, bestMove == ttMove ? 809 : -865);
        int bonus = depth * depth;
        // HISTTTBONUS (#8b): a ttMove-that-held-up gets an extra positive history bonus.
        // Applied ONLY to bestMove's +bonus writes below, never to the malus. Off → +0.
        int bestBonus = bonus;
        if (C.tune.histTtBonus && bestMove == ttMove) bestBonus = bonus + C.tune.histTtBonusVal;
        // HISTTAPER (#8c): precompute the per-quiet malus, tapering late tries exactly
        // as SF search.cpp:1841-1850 does. `rank` counts non-best searched quiets
        // (1-indexed) — NOT the array slot, since zug's quietsSearched includes bestMove.
        // Off (or rank<=K) → tMalus[i] == -bonus, so every write is byte-identical.
        int tMalus[64];
        {
            int rank = 0;
            for (int i = 0; i < quietCount; ++i) {
                if (quietsSearched[i] == bestMove) { tMalus[i] = 0; continue; }
                ++rank;
                int mal = -bonus;
                if (C.tune.histTaper && rank > C.tune.histTaperK)
                    mal -= mal * (rank - C.tune.histTaperK) / rank;
                tMalus[i] = mal;
            }
        }
        if (!pos.is_capture(bestMove) && type_of_move(bestMove) != PROMOTION) {
            if (ss->killers[0] != bestMove) {
                ss->killers[1] = ss->killers[0];
                ss->killers[0] = bestMove;
            }
            update_history(C, us, bestMove, bestBonus);
            for (int i = 0; i < quietCount; ++i)
                if (quietsSearched[i] != bestMove)
                    update_history(C, us, quietsSearched[i], tMalus[i]);
            // PIECETOHIST: mirrors the butterfly bestMove/malus updates above in
            // lockstep (SP updateMainHistory updates butterfly+pieceTo together).
            // Every move in this branch is already verified quiet by the outer
            // !is_capture(bestMove) && !PROMOTION gate.
            if (C.tune.pieceToHist) {
                update_piece_to_hist(C, pos.moved_piece(bestMove), to_sq(bestMove), bestBonus);
                for (int i = 0; i < quietCount; ++i)
                    if (quietsSearched[i] != bestMove)
                        update_piece_to_hist(C, pos.moved_piece(quietsSearched[i]), to_sq(quietsSearched[i]), tMalus[i]);
            }
            if (C.tune.lowPlyHist && ss->ply < 5) {
                update_low_ply_hist(C, ss->ply, bestMove, bestBonus);
                for (int i = 0; i < quietCount; ++i)
                    if (quietsSearched[i] != bestMove)
                        update_low_ply_hist(C, ss->ply, quietsSearched[i], tMalus[i]);
            }
            if (C.tune.pawnOrderHist) {
                // pos is back at the pre-move-loop position here (same guard
                // update_cont_hist/update_capt_hist above rely on), so
                // moved_piece() is valid for bestMove and every searched quiet.
                update_pawn_order_hist(C, pos, pos.moved_piece(bestMove), to_sq(bestMove), bestBonus);
                for (int i = 0; i < quietCount; ++i)
                    if (quietsSearched[i] != bestMove)
                        update_pawn_order_hist(C, pos, pos.moved_piece(quietsSearched[i]), to_sq(quietsSearched[i]), tMalus[i]);
            }
            if (C.tune.contHist) {
                // pos is back at the pre-move-loop position here (every iteration
                // above paired do_move with undo_move), so moved_piece() is valid.
                // ch1/ch2 were hoisted once for this node above the move loop —
                // reuse them here instead of re-deriving the parent key.
                update_cont_hist(C, ch1, ch2, ch3, ch4, ch6, us, from_sq(bestMove),
                                 pos.moved_piece(bestMove), to_sq(bestMove), bestBonus);
                for (int i = 0; i < quietCount; ++i)
                    if (quietsSearched[i] != bestMove)
                        update_cont_hist(C, ch1, ch2, ch3, ch4, ch6, us, from_sq(quietsSearched[i]),
                                         pos.moved_piece(quietsSearched[i]), to_sq(quietsSearched[i]), tMalus[i]);
            }
            if ((ss - 1)->currentMove)
                C.counterMoves[pos.piece_on(to_sq((ss - 1)->currentMove))][to_sq((ss - 1)->currentMove)] = bestMove;
        } else if (C.tune.captHist && pos.is_capture(bestMove)) {
            // Best move was a capture: reward it in capture history.
            PieceType vic = (type_of_move(bestMove) == EN_PASSANT) ? PAWN
                                                                   : type_of(pos.piece_on(to_sq(bestMove)));
            update_capt_hist(C, pos.moved_piece(bestMove), to_sq(bestMove), vic, bestBonus);
        }
        // Penalize every searched-but-not-best capture (on ANY cutoff — a capture tried
        // that didn't cut is bad ordering). pos is back at the node position here, so
        // moved_piece()/piece_on() are valid.
        if (C.tune.captHist) {
            for (int i = 0; i < captureCount; ++i) {
                Move cm = capturesSearched[i];
                if (cm == bestMove) continue;
                PieceType vic = (type_of_move(cm) == EN_PASSANT) ? PAWN
                                                                 : type_of(pos.piece_on(to_sq(cm)));
                update_capt_hist(C, pos.moved_piece(cm), to_sq(cm), vic, -bonus);
            }
        }
    }

    // #10 PCM (see Tune::pcm): fail-low parent-move credit. Fires when THIS node failed
    // low (no bestMove) after searching >=1 move, the parent move exists and was quiet,
    // and we're not inside a singular verification (!excluded). Credits the opponent's
    // refuting move in ~us butterfly history, weighted by the surprise of the refutation.
    if (C.tune.pcm && bestMove == MOVE_NONE && moveCount > 0 && ss->ply > 0 && !excluded) {
        Move pm = (ss - 1)->currentMove;
        if (pm != MOVE_NONE && pm != MOVE_NULL && !(ss - 1)->didCapture) {
            int weight = C.tune.pcmBase
                + std::min(depth * C.tune.pcmDepthW, C.tune.pcmDepthMax)
                + ((ss - 1)->moveCount >= 8 ? C.tune.pcmParentMcW : 0)
                + ((!ss->inCheck && bestValue <= ss->staticEval - C.tune.pcmSeThresh) ? C.tune.pcmSeW : 0)
                + (((ss - 1)->staticEval != VALUE_NONE
                    && bestValue <= -(ss - 1)->staticEval - C.tune.pcmParentSeThr) ? C.tune.pcmParentSeW : 0);
            if (weight > 0) {
                int pcmBonus = depth * depth * weight / C.tune.pcmDiv;
                update_history(C, ~us, pm, pcmBonus);
                // PIECETOHIST: mirrors the butterfly fail-low credit above in lockstep.
                // Extra promotion exclusion (this block's own gate only checks
                // !didCapture) so the table only ever sees genuine quiets.
                if (C.tune.pieceToHist && type_of_move(pm) != PROMOTION)
                    update_piece_to_hist(C, (ss - 1)->currentPiece, to_sq(pm), pcmBonus);
            }
        }
    }

    // Apply the Step-5 tablebase CEILING (~sf18-arm/src/search.cpp:1455-1456, verbatim
    // including the PvNode guard and the placement — after every history update, before
    // the ttPv propagation and the TT store, so both of those see the capped value).
    // maxValue is VALUE_INFINITE unless a WDL probe reported a loss whose value did not
    // fall below alpha, so this is the identity in every search that never hit a table.
    //
    // The `moveCount == 0` early return above deliberately bypasses it, unlike SF (which
    // assigns bestValue there and falls through). That is not reachable with effect: a
    // node with no legal moves is mate or stalemate, and a probe that set maxValue said
    // "the side to move is LOST", which rules stalemate out and makes mated_in(ply) — the
    // value that return produces — already lower than any maxValue a loss can carry.
    if (PvNode) bestValue = std::min(bestValue, maxValue);

    // #5 ttPv: a node that fails low keeps its PV bit if its parent was on a PV —
    // SF propagates the "was live" mark forward so pruning stays cautious there.
    if (C.tune.ttPvOn && !excluded && bestValue <= alpha && ss->ply > 0)
        ss->ttPv = ss->ttPv || (ss - 1)->ttPv;

    // SF search.cpp:1465, `if (!excludedMove && !(rootNode && pvIdx))`: a pvIdx>0 root
    // search only looked at a SUBSET of the root moves, so its bestValue is not the true
    // value of this position — storing it would poison the shared TT for every later
    // line (and for the next iteration's line 0). No-op at pvIdx==0, hence byte-identical
    // on the single-PV path.
    if (!excluded && !(rootNode && C.pvIdx)) {
        Bound b = bestValue >= beta ? BOUND_LOWER
                : (PvNode && bestMove) ? BOUND_EXACT : BOUND_UPPER;
        C.tt.store(tte, pos.key(), C.tt.value_to_tt(bestValue, ss->ply),
                   C.tune.ttPvOn ? ss->ttPv : PvNode, b, depth,
                   bestMove, ss->inCheck ? VALUE_NONE : rawEval);

        // Correction history update (§CorrHist, negamax only — never qsearch).
        // Excluded (singular-verification) nodes must not teach it either, hence
        // this living inside the same `!excluded` guard as the TT store.
        if (!ss->inCheck)
            update_corrhist(C, pos, ss, ss->staticEval, bestValue, depth, bestMove);
    }

    return bestValue;
}

// Emit "score cp N" / "score mate N" for one line, in this engine's mate-distance
// convention. Factored out of print_pv so the single-PV and MultiPV branches can
// never drift apart.
void print_score(int score) {
    if (is_mate_score(score)) {
        int mateIn = (score > 0 ? (VALUE_MATE - score + 1) : -(VALUE_MATE + score)) / 2;
        std::cout << "mate " << mateIn;
    } else {
        std::cout << "cp " << score;
    }
}

void print_pv(Context& C, Position& pos, Stack* ss, int depth, int score, int64_t nodes) {
    (void)pos;
    int64_t ms = elapsed(C);
    int64_t nps = ms > 0 ? nodes * 1000 / ms : 0;

    // Single PV: byte-for-byte the line this engine has always printed. NO `multipv`
    // token — a GUI/SPRT/CCRL parser sees an unchanged stream, and so does
    // test/multipv_identity.sh, whose whole job is to prove that.
    if (C.multiPV <= 1) {
        std::cout << "info depth " << depth << " score ";
        // Syzygy root score override (SF search.cpp:2138-2139). No-op unless the root was
        // DTZ-ranked; see reported_score(). rootMoves[0] IS line 0 here — the ID loop
        // stable-sorts it to the front after every root search.
        print_score(reported_score(C, score, C.rootMoves.empty() ? nullptr : &C.rootMoves[0]));
        std::cout << " nodes " << nodes << " nps " << nps
                  << " time " << ms << " hashfull " << C.tt.hashfull() << " pv";
        for (int i = 0; i < ss->pvLen; ++i)
            std::cout << " " << move_to_uci(ss->pv[i]);
        std::cout << std::endl;
        return;
    }

    // MultiPV: one `info ... multipv i ...` line per PV, best first (SF search.cpp:2124
    // — `for (i = 0; i < multiPV; ++i) ... info.multiPV = i + 1`). rootMoves is already
    // sorted descending by the ID loop, so index order IS rank order and the scores come
    // out non-increasing. All lines carry the same `depth`, which is the entire point of
    // real MultiPV. `multipv` goes right after `depth`, as SF orders it.
    int n = std::min<int>(C.multiPV, static_cast<int>(C.rootMoves.size()));
    for (int i = 0; i < n; ++i) {
        const RootMove& rm = C.rootMoves[i];
        if (rm.score == -VALUE_INFINITE) break; // line never completed (interrupted iteration)
        std::cout << "info depth " << depth << " multipv " << (i + 1) << " score ";
        print_score(reported_score(C, rm.score, &rm));
        std::cout << " nodes " << nodes << " nps " << nps
                  << " time " << ms << " hashfull " << C.tt.hashfull() << " pv";
        for (Move m : rm.pv)
            std::cout << " " << move_to_uci(m);
        std::cout << std::endl;
    }
}

void set_time_limits(Context& C, const Position& pos) {
    C.timeLimitSoft = C.timeLimitHard = 0;
    C.tmScaled = false;
    if (C.limits.movetime) {
        // std::max(1, ...): `movetime - 5` hits exactly 0 whenever movetime==5
        // (a real, common value — e.g. multi_pv()'s per-move time budget floors
        // at 5ms whenever a position has enough legal moves). 0 is the "no
        // limit" sentinel every check_time()/start() caller below tests via
        // `if (C.timeLimitHard && ...)`, so an unclamped `movetime - 5` would
        // silently DISABLE the time cutoff right when the caller asked for the
        // shortest possible search — the iterative-deepening loop then runs
        // unbounded (up to MAX_PLY), hanging that search (and, in the pool,
        // permanently starving one Context) instead of returning in ~5ms.
        C.timeLimitSoft = C.timeLimitHard = std::max(1, C.limits.movetime - 5);
        return;
    }
    Color us = pos.side_to_move();
    int t = C.limits.time[us];
    int inc = C.limits.inc[us];
    if (t <= 0 && inc <= 0) return; // depth/nodes/infinite mode
    // Reserve overhead for GUI communication + OS scheduling jitter (+ network latency in
    // online play). Configurable via the "MoveOverhead" UCI option (Tune::moveOverhead,
    // default 40 = the old hardcoded literal → byte-identical default behaviour).
    int overhead = C.tune.moveOverhead;
    int usable = std::max(1, t - overhead);

    if (C.tune.timeMan) {
        // TIMEMAN base allocation (Stormphrax limit.cpp:34-44): a cleaner soft/hard split.
        //   base = usable/mtg + inc*0.94 ;  hard = usable*0.65 ;  soft = min(base*0.68, hard)
        // The per-iteration soft-limit SCALING (best-move stability + eval trend) is applied
        // in start()'s ID loop against C.timeLimitSoft, not here. mtg defaults to 19 (SP's
        // defaultMovesToGo) rather than zug's old 30 — a shorter horizon spends more per move.
        int mtg = C.limits.movestogo ? C.limits.movestogo : 19;
        int base = std::max(1, usable / mtg + inc * 94 / 100);
        C.timeLimitHard = std::max(1, usable * 65 / 100);

        // TMFALLING (b) (SF timeman.cpp:106-134, VERIFIED directly against
        // ~sf18-arm/src, tag sf_18): ply-growth base-allocation shape. SF's real
        // formula (`optScale = min(0.0121431 + pow(ply+2.94693,0.461073)*optConstant,
        // 0.213035*limits.time[us]/timeLeft) * originalTimeAdjust`, with optConstant
        // itself a small log10(time)-dependent term) is built entirely around a
        // `timeLeft`/per-move-horizon percentage model zug doesn't have — reimplementing
        // that wholesale isn't "sound, minimal plumbing" for an opt-in flag, so only the
        // ply/log-time SHAPE is carried over: a bounded multiplier on the existing flat
        // `base` above, 1.0 (no-op) at the game's first move, growing gently with game
        // ply and damped when little time is banked. `ply` here is SF's game_ply (moves
        // played so far in the GAME, not search depth) — SF passes pos.game_ply() into
        // TimeManagement::init once per search; zug derives the equivalent from the FEN
        // fullmove counter + side to move (structural/ply term, ported as-is, no
        // value-scale rescale — it's a move count, not a cp value).
        if (C.tune.tmFalling) {
            int gamePly = 2 * (pos.fullmove_number() - 1) + (pos.side_to_move() == BLACK ? 1 : 0);
            double plyShape = std::pow(gamePly + 2.94693, 0.461073) / std::pow(2.94693, 0.461073);
            double logTimeSec = std::log10(std::max(1, usable) / 1000.0);
            // Damp the ply growth's reach when little time is banked (qualitatively
            // mirrors SF's own timeLeft-coupled cap on optScale — a short clock caps how
            // far the multiplier can run away): clamp so the factor is 1.0 (no growth) at
            // ply 0 and never more than doubles the base allocation.
            double damp   = std::clamp(1.0 + 0.15 * logTimeSec, 0.4, 1.0);
            double factor = std::clamp(1.0 + (plyShape - 1.0) * damp, 1.0, 2.0);
            base = std::max(1, (int) std::llround(base * factor));
        }

        C.timeLimitSoft = std::min<int64_t>(base * 68 / 100, C.timeLimitHard);
        if (C.timeLimitSoft < 1) C.timeLimitSoft = 1;
        C.tmScaled = true; // enable start()'s per-iteration soft-limit scaling
        return;
    }

    // Legacy (default) allocation — unchanged from before MoveOverhead/TIMEMAN, except the
    // overhead literal is now the (default-40) UCI knob above, so this is byte-identical
    // whenever MoveOverhead is left at its default.
    int mtg = C.limits.movestogo ? C.limits.movestogo : 30;
    // Use most of the increment plus a slice of remaining time.
    int budget = std::max(1, usable / mtg + inc * 3 / 4);
    C.timeLimitSoft = std::min(budget, usable);
    // Hard cap: never risk the clock — stay well under remaining time.
    C.timeLimitHard = std::min(usable / 2, budget * 3);
    if (C.timeLimitHard < 1) C.timeLimitHard = 1;
    if (C.timeLimitSoft > C.timeLimitHard) C.timeLimitSoft = C.timeLimitHard;
    if (C.timeLimitSoft < 1) C.timeLimitSoft = 1;
}

// ---- default_context(): the single Context used by the UCI CLI path ----
// Bound to the pre-existing global TT (tt.h/tt.cpp, unchanged) and a
// dedicated stop flag (request_stop()) — so `TT.resize()`/`TT.clear()` calls
// from uci.cpp still resize/clear exactly the table the UCI search reads,
// and the "stop"/"quit" commands still interrupt the running search exactly
// as before. Nothing about the UCI path's behavior changes.
std::atomic<bool> defaultStop{false};
std::unique_ptr<Context> defaultCtxPtr;

Context& default_ctx_ref() {
    if (!defaultCtxPtr) defaultCtxPtr = std::make_unique<Context>(::TT, defaultStop);
    return *defaultCtxPtr;
}

// ---- Concurrent search-GROUP pool (HTTP serve mode) ----
// G groups, each a K-worker SearchGroup with its own TT + stop flag. A handler
// leases a whole group (GroupLease) and runs a K-thread Lazy-SMP search on it;
// up to G run concurrently (peak G*K threads). free_ holds the currently-idle
// groups; the mutex/cv give the same blocking-lease semantics the old
// per-Context pool had.
struct GroupPool {
    std::mutex m;
    std::condition_variable cv;
    std::vector<std::unique_ptr<SearchGroup>> groups;
    std::vector<SearchGroup*> free_;
    int threadsPerGroup = 1;
};

GroupPool& gpool() {
    static GroupPool p;
    return p;
}

// ---- Lazy SMP shared state ----
//
// smpStop is the ONE shared cancellation flag every SMP worker Context binds
// its `stop` to. It is deliberately SEPARATE from defaultStop (the single-thread
// UCI path's flag) so Threads=1 (which runs on default_context / defaultStop) is
// completely untouched. request_stop() sets both, so the UCI "stop"/"quit"
// commands cancel whichever path is live.
std::atomic<bool> smpStop{false};

// Persistent SMP worker Contexts, all bound to the GLOBAL TT (::TT) and to
// smpStop, so they cooperate through one shared transposition table (classic
// Lazy SMP). Created lazily up to the requested thread count and reused across
// searches. Grown only from the driver thread BEFORE any worker thread is
// spawned, so the vector itself is never mutated concurrently.
std::vector<std::unique_ptr<Context>> smpContexts;

Context& smp_context(int i) {
    while ((int)smpContexts.size() <= i) {
        auto c = std::make_unique<Context>(::TT, smpStop);
        build_reductions(*c);
        smpContexts.push_back(std::move(c));
    }
    return *smpContexts[i];
}

// Final UCI report for an SMP search: exactly one "info" line (from the chosen
// worker's completed iteration) and exactly one "bestmove" line. During the SMP
// search every worker runs silent (limits.silent=true), so this is the only
// UCI output — guaranteeing the single bestmove line UCI requires.
void print_smp_result(const Result& r, int64_t startTime, int multiPV) {
    int64_t ms = now_ms() - startTime;
    int64_t nps = ms > 0 ? r.nodes * 1000 / ms : 0;
    if (multiPV <= 1) {
        // Byte-identical to the pre-MultiPV single info line — no `multipv` token.
        std::cout << "info depth " << r.depth << " score ";
        print_score(r.score);
        std::cout << " nodes " << r.nodes << " nps " << nps << " time " << ms
                  << " hashfull " << TT.hashfull() << " pv";
        for (Move m : r.pv) std::cout << " " << move_to_uci(m);
        std::cout << std::endl;
    } else {
        // The CHOSEN worker's whole line set — never a merge across workers (see
        // run_lazy_smp: lines from different threads come from different trees and
        // are not mutually comparable).
        for (size_t i = 0; i < r.lines.size(); ++i) {
            const Line& ln = r.lines[i];
            std::cout << "info depth " << ln.depth << " multipv " << (i + 1) << " score ";
            print_score(ln.score);
            std::cout << " nodes " << r.nodes << " nps " << nps << " time " << ms
                      << " hashfull " << TT.hashfull() << " pv";
            for (Move m : ln.pv) std::cout << " " << move_to_uci(m);
            std::cout << std::endl;
        }
    }
    std::cout << "bestmove " << move_to_uci(r.bestMove);
    if (r.pv.size() > 1 && r.pv[0] == r.bestMove) // ponder move = 2nd PV move (SF search.cpp:246)
        std::cout << " ponder " << move_to_uci(r.pv[1]);
    std::cout << std::endl;
}

// ---- Lazy SMP core (shared by the UCI start_smp path and the serve
// start_group path) ----
//
// Runs one search over `workers` (K Context*), all sharing `tt` + `stop`.
// This is the ONE place the fan-out lives; start_smp() drives it with the
// global smpContexts + ::TT + smpStop, start_group() drives it with a leased
// group's workers + its own TT + its own stop flag. Never prints — the caller
// owns any UCI stdout (start_smp prints once via print_smp_result; serve runs
// silent). Returns the best-thread-voted Result with an aggregate node count.
//
// K==1 is the exact single-thread fast path: NO threads are spawned, and
// start() runs with its default resetShared=true (clears `stop`, bumps `tt`),
// so the tree, the bestmove and the node count are byte-identical to a plain
// start(*workers[0], pos, limits). This is what makes -search-threads 1 (and
// UCI Threads=1, which never reaches here) behave exactly as before.
// SMPVOTE env kill-switch, read once (Lazy-SMP best-thread vote weighting).
static bool smp_vote_enabled() {
    static const bool v = []{ const char* e = std::getenv("SMPVOTE"); return e && e[0] == '1'; }();
    return v;
}

// SMPDIV env kill-switch, read once (per-worker aspiration-window diversity — the
// co-designed partner of SMPVOTE: it makes the Lazy-SMP threads diverge so the vote
// has genuinely different results to weigh).
static bool smp_div_enabled() {
    static const bool v = []{ const char* e = std::getenv("SMPDIV"); return e && e[0] == '1'; }();
    return v;
}

Result run_lazy_smp(std::vector<Context*>& workers, TranspositionTable& tt,
                    std::atomic<bool>& stop, Position& rootPos, const Limits& limits) {
    int threads = static_cast<int>(workers.size());
    if (threads <= 1)
        return start(*workers[0], rootPos, limits); // resetShared=true: byte-identical single thread

    // Shared side-effects, done exactly ONCE (workers pass resetShared=false):
    // clear the shared stop flag and bump the shared TT generation. After this
    // point tt.generation is only READ by probe/store — no write race. Within a
    // group the K workers share `tt` with NO locks: torn reads fail the key16
    // low-bit verification (tt.cpp, commit d43d489) and are treated as a miss.
    stop = false;
    tt.new_search();

    // Per-worker Limits: every worker runs silent (the caller prints, if at
    // all), and any explicit node budget is split across workers so the
    // AGGREGATE node count ~= limits.nodes. Movetime/time/depth are shared
    // unchanged (all workers derive the same hard deadline from startTime).
    Limits shared = limits;
    shared.silent = true;
    if (shared.nodes > 0)
        shared.nodes = std::max<int64_t>(1, shared.nodes / threads);

    // Independent Position copy per worker (self-contained search root; search
    // only pushes NEW StateInfos on each worker's own do_move stack). rootPos
    // stays alive + unmutated for the whole search (caller joins before reuse).
    std::vector<Position> positions(threads, rootPos);
    std::vector<Result>   results(threads);
    // NativeThread, not std::thread: each helper runs the same start() the driver does,
    // and macOS hands a plain std::thread only ~544KB of stack — not enough for a search
    // that recurses past ~86 plies (native_thread.h has the measurements).
    std::vector<zug::NativeThread> helpers;
    helpers.reserve(threads - 1);

    // Tag each worker with its index (SMPDIV reads it for per-thread aspiration
    // diversity; harmless no-op when SMPDIV is off).
    for (int i = 0; i < threads; ++i) workers[i]->threadIdx = i;

    // Helpers: workers 1..threads-1. resetShared=false — they must NOT touch
    // the shared stop/generation (that would race the driver's one-time reset).
    for (int i = 1; i < threads; ++i)
        helpers.emplace_back([i, &results, &positions, &workers, shared]() {
            results[i] = start(*workers[i], positions[i], shared, /*resetShared=*/false);
        });

    // Worker 0 runs inline on the calling thread.
    results[0] = start(*workers[0], positions[0], shared, /*resetShared=*/false);

    // Driver finished (soft-time / stop): force every still-running helper to
    // stop at its next node-count check, then join them ALL before returning
    // (so no helper can outlive the group / touch its Contexts after release).
    stop = true;
    for (auto& t : helpers) t.join();

    // Best-thread selection. Default: greatest depth, tie -> greatest score.
    // SMPVOTE=1 (default off): SF-style vote-weighted selection
    // (~sf18-arm/src/thread.cpp get_best_thread). Each thread votes for its own
    // bestMove with weight (score - minScore + 14) * completedDepth; the move with
    // the highest total vote wins, so a consensus move beats a lone thread that
    // merely reached one ply deeper. Proven wins prefer the shortest mate; proven
    // losses prefer the longest survival — same overrides as SF. Default-off path
    // below is byte-identical to the prior depth/score pick.
    int best = 0;
    if (smp_vote_enabled()) {
        auto is_win  = [](int s){ return s >=  VALUE_MATE_IN_MAX_PLY; };
        auto is_loss = [](int s){ return s <= -VALUE_MATE_IN_MAX_PLY; };
        int minScore = VALUE_INFINITE;
        for (const Result& r : results)
            if (r.bestMove != MOVE_NONE) minScore = std::min(minScore, r.score);
        // O(threads^2) vote tally (threads is small); vote[i] = sum over threads j
        // that also picked results[i].bestMove of (score_j - minScore + 14)*depth_j.
        auto voteFor = [&](int i) -> int64_t {
            int64_t v = 0;
            for (int j = 0; j < threads; ++j)
                if (results[j].bestMove != MOVE_NONE && results[j].bestMove == results[i].bestMove)
                    v += int64_t(results[j].score - minScore + 14) * results[j].depth;
            return v;
        };
        for (int i = 1; i < threads; ++i) {
            const Result& ri = results[i];
            const Result& rb = results[best];
            if (ri.bestMove == MOVE_NONE) continue;
            if (rb.bestMove == MOVE_NONE) { best = i; continue; }
            bool take;
            if (is_win(rb.score))        take = ri.score > rb.score;          // shorter mate
            else if (is_loss(ri.score))  take = false;                        // don't pick a proven loss over a non-loss
            else if (is_loss(rb.score))  take = true;                         // anything beats a proven loss
            else if (is_win(ri.score))   take = true;                         // a proven win beats a non-win
            else                         take = voteFor(i) > voteFor(best);   // otherwise: consensus
            if (take) best = i;
        }
    } else {
        for (int i = 1; i < threads; ++i) {
            if (results[i].bestMove == MOVE_NONE) continue;
            if (results[best].bestMove == MOVE_NONE
                || results[i].depth > results[best].depth
                || (results[i].depth == results[best].depth
                    && results[i].score > results[best].score))
                best = i;
        }
    }
    // The chosen worker's ENTIRE Result, MultiPV lines included. Lines are never
    // merged across workers: each worker ran its own independent MultiPV loop over
    // its own tree, so line 2 from thread 3 is not comparable to line 1 from thread
    // 0. The vote above only ever inspects line 0 (bestMove/score/depth), exactly as
    // it did before MultiPV existed, so single-PV thread selection is unchanged.
    Result chosen = results[best];

    // Report the true aggregate node count across all workers.
    int64_t total = 0;
    for (const Result& r : results) total += r.nodes;
    chosen.nodes = total;
    return chosen;
}

} // namespace

Context& default_context() { return default_ctx_ref(); }

void request_stop(bool value) {
    // Cancel whichever path is live. Threads=1 runs on default_context/defaultStop
    // exactly as before; the extra smpStop write is a no-op there (no SMP worker
    // is reading it). Threads>1 workers all bind to smpStop.
    default_ctx_ref().stop = value;
    smpStop = value;
}

// UCI `ponderhit`: the opponent played the predicted move, so convert the in-flight ponder
// search into a normal timed one. Just clears the global ponder flag — the running search's
// next check_time()/soft-break stops early-returning, and elapsed() is measured from the
// original `go ponder` startTime, so time already spent pondering counts (SF engine.cpp:258).
void ponderhit() { ponderFlag.store(false, std::memory_order_relaxed); }

// Set/clear the ponder flag from the UCI layer. `go ponder` sets it true before launching the
// search thread; every non-ponder `go` sets it false so a prior ponder can't leak in.
void set_ponder(bool value) { ponderFlag.store(value, std::memory_order_relaxed); }

bool set_tune_option(const std::string& name, int value) {
    return set_tune_option_impl(default_ctx_ref(), name, value);
}

void init() {
    build_reductions(default_ctx_ref());
}

void clear() {
    reset_tables(default_ctx_ref());
}

void init_pool(int groups, int threadsPerGroup, size_t ttMbPerGroup) {
    GroupPool& p = gpool();
    std::lock_guard<std::mutex> lock(p.m);
    if (!p.groups.empty()) return; // already initialized — idempotent
    if (groups < 1) groups = 1;
    if (threadsPerGroup < 1) threadsPerGroup = 1;
    p.threadsPerGroup = threadsPerGroup;
    for (int g = 0; g < groups; ++g) {
        auto grp = std::make_unique<SearchGroup>();
        grp->tt = std::make_unique<TranspositionTable>();
        grp->tt->resize(ttMbPerGroup);
        grp->stop = std::make_unique<std::atomic<bool>>(false);
        // K worker Contexts, all bound to THIS group's shared tt + stop.
        for (int k = 0; k < threadsPerGroup; ++k) {
            auto ctx = std::make_unique<Context>(*grp->tt, *grp->stop);
            build_reductions(*ctx);
            grp->workerPtrs.push_back(ctx.get());
            grp->contexts.push_back(std::move(ctx));
        }
        p.free_.push_back(grp.get());
        p.groups.push_back(std::move(grp));
    }
}

int pool_group_count() {
    GroupPool& p = gpool();
    std::lock_guard<std::mutex> lock(p.m);
    return static_cast<int>(p.groups.size());
}

int pool_threads_per_group() {
    GroupPool& p = gpool();
    std::lock_guard<std::mutex> lock(p.m);
    return p.threadsPerGroup;
}

SearchGroup& acquire_group() {
    GroupPool& p = gpool();
    std::unique_lock<std::mutex> lock(p.m);
    p.cv.wait(lock, [&] { return !p.free_.empty(); });
    SearchGroup* g = p.free_.back();
    p.free_.pop_back();
    return *g;
}

void release_group(SearchGroup& g) {
    GroupPool& p = gpool();
    {
        std::lock_guard<std::mutex> lock(p.m);
        p.free_.push_back(&g);
    }
    p.cv.notify_one();
}

GroupLease::GroupLease() : group_(&acquire_group()) {}
GroupLease::~GroupLease() { release_group(*group_); }

Context& primary_context(SearchGroup& g) { return *g.workerPtrs[0]; }

// Serve-path SMP entry point: run one search across the leased group's K
// workers on the group's own TT + stop flag. Shares run_lazy_smp() with the
// UCI start_smp path — the ONLY difference is which TT/stop/workers it drives.
Result start_group(SearchGroup& g, Position& pos, const Limits& limits) {
    return run_lazy_smp(g.workerPtrs, *g.tt, *g.stop, pos, limits);
}

int64_t now_ms() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now().time_since_epoch()).count();
}

Result start(Context& C, Position& pos, const Limits& lim, bool resetShared) {
    C.limits = lim;
    C.tune.load();
    build_reductions(C); // Tune::load() no longer rebuilds this itself (it has
                          // no access to the owning Context's Reductions table);
                          // every start() call still gets a fresh table exactly
                          // as before.
    if (C.limits.startTime == 0) C.limits.startTime = now_ms();
    // resetShared=false (Lazy SMP workers only): the driver already cleared the
    // shared stop flag and bumped the shared TT generation ONCE; skip both here
    // so N workers don't race on TT.generation (a non-atomic RMW) or clobber a
    // sibling's timeout. resetShared=true (every other caller) is unchanged.
    if (resetShared) C.stop = false;
    C.nodeCount = 0;
    set_time_limits(C, pos);
    // Contempt: fix the sign once at the root — +C for the side to move at the root (the
    // engine's side), -C for the opponent — so negamax's per-ply `C.contempt[side_to_move]`
    // read biases every static eval toward the root side. Default Tune::contempt 0 → {0,0}.
    {
        Color rootSide = pos.side_to_move();
        C.contempt[rootSide]  = C.tune.contempt;
        C.contempt[~rootSide] = -C.tune.contempt;
        // OPTIMISM: capture the root side + reset the running score average for THIS
        // search. Cheap to always set (mirrors contempt's own precedent above); the
        // average itself is only ever read/updated when Tune::optimism is on.
        C.rootStm = rootSide;
        C.rootAvgScore = 0;
        C.rootAvgInit = false;
    }
    if (resetShared) C.tt.new_search();

    // Attach the incremental NNUE accumulator for the duration of the search.
    // C.accStack persists across calls (avoids reallocation) but is now owned
    // by this Context alone — no longer a function-local `static` shared by
    // every concurrent search (that was safe single-threaded, but a data race
    // once two searches could run at once; see Context's doc comment).
    bool useAcc = NNUE::loaded();
    if (useAcc) { C.accStack.reset(pos); pos.set_nnue_acc(&C.accStack); }

    // HCEBLEND root-gate: arm the HCE-resolution blend for THIS search only if the root
    // position is clearly losing (see Eval::begin_search). Keeps non-lost searches — i.e.
    // all of normal play — byte-identical to no-blend; the blend engages solely when the
    // actual position we're moving in is lost. Thread-local, so per-worker under Lazy SMP.
    Eval::begin_search(pos);

    // Leading pad is 7 (not just 4) so CONTHISTPLIES can safely dereference
    // (ss - 6) at ply 0..5 without underflowing the array — mirrors SF's own
    // reasoning for a 7-slot pad (~sf18-arm/src/search.cpp:275-279: "(ss - 7)
    // is needed for update_continuation_histories(ss - 1) which accesses
    // (ss - 6)"). Total size bumped by the same +3 so the forward extent
    // (ss + MAX_PLY + 5) is unchanged from before this change. The memset
    // zero-inits every pad slot's currentMove to MOVE_NONE (move.h:11), which
    // is exactly the sentinel cont_hist_planes/corrHistCont already guard on
    // for "no real ancestor at this ply" — so the deeper pad slots are just as
    // inert as the original ss-4 pad slot was.
    Stack stack[MAX_PLY + 13];
    std::memset(stack, 0, sizeof(stack));
    Stack* ss = stack + 7;
    for (int i = 0; i < MAX_PLY + 13; ++i) stack[i].ply = i - 7;

    C.rootBestMove = MOVE_NONE;
    // ---- Root move list (SF search.cpp:302-310 / thread.cpp's RootMoves build) ----
    // Every legal root move, once, carried across the whole ID loop. This is also the
    // NODEEFFORT reset (rm.effort starts at 0 on a freshly built list — mirrors SF,
    // which only resets effort when a fresh search begins).
    C.rootMoves.clear();
    {
        MoveList rootList;
        generate<ALL>(pos, rootList);
        for (const ExtMove& em : rootList)
            if (pos.legal(em.move)) C.rootMoves.emplace_back(em.move);
    }
    // ---- Syzygy root DTZ ranking (SF Tablebases::rank_root_moves,
    //      ~sf18-arm/src/syzygy/tbprobe.cpp:1717, called from thread.cpp:313) ----
    //
    // WHY HERE. This is the one point EVERY entry path crosses exactly once: UCI goes
    // start_smp → (threads<=1) start() or run_lazy_smp → N× start(); the HTTP serve layer
    // goes start_group → run_lazy_smp → the same start(). Before this, DTZ lived in
    // start_smp alone, so /bestmove, /candidates, /analyze, /analyze-game, bot games and
    // engine-vs-engine — the entire website — never saw it, and shuffled won ≤5-man
    // endings into 50-move draws. Putting the ranking anywhere else means two call sites,
    // which is exactly the split that caused the bug.
    //
    // Thread safety: N Lazy-SMP workers reach this concurrently and Fathom's DTZ path is
    // not thread-safe. TB::rank_root_moves serializes the probe on its own mutex — see the
    // dtz_mutex() comment in zug_tb.cpp for why serialize-and-duplicate beats
    // compute-once-and-thread-it-through here.
    C.tbRootInTB = false;
    C.tbCardinality = TB::loaded() ? static_cast<int>(TB::max_pieces()) : 0;
    if (C.tune.syzygy && C.tune.tbRootRank && TB::loaded() && !C.rootMoves.empty()
        && pos.castling_rights() == 0
        && BB::popcount(pos.pieces()) <= C.tbCardinality) {
        // rankDTZ (SF's flag, tbprobe.cpp:1607): does DTZ also order moves INSIDE the
        // certain-win band? SF passes false for the search (thread.cpp:313) and true only
        // when extending a finished PV to mate (search.cpp:2075), and zug follows it —
        // see TB_ROOT_RANK_DTZ for the full argument, which turns on this probe zeroing
        // C.tbCardinality three lines below.
        std::vector<TB::RootRank> ranks;
        if (TB::rank_root_moves(pos, TB_ROOT_USE_RULE50, TB_ROOT_RANK_DTZ, ranks)) {
            for (const TB::RootRank& rr : ranks)
                if (RootMove* rm = find_root_move(C, rr.move)) {
                    rm->tbRank   = rr.rank;
                    rm->tbScore  = rr.score;
                    rm->tbCursed = rr.cursed;
                }
            C.tbRootInTB = true;
            // SF tbprobe.cpp:1758-1761. The ONE sort that crosses rank groups; from here
            // on the ID loop only ever sorts within [pvFirst, pvLast). Stable, so moves
            // sharing a rank keep the movegen order they were built in.
            std::stable_sort(C.rootMoves.begin(), C.rootMoves.end(),
                             [](const RootMove& a, const RootMove& b) { return a.tbRank > b.tbRank; });
            // SF tbprobe.cpp:1764-1766: DTZ is available, so stop probing WDL inside the
            // search. See the in-search probe's own comment for why this is the half of
            // the fix that lets the search find the mate instead of tying every winning
            // move at ±(VALUE_TB_WIN - ply).
            C.tbCardinality = 0;
        }
    }
    // SF search.cpp:310, `multiPV = std::min(multiPV, rootMoves.size())`. The extra
    // max(1,...) keeps a TERMINAL root (no legal moves) running exactly one root
    // negamax — its mated_in()/VALUE_DRAW return is load-bearing for the Result (see
    // the "case 2" comment at the bottom of this function).
    C.multiPV = std::max(1, std::min(C.limits.multiPV < 1 ? 1 : C.limits.multiPV,
                                     static_cast<int>(C.rootMoves.size())));
    C.pvIdx = 0;
    C.pvFirst = 0;
    C.pvLast = 0;
    C.rootBestMoveChangesIter = 0;
    int maxDepth = C.limits.depth ? C.limits.depth : MAX_PLY - 1;

    // HISTDECAY (sf-sp-search-backlog.md #2): faithful SF18/Stormphrax port —
    // decay the main history[] table exactly ONCE per start() call, here,
    // before the ID loop begins, NOT per depth iteration. This ages whatever
    // history[] CARRIED OVER from this Context's previous search (the
    // previous move in the same game — zug's history[] persists across moves,
    // cleared only by reset_tables() at ucinewgame/new-game; see the
    // Tune::histDecay comment for the verification). Matches SF
    // (~sf18-arm/src/search.cpp:316-319, before its `while(++rootDepth...)`)
    // and Stormphrax (~stormphrax/src/search.cpp:418 `thread.history.age()`,
    // before its `for(depth=1;;++depth)`) in both cadence and target table
    // (main/butterfly only). Runs once per worker's own start() call in SMP
    // too (each Context in the pool owns its own history[] — see
    // SearchGroup::contexts, "own the storage" — so this is never a shared-
    // state race). Not gated on resetShared: that flag guards ONE-TIME
    // cross-worker side effects (stop flag, TT generation bump); this decay
    // is per-Context private state and must run for every worker's own call.
    // OFF path: single bool check, function never runs -- byte-identical.
    if (C.tune.histDecay) decay_history_table(C);

    Result lastResult;
    int prevScore = 0;
    Move lastBest = MOVE_NONE;
    // TIMEMAN per-iteration scaling state (only used when C.tmScaled). Stormphrax limit.cpp:
    // a best-move-stability counter and an 8-sample EMA of the root score drive a multiplier
    // applied to timeLimitSoft each iteration: a long-stable best move shrinks the budget, a
    // falling eval extends it.
    int    tmStability = 0;
    Move   tmPrevBest  = MOVE_NONE;
    double tmAvgScore  = 0.0;
    bool   tmHaveAvg   = false;
    // NODEEFFORT (SF search.cpp:272/327, sf_18): a decaying (halved each iteration,
    // like SF's totBestMoveChanges) count of how many times a later root move overtook
    // alpha this iteration, accumulated across the whole search. Only used/updated
    // when Tune::nodeEffort is on.
    double tmTotBestMoveChanges = 0.0;
    // TMFALLING (a) (SF search.cpp:487-508/240/296-299, VERIFIED sf_18): fallingEval
    // state. tmIterValue/tmIterIdx mirror SF's mainThread->iterValue[4] ring buffer —
    // pure per-start()-call local state (never needs to persist across `go` calls, unlike
    // Context::bestPreviousAverageScore below). tmRootAvg/tmRootAvgInit mirror SF's
    // per-root-move averageScore blend (search.cpp:1310-1311, `(value+avg)/2`), reduced to
    // a single scalar since zug's single-PV ID loop only ever has ONE "current root" slot
    // per iteration (SF's per-RootMove map only matters under MultiPV). Seeded from
    // Context::bestPreviousAverageScore exactly like SF seeds iterValue from
    // bestPreviousScore at iterative_deepening entry (search.cpp:296-299). Harmless when
    // Tune::tmFalling is off (never read/written).
    int  tmIterValue[4] = {0, 0, 0, 0};
    int  tmIterIdx      = 0;
    int  tmRootAvg      = 0;
    bool tmRootAvgInit  = false;
    if (C.tune.tmFalling)
        for (int& v : tmIterValue) v = C.bestPreviousAverageScore;
    for (int depth = 1; depth <= maxDepth; ++depth) {
        C.rootDepthGlobal = depth;
        // NODEEFFORT: SF search.cpp:327 ages the running instability EMA at the top of
        // every iteration (before that iteration's own flips are counted below).
        if (C.tune.nodeEffort) {
            tmTotBestMoveChanges *= 0.5;
            C.rootBestMoveChangesIter = 0;
        }

        // Save last iteration's scores BEFORE the first PV line is searched — every
        // score except the new PV's is about to be reset to -VALUE_INFINITE, and
        // prevScore is what the stable sort's tiebreak (and a pvIdx>0 window seed)
        // falls back on (SF search.cpp:330-331).
        for (RootMove& rm : C.rootMoves) rm.prevScore = rm.score;

        // Reset the Syzygy rank-group window for this iteration (SF search.cpp:336-337).
        // Without a DTZ-ranked root this is a no-op: the first advance_rank_group() call
        // below walks pvLast straight to rootMoves.size() and the "window" is the whole
        // list, exactly as before.
        C.pvFirst = 0;
        C.pvLast  = 0;

        // ---- MultiPV loop (SF search.cpp:341) ----
        // One full root search per reported line; each pass is restricted to the root
        // moves not yet emitted, so all N lines finish at THIS depth and their scores
        // are directly comparable. C.multiPV == 1 for every legacy caller, so this loop
        // body runs exactly once with pvIdx == 0 — where the root filter, the TT-store
        // guard and the per-line window seeding below are all provable no-ops. That is
        // the byte-identity contract for the single-PV tree.
        int score = 0;
        for (C.pvIdx = 0; C.pvIdx < C.multiPV; ++C.pvIdx) {
            // Move the [pvFirst, pvLast) rank window on once this group is exhausted
            // (SF search.cpp:343-350). Every sort and the root filter live inside it.
            advance_rank_group(C);
            // Aspiration windows
            int lineScore;
            if (depth <= 4) {
                C.rootDelta = VALUE_INFINITE - (-VALUE_INFINITE); // ROOTDELTALMR: full-window branch (SF sets rootDelta unconditionally)
                lineScore = negamax<true>(C, pos, ss, -VALUE_INFINITE, VALUE_INFINITE, depth, false);
                sort_root_moves(C);
            } else {
                // Window seed. Line 0 keeps zug's `prevScore` (the completed previous
                // iteration's root score) UNCHANGED — deliberately NOT SF's
                // averageScore/meanSquaredScore seeding, which would perturb every
                // window on every iteration and invalidate the SPSA/SPRT baseline.
                // Per-line avgScore seeding (SF search.cpp:356-358) applies to pvIdx>0
                // only, where there is no baseline to protect and a per-line average is
                // strictly better than reusing line 0's score.
                int seed = prevScore;
                if (C.pvIdx != 0) {
                    const RootMove& rm = C.rootMoves[C.pvIdx];
                    seed = rm.avgScore != -VALUE_INFINITE   ? rm.avgScore
                         : rm.prevScore != -VALUE_INFINITE  ? rm.prevScore
                                                            : prevScore;
                }
                // SF search.cpp:355 scales the initial delta off |meanSquaredScore| (a
                // quadratic volatility signal zug doesn't track); zug's only available
                // prior-score signal at this point is `prevScore` (the completed
                // previous iteration's root score), so ASPADAPT uses a linear proxy:
                // delta = aspInitDelta + |prevScore|/12. K=12 chosen so a near-zero eval
                // leaves delta at the unchanged baseline (25), a one-pawn score (100cp)
                // adds ~8, and a clearly-won position (300cp) roughly doubles delta to
                // ~50 — widening the window before the volatile position forces a
                // re-search, without perturbing quiet/equal positions.
                int delta = C.tune.aspAdapt
                    ? C.tune.aspInitDelta + std::abs(seed) / 12
                    : C.tune.aspInitDelta;
                // SMPDIV: stagger each Lazy-SMP worker's initial window width by its index
                // (SF search.cpp:355 `delta = 5 + threadIdx%8 + …`) so threads search
                // slightly different windows and diverge. threadIdx==0 on the main/single
                // thread path → no change; whole block is a no-op unless SMPDIV=1.
                if (smp_div_enabled()) delta += C.threadIdx % 8;
                int alpha = std::max(seed - delta, -VALUE_INFINITE);
                int beta  = std::min(seed + delta, VALUE_INFINITE);
                while (true) {
                    // ROOTDELTALMR: re-sync rootDelta to the window about to be searched
                    // on *every* pass through this loop, including re-searches after a
                    // fail-high/low widens [alpha,beta] below (SF search.cpp:374 does the
                    // same — rootDelta is set inside its `while (true)` re-search loop,
                    // not before it). Without this, a widened re-search window makes
                    // node-local delta (beta-alpha at depth) exceed a stale rootDelta
                    // frozen from before the widening, blowing the ROOTDELTALMR term past
                    // its intended [0,608] bound.
                    C.rootDelta = beta - alpha;
                    lineScore = negamax<true>(C, pos, ss, alpha, beta, depth, false);
                    // Re-sort after EVERY root search, including each fail-high/low
                    // re-search (SF search.cpp:383, inside its `while (true)`) — the
                    // next pass reads rootMoves[pvIdx].pv[0] as its root ttMove, so a
                    // stale order there would change the tree. This is precisely what
                    // makes rootMoves[0].pv[0] track the old scalar `rootBestMove`.
                    sort_root_moves(C);
                    if (C.stop) break;
                    if (lineScore <= alpha) {
                        beta = (alpha + beta) / 2;
                        alpha = std::max(lineScore - delta, -VALUE_INFINITE);
                    } else if (lineScore >= beta) {
                        beta = std::min(lineScore + delta, VALUE_INFINITE);
                    } else break;
                    // SF search.cpp:418: delta += delta / 3 (vs zug's default delta/2).
                    delta += C.tune.aspAdapt ? delta / 3 : delta / 2;
                }
            }
            // Now that this line has an exact score, re-rank the emitted prefix so the
            // reported lines stay in descending order (SF search.cpp:424).
            sort_emitted_lines(C);
            // The search's score IS line 0's score — every scalar consumer below
            // (prevScore, TIMEMAN, Result::score) means the best line, never a
            // secondary one.
            if (C.pvIdx == 0) score = lineScore;
            if (C.stop) break;
        }
        C.pvIdx = 0; // leave the Context in its single-PV resting state

        if (C.stop && depth > 1) break;

        // NODEEFFORT (SF search.cpp:480-481): fold this iteration's flip count into the
        // running (decaying) total, then reset the per-iteration counter for the next
        // depth. Placed after the `C.stop` break so an interrupted iteration's partial
        // (possibly not-fully-searched) flip count is never folded in — same guard SF
        // gets from checking threads.stop before this bookkeeping runs.
        if (C.tune.nodeEffort) {
            tmTotBestMoveChanges += C.rootBestMoveChangesIter;
            C.rootBestMoveChangesIter = 0;
        }

        prevScore = score;
        // OPTIMISM: maintain a running EMA of the completed root score, consumed by
        // optimism_term() inside corrected_eval(). Off -> this update is skipped
        // entirely (Context::rootAvgScore/rootAvgInit stay at their start()-reset
        // values, never read).
        if (C.tune.optimism) {
            if (!C.rootAvgInit) { C.rootAvgScore = score; C.rootAvgInit = true; }
            else C.rootAvgScore += (score - C.rootAvgScore) / 8;
        }
        lastBest = C.rootBestMove;
        if (!C.limits.silent) print_pv(C, pos, ss, depth, score, C.nodeCount);

        // Snapshot the completed iteration — returned to the caller once the
        // whole search loop finishes (was a global `lastResult` before this
        // change; now purely local to this call, so two concurrent start()
        // calls never share it).
        lastResult.bestMove = C.rootBestMove;
        // Syzygy root score override (SF search.cpp:2138-2139) — a reporting-only swap,
        // see reported_score(). `score` itself stays the true search score above and is
        // what prevScore/TIMEMAN/OPTIMISM keep reading.
        lastResult.score = reported_score(C, score, C.rootMoves.empty() ? nullptr : &C.rootMoves[0]);
        lastResult.depth = depth;
        lastResult.nodes = C.nodeCount;
        lastResult.pv.assign(ss->pv, ss->pv + ss->pvLen);

        // Publish the MultiPV lines from this FULLY COMPLETED iteration, so a later
        // timeout still returns the last complete, internally-consistent line set —
        // exactly the guarantee the scalar fields above already give. lines[0] mirrors
        // them by construction: rootMoves[0] is the sorted-best root move, i.e.
        // C.rootBestMove, its score is the in-window root value `score`, and its pv was
        // built from the same (ss+1)->pv that ss->pv was.
        lastResult.lines.clear();
        if (C.rootMoves.empty()) {
            // Terminal root (checkmate/stalemate): no root move exists, but the score is
            // real and load-bearing. One line, no moves.
            Line ln;
            ln.score = score;
            ln.depth = depth;
            ln.pv = lastResult.pv;
            lastResult.lines.push_back(ln);
        } else {
            int n = std::min<int>(C.multiPV, static_cast<int>(C.rootMoves.size()));
            for (int i = 0; i < n; ++i) {
                const RootMove& rm = C.rootMoves[i];
                // Only reachable on a degenerate interrupted depth-1 iteration (the ID
                // loop's `C.stop && depth > 1` break lets depth 1 through). Stop rather
                // than report a sentinel score.
                if (rm.score == -VALUE_INFINITE) break;
                Line ln;
                ln.score = reported_score(C, rm.score, &rm);
                ln.depth = depth;
                ln.pv = rm.pv;
                lastResult.lines.push_back(ln);
            }
            if (lastResult.lines.empty()) {
                Line ln;
                ln.score = score;
                ln.depth = depth;
                ln.pv = lastResult.pv;
                lastResult.lines.push_back(ln);
            }
        }

        // Soft time check between iterations. In the default (legacy) time scheme the soft
        // limit is a flat wall. When TIMEMAN clock-mode is active (C.tmScaled), scale it per
        // iteration by best-move stability and eval trend (Stormphrax limit.cpp:46-102).
        int64_t softLimit = C.timeLimitSoft;
        if (C.tmScaled && C.timeLimitSoft) {
            // Best-move stability: consecutive iterations with the same root PV move.
            if (C.rootBestMove == tmPrevBest) ++tmStability;
            else { tmStability = 1; tmPrevBest = C.rootBestMove; }
            // Stability scale (from depth>=6): monotonically falling in stability toward ~0.78,
            // capped at 2.36 when freshly unstable. SP bmStability{Min 0.78, Scale 8.59,
            // Offset 0.9, Power -2.57, Max 2.36}.
            double stabScale = 1.0;
            if (depth >= 6)
                stabScale = std::min(2.36, 0.78 + 8.59 * std::pow(tmStability + 0.9, -2.57));
            // Eval-trend scale off an 8-sample EMA: a rising score shrinks the budget, a
            // falling one extends it (up to 2.48x). SP scoreTrend{Score 4.94, Scale 0.36,
            // Stretch 0.94, Pos 0.94, Neg 1.1, Min 0.63, Max 2.48}, EMA weight 1/8.
            double evalScale = 1.0;
            if (tmHaveAvg) {
                double chg = (score - tmAvgScore) / 4.94;
                double inv = chg * 0.36 / (std::abs(chg) + 0.94) * (chg > 0 ? 0.94 : 1.1);
                evalScale = std::min(2.48, std::max(0.63, 1.0 - inv));
                tmAvgScore += (score - tmAvgScore) / 8.0;
            } else { tmAvgScore = score; tmHaveAvg = true; }
            double scale = std::max(0.09, stabScale * evalScale);
            // NODEEFFORT (SF search.cpp:502-505): two more multiplicative factors,
            // layered on top of the Stormphrax scale above. Both are pure ratios (a
            // node-count fraction, a flip count), not cp values, so SF's constants are
            // ported unchanged — no value-scale rescale applies to either.
            if (C.tune.nodeEffort) {
                // nodesEffort: share (per 100000) of this search's total nodes so far
                // spent on the CURRENT best root move (SF: rootMoves[0].effort*100000/
                // nodes; rootMoves[0] is the current-best after SF's per-iteration sort,
                // i.e. exactly C.rootBestMove here).
                const RootMove* rbm = find_root_move(C, C.rootBestMove);
                int64_t effort = rbm ? rbm->effort : 0;
                int64_t nodesEffort = effort * 100000 / std::max<int64_t>(1, C.nodeCount);
                double highBestMoveEffort = nodesEffort >= 93340 ? 0.76 : 1.0;
                // bestMoveInstability (SF search.cpp:503): threads.size() divisor is 1
                // here — this Context's own single-thread ID loop, not an SMP-aggregate.
                double bestMoveInstability = 1.02 + 2.14 * tmTotBestMoveChanges;
                scale *= highBestMoveEffort * bestMoveInstability;
            }
            // TMFALLING (a) (SF search.cpp:487-494, VERIFIED sf_18): fallingEval — a
            // falling score (vs. the PREVIOUS search's blended root average AND this
            // search's own score 4 iterations back) extends the budget.
            //
            // SCALE (critical — NOT a blind x0.4808): 2.24/0.93 are COEFFICIENTS of a
            // cp-scale VALUE DIFFERENCE, not additive value-scale constants added to a cp
            // value — to reproduce the same chess-equivalent swing under zug's smaller cp
            // scale (pawn=100 vs SF's 208, ratio 0.4808), the coefficient must scale by the
            // INVERSE ratio (x1/0.4808 ~= x2.08), not x0.4808. Verified numerically: SF's
            // formula saturates its own ceiling clamp (1.70) at roughly a 70cp SF-scale
            // swing (~0.336 pawns) — 11.85+2.24*70~=168.6. Reproducing that SAME
            // pawn-fraction swing at zug's scale (~33.6 zug-cp) needs
            // 11.85+coeff*33.6~=170 => coeff~=4.71, matching 2.24*2.08~=4.66 to within
            // rounding (NOT 2.24*0.48~=1.08, which would need an eval swing over 2x larger
            // to saturate, silently gutting the effect). Same derivation for 0.93*2.08~=1.93.
            // The additive 11.85 baseline is dimensionless (sets where the un-clamped ratio
            // sits before the value terms shift it, not a cp value) — ported unchanged.
            if (C.tune.tmFalling) {
                double fallingEval = (11.85 + 4.66 * (C.bestPreviousAverageScore - score)
                                             + 1.93 * (tmIterValue[tmIterIdx] - score)) / 100.0;
                fallingEval = std::clamp(fallingEval, 0.57, 1.70);
                scale *= fallingEval;
                tmIterValue[tmIterIdx] = score;
                tmIterIdx = (tmIterIdx + 1) & 3;
                tmRootAvg = tmRootAvgInit ? (score + tmRootAvg) / 2 : score;
                tmRootAvgInit = true;
            }
            softLimit = std::max<int64_t>(1, int64_t(C.timeLimitSoft * scale));
            // Never let the scaled soft limit exceed the hard cap.
            if (C.timeLimitHard && softLimit > C.timeLimitHard) softLimit = C.timeLimitHard;
        }
        if (!C.limits.infinite && !ponderFlag.load(std::memory_order_relaxed)
            && softLimit && elapsed(C) >= softLimit) break;
        if (C.limits.nodes && C.nodeCount >= C.limits.nodes) break;
    }

    // TMFALLING (a): persist this search's fast root-score EMA as the "previous average"
    // baseline the NEXT start() call on this Context reads (SF search.cpp:240,
    // `bestPreviousAverageScore = bestThread->rootMoves[0].averageScore`, assigned once
    // per completed `go`). Only written when at least one iteration actually completed.
    if (C.tune.tmFalling && tmRootAvgInit)
        C.bestPreviousAverageScore = tmRootAvg;

    if (useAcc) pos.set_nnue_acc(nullptr); // detach: eval reverts to from-scratch off-search

    Move best = lastBest != MOVE_NONE ? lastBest : C.rootBestMove;
    // `best == MOVE_NONE` has TWO distinct causes, and only one wants the fallback:
    //   1. No iteration ever completed (e.g. an absurdly small movetime) — depth
    //      stayed at its 0 default, lastResult was never populated. Pick any legal
    //      move and synthesize a consistent (score 0) result.
    //   2. The root is genuinely TERMINAL (checkmate/stalemate): depth-1 completed
    //      and returned a real mated_in()/VALUE_DRAW score, but no move was ever
    //      searched at the root so rootBestMove is legitimately MOVE_NONE. Here
    //      lastResult.depth >= 1 and its score is load-bearing — clobbering it to 0
    //      would erase a checkmate. That mis-scored a mate-delivering move (searched
    //      as do_move → start on the now-terminal child) as 0 instead of +MATE,
    //      which flipped the "Unlosable" worst-move picker into playing mate-in-one.
    // Only case 1 takes the fallback: gate on "no iteration completed", not on best.
    if (best == MOVE_NONE && lastResult.depth == 0) {
        MoveList list; generate<ALL>(pos, list);
        for (auto& m : list) if (pos.legal(m)) { best = m; break; }
        lastResult.bestMove = best;
        lastResult.score = 0;
        lastResult.depth = 0;
        lastResult.nodes = C.nodeCount;
        lastResult.pv.assign(1, best);
        lastResult.lines.clear();
    }
    // Result::lines is a promise: ALWAYS at least one entry, always mirroring the
    // scalar fields. Covers the fallback above and any path where no iteration ever
    // published (e.g. a movetime so small that depth 1 never completed).
    if (lastResult.lines.empty()) {
        Line ln;
        ln.score = lastResult.score;
        ln.depth = lastResult.depth;
        ln.pv = lastResult.pv;
        lastResult.lines.push_back(ln);
    }
    // Ponder/infinite hold (SF search.cpp:210-216): the UCI protocol forbids emitting
    // bestmove while pondering or in an `infinite` search until the GUI sends `stop`/
    // `ponderhit`. If the ID loop exhausted all depths before either arrived (rare — depth
    // ceiling is MAX_PLY), wait here. Only the emitting (non-silent) path waits; SMP workers
    // are silent and simply keep searching until stopped, and the driver joins them. A 1ms
    // sleep instead of SF's hard spin keeps a core free without hurting stop responsiveness.
    if (!C.limits.silent) {
        while (!C.stop && (ponderFlag.load(std::memory_order_relaxed) || C.limits.infinite))
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }

    if (!C.limits.silent) {
        std::cout << "bestmove " << move_to_uci(best);
        // Ponder move = 2nd PV move, so a GUI can think on the opponent's clock (SF
        // search.cpp:246-253). Only when it matches the reported bestmove and the PV is long
        // enough; no TT-probe fallback (SF's extract_ponder_from_tt) — omit if unavailable.
        if (lastResult.pv.size() > 1 && lastResult.pv[0] == best)
            std::cout << " ponder " << move_to_uci(lastResult.pv[1]);
        std::cout << std::endl;
    }

    return lastResult;
}

void start(Position& pos, const Limits& lim) {
    start(default_ctx_ref(), pos, lim);
}

// ---- Lazy SMP driver ----
//
// Syzygy root DTZ used to live HERE, as a short-circuit that returned a single DTZ move
// with `nodes 0` and no search at all. That placement was the bug: start_smp is the UCI
// entry point only, so the HTTP serve path (start_group → run_lazy_smp) never reached it
// and the whole website played won ≤5-man endings on flat WDL alone. The short-circuit
// shape also forced two exclusions it could never shed — it had to be skipped under
// MultiPV (it can only ever produce one line) and while pondering (it would emit a
// bestmove during the UCI ponder hold). Both are gone: DTZ is now a RANKING applied in
// Search::start() (the one function every entry path crosses), the engine always runs a
// real search, and the rank grouping constrains which moves that search may choose.
Result start_smp(Position& rootPos, const Limits& limits, int threads) {
    // Threads<=1: the exact pre-SMP single-thread path. default_context() is
    // bound to the global TT + defaultStop, resetShared defaults to true, and
    // limits.silent is untouched — so the tree, the bestmove, and every
    // info/bestmove stdout line are byte-identical to the engine before SMP.
    if (threads <= 1)
        return start(default_ctx_ref(), rootPos, limits);

    // Create all worker Contexts up front, on THIS (driver) thread, so the
    // smpContexts vector is never grown while worker threads run, then collect
    // them into the worker-pointer view run_lazy_smp() drives. This UCI path's
    // global group = { smpContexts[0..threads-1], ::TT, smpStop }.
    std::vector<Context*> workers;
    workers.reserve(threads);
    for (int i = 0; i < threads; ++i) workers.push_back(&smp_context(i));

    // Same Lazy-SMP core the serve start_group() path uses — driven here with
    // the global TT + smpStop. Workers run silent; the driver prints the single
    // final info/bestmove below. Byte-identical to the pre-refactor start_smp.
    Result chosen = run_lazy_smp(workers, ::TT, smpStop, rootPos, limits);

    if (!limits.silent)
        print_smp_result(chosen, limits.startTime ? limits.startTime : now_ms(), limits.multiPV);

    return chosen;
}

} // namespace Search
