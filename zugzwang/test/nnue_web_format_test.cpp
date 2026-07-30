// nnue_web_format_test: proves the pre-quantized "web format" loader (src/nnue_net.cpp
// load_net_prequant, spec in src/nnue_web_format.h) produces a Net BYTE-IDENTICAL to
// the existing float32 loader, and that a corrupted pre-quantized file is refused
// rather than silently loaded.
//
// Three checks, run in order (all must pass for exit code 0):
//   a) struct equality — load the float32 net, snapshot Net, write it out as
//      pre-quantized, load that fresh, memcmp every array raw-byte-for-byte.
//   b) golden eval vectors — evaluate >=20 diverse FENs with the float32-loaded net
//      and with the pre-quantized-loaded net; assert EXACT integer cp equality.
//      Vectors are persisted to test/golden_eval_web.txt (fen | eval, one per line) —
//      a later WASM build should be checked against this same file.
//   c) corruption detection — flip one payload byte in the pre-quantized file and
//      assert the loader refuses it (checksum mismatch), not that it loads garbage.
//
// Build: `make nnue_web_format_test` (see Makefile) or:
//   c++ -std=c++17 -O3 -DNDEBUG -ffp-contract=off -Isrc \
//     test/nnue_web_format_test.cpp src/position.cpp src/bitboard.cpp src/zobrist.cpp \
//     src/movegen.cpp src/rules.cpp src/weakening.cpp src/antichess.cpp \
//     src/nnue_net.cpp src/nnue_features.cpp src/nnue_eval.cpp src/nnue_accumulator.cpp \
//     -o test/nnue_web_format_test
// Run: ./test/nnue_web_format_test [path-to-float32-net]   (default net.nnue)

#include "nnue.h"
#include "nnue_net.h"
#include "nnue_web_format.h"
#include "position.h"
#include "bitboard.h"
#include "zobrist.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

using namespace NNUE;

namespace {

// >=20 diverse FENs: opening, middlegame, castled, high/low material, mate-adjacent
// endgames, en passant, asymmetric castling rights, a Chess960-shuffled back rank.
// First 20 are drawn from test/golden_eval.txt (already vetted-legal by golden_check.sh);
// the last 4 are new, added for coverage this test cares about specifically.
const char* kFens[] = {
    "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1",
    "r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3",
    "rnbqkb1r/pp2pppp/3p1n2/2p5/4P3/2N2N2/PPPP1PPP/R1BQKB1R w KQkq - 0 5",
    "r1bq1rk1/pp2bppp/2n1pn2/2pp4/3P1B2/2NBPN2/PPP2PPP/R2Q1RK1 w - - 0 8",
    "r2q1rk1/pp1bbppp/2np1n2/4p3/2B1P3/2NP1N2/PPP2PPP/R1BQ1RK1 w - - 0 9",
    "r1bqk2r/ppp2ppp/2np1n2/2b1p3/2B1P3/2NP1N2/PPP2PPP/R1BQK2R w KQkq - 0 6",
    "2rq1rk1/pp1bbppp/2np1n2/4p3/4P3/1NNP2P1/PPP1QPBP/R1B2RK1 b - - 0 11",
    "r3k2r/pbpnqppp/1p2pn2/3p4/2PP4/2NBPN2/PP1BQPPP/R3K2R w KQkq - 0 10",
    "r1b1k2r/ppppnppp/2n2q2/2b5/3NP3/2P5/PP3PPP/RNBQKB1R w KQkq - 0 7",
    "rnbq1rk1/ppp1ppbp/3p1np1/8/2PPP3/2N2N2/PP2BPPP/R1BQK2R b KQ - 0 6",
    "r1bqr1k1/pp1nbppp/2p2n2/3p4/3P4/2NBPN2/PPQ2PPP/R1B2RK1 b - - 0 11",
    "r3r1k1/1pq2ppp/p1np1n2/2p1p3/4P3/1BPPBN2/PP1Q1PPP/R3R1K1 w - - 0 15",
    "2r3k1/1p3ppp/p1n1p3/3pP3/1b1P4/2N1BN2/PP3PPP/2R3K1 w - - 0 18",
    "6k1/5ppp/8/8/8/8/1R3PPP/6K1 w - - 0 40",
    "r5k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 35",
    "8/5ppk/8/8/8/8/1R3PPK/8 b - - 0 45",
    "6k1/5ppp/8/8/3B4/8/5PPP/6K1 w - - 0 40",
    "6k1/5ppp/8/3n4/8/8/5PPP/6K1 b - - 0 40",
    "8/8/4k3/8/8/2B1N3/4K3/8 w - - 0 60",
    // --- new for this test ---
    "r3k2r/8/8/8/8/8/8/R3K2R w Kq - 0 1",                     // asymmetric castling rights
    "nbbrkrqn/pppppppp/8/8/8/8/PPPPPPPP/NBBRKRQN w KQkq - 0 1", // Chess960-shuffled back rank
    "8/8/8/8/3k4/8/3N4/4K3 w - - 0 1",                          // low material, K+N vs K
    "rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3", // en passant, white to move
};
constexpr int kNumFens = sizeof(kFens) / sizeof(kFens[0]);

bool net_equal(const Net& a, const Net& b) {
    bool ok = true;
    auto cmp16 = [&](const char* name, const std::vector<int16_t>& x, const std::vector<int16_t>& y) {
        if (x.size() != y.size() || std::memcmp(x.data(), y.data(), x.size() * sizeof(int16_t)) != 0) {
            std::printf("  MISMATCH: %s (sizes %zu vs %zu)\n", name, x.size(), y.size());
            ok = false;
        }
    };
    auto cmp8 = [&](const char* name, const std::vector<int8_t>& x, const std::vector<int8_t>& y) {
        if (x.size() != y.size() || std::memcmp(x.data(), y.data(), x.size() * sizeof(int8_t)) != 0) {
            std::printf("  MISMATCH: %s (sizes %zu vs %zu)\n", name, x.size(), y.size());
            ok = false;
        }
    };
    auto cmpf = [&](const char* name, const std::vector<float>& x, const std::vector<float>& y) {
        if (x.size() != y.size() || std::memcmp(x.data(), y.data(), x.size() * sizeof(float)) != 0) {
            std::printf("  MISMATCH: %s (sizes %zu vs %zu)\n", name, x.size(), y.size());
            ok = false;
        }
    };
    cmp16("W0i", a.W0i, b.W0i);
    cmp16("B0i", a.B0i, b.B0i);
    cmp8("L1W8", a.L1W8, b.L1W8);
    cmpf("L1B", a.L1B, b.L1B);
    cmpf("L2W", a.L2W, b.L2W);
    cmpf("L2B", a.L2B, b.L2B);
    cmpf("OW", a.OW, b.OW);
    cmpf("OB", a.OB, b.OB);
    return ok;
}

std::vector<int> eval_all() {
    std::vector<int> out;
    out.reserve(kNumFens);
    for (const char* fen : kFens) {
        Position pos;
        pos.set(fen);
        out.push_back(NNUE::evaluate(pos));
    }
    return out;
}

bool flip_byte(const char* srcPath, const char* dstPath, long offset) {
    std::FILE* fp = std::fopen(srcPath, "rb");
    if (!fp) return false;
    std::fseek(fp, 0, SEEK_END);
    long n = std::ftell(fp);
    std::fseek(fp, 0, SEEK_SET);
    std::vector<unsigned char> buf(static_cast<size_t>(n));
    size_t got = std::fread(buf.data(), 1, buf.size(), fp);
    std::fclose(fp);
    if (got != buf.size() || offset < 0 || offset >= n) return false;
    buf[static_cast<size_t>(offset)] ^= 0xFF;
    std::FILE* out = std::fopen(dstPath, "wb");
    if (!out) return false;
    size_t wrote = std::fwrite(buf.data(), 1, buf.size(), out);
    std::fclose(out);
    return wrote == buf.size();
}

} // namespace

int main(int argc, char** argv) {
    BB::init();
    Zobrist::init();

    const char* floatPath = argc > 1 ? argv[1] : "net.nnue";
    const char* prequantPath = "test/.tmp_web_net.bin";
    const char* corruptPath  = "test/.tmp_web_net_corrupt.bin";
    const char* goldenOut    = "test/golden_eval_web.txt";

    int failures = 0;

    // --- load float32 net, snapshot ---
    std::printf("== loading float32 net: %s ==\n", floatPath);
    if (!load_net(floatPath) || !g_net.ok) {
        std::printf("FATAL: load_net(%s) failed\n", floatPath);
        return 1;
    }
    Net netA = g_net; // deep copy (std::vector copy ctor)
    std::printf("  W0i=%zu B0i=%zu L1W8=%zu L1B=%zu L2W=%zu L2B=%zu OW=%zu OB=%zu\n",
                netA.W0i.size(), netA.B0i.size(), netA.L1W8.size(), netA.L1B.size(),
                netA.L2W.size(), netA.L2B.size(), netA.OW.size(), netA.OB.size());

    // --- (b) prep: evaluate golden FENs with the float32-loaded net ---
    std::vector<int> valsA = eval_all();

    // --- write pre-quantized file from the snapshot, load it back fresh ---
    std::printf("== writing pre-quantized net: %s ==\n", prequantPath);
    if (!WebFormat::write_net(netA, prequantPath)) {
        std::printf("FATAL: write_net(%s) failed\n", prequantPath);
        return 1;
    }

    std::printf("== loading pre-quantized net: %s ==\n", prequantPath);
    if (!load_net(prequantPath) || !g_net.ok) {
        std::printf("FATAL: load_net(%s) [prequant] failed\n", prequantPath);
        return 1;
    }

    // --- (a) struct equality ---
    std::printf("== (a) struct equality: float32-loaded Net vs pre-quantized-loaded Net ==\n");
    if (net_equal(netA, g_net)) {
        std::printf("  PASS: all arrays byte-identical\n");
    } else {
        std::printf("  FAIL: see MISMATCH lines above\n");
        ++failures;
    }

    // --- (b) golden eval vectors ---
    std::printf("== (b) golden eval vectors (%d FENs) ==\n", kNumFens);
    std::vector<int> valsB = eval_all();
    int mism = 0;
    std::FILE* gf = std::fopen(goldenOut, "w");
    if (gf) {
        std::fprintf(gf, "# golden_eval_web.txt — NNUE::evaluate() stm-relative centipawns,\n");
        std::fprintf(gf, "# computed by test/nnue_web_format_test.cpp. Format: fen | eval\n");
        std::fprintf(gf, "# Byte-identical whether the net was loaded from the float32 export\n");
        std::fprintf(gf, "# or from the pre-quantized web format (src/nnue_web_format.h) — this\n");
        std::fprintf(gf, "# file is the reference a WASM build should reproduce exactly.\n");
    }
    for (int i = 0; i < kNumFens; ++i) {
        bool eq = valsA[i] == valsB[i];
        if (!eq) { ++mism; std::printf("  MISMATCH fen=%s float32=%d prequant=%d\n", kFens[i], valsA[i], valsB[i]); }
        if (gf) std::fprintf(gf, "%s | %d\n", kFens[i], valsA[i]);
    }
    if (gf) std::fclose(gf);
    if (mism == 0) {
        std::printf("  PASS: all %d evals exactly equal (golden written to %s)\n", kNumFens, goldenOut);
    } else {
        std::printf("  FAIL: %d/%d evals mismatched\n", mism, kNumFens);
        ++failures;
    }

    // --- (c) corruption detection ---
    std::printf("== (c) corruption detection ==\n");
    std::FILE* fp = std::fopen(prequantPath, "rb");
    std::fseek(fp, 0, SEEK_END);
    long fsize = std::ftell(fp);
    std::fclose(fp);
    long flipOffset = WebFormat::kHeaderSize + (fsize - static_cast<long>(WebFormat::kHeaderSize)) / 2;
    if (!flip_byte(prequantPath, corruptPath, flipOffset)) {
        std::printf("FATAL: could not create corrupt copy\n");
        return 1;
    }
    bool loadedCorrupt = load_net(corruptPath);
    if (!loadedCorrupt && !g_net.ok) {
        std::printf("  PASS: corrupted pre-quantized file (byte flipped at offset %ld) was refused\n", flipOffset);
    } else {
        std::printf("  FAIL: corrupted file was accepted (loadedCorrupt=%d g_net.ok=%d)\n", loadedCorrupt, g_net.ok);
        ++failures;
    }

    std::remove(prequantPath);
    std::remove(corruptPath);

    std::printf("== summary: %s ==\n", failures == 0 ? "ALL PASS" : "FAILURES PRESENT");
    return failures == 0 ? 0 : 1;
}
