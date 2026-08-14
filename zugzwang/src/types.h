#pragma once
#include <cstdint>
#include <string>

using U64 = uint64_t;

// ---- Colors ----
enum Color : int { WHITE = 0, BLACK = 1, COLOR_NB = 2 };
constexpr Color operator~(Color c) { return Color(c ^ 1); }

// ---- Piece types ----
enum PieceType : int {
    NO_PIECE_TYPE = 0,
    PAWN = 1, KNIGHT = 2, BISHOP = 3, ROOK = 4, QUEEN = 5, KING = 6,
    PIECE_TYPE_NB = 7
};

// ---- Pieces (color + type) ----
enum Piece : int {
    NO_PIECE = 0,
    W_PAWN = 1, W_KNIGHT, W_BISHOP, W_ROOK, W_QUEEN, W_KING,
    B_PAWN = 9, B_KNIGHT, B_BISHOP, B_ROOK, B_QUEEN, B_KING,
    PIECE_NB = 16
};

constexpr Piece make_piece(Color c, PieceType pt) { return Piece((c << 3) + pt); }
constexpr PieceType type_of(Piece p) { return PieceType(p & 7); }
constexpr Color color_of(Piece p) { return Color(p >> 3); }

// ---- Squares (a1 = 0, h8 = 63) ----
enum Square : int {
    A1, B1, C1, D1, E1, F1, G1, H1,
    A2, B2, C2, D2, E2, F2, G2, H2,
    A3, B3, C3, D3, E3, F3, G3, H3,
    A4, B4, C4, D4, E4, F4, G4, H4,
    A5, B5, C5, D5, E5, F5, G5, H5,
    A6, B6, C6, D6, E6, F6, G6, H6,
    A7, B7, C7, D7, E7, F7, G7, H7,
    A8, B8, C8, D8, E8, F8, G8, H8,
    SQ_NONE = 64, SQUARE_NB = 64
};

constexpr int file_of(Square s) { return s & 7; }
constexpr int rank_of(Square s) { return s >> 3; }
constexpr Square make_square(int f, int r) { return Square((r << 3) + f); }
constexpr Square flip_rank(Square s) { return Square(s ^ 56); } // vertical flip

inline bool is_ok(Square s) { return s >= A1 && s <= H8; }

// ---- Directions ----
enum Direction : int {
    NORTH = 8, EAST = 1, SOUTH = -8, WEST = -1,
    NORTH_EAST = 9, NORTH_WEST = 7, SOUTH_EAST = -7, SOUTH_WEST = -9
};

// ---- Castling rights (bitmask) ----
enum CastlingRight : int {
    NO_CASTLING = 0,
    WHITE_OO  = 1,
    WHITE_OOO = 2,
    BLACK_OO  = 4,
    BLACK_OOO = 8,
    ANY_CASTLING = 15
};

// ---- Values / scores ----
constexpr int VALUE_ZERO = 0;
constexpr int VALUE_DRAW = 0;
constexpr int VALUE_MATE = 32000;
constexpr int VALUE_INFINITE = 32001;
constexpr int VALUE_NONE = 32002;
constexpr int VALUE_MATE_IN_MAX_PLY = VALUE_MATE - 256;
constexpr int MAX_PLY = 246;
// Syzygy TB win/loss: decisive, above any eval, but BELOW mate-in-max-ply so TB scores
// never masquerade as forced mates. `VALUE_TB_WIN - ply` stays < VALUE_MATE_IN_MAX_PLY.
constexpr int VALUE_TB_WIN = VALUE_MATE_IN_MAX_PLY - MAX_PLY - 1;
// Bottom of the TB band. The in-search WDL probe returns VALUE_TB_WIN - ply and the
// root DTZ ranking returns a flat VALUE_TB_WIN, so every TB verdict that can reach a
// caller lies in [VALUE_TB_WIN_IN_MAX_PLY, VALUE_TB_WIN]. Mirrors SF's
// VALUE_TB_WIN_IN_MAX_PLY (~/sf18-arm/src/types.h:164).
constexpr int VALUE_TB_WIN_IN_MAX_PLY = VALUE_TB_WIN - MAX_PLY;

constexpr int mate_in(int ply) { return VALUE_MATE - ply; }
constexpr int mated_in(int ply) { return -VALUE_MATE + ply; }

inline bool is_mate_score(int v) {
    return v >= VALUE_MATE_IN_MAX_PLY || v <= -VALUE_MATE_IN_MAX_PLY;
}

// A decisive TABLEBASE verdict — not a forced mate, and not an evaluation. Splits the
// band between VALUE_TB_WIN_IN_MAX_PLY and VALUE_MATE_IN_MAX_PLY out of "cp", the same
// way SF's is_win/is_loss/is_decisive do (~/sf18-arm/src/types.h:170-180) so that the
// UCI/JSON layers can report it as a verdict instead of a 315-pawn evaluation.
inline bool is_tb_score(int v) {
    return !is_mate_score(v) && (v >= VALUE_TB_WIN_IN_MAX_PLY || v <= -VALUE_TB_WIN_IN_MAX_PLY);
}

const std::string SQ_NAMES[65] = {
    "a1","b1","c1","d1","e1","f1","g1","h1",
    "a2","b2","c2","d2","e2","f2","g2","h2",
    "a3","b3","c3","d3","e3","f3","g3","h3",
    "a4","b4","c4","d4","e4","f4","g4","h4",
    "a5","b5","c5","d5","e5","f5","g5","h5",
    "a6","b6","c6","d6","e6","f6","g6","h6",
    "a7","b7","c7","d7","e7","f7","g7","h7",
    "a8","b8","c8","d8","e8","f8","g8","h8","-"
};
