#include "bitboard.h"
#include <algorithm>

namespace BB {

U64 PawnAttacks[COLOR_NB][SQUARE_NB];
U64 KnightAttacks[SQUARE_NB];
U64 KingAttacks[SQUARE_NB];
U64 LineBB[SQUARE_NB][SQUARE_NB];
U64 BetweenBB[SQUARE_NB][SQUARE_NB];
uint8_t SquareDistance[SQUARE_NB][SQUARE_NB];

// ---- Magic bitboards ----
struct Magic {
    U64  mask;
    U64  magic;
    U64* attacks;
    unsigned shift;
    unsigned index(U64 occ) const {
        return unsigned(((occ & mask) * magic) >> shift);
    }
};

static Magic RookMagics[SQUARE_NB];
static Magic BishopMagics[SQUARE_NB];
static U64 RookTable[102400];
static U64 BishopTable[5248];

U64 bishop_attacks(Square s, U64 occ) {
    const Magic& m = BishopMagics[s];
    return m.attacks[m.index(occ)];
}
U64 rook_attacks(Square s, U64 occ) {
    const Magic& m = RookMagics[s];
    return m.attacks[m.index(occ)];
}

// Slow slider attack computation (used to fill magic tables)
static U64 sliding_attack(const int deltas[4][2], Square sq, U64 occ) {
    U64 attack = 0;
    int r0 = rank_of(sq), f0 = file_of(sq);
    for (int i = 0; i < 4; ++i) {
        int df = deltas[i][0], dr = deltas[i][1];
        int f = f0 + df, r = r0 + dr;
        while (f >= 0 && f <= 7 && r >= 0 && r <= 7) {
            Square s2 = make_square(f, r);
            attack |= square_bb(s2);
            if (occ & square_bb(s2)) break;
            f += df; r += dr;
        }
    }
    return attack;
}

// xorshift64* PRNG with sparse magic candidates (fixed seed → deterministic)
struct PRNG {
    U64 s;
    PRNG(U64 seed) : s(seed) {}
    U64 rand() {
        s ^= s >> 12; s ^= s << 25; s ^= s >> 27;
        return s * 2685821657736338717ULL;
    }
    U64 sparse_rand() { return rand() & rand() & rand(); }
};

static void init_magics(bool bishop, U64* table, Magic magics[]) {
    const int bishopDeltas[4][2] = {{1,1},{-1,1},{1,-1},{-1,-1}};
    const int rookDeltas[4][2]   = {{1,0},{-1,0},{0,1},{0,-1}};
    const int (*deltas)[2] = bishop ? bishopDeltas : rookDeltas;

    // Per-square seeds for reproducible magic search (Stockfish-style)
    U64 seeds[8] = {728, 10316, 55013, 32803, 12281, 15100, 16645, 255};

    U64 occupancy[4096], reference[4096];
    U64* attacksPtr = table;

    for (Square s = A1; s <= H8; s = Square(s + 1)) {
        // Board edges not relevant for the piece on this square
        U64 edges = ((Rank1 | Rank8) & ~RankBB[rank_of(s)]) |
                    ((FileA | FileH) & ~FileBB[file_of(s)]);

        Magic& m = magics[s];
        m.mask = sliding_attack(deltas, s, 0) & ~edges;
        m.shift = 64 - popcount(m.mask);
        m.attacks = attacksPtr;

        // Enumerate all subsets of mask (Carry-Rippler)
        U64 b = 0;
        int size = 0;
        do {
            occupancy[size] = b;
            reference[size] = sliding_attack(deltas, s, b);
            size++;
            b = (b - m.mask) & m.mask;
        } while (b);

        attacksPtr += size;

        PRNG rng(seeds[rank_of(s)]);
        long tries = 0;
        for (int i = 0; i < size; ) {
            if (++tries > 100000000) { fprintf(stderr, "STUCK sq=%d bishop=%d size=%d\n", s, bishop, size); abort(); }
            m.magic = 0;
            // require good spread in top bits
            while (popcount((m.mask * m.magic) >> 56) < 6)
                m.magic = rng.sparse_rand();

            // Verify magic maps all subsets uniquely (or consistently)
            static U64 used[4096];
            static int epoch[4096];
            static int cur = 0;
            cur++;
            bool fail = false;
            for (i = 0; i < size; ++i) {
                unsigned idx = m.index(occupancy[i]);
                if (epoch[idx] < cur) {
                    epoch[idx] = cur;
                    used[idx] = reference[i];
                    m.attacks[idx] = reference[i];
                } else if (used[idx] != reference[i]) {
                    fail = true;
                    break;
                }
            }
            if (fail) i = 0; // retry with a new magic
        }
    }
}

void init() {
    // distance
    for (Square a = A1; a <= H8; a = Square(a + 1))
        for (Square b = A1; b <= H8; b = Square(b + 1))
            SquareDistance[a][b] = uint8_t(std::max(std::abs(file_of(a) - file_of(b)),
                                                    std::abs(rank_of(a) - rank_of(b))));

    // pawn, knight, king attacks
    for (Square s = A1; s <= H8; s = Square(s + 1)) {
        U64 b = square_bb(s);
        PawnAttacks[WHITE][s] = shift<NORTH_EAST>(b) | shift<NORTH_WEST>(b);
        PawnAttacks[BLACK][s] = shift<SOUTH_EAST>(b) | shift<SOUTH_WEST>(b);

        U64 k = 0;
        int r = rank_of(s), f = file_of(s);
        const int knightMoves[8][2] = {{1,2},{2,1},{2,-1},{1,-2},{-1,-2},{-2,-1},{-2,1},{-1,2}};
        for (auto& mv : knightMoves) {
            int nf = f + mv[0], nr = r + mv[1];
            if (nf >= 0 && nf <= 7 && nr >= 0 && nr <= 7)
                k |= square_bb(make_square(nf, nr));
        }
        KnightAttacks[s] = k;

        U64 kk = 0;
        for (int df = -1; df <= 1; ++df)
            for (int dr = -1; dr <= 1; ++dr) {
                if (!df && !dr) continue;
                int nf = f + df, nr = r + dr;
                if (nf >= 0 && nf <= 7 && nr >= 0 && nr <= 7)
                    kk |= square_bb(make_square(nf, nr));
            }
        KingAttacks[s] = kk;
    }

    // magics
    init_magics(true,  BishopTable, BishopMagics);
    init_magics(false, RookTable,   RookMagics);

    // LineBB and BetweenBB (using slider attacks over empty board)
    for (Square s1 = A1; s1 <= H8; s1 = Square(s1 + 1)) {
        for (PieceType pt : {BISHOP, ROOK}) {
            U64 att1 = (pt == BISHOP) ? bishop_attacks(s1, 0) : rook_attacks(s1, 0);
            for (Square s2 = A1; s2 <= H8; s2 = Square(s2 + 1)) {
                if (!(att1 & square_bb(s2))) continue;
                // line
                U64 att2 = (pt == BISHOP) ? bishop_attacks(s2, 0) : rook_attacks(s2, 0);
                LineBB[s1][s2] = (att1 & att2) | square_bb(s1) | square_bb(s2);
                // between: squares strictly between s1 and s2, plus s2
                U64 occ2 = square_bb(s2);
                U64 b1 = (pt == BISHOP) ? bishop_attacks(s1, occ2) : rook_attacks(s1, occ2);
                U64 b2 = (pt == BISHOP) ? bishop_attacks(s2, square_bb(s1))
                                        : rook_attacks(s2, square_bb(s1));
                BetweenBB[s1][s2] = b1 & b2;
                BetweenBB[s1][s2] |= square_bb(s2);
            }
        }
    }
}

} // namespace BB
