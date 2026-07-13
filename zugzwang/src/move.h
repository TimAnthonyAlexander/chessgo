#pragma once
#include "types.h"

// Move encoding: 16 bits
//   bits 0-5   : from square
//   bits 6-11  : to square
//   bits 12-13 : promotion piece type - KNIGHT (0=N,1=B,2=R,3=Q)
//   bits 14-15 : move type flag
using Move = uint16_t;

constexpr Move MOVE_NONE = 0;
constexpr Move MOVE_NULL = 65; // b1->a1, harmless sentinel

enum MoveType {
    NORMAL     = 0,
    PROMOTION  = 1 << 14,
    EN_PASSANT = 2 << 14,
    CASTLING   = 3 << 14
};

constexpr Square from_sq(Move m) { return Square(m & 0x3F); }
constexpr Square to_sq(Move m)   { return Square((m >> 6) & 0x3F); }
constexpr MoveType type_of_move(Move m) { return MoveType(m & (3 << 14)); }
constexpr PieceType promotion_type(Move m) {
    return PieceType(((m >> 12) & 3) + KNIGHT);
}

constexpr Move make_move(Square from, Square to) {
    return Move(from | (to << 6));
}
template <MoveType T>
constexpr Move make(Square from, Square to, PieceType pt = KNIGHT) {
    return Move(from | (to << 6) | (((pt - KNIGHT) & 3) << 12) | T);
}

inline std::string move_to_uci(Move m) {
    if (m == MOVE_NONE) return "(none)";
    if (m == MOVE_NULL) return "0000";
    Square from = from_sq(m), to = to_sq(m);
    std::string s = SQ_NAMES[from] + SQ_NAMES[to];
    if (type_of_move(m) == PROMOTION) {
        const char* pc = " nbrq";
        s += pc[promotion_type(m) - KNIGHT + 1];
    }
    return s;
}
