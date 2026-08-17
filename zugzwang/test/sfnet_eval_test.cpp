// Wave 2 gate for the SF-net backend: builds and runs the from-scratch (no
// incremental accumulator, no SIMD) forward pass over a FEN corpus.
//
//   make sfnet_eval_test
//   ./test/sfnet_eval_test ~/sf18-arm/src/nn-c288c895ea92.nnue book.epd
//   ./test/sfnet_eval_test --self-check ~/sf18-arm/src/nn-c288c895ea92.nnue book.epd
//
// Default mode prints one TSV row per FEN: fen<TAB>bucket<TAB>psqt<TAB>positional.
// --self-check instead asserts SFNet::self_check() on every FEN (feature counts in
// range, no index escapes its dimension, evaluate_raw() runs clean) and prints a
// pass/fail summary.
//
// This test does NOT claim the numbers are correct against Stockfish — that
// comparison needs an independent SF-side oracle (a separate task) and is
// deliberately not done here.

#include "sfnet.h"
#include "position.h"
#include "bitboard.h"
#include "zobrist.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>

namespace {

std::vector<std::string> read_fens(const std::string& path) {
    std::vector<std::string> fens;
    std::ifstream f(path);
    std::string line;
    while (std::getline(f, line)) {
        // Trim trailing whitespace/CR; skip blank lines.
        while (!line.empty() && (line.back() == '\r' || line.back() == '\n' || line.back() == ' '))
            line.pop_back();
        if (!line.empty()) fens.push_back(line);
    }
    return fens;
}

}  // namespace

int main(int argc, char** argv) {
    BB::init();
    Zobrist::init();

    std::vector<std::string> args(argv + 1, argv + argc);
    bool selfCheck = false;
    std::vector<std::string> pos;
    for (const std::string& a : args) {
        if (a == "--self-check") selfCheck = true;
        else pos.push_back(a);
    }
    if (pos.size() < 2) {
        std::fprintf(stderr, "usage: %s [--self-check] <net.nnue> <fens.epd>\n", argv[0]);
        return 2;
    }
    const std::string netPath = pos[0];
    const std::string fenPath = pos[1];

    if (!SFNet::load(netPath.c_str())) {
        std::fprintf(stderr, "sfnet_eval_test: failed to load net %s\n", netPath.c_str());
        return 1;
    }

    const std::vector<std::string> fens = read_fens(fenPath);
    if (fens.empty()) {
        std::fprintf(stderr, "sfnet_eval_test: no FENs read from %s\n", fenPath.c_str());
        return 1;
    }

    if (selfCheck) {
        int fails = 0;
        for (const std::string& fen : fens) {
            Position p;
            p.set(fen);
            if (p.in_check()) continue;  // evaluate_raw's precondition; skip, not a failure
            std::string why;
            if (!SFNet::self_check(p, &why)) {
                std::fprintf(stderr, "FAIL %s -- %s\n", fen.c_str(), why.c_str());
                ++fails;
            }
        }
        std::printf("self-check: %zu positions, %d failed\n", fens.size(), fails);
        std::printf("%s\n", fails == 0 ? "RESULT: PASS" : "RESULT: FAIL");
        return fails == 0 ? 0 : 1;
    }

    for (const std::string& fen : fens) {
        Position p;
        p.set(fen);
        if (p.in_check()) continue;  // evaluate_raw's precondition (assert(!in_check()))
        const int bucket = (BB::popcount(p.pieces()) - 1) / 4;
        const SFNet::EvalPair ev = SFNet::evaluate_raw(p);
        std::printf("%s\t%d\t%d\t%d\n", fen.c_str(), bucket, ev.psqt, ev.positional);
    }
    return 0;
}
