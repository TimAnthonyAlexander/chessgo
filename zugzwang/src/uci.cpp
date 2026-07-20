#include "position.h"
#include "movegen.h"
#include "search.h"
#include "eval.h"
#include "nnue.h"
#include "tt.h"
#include "bitboard.h"
#include "zobrist.h"
#include "book.h"
#include "rating.h"
#include <iostream>
#include <sstream>
#include <thread>
#include <string>
#include <vector>
#include <algorithm>

static const char* START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
static const char* ENGINE_NAME = "hce 1.0";
static const char* ENGINE_AUTHOR = "Claude (HCE)";

static Position pos;
static std::thread searchThread;
static int ttSizeMB = 128;
static int engineThreads = 1; // UCI "Threads" option — Lazy SMP worker count (1 = single-thread)
static Book::Book book;
static bool ownBook = false;

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
    }
    if (uciLimitStrength) {
        // Weakened play through the rating ladder. Runs on the search thread (so
        // `stop` still joins cleanly) and prints its own bestmove — the ladder's
        // clean branch searches with silent=true, so there is no double print.
        Search::request_stop(false);
        int elo = uciElo, gd = limits.depth, gmt = limits.movetime;
        int64_t gn = limits.nodes;
        searchThread = std::thread([elo, gd, gmt, gn]() {
            std::vector<uint64_t> hist;
            Rating::WeakResult wr = Rating::best_move_for_rating_single(
                Search::default_context(), pos, elo, gd, gmt, gn, hist);
            std::cout << "bestmove " << (wr.move != MOVE_NONE ? move_to_uci(wr.move) : "0000")
                      << std::endl;
        });
        return;
    }
    if (try_book_move(pos)) return; // book hit: skip the search entirely
    Search::request_stop(false);
    // Lazy SMP: start_smp runs engineThreads Contexts sharing the global TT +
    // one stop flag. engineThreads==1 delegates to the byte-identical single-
    // thread path. The driver runs on this searchThread and joins its own
    // helper threads before returning, so stop_search()'s join still cleanly
    // waits for the entire (multi-threaded) search to finish.
    int nThreads = engineThreads;
    searchThread = std::thread([limits, nThreads]() { Search::start_smp(pos, limits, nThreads); });
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

// Entry point for the UCI CLI path (bare `./zugzwang`, no subcommand). Renamed
// from `main` so main.cpp can dispatch between this and `serve_main` (the HTTP
// serve subcommand, src/serve.cpp) — the UCI loop itself is untouched.
int uci_main() {
    BB::init();
    Zobrist::init();
    Eval::init();
    Search::init();
    if (NNUE::load("net.nnue"))
        std::cerr << "NNUE: loaded net.nnue\n";
    else
        std::cerr << "NNUE: net.nnue absent — using HCE\n";
    if (book.load("book.bin"))
        std::cerr << "Book: loaded book.bin\n";
    else
        std::cerr << "Book: book.bin absent/unusable — OwnBook will no-op\n";
    TT.resize(ttSizeMB);

    pos.set(START_FEN);

    std::string line;
    while (std::getline(std::cin, line)) {
        std::istringstream is(line);
        std::string cmd;
        is >> cmd;

        if (cmd == "uci") {
            std::cout << "id name " << ENGINE_NAME << "\n";
            std::cout << "id author " << ENGINE_AUTHOR << "\n";
            std::cout << "option name Hash type spin default 128 min 1 max 4096\n";
            std::cout << "option name Threads type spin default 1 min 1 max 256\n";
            // SPSA-tunable search margins (search.cpp Tune struct; Search::set_tune_option
            // applies these on setoption). Defaults reproduce the pre-tunable literals exactly.
            std::cout << "option name RfpMargin type spin default 75 min 40 max 130\n";
            std::cout << "option name RazorMargin type spin default 200 min 100 max 350\n";
            std::cout << "option name FutBase type spin default 0 min 0 max 220\n";
            std::cout << "option name FutSlope type spin default 100 min 40 max 150\n";
            std::cout << "option name SeeQuietCoeff type spin default 25 min 10 max 45\n";
            std::cout << "option name CaptSeeCoeff type spin default 23 min 0 max 180\n";
            std::cout << "option name NmpEvalDiv type spin default 200 min 80 max 400\n";
            std::cout << "option name SingularMargin type spin default 32 min 16 max 80\n";
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
            std::cout << "option name OwnBook type check default false\n";
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
                engineThreads = std::max(1, std::min(256, std::stoi(value)));
            } else if (name == "OwnBook") {
                ownBook = (value == "true");
            } else if (name == "UCI_LimitStrength") {
                uciLimitStrength = (value == "true");
            } else if (name == "UCI_Elo") {
                uciElo = std::max(Rating::RatingMin, std::min(Rating::RatingMax, std::stoi(value)));
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
        } else if (cmd == "stop") {
            stop_search();
        } else if (cmd == "quit") {
            stop_search();
            break;
        } else if (cmd == "perft") {
            int d; is >> d;
            int64_t start = Search::now_ms();
            uint64_t n = perft_count(pos, d);
            int64_t ms = Search::now_ms() - start;
            std::cout << "perft " << d << " = " << n << " (" << ms << " ms)" << std::endl;
        } else if (cmd == "bench") {
            bench();
        } else if (cmd == "eval") {
            std::cout << "eval " << Eval::evaluate(pos) << std::endl;
        } else if (cmd == "d") {
            std::cout << pos.fen() << std::endl;
        }
    }
    stop_search();
    return 0;
}
