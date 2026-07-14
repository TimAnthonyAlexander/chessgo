#include "position.h"
#include "movegen.h"
#include "search.h"
#include "eval.h"
#include "nnue.h"
#include "tt.h"
#include "bitboard.h"
#include "zobrist.h"
#include <iostream>
#include <sstream>
#include <thread>
#include <string>
#include <vector>

static const char* START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
static const char* ENGINE_NAME = "hce 1.0";
static const char* ENGINE_AUTHOR = "Claude (HCE)";

static Position pos;
static std::thread searchThread;
static int ttSizeMB = 128;

static void join_search() {
    if (searchThread.joinable()) searchThread.join();
}

static void stop_search() {
    Search::Stop = true;
    join_search();
}

// Apply a UCI move string to the position by matching against legal moves
static Move parse_move(Position& p, const std::string& str) {
    MoveList list;
    generate<ALL>(p, list);
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
    Search::Stop = false;
    searchThread = std::thread([limits]() { Search::start(pos, limits); });
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
        Search::Stop = false;
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
            std::cout << "option name Threads type spin default 1 min 1 max 1\n";
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
