#include "zobrist.h"
#include "bitboard.h"
#include <cstdio>
#include <cstdlib>
#include <cassert>

namespace Zobrist {
U64 psq[PIECE_NB][SQUARE_NB];
U64 enpassant[8];
U64 castling[16];
U64 side;

std::array<U64, 8192>  cuckoo;
std::array<Move, 8192> cuckooMove;

bool cuckoo_enabled() {
    static const bool v = []{ const char* e = std::getenv("CUCKOO"); return e && e[0] == '1'; }();
    return v;
}

// Empty-board attacks for a non-pawn piece type — the reversible-move test the
// cuckoo table population needs (zug has no runtime-dispatched BB::attacks(pt,s)
// overload, only the compile-time BB::attacks<Pt> template, so switch on pt here).
static U64 attacks_on_empty(PieceType pt, Square s) {
    switch (pt) {
        case KNIGHT: return BB::attacks<KNIGHT>(s);
        case BISHOP: return BB::attacks<BISHOP>(s);
        case ROOK:   return BB::attacks<ROOK>(s);
        case QUEEN:  return BB::attacks<QUEEN>(s);
        case KING:   return BB::attacks<KING>(s);
        default:     return 0;
    }
}

void init() {
    U64 s = 1070372ULL; // fixed seed → reproducible keys
    auto rand = [&]() {
        s ^= s >> 12; s ^= s << 25; s ^= s >> 27;
        return s * 2685821657736338717ULL;
    };
    for (int p = 0; p < PIECE_NB; ++p)
        for (int sq = 0; sq < SQUARE_NB; ++sq)
            psq[p][sq] = rand();
    for (int f = 0; f < 8; ++f) enpassant[f] = rand();
    for (int c = 0; c < 16; ++c) castling[c] = rand();
    side = rand();

    // Cuckoo tables (SF #15 port, docs/tasks/open/cuckoo-upcoming-repetition.md):
    // Marcel van Kervinck's cuckoo algorithm for fast upcoming-repetition detection.
    // Board-independent (only depends on psq/side above), so always populated here
    // regardless of CUCKOO — it's cheap (one-time, 8192-slot fill) and inert unless
    // upcoming_repetition() is actually called (gated at the search call sites).
    cuckoo.fill(0);
    cuckooMove.fill(MOVE_NONE);
    int count = 0;
    static const PieceType NonPawnTypes[5] = {KNIGHT, BISHOP, ROOK, QUEEN, KING};
    for (Color c : {WHITE, BLACK}) {
        for (PieceType pt : NonPawnTypes) {
            Piece pc = make_piece(c, pt);
            for (Square s1 = A1; s1 <= H8; s1 = Square(s1 + 1)) {
                for (Square s2 = Square(s1 + 1); s2 <= H8; s2 = Square(s2 + 1)) {
                    if (attacks_on_empty(pt, s1) & BB::square_bb(s2)) {
                        Move move = make_move(s1, s2);
                        U64  key  = psq[pc][s1] ^ psq[pc][s2] ^ side;
                        int  i    = H1(key);
                        while (true) {
                            std::swap(cuckoo[i], key);
                            std::swap(cuckooMove[i], move);
                            if (move == MOVE_NONE) break; // arrived at an empty slot
                            i = (i == H1(key)) ? H2(key) : H1(key); // push victim to alt slot
                        }
                        count++;
                    }
                }
            }
        }
    }
    // HARD SENTINEL: if this fires, the enumeration is wrong — fix it, never
    // remove/relax this check (see docs/tasks/open/cuckoo-upcoming-repetition.md).
    assert(count == 3668);
    if (count != 3668) {
        // The Makefile always builds -DNDEBUG (assert() above is compiled out in
        // the normal build), so this unconditional runtime check is the one that
        // actually fires in production if the port is ever wrong.
        std::fprintf(stderr, "CUCKOO COUNT=%d (expected 3668) — cuckoo table enumeration is WRONG\n", count);
        std::abort();
    }
}
}
