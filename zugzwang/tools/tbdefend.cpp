// tbdefend — a perfect Syzygy DTZ oracle, used as the opponent (and the judge)
// in test/tb_conversion.py.
//
// WHY THIS EXISTS
// ---------------
// The bug this tool gates is "the engine wins a won ≤5-man ending on the board
// but draws it on the clock": WDL-in-search scores every winning child of the
// root identically (±(VALUE_TB_WIN - ply)), so search cannot tell a move that
// PROGRESSES from a move that merely PRESERVES the win, and the 50-move counter
// runs out. Catching that needs an opponent who plays the hardest possible
// stalling defence — anything softer lets a shuffling engine get away with it
// because the defender helpfully walks into the mate.
//
// Fathom's root probe IS that opponent, for free and by construction. In
// src/syzygy/tbprobe.cpp:2625 the `dtz < 0` (losing) branch of probe_root()
// picks the move with the most negative DTZ, i.e. the one that maximises the
// number of plies before the winner's next zeroing move. That is exactly
// "hold out for the 50-move rule as long as the tables allow" — perfect
// defence, not a heuristic approximation of it. Verified move-for-move against
// Stockfish 18 (~/sf18-arm) on the KNPvKB endgame from the reported game.
//
// The same probe doubles as the suite's judge. tb_probe_root_impl folds the
// halfmove clock into its WDL (dtz_to_wdl(), tbprobe.cpp:559): it reports
// TB_WIN only while `dtz + rule50 <= 100`, and downgrades to TB_CURSED_WIN the
// moment the win stops being reachable inside the remaining clock. So a caller
// that probes at every winner-to-move node sees the EXACT ply at which the win
// was thrown away. Note this is deliberately NOT the path src/zug_tb.cpp's
// probe_wdl() takes — that one calls tb_probe_wdl_impl, which ignores rule50
// and therefore reads a cursed win as a full win.
//
// OUTPUT CONTRACT (one line per input FEN, flushed, always three fields)
//
//     <uci> <wdl> <dtz>
//
//   uci   the DTZ-optimal move for the side to move, or one of the sentinels
//         `none` (position not probeable: >TB_LARGEST men, castling rights,
//         or missing tables), `checkmate` (side to move is mated),
//         `stalemate`.
//   wdl   Fathom's WDL code FROM THE SIDE TO MOVE's point of view, with the
//         50-move budget already applied: 0 LOSS, 1 BLESSED_LOSS, 2 DRAW,
//         3 CURSED_WIN, 4 WIN. -1 on `none`.
//   dtz   |DTZ| in plies (0 for the sentinels, -1 on `none`).
//
// Usage:
//   ./tools/tbdefend [--path DIR] [FEN ...]
// With no FEN arguments it reads one FEN per line from stdin and answers each
// one — that is the mode the suite uses, so a single process serves a whole
// game without re-mapping the tables.

#include "position.h"
#include "bitboard.h"
#include "zobrist.h"
#include "syzygy/tbprobe.h"

#include <cstdio>
#include <cstring>
#include <iostream>
#include <string>
#include <vector>

namespace {

const char* const kSquareName[64] = {
    "a1", "b1", "c1", "d1", "e1", "f1", "g1", "h1",
    "a2", "b2", "c2", "d2", "e2", "f2", "g2", "h2",
    "a3", "b3", "c3", "d3", "e3", "f3", "g3", "h3",
    "a4", "b4", "c4", "d4", "e4", "f4", "g4", "h4",
    "a5", "b5", "c5", "d5", "e5", "f5", "g5", "h5",
    "a6", "b6", "c6", "d6", "e6", "f6", "g6", "h6",
    "a7", "b7", "c7", "d7", "e7", "f7", "g7", "h7",
    "a8", "b8", "c8", "d8", "e8", "f8", "g8", "h8",
};

void usage() {
    std::printf(
        "tbdefend — perfect Syzygy DTZ oracle (move + rule50-aware WDL + DTZ)\n"
        "\n"
        "  ./tools/tbdefend [--path DIR] [FEN ...]\n"
        "\n"
        "  --path DIR   Syzygy directory (default \"syzygy\", cwd-relative — run\n"
        "               from the zugzwang root, same as `zugzwang serve`).\n"
        "  --help       this text\n"
        "\n"
        "With FEN arguments each is answered once and the tool exits; with none\n"
        "it answers one FEN per stdin line until EOF, flushing every line.\n"
        "\n"
        "Each answer is `<uci> <wdl> <dtz>`, where uci may be the sentinel\n"
        "`none` / `checkmate` / `stalemate`, wdl is Fathom's code with the\n"
        "halfmove clock applied (0 LOSS .. 4 WIN, -1 unknown) and dtz is |DTZ|\n"
        "in plies. For a LOSING side the move is the DTZ-maximizing one, i.e.\n"
        "the strongest possible 50-move-rule stalling defence.\n");
}

// One probe, formatted. Written straight to stdout and flushed so a pipe
// partner (the suite) can drive this synchronously, one FEN at a time.
void answer(const std::string& fen) {
    Position pos;
    pos.set(fen);

    // Fathom's Pos carries no castling state, so a position with castling
    // rights would be probed as though it had none — refuse rather than lie.
    // Likewise anything above the largest table on disk. Mirrors the guards in
    // src/zug_tb.cpp.
    if (BB::popcount(pos.pieces()) > (int) TB_LARGEST || pos.castling_rights() != 0) {
        std::printf("none -1 -1\n");
        std::fflush(stdout);
        return;
    }

    // Fathom wants the ep TARGET square with 0 = none; a1 is never a legal ep
    // square so the sentinel is unambiguous. zug uses SQ_NONE (64).
    unsigned ep = (pos.ep_square() == SQ_NONE) ? 0u : (unsigned) pos.ep_square();

    unsigned res = tb_probe_root_impl(
        pos.pieces(WHITE), pos.pieces(BLACK), pos.pieces(KING),
        pos.pieces(QUEEN), pos.pieces(ROOK), pos.pieces(BISHOP),
        pos.pieces(KNIGHT), pos.pieces(PAWN),
        pos.rule50_count(), ep, pos.side_to_move() == WHITE, nullptr);

    // These two are exact sentinel values (from/to both a1, dtz 0), so they
    // must be tested before decoding a move out of the result word.
    if (res == TB_RESULT_FAILED)    { std::printf("none -1 -1\n");     std::fflush(stdout); return; }
    if (res == TB_RESULT_CHECKMATE) { std::printf("checkmate 0 0\n");  std::fflush(stdout); return; }
    if (res == TB_RESULT_STALEMATE) { std::printf("stalemate 2 0\n");  std::fflush(stdout); return; }

    std::string uci = kSquareName[TB_GET_FROM(res)];
    uci += kSquareName[TB_GET_TO(res)];
    switch (TB_GET_PROMOTES(res)) {
        case TB_PROMOTES_QUEEN:  uci += 'q'; break;
        case TB_PROMOTES_ROOK:   uci += 'r'; break;
        case TB_PROMOTES_BISHOP: uci += 'b'; break;
        case TB_PROMOTES_KNIGHT: uci += 'n'; break;
        default: break;
    }

    std::printf("%s %u %u\n", uci.c_str(), TB_GET_WDL(res), TB_GET_DTZ(res));
    std::fflush(stdout);
}

}  // namespace

int main(int argc, char** argv) {
    std::string path = "syzygy";
    std::vector<std::string> fens;

    for (int i = 1; i < argc; ++i) {
        std::string a = argv[i];
        if (a == "--help" || a == "-h") { usage(); return 0; }
        if (a == "--path" && i + 1 < argc) { path = argv[++i]; continue; }
        if (a.rfind("--path=", 0) == 0)    { path = a.substr(7); continue; }
        if (!a.empty() && a[0] == '-')     { std::fprintf(stderr, "tbdefend: unknown option %s\n", a.c_str()); usage(); return 2; }
        fens.push_back(a);
    }

    BB::init();
    Zobrist::init();
    if (!tb_init(path.c_str()) || TB_LARGEST == 0) {
        std::fprintf(stderr, "tbdefend: no Syzygy tables under \"%s\" (cwd-relative)\n", path.c_str());
        return 1;
    }

    if (!fens.empty()) {
        for (const std::string& f : fens) answer(f);
        return 0;
    }

    std::string line;
    while (std::getline(std::cin, line)) {
        if (line.empty()) continue;
        answer(line);
    }
    return 0;
}
