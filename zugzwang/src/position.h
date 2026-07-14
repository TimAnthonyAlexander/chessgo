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
    // Correction-history sub-keys (§CorrHist): pure piece-placement XORs of
    // Zobrist::psq, maintained in lockstep with `key` in do_move but NEVER
    // folded into `key` itself — perft/TT must be byte-unaffected by these.
    U64      pawnKey;               // XOR of Zobrist::psq[pc][sq] over pawns only
    U64      nonPawnKey[COLOR_NB];  // per-color XOR over that color's non-pawn pieces (incl. king)
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
    // Chess960: origin square of the rook for a given castling right (WHITE_OO
    // etc.) — SQ_NONE if that right is not held. For a standard (non-960) game
    // these are exactly H1/A1/H8/A8. Fixed for the whole game once set() parses
    // the FEN (mirrors gomachine's Position.castleRook — losing a right doesn't
    // change where the rook WAS, and a lost right is never regained).
    Square castling_rook_square(int right) const { return castlingRookFrom[castling_right_index(right)]; }
    Square ep_square() const { return st->epSquare; }
    int rule50_count() const { return st->rule50; }
    // Display-only FEN fullmove counter (see the `fullmove` field doc below) —
    // Crazyhouse's move-cap draw safety valve reads this (mirrors gomachine's
    // drawMoveCap check on chess.Position.FullmoveNumber).
    int fullmove_number() const { return fullmove; }
    U64 key() const { return st->key; }
    U64 pawn_key() const { return st->pawnKey; }
    U64 non_pawn_key(Color c) const { return st->nonPawnKey[c]; }
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

    // Crazyhouse: place a pocketed piece `pc` on the EMPTY square `s`, passing
    // the turn — the one primitive the variant needs on top of standard chess
    // (mirrors gomachine's Position.DoDrop, internal/chess/makemove.go). Unlike
    // DoDrop's value-copy precedent, zugzwang's Position is do_move/undo_move
    // stack-mutated in place (StateInfo chain via `st`), so a drop gets the
    // same push/pop shape as do_move/undo_move — caller owns `newSt`'s storage
    // (same contract as do_move) and must undo_drop(s) in LIFO order. Pockets/
    // promoted-bitboard bookkeeping is the CALLER's job (internal/crazyhouse's
    // C++ port, src/crazyhouse.{h,cpp}) — this only touches the board, key,
    // castling/ep/rule50 state and checkers, exactly like do_move does for a
    // quiet move, so the rest of Position (SEE, is_draw, san, fen, …) stays
    // valid on a position that includes a dropped piece.
    void do_drop(Piece pc, Square s, StateInfo& newSt);
    void undo_drop(Square s);

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

    // Chess960 castling: FEN parse + per-square castling-rights-clear mask.
    // castling_right_index maps a single CastlingRight bit (1,2,4,8) to a
    // 0..3 slot — mirrors gomachine's ciWK/ciWQ/ciBK/ciBQ.
    static int castling_right_index(int right);
    void parse_castling(const std::string& field);
    void refresh_castling_mask();
    // outer_rook: the outermost rook of color c on its back rank to the given
    // side of the king (X-FEN interpretation of a plain K/Q/k/q right) —
    // kingside scans from the h-file inward, queenside from the a-file
    // inward. SQ_NONE if no such rook. Mirrors gomachine's Position.outerRook.
    Square outer_rook(Color c, bool kingside) const;
    // castling_field: X-FEN castling-rights serialization for fen() — a right
    // whose rook is the outermost on its side prints as K/Q/k/q (so standard
    // positions round-trip to "KQkq"); an inner rook prints as a Shredder
    // file letter. Mirrors gomachine's Position.castlingField.
    std::string castling_field() const;

    Piece board[SQUARE_NB];
    U64   byTypeBB[PIECE_TYPE_NB];
    U64   byColorBB[COLOR_NB];
    Color sideToMove;
    StateInfo* st;
    StateInfo rootState;
    // Chess960: rook origin square per castling right, indexed via
    // castling_right_index (0=WHITE_OO,1=WHITE_OOO,2=BLACK_OO,3=BLACK_OOO).
    // Set once in set(); never mutated afterward (a right is only ever lost,
    // never regained, so the origin square it names is meaningless once lost
    // — see refresh_castling_mask).
    Square castlingRookFrom[4];
    // Per-square bits to CLEAR from castlingRights when that square is
    // touched (moved from/to). Replaces the old static/global
    // CastlingRightsMask table so it can depend on THIS game's actual
    // king/rook home squares (Chess960) rather than fixed E1/A1/H1/E8/A8/H8.
    // Computed once in set() by refresh_castling_mask(); mirrors gomachine's
    // Position.castleMask.
    int castlingRightsMask[SQUARE_NB];
    NNUE::AccStack* nnueAcc = nullptr;
    // Display-only FEN fullmove counter (SPSA/search/perft never read this —
    // it exists purely so fen() round-trips correctly for the HTTP serve
    // layer, which the search's own move-application never needed before).
    // Incremented in do_move / decremented in undo_move whenever a BLACK move
    // completes/is-undone, mirroring standard FEN semantics.
    int fullmove = 1;
};

// Utility
Position& root_position();
