#pragma once
#include "types.h"

namespace BB {

constexpr U64 FileA = 0x0101010101010101ULL;
constexpr U64 FileB = FileA << 1;
constexpr U64 FileC = FileA << 2;
constexpr U64 FileD = FileA << 3;
constexpr U64 FileE = FileA << 4;
constexpr U64 FileF = FileA << 5;
constexpr U64 FileG = FileA << 6;
constexpr U64 FileH = FileA << 7;

constexpr U64 Rank1 = 0xFFULL;
constexpr U64 Rank2 = Rank1 << (8 * 1);
constexpr U64 Rank3 = Rank1 << (8 * 2);
constexpr U64 Rank4 = Rank1 << (8 * 3);
constexpr U64 Rank5 = Rank1 << (8 * 4);
constexpr U64 Rank6 = Rank1 << (8 * 5);
constexpr U64 Rank7 = Rank1 << (8 * 6);
constexpr U64 Rank8 = Rank1 << (8 * 7);

constexpr U64 FileBB[8] = { FileA, FileB, FileC, FileD, FileE, FileF, FileG, FileH };
constexpr U64 RankBB[8] = { Rank1, Rank2, Rank3, Rank4, Rank5, Rank6, Rank7, Rank8 };

inline U64 square_bb(Square s) { return 1ULL << s; }

inline bool more_than_one(U64 b) { return b & (b - 1); }

// popcount
inline int popcount(U64 b) { return __builtin_popcountll(b); }

// least significant bit index
inline Square lsb(U64 b) { return Square(__builtin_ctzll(b)); }
inline Square msb(U64 b) { return Square(63 ^ __builtin_clzll(b)); }

inline Square pop_lsb(U64& b) {
    Square s = lsb(b);
    b &= b - 1;
    return s;
}

// Shift a bitboard in a direction (with wrap masking)
template <Direction D>
inline U64 shift(U64 b) {
    return D == NORTH      ? b << 8
         : D == SOUTH      ? b >> 8
         : D == EAST       ? (b & ~FileH) << 1
         : D == WEST       ? (b & ~FileA) >> 1
         : D == NORTH_EAST ? (b & ~FileH) << 9
         : D == NORTH_WEST ? (b & ~FileA) << 7
         : D == SOUTH_EAST ? (b & ~FileH) >> 7
         : D == SOUTH_WEST ? (b & ~FileA) >> 9
         : 0;
}

// ---- Precomputed tables (defined in bitboard.cpp) ----
extern U64 PawnAttacks[COLOR_NB][SQUARE_NB];
extern U64 KnightAttacks[SQUARE_NB];
extern U64 KingAttacks[SQUARE_NB];
extern U64 LineBB[SQUARE_NB][SQUARE_NB];    // full line through two squares
extern U64 BetweenBB[SQUARE_NB][SQUARE_NB]; // squares strictly between (incl. `to`)
extern uint8_t SquareDistance[SQUARE_NB][SQUARE_NB];

// Magic bitboard lookups
U64 bishop_attacks(Square s, U64 occ);
U64 rook_attacks(Square s, U64 occ);
inline U64 queen_attacks(Square s, U64 occ) {
    return bishop_attacks(s, occ) | rook_attacks(s, occ);
}

// attacks_by for a given piece type
inline U64 pawn_attacks(Color c, Square s) { return PawnAttacks[c][s]; }

template <PieceType Pt>
inline U64 attacks(Square s, U64 occ = 0) {
    switch (Pt) {
        case KNIGHT: return KnightAttacks[s];
        case KING:   return KingAttacks[s];
        case BISHOP: return bishop_attacks(s, occ);
        case ROOK:   return rook_attacks(s, occ);
        case QUEEN:  return queen_attacks(s, occ);
        default:     return 0;
    }
}

inline U64 line_bb(Square a, Square b) { return LineBB[a][b]; }
inline U64 between_bb(Square a, Square b) { return BetweenBB[a][b]; }
inline int distance(Square a, Square b) { return SquareDistance[a][b]; }

// span_bb: squares from a to b INCLUSIVE of both ends (a and b must be
// aligned — same rank/file/diagonal; Chess960 castling only ever spans a
// single back rank). between_bb(a,b) is strictly-between-plus-b, and is 0
// when a==b (BetweenBB is only populated for squares that attack each
// other), so this is also correct — and side-effect-free — when a==b.
inline U64 span_bb(Square a, Square b) { return square_bb(a) | between_bb(a, b); }

// aligned: are three squares on a line?
inline bool aligned(Square a, Square b, Square c) {
    return LineBB[a][b] & square_bb(c);
}

void init();

} // namespace BB
