#pragma once
#include "types.h"
#include "bitboard.h"
#include "move.h"
#include <string>
#include <vector>

namespace NNUE { class AccStack; }

struct StateInfo {
    // Copied/updated on make_move
    U64      key;
    int      castlingRights;
    Square   epSquare;
    int      rule50;
    int      pliesFromNull;
    // Recomputed each move
    Piece    capturedPiece;
    U64      checkers;                 // pieces giving check to side-to-move
    U64      blockersForKing[COLOR_NB];// pinned-ish pieces blocking check on own king
    U64      pinners[COLOR_NB];
    StateInfo* previous;
};

class Position {
public:
    void set(const std::string& fen);
    std::string fen() const;

    // Accessors
    Color side_to_move() const { return sideToMove; }
    Piece piece_on(Square s) const { return board[s]; }
    bool empty(Square s) const { return board[s] == NO_PIECE; }
    U64 pieces() const { return byTypeBB[0]; }
    U64 pieces(PieceType pt) const { return byTypeBB[pt]; }
    U64 pieces(PieceType pt1, PieceType pt2) const { return byTypeBB[pt1] | byTypeBB[pt2]; }
    U64 pieces(Color c) const { return byColorBB[c]; }
    U64 pieces(Color c, PieceType pt) const { return byColorBB[c] & byTypeBB[pt]; }
    U64 pieces(Color c, PieceType pt1, PieceType pt2) const {
        return byColorBB[c] & (byTypeBB[pt1] | byTypeBB[pt2]);
    }
    int count(Color c, PieceType pt) const { return BB::popcount(pieces(c, pt)); }
    Square king_square(Color c) const { return BB::lsb(pieces(c, KING)); }

    int castling_rights() const { return st->castlingRights; }
    Square ep_square() const { return st->epSquare; }
    int rule50_count() const { return st->rule50; }
    U64 key() const { return st->key; }
    U64 checkers() const { return st->checkers; }
    U64 blockers_for_king(Color c) const { return st->blockersForKing[c]; }
    bool in_check() const { return st->checkers != 0; }

    // Incremental NNUE accumulator: attached by the search for its duration (null
    // otherwise, so perft / UCI move-application / tests take the from-scratch eval
    // path). When set, do_move/undo_move/do_null_move/undo_null_move drive it in lockstep.
    NNUE::AccStack* nnue_acc() const { return nnueAcc; }
    void set_nnue_acc(NNUE::AccStack* a) { nnueAcc = a; }

    // Attacks
    U64 attackers_to(Square s, U64 occ) const;
    U64 attackers_to(Square s) const { return attackers_to(s, byTypeBB[0]); }
    bool is_attacked(Square s, Color by) const;

    // Move machinery
    void do_move(Move m, StateInfo& newSt);
    void undo_move(Move m);
    void do_null_move(StateInfo& newSt);
    void undo_null_move();

    bool legal(Move m) const;
    bool pseudo_legal(Move m) const;
    bool gives_check(Move m) const;
    bool is_capture(Move m) const;
    Piece moved_piece(Move m) const { return board[from_sq(m)]; }

    // Draw / repetition
    bool is_draw(int ply) const;
    bool has_repeated() const;
    bool upcoming_repetition(int ply) const;

    // SEE
    bool see_ge(Move m, int threshold) const;

    // Eval helpers
    bool non_pawn_material(Color c) const {
        return pieces(c, KNIGHT, BISHOP) | pieces(c, ROOK) | pieces(c, QUEEN);
    }

    U64 game_key_history[1024];
    int history_count = 0;

private:
    void put_piece(Piece pc, Square s);
    void remove_piece(Square s);
    void move_piece(Square from, Square to);
    void set_check_info();
    U64 compute_key() const;
    template<bool AfterMove> U64 slider_blockers(U64 sliders, Square s, U64& pinners) const;

    Piece board[SQUARE_NB];
    U64   byTypeBB[PIECE_TYPE_NB];
    U64   byColorBB[COLOR_NB];
    Color sideToMove;
    StateInfo* st;
    StateInfo rootState;
    NNUE::AccStack* nnueAcc = nullptr;
};

// Utility
Position& root_position();
