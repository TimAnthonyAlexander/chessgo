#include "uci.h"
#include "position.h"
#include "movegen.h"
#include "search.h"
#include "eval.h"
#include "nnue.h"
#include "nnue_internal.h"   // SATDIAG rail counters, reported by the `eval` command
#include "nnue_arch.h"
#include "tt.h"
#include "bitboard.h"
#include "zobrist.h"
#include "book.h"
#include "zug_tb.h"
#include "rating.h"
#include "rules.h"
#include <iostream>
#include <sstream>
#include <thread>
#include <string>
#include <vector>
#include <algorithm>
#include "native_thread.h"  // NativeThread: 8MB stacks (SF ~sf18-arm/src/thread_win32_osx.h)

static const char* START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
static const char* ENGINE_NAME = "hce 1.0";
static const char* ENGINE_AUTHOR = "Claude (HCE)";

static Position pos;
// The search runs here, NOT on the stdin-reading main thread — and it must be a
// NativeThread: a deep search needs >1MB of stack and macOS gives a plain std::thread
// only ~544KB (see native_thread.h for the measured frame sizes and the crash it fixes).
static zug::NativeThread searchThread;
static int ttSizeMB = 128;
static int engineThreads = 1; // UCI "Threads" option — Lazy SMP worker count (1 = single-thread)
// UCI "MultiPV": how many principal variations `go` should report. 1 (the default) is
// the engine's normal single-PV search — same tree, same node counts, and print_pv emits
// the exact same info lines with no `multipv` token, so every SPRT/CCRL/fastchess run is
// unaffected. >1 runs SF's real root MultiPV loop (search.cpp): N lines, one search, all
// at the same depth.
static int multiPV = 1;
static Book::Book book;
static bool ownBook = true;  // default-ON (2026-07-20): the +150-Elo GMBK book
                             // (book.bin → ../gomachine/data/book.bin) is used in EVERY
                             // UCI entrypoint — SPRTs, fastchess-vs-Stockfish, GUI play.
                             // Kill with `setoption name OwnBook value false`.

// UCI strength limiting (standard UCI_LimitStrength / UCI_Elo). Off by default so
// the UCI/bench/golden path is byte-identical to full strength. When on, `go`
// routes through the engine's rating ladder (Rating::best_move_for_rating_single)
// instead of a full search — the same weakening the serve `limits.rating` path
// uses, making strength a first-class, SPRT-testable engine param.
static bool uciLimitStrength = false;
static int uciElo = Rating::RatingMax;

static void join_search() {
    if (searchThread.joinable()) searchThread.join();
}

static void stop_search() {
    Search::request_stop(true);
    join_search();
}

// Apply a UCI move string to the position by matching against legal moves.
// Accepts both castling UCI conventions (king-two-square, the canonical
// move_to_uci output, and king-captures-rook e.g. "e1h1", the Chess960/
// Lichess convention) — mirrors Rules::parse_uci_move.
static Move parse_move(Position& p, const std::string& str) {
    MoveList list;
    generate<ALL>(p, list);
    Color us = p.side_to_move();
    for (const ExtMove& m : list) {
        if (!p.legal(m.move) || type_of_move(m.move) != CASTLING) continue;
        bool kingside = castle_is_kingside(m.move);
        int flag = (us == WHITE) ? (kingside ? WHITE_OO : WHITE_OOO)
                                 : (kingside ? BLACK_OO : BLACK_OOO);
        Square rfrom = p.castling_rook_square(flag);
        if (SQ_NAMES[from_sq(m.move)] + SQ_NAMES[rfrom] == str) return m.move;
    }
    for (const ExtMove& m : list)
        if (move_to_uci(m.move) == str && p.legal(m.move))
            return m.move;
    return MOVE_NONE;
}

static void position_cmd(std::istringstream& is) {
    std::string token, fen;
    is >> token;
    if (token == "startpos") {
        fen = START_FEN;
        is >> token; // consume "moves" if present
    } else if (token == "fen") {
        while (is >> token && token != "moves")
            fen += token + " ";
    } else return;

    // Two-tier FEN validation, mirroring the HTTP serve path's gate
    // (serve_handlers.cpp parse_legal_or_throw / Rules::valid_fen_structure's doc
    // comment). Tier 1 MUST run BEFORE pos.set(): Position::set() unconditionally
    // computes king_square(sideToMove) in set_check_info(), which is undefined
    // behavior — a reproduced segfault (exit 139) — on a FEN with a missing king.
    // The UCI path previously had no such gate; in the browser this is the ONLY
    // path a FEN reaches the engine through, and a segfault there aborts the whole
    // wasm module, not just one request, so this gate applies unconditionally
    // (native and wasm alike) rather than behind an __EMSCRIPTEN__ guard.
    if (!Rules::valid_fen_structure(fen)) {
        std::cout << "info string invalid fen: malformed FEN string" << std::endl;
        return; // pos left untouched — safe to keep issuing commands
    }

    // Tier 2: well-formed but illegal (e.g. the side not to move is already in
    // check). pos.set() itself cannot crash here (both kings are present per
    // tier 1), but searching from an illegal position is meaningless — reject it.
    //
    // Validated on a SCRATCH position, not on `pos`, so a rejected FEN leaves the
    // real position exactly as tier 1 leaves it: untouched, including whatever
    // move history a `position startpos moves ...` had built up. Tier 2 used to
    // `pos.set(START_FEN)` here, which made the two tiers disagree about what a
    // rejected `position` command does — and the START_FEN branch is the worse of
    // the two, because a GUI that ignores `info string` (they all may) then gets a
    // perfectly confident bestmove for the STARTING POSITION rather than an error.
    // That is how both illegal fixtures in test/golden_eval.txt came to report the
    // start position's eval (69) instead of failing visibly.
    Position probe;
    probe.set(fen);
    if (!Rules::position_legal(probe)) {
        std::cout << "info string illegal position: side not to move is in check, or a king is missing" << std::endl;
        return; // pos left untouched, exactly as in tier 1
    }
    pos.set(fen);

    if (token == "moves")
        while (is >> token) {
            Move m = parse_move(pos, token);
            if (m == MOVE_NONE) break;
            // We must keep state alive across the game: use a growing state store.
            static std::vector<StateInfo*> states;
            StateInfo* st = new StateInfo();
            states.push_back(st);
            pos.do_move(m, *st);
        }
}

// If OwnBook is on, the book is loaded, and the current position has a hit
// whose pv[0] is a LEGAL move, print the book's line as if it were a search
// result and return true (caller skips the real search entirely). Re-validates
// legality against movegen — never trusts the book blindly, since a book move
// could in principle be stale relative to this position (e.g. a key collision,
// though the 64-bit exact-match key makes that vanishingly unlikely).
static bool try_book_move(Position& p) {
    if (!ownBook || !book.loaded()) return false;
    const Book::BookEntry* e = book.lookup(Book::book_key(p));
    if (!e || e->pv.empty()) return false;

    Move best = parse_move(p, e->pv[0]);
    if (best == MOVE_NONE) return false; // not legal here — don't trust the book

    std::cout << "info depth " << e->depth << " score ";
    if (e->mate != 0) std::cout << "mate " << e->mate;
    else std::cout << "cp " << e->score;
    std::cout << " pv";
    for (const std::string& mv : e->pv) std::cout << " " << mv;
    std::cout << std::endl;
    std::cout << "bestmove " << e->pv[0] << std::endl;
    return true;
}

static void go_cmd(std::istringstream& is) {
    join_search();
    Search::Limits limits;
    limits.startTime = Search::now_ms();
    limits.multiPV = multiPV;
    std::string token;
    while (is >> token) {
        if (token == "wtime") is >> limits.time[WHITE];
        else if (token == "btime") is >> limits.time[BLACK];
        else if (token == "winc") is >> limits.inc[WHITE];
        else if (token == "binc") is >> limits.inc[BLACK];
        else if (token == "movestogo") is >> limits.movestogo;
        else if (token == "depth") is >> limits.depth;
        else if (token == "nodes") is >> limits.nodes;
        else if (token == "movetime") is >> limits.movetime;
        else if (token == "infinite") limits.infinite = true;
        else if (token == "ponder") limits.ponderMode = true;
    }
    // Set the process-wide ponder flag for THIS search (true only for `go ponder`), so a
    // prior ponder can never leak into an ordinary `go`. Must precede the search launch and
    // the early-return shortcuts below. startTime was stamped above at the `go` moment, so a
    // later `ponderhit` measures elapsed() from here — pondering time counts (SF semantics).
    Search::set_ponder(limits.ponderMode);
    // During ponder we must NOT emit a bestmove immediately: skip both the weakening ladder
    // and the opening book (which print+return instantly) and fall through to a real search
    // that holds until `ponderhit`/`stop`. (Full-strength CCRL play never hits these anyway.)
#ifdef __EMSCRIPTEN__
    // No pthreads in the wasm build (single-threaded, deliberately — see
    // wasm_main.cpp): every `go` runs SYNCHRONOUSLY on the calling thread instead
    // of spawning searchThread. The engine lives in a JS Web Worker, so blocking
    // this call is correct there — the worker just doesn't process another
    // message until the search returns. Consequence: an async `stop` can no
    // longer interrupt an in-flight search (there is no other thread to signal
    // from); callers must bound every `go` with movetime/depth/nodes. `stop`/
    // `quit` still behave sanely — join_search() is a no-op (searchThread was
    // never actually started) so there is nothing to deadlock on.
    if (uciLimitStrength && !limits.ponderMode) {
        Search::request_stop(false);
        std::vector<uint64_t> hist;
        Rating::WeakResult wr = Rating::best_move_for_rating_single(
            Search::default_context(), pos, uciElo, limits.depth, limits.movetime, limits.nodes, hist);
        std::cout << "bestmove " << (wr.move != MOVE_NONE ? move_to_uci(wr.move) : "0000")
                  << std::endl;
        return;
    }
    if (!limits.ponderMode && multiPV <= 1 && try_book_move(pos)) return;
    Search::request_stop(false);
    // engineThreads is forced to 1 on the wasm path (setoption "Threads" clamps
    // it below), so start_smp's threads<=1 branch is the exact single-thread
    // path — byte-identical tree/output to the native default, no thread spawn.
    Search::start_smp(pos, limits, engineThreads);
#else
    if (uciLimitStrength && !limits.ponderMode) {
        // Weakened play through the rating ladder. Runs on the search thread (so
        // `stop` still joins cleanly) and prints its own bestmove — the ladder's
        // clean branch searches with silent=true, so there is no double print.
        Search::request_stop(false);
        int elo = uciElo, gd = limits.depth, gmt = limits.movetime;
        int64_t gn = limits.nodes;
        searchThread = zug::NativeThread([elo, gd, gmt, gn]() {
            std::vector<uint64_t> hist;
            Rating::WeakResult wr = Rating::best_move_for_rating_single(
                Search::default_context(), pos, elo, gd, gmt, gn, hist);
            std::cout << "bestmove " << (wr.move != MOVE_NONE ? move_to_uci(wr.move) : "0000")
                      << std::endl;
        });
        return;
    }
    // Book hit: skip the search entirely. Never while pondering, and never under
    // MultiPV>1 — the book stores ONE move, and a GUI asking for N ranked lines must
    // get a real search rather than a single line. MultiPV==1 (play, SPRTs, CCRL) is
    // the unchanged path.
    if (!limits.ponderMode && multiPV <= 1 && try_book_move(pos)) return;
    Search::request_stop(false);
    // Lazy SMP: start_smp runs engineThreads Contexts sharing the global TT +
    // one stop flag. engineThreads==1 delegates to the byte-identical single-
    // thread path. The driver runs on this searchThread and joins its own
    // helper threads before returning, so stop_search()'s join still cleanly
    // waits for the entire (multi-threaded) search to finish.
    int nThreads = engineThreads;
    searchThread = zug::NativeThread([limits, nThreads]() { Search::start_smp(pos, limits, nThreads); });
#endif
}

static uint64_t perft_count(Position& p, int depth) {
    if (depth == 0) return 1;
    MoveList list; generate<ALL>(p, list);
    uint64_t nodes = 0;
    StateInfo st;
    for (const ExtMove& m : list) {
        if (!p.legal(m)) continue;
        if (depth == 1) { nodes++; continue; }
        p.do_move(m, st);
        nodes += perft_count(p, depth - 1);
        p.undo_move(m);
    }
    return nodes;
}

static void bench() {
    const char* fens[] = {
        "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1",
        "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1",
        "r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10",
        "rnbq1rk1/pp2ppbp/3p1np1/8/2PNP3/2N1B3/PP2BPPP/R2QK2R w KQ - 0 8",
        "8/8/8/2k5/2pP4/8/B7/4K3 b - d3 0 3",
    };
    int64_t totalNodes = 0;
    int64_t start = Search::now_ms();
    for (const char* f : fens) {
        pos.set(f);
        TT.clear();
        Search::Limits lim; lim.depth = 12; lim.startTime = Search::now_ms();
        // Redirect: just run and count via a synchronous search
        Search::request_stop(false);
        Search::start(pos, lim);
    }
    int64_t ms = Search::now_ms() - start;
    std::cout << "bench done in " << ms << " ms" << std::endl;
    (void)totalNodes;
}

// One-time engine startup. Native: also loads net.nnue/book.bin/syzygy off
// disk (unchanged behavior). Under __EMSCRIPTEN__ there is no filesystem in
// the browser, so all three are skipped here — the wasm entry point
// (wasm_main.cpp) instead calls NNUE::load_from_memory() once the JS side has
// fetched the net bytes. Skipping book/syzygy is safe by construction: an
// unloaded Book::loaded()==false makes try_book_move() a no-op regardless of
// OwnBook, and TB::loaded()==false gates every TB:: call in search.cpp — both
// are the exact same "not loaded" state a native run with no book.bin/syzygy/
// directory already produces (book.cpp/zug_tb.cpp's documented fallback).
void uci_init() {
    BB::init();
    Zobrist::init();
    Eval::init();
    Search::init();
#ifndef __EMSCRIPTEN__
    if (NNUE::load("net.nnue"))
        std::cerr << "NNUE: loaded net.nnue\n";
    else
        std::cerr << "NNUE: net.nnue absent — using HCE\n";
    if (book.load("book.bin"))
        std::cerr << "Book: loaded book.bin\n";
    else
        std::cerr << "Book: book.bin absent/unusable — OwnBook will no-op\n";
    {
        const char* p = getenv("SYZYGY_PATH");
        std::string tbPath = (p && *p) ? p : "syzygy";  // cwd-relative symlink, like net.nnue
        if (TB::init(tbPath.c_str()))
            std::cerr << "Syzygy: loaded " << tbPath << " (max " << TB::max_pieces() << "-man)\n";
        else
            std::cerr << "Syzygy: none at " << tbPath << " — TB probing off\n";
    }
#else
    std::cerr << "NNUE: wasm build — waiting for load_net_from_memory()\n";
#endif
    TT.resize(ttSizeMB);

    pos.set(START_FEN);
}

// Dispatches ONE UCI command line. This is the exact body of the old
// uci_main() stdin loop, extracted verbatim (a pure refactor — see uci.h) so
// the wasm entry point can feed it commands one at a time without a stdin
// loop, while native behavior (uci_main() below) is completely unchanged.
bool uci_command(const std::string& line) {
    {
        std::istringstream is(line);
        std::string cmd;
        is >> cmd;

        if (cmd == "uci") {
            std::cout << "id name " << ENGINE_NAME << "\n";
            std::cout << "id author " << ENGINE_AUTHOR << "\n";
            std::cout << "option name Hash type spin default 128 min 1 max 4096\n";
#ifdef __EMSCRIPTEN__
            std::cout << "option name Threads type spin default 1 min 1 max 1\n";
#else
            std::cout << "option name Threads type spin default 1 min 1 max 256\n";
#endif
            std::cout << "option name MultiPV type spin default 1 min 1 max 256\n";
            // SPSA-tunable search margins (search.cpp Tune struct; Search::set_tune_option
            // applies these on setoption). Defaults reproduce the pre-tunable literals exactly.
            std::cout << "option name RfpMargin type spin default 84 min 40 max 130\n";
            std::cout << "option name RazorMargin type spin default 222 min 100 max 350\n";
            std::cout << "option name FutBase type spin default 0 min 0 max 220\n";
            std::cout << "option name FutSlope type spin default 107 min 40 max 150\n";
            std::cout << "option name SeeQuietCoeff type spin default 17 min 10 max 45\n";
            std::cout << "option name CaptSeeCoeff type spin default 23 min 0 max 180\n";
            std::cout << "option name NmpEvalDiv type spin default 120 min 80 max 400\n";
            std::cout << "option name SingularMargin type spin default 35 min 16 max 80\n";
            // HISTMARGIN constants (only read when env HISTMARGIN=1) — exposed for a
            // co-tuned SPSA (both arms run HISTMARGIN=1 while SPSA drives these + margins).
            std::cout << "option name HistPruneCoeff type spin default 8000 min 1000 max 40000\n";
            std::cout << "option name HistMarginDiv type spin default 8000 min 1000 max 40000\n";
            // LMRCLUSTER fine-term tunables (2026-07-16, search.cpp Tune struct) — the
            // co-dependent corrMargin/allNodeLmr/rootDeltaLmr trio's constants, exposed
            // for a joint SPSA campaign (env LMRCLUSTER=1 turns the trio on; these
            // options tune the constants regardless of which of the trio's flags are
            // set). LmrBase/LmrDiv wire values are the underlying double x 10000
            // (Search::LMR_DOUBLE_SCALE) since UCI spin options are integers.
            std::cout << "option name RootDeltaCoeff type spin default 608 min 200 max 1200\n";
            std::cout << "option name CorrMarginDiv type spin default 30370 min 10000 max 100000\n";
            std::cout << "option name AllNodeDiv type spin default 1 min 1 max 6\n";
            std::cout << "option name DblExtMargin type spin default 64 min 20 max 130\n";
            std::cout << "option name LmrBase type spin default 7844 min 3000 max 15000\n";
            std::cout << "option name LmrDiv type spin default 24696 min 15000 max 40000\n";
            // CAPFUT constants (2026-07-20, only read when env CAPFUT=1) — capture
            // futility pruning, search.cpp Tune::capFut* (SF search.cpp:1064-1072).
            std::cout << "option name CapFutBase type spin default 112 min 0 max 220\n";
            std::cout << "option name CapFutSlope type spin default 104 min 20 max 200\n";
            std::cout << "option name CapFutHistCoeff type spin default 41 min 0 max 120\n";
            // HISTDECAY constants (2026-07-20, only read when env HISTDECAY=1) —
            // per-search main-history decay (once per go, before the ID loop),
            // search.cpp Tune::histDecay* (sf-sp-search-backlog.md #2; faithful
            // cadence match to SF search.cpp:316-319 and Stormphrax
            // history.h:108-134 -- see the Tune::histDecay comment). Wire
            // values ARE the fraction's numerator/denominator directly (not
            // x-scaled), default 3/4 = SF's own decay factor.
            std::cout << "option name HistDecayNum type spin default 3 min 1 max 32\n";
            std::cout << "option name HistDecayDen type spin default 4 min 2 max 64\n";
            // CUTOFFGRADE constants (2026-07-20, only read when env CUTOFFGRADE=1) —
            // graded cutoffCnt->LMR reduction, search.cpp Tune::cutoffGrade*
            // (sf-sp-search-backlog.md #3; SF search.cpp:1208-1209). Wire values are
            // already in zug's native r x1024 fixed-point units — no rescale.
            std::cout << "option name CutoffGradeBase type spin default 256 min 0 max 2048\n";
            std::cout << "option name CutoffGradeStep type spin default 1024 min 0 max 2048\n";
            // POSTLMRCH constant (2026-07-20, only read when env POSTLMRCH=1) —
            // post-LMR continuation-history bonus, search.cpp Tune::postLmrCh*
            // (sf-sp-search-backlog.md #4; SF search.cpp:1259).
            std::cout << "option name PostLmrChBonus type spin default 43 min 0 max 400\n";
            // CHECKORDER constants (2026-07-20, only read when env CHECKORDER=1) —
            // givesCheck quiet-ordering bonus, search.cpp Tune::checkOrder*
            // (sf-sp-search-backlog.md #6; SF movepick.cpp:170).
            std::cout << "option name CheckOrderBonus type spin default 4096 min 0 max 20000\n";
            std::cout << "option name CheckOrderSeeMargin type spin default -36 min -100 max 0\n";
            // HISTTAPER / HISTTTBONUS constants (2026-07-20, only read when the owning
            // env flag is on) — sf-sp-search-backlog.md #8b/#8c, SF search.cpp:1833/1841.
            std::cout << "option name HistTaperK type spin default 5 min 0 max 32\n";
            std::cout << "option name HistTtBonusVal type spin default 90 min 0 max 400\n";
            // LMREXT (2026-07-20, only read when env LMREXT=1) — sf-sp-search-backlog.md
            // #11, SF search.cpp:1231. lmrExtCap = extra plies LMR may extend past newDepth.
            std::cout << "option name LmrExtCap type spin default 2 min 0 max 4\n";
            // TTPVRICH coefficients (2026-07-25, only read when env/opt TTPVRICH=1) —
            // conditioned ttPv LMR de-reduction, search.cpp Tune::ttPv* (SF search.cpp:1191-93
            // signal structure, zug-native magnitudes). x1024 = plies.
            std::cout << "option name TtPvBase type spin default 1024 min 0 max 3072\n";
            std::cout << "option name TtPvPvW type spin default 0 min 0 max 1536\n";
            std::cout << "option name TtPvPromW type spin default 1024 min 0 max 1536\n";
            std::cout << "option name TtPvDeepW type spin default 0 min 0 max 1536\n";
            std::cout << "option name TtPvDeepCutW type spin default 0 min 0 max 1536\n";
            // PCM constants (2026-07-20, only read when env PCM=1) — fail-low parent-move
            // credit, sf-sp-search-backlog.md #10, SF search.cpp:1423 / SP search.cpp:1398.
            std::cout << "option name PcmBase type spin default 260 min -1024 max 1024\n";
            std::cout << "option name PcmDepthW type spin default 400 min 0 max 768\n";
            std::cout << "option name PcmDepthMax type spin default 4018 min 2048 max 8192\n";
            std::cout << "option name PcmParentMcW type spin default 976 min 0 max 2048\n";
            std::cout << "option name PcmSeW type spin default 1047 min 0 max 2048\n";
            std::cout << "option name PcmParentSeW type spin default 1023 min 0 max 2048\n";
            std::cout << "option name PcmSeThresh type spin default 100 min 40 max 240\n";
            std::cout << "option name PcmParentSeThr type spin default 60 min 40 max 240\n";
            std::cout << "option name PcmDiv type spin default 4096 min 512 max 16384\n";
            // QSMOVECAP (2026-07-20, only read when env QSMOVECAP=1) — sf-sp #7.
            std::cout << "option name QsMoveCapN type spin default 2 min 1 max 8\n";
            // RULE50DAMP (2026-07-20, only read when env RULE50DAMP=1) — SF evaluate.cpp:83.
            std::cout << "option name Rule50DampDiv type spin default 199 min 80 max 400\n";
            std::cout << "option name EvalComplexityDiv type spin default 2600 min 400 max 20000\n";
            // MoveOverhead (2026-07-20): per-move latency slack (ms), clock-mode TM only.
            // Default 40 = zug's old hardcoded literal → byte-identical. Lower (e.g. 10, SF's
            // default) for low-latency local CCRL; raise for networked play to never flag.
            std::cout << "option name MoveOverhead type spin default 40 min 0 max 5000\n";
            // Contempt (2026-07-20): cp draw-avoidance bias added to static eval from the root
            // side's POV (Stormphrax). Default 0 = OFF. Positive avoids draws vs weaker fields.
            std::cout << "option name Contempt type spin default 0 min -1000 max 1000\n";
            // TTCUTBONUS margin knobs (2026-07-21, only read when env TTCUTBONUS=1) — bonus =
            // depth*depth * Num/Den, prev-ply malus = (depth+1)^2 * Num/Den. For A/B + SPSA.
            std::cout << "option name TtCutBonusNum type spin default 1 min 0 max 8\n";
            std::cout << "option name TtCutBonusDen type spin default 1 min 1 max 8\n";
            std::cout << "option name TtCutMalusNum type spin default 1 min 0 max 8\n";
            std::cout << "option name TtCutMalusDen type spin default 1 min 1 max 8\n";
            // LMPHIST divisor (2026-07-21, only read when env LMPHIST=1) — SP history-scaled LMP.
            std::cout << "option name LmpHistDiv type spin default 4000 min 500 max 40000\n";
            // RFPTTHIT coeff (2026-07-21, only read when env RFPTTHIT=1) — SF ttHit RFP multiplier.
            std::cout << "option name RfpTtHitCoeff type spin default 23 min 0 max 60\n";
            // SINGCORRMARGIN div (2026-07-21, only read when env SINGCORRMARGIN=1) — SF singular corrValue term.
            std::cout << "option name SingCorrDiv type spin default 230673 min 40000 max 800000\n";
            // FUTSFTERMS bonuses (2026-07-21, only read when env FUTSFTERMS=1) — SF futility-value terms.
            std::cout << "option name FutNoMoveBonus type spin default 77 min 0 max 200\n";
            std::cout << "option name FutAlphaBonus type spin default 41 min 0 max 200\n";
            // TTPVFAILLOW r (2026-07-21, only read when env TTPVFAILLOW=1) — SP ttpv-fail-low LMR term.
            std::cout << "option name TtPvFailLowR type spin default 1024 min 0 max 2048\n";
            // SINGTTPV coeff (2026-07-23, only read when env SINGTTPV=1) — sf-sp-search-
            // backlog.md #14, SF search.cpp:1119,1127 singular ttPv margin widening.
            std::cout << "option name SingTtPvCoeff type spin default 50 min 0 max 200\n";
            // RFPQUAD coeff (2026-07-23, only read when env RFPQUAD=1) — sf-sp-search-
            // backlog.md #20, Stormphrax search.cpp:838-853 RFP quadratic depth term.
            std::cout << "option name RfpQuadCoeff type spin default 4 min 0 max 30\n";
            // NONLMRRED constants (2026-07-23, only read when env NONLMRRED=1) — sf-sp-
            // search-backlog.md #12, SF search.cpp:1263-1273 non-LMR fallback reduction.
            std::cout << "option name NonLmrNoTtR type spin default 1140 min 0 max 4096\n";
            std::cout << "option name NonLmrT1 type spin default 3957 min 0 max 12288\n";
            std::cout << "option name NonLmrT2 type spin default 5654 min 0 max 12288\n";
            // OPTIMISM constants (2026-07-23, only read when env OPTIMISM=1) — sf-sp-search-
            // backlog.md #17, Stormphrax search.cpp:463-468 single-scalar root optimism.
            std::cout << "option name OptimismScale type spin default 120 min 0 max 400\n";
            std::cout << "option name OptimismStretch type spin default 100 min 1 max 400\n";
            std::cout << "option name OptBase type spin default 64 min 0 max 400\n";
            std::cout << "option name OptMatScale type spin default 20 min 0 max 200\n";
            std::cout << "option name OptDiv type spin default 800 min 100 max 4000\n";
            // PIECETOHIST / CONTHISTBASE constants (2026-07-24, only read when the owning
            // env flag is on) — Stormphrax history.h pieceTo table + conthist-base blend.
            std::cout << "option name PieceToWeight type spin default 256 min 0 max 2048\n";
            std::cout << "option name ConthistBaseButterflyW type spin default 211 min 0 max 4096\n";
            std::cout << "option name ConthistBasePieceToW type spin default 101 min 0 max 4096\n";
            std::cout << "option name ConthistBaseCont1W type spin default 929 min 0 max 4096\n";
            std::cout << "option name ConthistBaseCont2W type spin default 917 min 0 max 4096\n";
            std::cout << "option name ConthistBaseCont4W type spin default 553 min 0 max 4096\n";
            std::cout << "option name ConthistBaseCont6W type spin default 320 min 0 max 4096\n";
            // Ponder (2026-07-20): advertises pondering support so a GUI/CCRL will send
            // `go ponder`. Not read by the engine — pondering is honored unconditionally on
            // `go ponder`; this flag only tells the GUI the feature exists.
            std::cout << "option name Ponder type check default false\n";
            std::cout << "option name OwnBook type check default true\n";
            std::cout << "option name UCI_LimitStrength type check default false\n";
            std::cout << "option name UCI_Elo type spin default " << Rating::RatingMax
                      << " min " << Rating::RatingMin << " max " << Rating::RatingMax << "\n";
            std::cout << "uciok" << std::endl;
        } else if (cmd == "isready") {
            std::cout << "readyok" << std::endl;
        } else if (cmd == "setoption") {
            std::string token, name, value;
            is >> token; // "name"
            is >> name;
            is >> token; // "value"
            is >> value;
            if (name == "Hash") {
                ttSizeMB = std::stoi(value);
                TT.resize(ttSizeMB);
            } else if (name == "Threads") {
#ifdef __EMSCRIPTEN__
                // No pthreads in the wasm build: single search-thread only,
                // regardless of what the caller asks for (see go_cmd).
                engineThreads = 1;
#else
                engineThreads = std::max(1, std::min(256, std::stoi(value)));
#endif
            } else if (name == "MultiPV") {
                multiPV = std::max(1, std::min(256, std::stoi(value)));
            } else if (name == "OwnBook") {
                ownBook = (value == "true");
            } else if (name == "UCI_LimitStrength") {
                uciLimitStrength = (value == "true");
            } else if (name == "UCI_Elo") {
                uciElo = std::max(Rating::RatingMin, std::min(Rating::RatingMax, std::stoi(value)));
            } else if (name == "Ponder") {
                // Advertise-only (see the option decl): pondering is honored unconditionally
                // on `go ponder`. Swallow here so the "true"/"false" value never hits the
                // std::stoi fallthrough below (which would throw on a non-numeric string).
            } else {
                Search::set_tune_option(name, std::stoi(value));
            }
        } else if (cmd == "ucinewgame") {
            stop_search();
            Search::clear();
            TT.resize(ttSizeMB);
        } else if (cmd == "position") {
            stop_search();
            position_cmd(is);
        } else if (cmd == "go") {
            go_cmd(is);
        } else if (cmd == "ponderhit") {
            // Opponent played the predicted move: convert the running ponder search to timed.
            // The search thread keeps running; clearing the flag makes its next time check bite
            // (clock measured from the original `go ponder`, so ponder time already counts).
            Search::ponderhit();
        } else if (cmd == "stop") {
            stop_search();
        } else if (cmd == "quit") {
            stop_search();
            return false; // signals uci_main() to stop reading stdin (old loop's `break`)
        } else if (cmd == "perft") {
            int d; is >> d;
            int64_t start = Search::now_ms();
            uint64_t n = perft_count(pos, d);
            int64_t ms = Search::now_ms() - start;
            std::cout << "perft " << d << " = " << n << " (" << ms << " ms)" << std::endl;
        } else if (cmd == "bench") {
            bench();
        } else if (cmd == "eval") {
            std::cout << "eval " << Eval::evaluate(pos);
            // SATDIAG=1 also reports how many tail SCReLU lanes railed (see
            // nnue_internal.h): "sat l1 lo/hi of 16, l2 lo/hi of 32". All-rails ==
            // the tail output is a constant and the eval says nothing about the board.
            if (NNUE::satdiag_enabled())
                std::cout << " sat l1 " << NNUE::g_satdiag.l1lo << "/" << NNUE::g_satdiag.l1hi
                          << " of " << NNUE::D2 << "  l2 " << NNUE::g_satdiag.l2lo << "/"
                          << NNUE::g_satdiag.l2hi << " of " << NNUE::D3
                          << "  overshoot lo " << NNUE::g_satdiag.ovLo
                          << " hi " << NNUE::g_satdiag.ovHi;
            std::cout << std::endl;
        } else if (cmd == "d") {
            std::cout << pos.fen() << std::endl;
        }
    }
    return true;
}

// Entry point for the UCI CLI path (bare `./zugzwang`, no subcommand). Renamed
// from `main` so main.cpp can dispatch between this and `serve_main` (the HTTP
// serve subcommand, src/serve.cpp) — the UCI loop itself is untouched: it now
// just calls uci_init() once and uci_command() per stdin line, both above.
int uci_main() {
    uci_init();
    std::string line;
    while (std::getline(std::cin, line))
        if (!uci_command(line)) break;
    stop_search();
    return 0;
}
