#include "zobrist.h"

namespace Zobrist {
U64 psq[PIECE_NB][SQUARE_NB];
U64 enpassant[8];
U64 castling[16];
U64 side;

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
}
}
