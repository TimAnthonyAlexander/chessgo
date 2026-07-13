#include "movegen.h"

using namespace BB;

namespace {

template <GenType T>
ExtMove* generate_pawn_moves(const Position& pos, ExtMove* moveList, U64 target) {
    Color us = pos.side_to_move();
    Color them = ~us;
    int up = (us == WHITE) ? 8 : -8;
    U64 rank7 = (us == WHITE) ? Rank7 : Rank2;
    U64 rank3 = (us == WHITE) ? Rank3 : Rank6;
    U64 emptySquares = ~pos.pieces();
    U64 enemies = pos.pieces(them);

    U64 pawns = pos.pieces(us, PAWN);
    U64 pawnsOn7 = pawns & rank7;
    U64 pawnsNot7 = pawns & ~rank7;

    auto shiftUp = [&](U64 b) { return (us == WHITE) ? (b << 8) : (b >> 8); };

    // Two capture directions, each: bitboard of destinations + signed delta (from = to - delta)
    // "East" = toward file H, "West" = toward file A.
    auto capEast = [&](U64 b) { return (us == WHITE) ? ((b & ~FileH) << 9) : ((b & ~FileH) >> 7); };
    auto capWest = [&](U64 b) { return (us == WHITE) ? ((b & ~FileA) << 7) : ((b & ~FileA) >> 9); };
    int deltaEast = (us == WHITE) ? 9 : -7;
    int deltaWest = (us == WHITE) ? 7 : -9;

    // Quiet pushes
    if (T != CAPTURES) {
        U64 b1 = shiftUp(pawnsNot7) & emptySquares;
        U64 b2 = shiftUp(b1 & rank3) & emptySquares;
        b1 &= target;
        b2 &= target;
        while (b1) { Square to = pop_lsb(b1); (moveList++)->move = make_move(Square(to - up), to); }
        while (b2) { Square to = pop_lsb(b2); (moveList++)->move = make_move(Square(to - up - up), to); }
    }

    // Promotions (push + captures)
    if (pawnsOn7) {
        U64 push = shiftUp(pawnsOn7) & emptySquares;
        U64 cE = capEast(pawnsOn7) & enemies;
        U64 cW = capWest(pawnsOn7) & enemies;

        if (T != CAPTURES) push &= target;
        cE &= target; cW &= target;

        auto addPromos = [&](Square from, Square to) {
            (moveList++)->move = make<PROMOTION>(from, to, QUEEN);
            (moveList++)->move = make<PROMOTION>(from, to, ROOK);
            (moveList++)->move = make<PROMOTION>(from, to, BISHOP);
            (moveList++)->move = make<PROMOTION>(from, to, KNIGHT);
        };
        if (T != CAPTURES)
            while (push) { Square to = pop_lsb(push); addPromos(Square(to - up), to); }
        while (cE) { Square to = pop_lsb(cE); addPromos(Square(to - deltaEast), to); }
        while (cW) { Square to = pop_lsb(cW); addPromos(Square(to - deltaWest), to); }
    }

    // Regular captures
    if (T != QUIETS) {
        U64 cE = capEast(pawnsNot7) & enemies & target;
        U64 cW = capWest(pawnsNot7) & enemies & target;
        while (cE) { Square to = pop_lsb(cE); (moveList++)->move = make_move(Square(to - deltaEast), to); }
        while (cW) { Square to = pop_lsb(cW); (moveList++)->move = make_move(Square(to - deltaWest), to); }

        // En passant
        if (pos.ep_square() != SQ_NONE) {
            Square ep = pos.ep_square();
            U64 epAttackers = pawnsNot7 & pawn_attacks(them, ep);
            while (epAttackers) {
                Square from = pop_lsb(epAttackers);
                (moveList++)->move = make<EN_PASSANT>(from, ep);
            }
        }
    }
    return moveList;
}

template <PieceType Pt>
ExtMove* generate_piece_moves(const Position& pos, ExtMove* moveList, U64 target) {
    Color us = pos.side_to_move();
    U64 bb = pos.pieces(us, Pt);
    U64 occ = pos.pieces();
    while (bb) {
        Square from = pop_lsb(bb);
        U64 att = BB::attacks<Pt>(from, occ) & target;
        while (att) {
            Square to = pop_lsb(att);
            (moveList++)->move = make_move(from, to);
        }
    }
    return moveList;
}

ExtMove* generate_castling(const Position& pos, ExtMove* moveList) {
    Color us = pos.side_to_move();
    if (pos.in_check()) return moveList;
    Square ksq = pos.king_square(us);
    U64 occ = pos.pieces();

    auto tryCastle = [&](int flag, Square kto, Square rfrom, U64 emptyMask) {
        if (!(pos.castling_rights() & flag)) return;
        if (occ & emptyMask) return; // squares between must be empty
        (void)rfrom;
        (moveList++)->move = make<CASTLING>(ksq, kto);
    };

    if (us == WHITE) {
        // King side: f1,g1 empty
        tryCastle(WHITE_OO, G1, H1, square_bb(F1) | square_bb(G1));
        // Queen side: b1,c1,d1 empty
        tryCastle(WHITE_OOO, C1, A1, square_bb(B1) | square_bb(C1) | square_bb(D1));
    } else {
        tryCastle(BLACK_OO, G8, H8, square_bb(F8) | square_bb(G8));
        tryCastle(BLACK_OOO, C8, A8, square_bb(B8) | square_bb(C8) | square_bb(D8));
    }
    return moveList;
}

} // namespace

template <GenType T>
ExtMove* generate(const Position& pos, ExtMove* moveList) {
    Color us = pos.side_to_move();
    U64 target;
    switch (T) {
        case CAPTURES: target = pos.pieces(~us); break;
        case QUIETS:   target = ~pos.pieces();   break;
        case ALL:      target = ~pos.pieces(us); break;
    }

    moveList = generate_pawn_moves<T>(pos, moveList, target);
    moveList = generate_piece_moves<KNIGHT>(pos, moveList, target);
    moveList = generate_piece_moves<BISHOP>(pos, moveList, target);
    moveList = generate_piece_moves<ROOK>(pos, moveList, target);
    moveList = generate_piece_moves<QUEEN>(pos, moveList, target);

    // King moves
    Square ksq = pos.king_square(us);
    U64 katt = KingAttacks[ksq] & target;
    while (katt) {
        Square to = pop_lsb(katt);
        (moveList++)->move = make_move(ksq, to);
    }

    if (T != CAPTURES)
        moveList = generate_castling(pos, moveList);

    return moveList;
}

// Explicit instantiations
template ExtMove* generate<CAPTURES>(const Position&, ExtMove*);
template ExtMove* generate<QUIETS>(const Position&, ExtMove*);
template ExtMove* generate<ALL>(const Position&, ExtMove*);
