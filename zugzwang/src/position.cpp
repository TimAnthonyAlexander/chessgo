#include "position.h"
#include "zobrist.h"
#include "nnue_accumulator.h"
#include <sstream>
#include <cctype>
#include <cstring>

using namespace BB;

namespace {
    // Castling ROOK DESTINATION squares are always standard (f/d-file) even in
    // Chess960 — only the rook's ORIGIN varies by game, which is why that half
    // moved into Position::castlingRookFrom (per-position, FEN-parsed) instead
    // of staying in this static table. Indexed by castling flag (WHITE_OO etc.).
    Square RookTo[16];
    bool castlingInit = false;

    void init_castling_tables() {
        if (castlingInit) return;
        castlingInit = true;
        RookTo[WHITE_OO] = F1;
        RookTo[WHITE_OOO] = D1;
        RookTo[BLACK_OO] = F8;
        RookTo[BLACK_OOO] = D8;
    }
}

void Position::put_piece(Piece pc, Square s) {
    board[s] = pc;
    byTypeBB[0] |= square_bb(s);
    byTypeBB[type_of(pc)] |= square_bb(s);
    byColorBB[color_of(pc)] |= square_bb(s);
}

void Position::remove_piece(Square s) {
    Piece pc = board[s];
    byTypeBB[0] ^= square_bb(s);
    byTypeBB[type_of(pc)] ^= square_bb(s);
    byColorBB[color_of(pc)] ^= square_bb(s);
    board[s] = NO_PIECE;
}

void Position::move_piece(Square from, Square to) {
    Piece pc = board[from];
    U64 fromTo = square_bb(from) | square_bb(to);
    byTypeBB[0] ^= fromTo;
    byTypeBB[type_of(pc)] ^= fromTo;
    byColorBB[color_of(pc)] ^= fromTo;
    board[from] = NO_PIECE;
    board[to] = pc;
}

int Position::castling_right_index(int right) {
    switch (right) {
        case WHITE_OO:  return 0;
        case WHITE_OOO: return 1;
        case BLACK_OO:  return 2;
        default:        return 3; // BLACK_OOO
    }
}

Square Position::outer_rook(Color c, bool kingside) const {
    if (!pieces(c, KING)) return SQ_NONE;
    int rank = (c == WHITE) ? 0 : 7;
    int kingFile = file_of(king_square(c));
    Piece rookP = make_piece(c, ROOK);
    if (kingside) {
        for (int f = 7; f > kingFile; --f) {
            Square s = make_square(f, rank);
            if (board[s] == rookP) return s;
        }
    } else {
        for (int f = 0; f < kingFile; ++f) {
            Square s = make_square(f, rank);
            if (board[s] == rookP) return s;
        }
    }
    return SQ_NONE;
}

// Parses the FEN castling field into st->castlingRights + castlingRookFrom,
// then rebuilds castlingRightsMask. Accepts "-" (no rights), standard/X-FEN
// (K/Q/k/q — rook = outermost on that side of the king), and Shredder-FEN
// (A-H/a-h — the rook's file; kingside/queenside inferred from the file
// relative to the king). Must run AFTER the board is populated (king/rook
// squares must already be on the board). Mirrors gomachine's
// Position.parseCastling exactly, including NOT verifying a rook actually
// sits on a Shredder-letter square (matches the oracle's contract; malformed
// input is caught downstream by Rules::position_legal, not here).
void Position::parse_castling(const std::string& field) {
    st->castlingRights = NO_CASTLING;
    for (int i = 0; i < 4; ++i) castlingRookFrom[i] = SQ_NONE;

    if (field != "-") {
        bool haveWK = pieces(WHITE, KING) != 0, haveBK = pieces(BLACK, KING) != 0;
        int wkFile = haveWK ? file_of(king_square(WHITE)) : -1;
        int bkFile = haveBK ? file_of(king_square(BLACK)) : -1;

        for (char ch : field) {
            int right = NO_CASTLING;
            Square rookSq = SQ_NONE;
            if (ch == 'K' && haveWK)       { right = WHITE_OO;  rookSq = outer_rook(WHITE, true); }
            else if (ch == 'Q' && haveWK)  { right = WHITE_OOO; rookSq = outer_rook(WHITE, false); }
            else if (ch == 'k' && haveBK)  { right = BLACK_OO;  rookSq = outer_rook(BLACK, true); }
            else if (ch == 'q' && haveBK)  { right = BLACK_OOO; rookSq = outer_rook(BLACK, false); }
            else if (ch >= 'A' && ch <= 'H' && haveWK) {
                int f = ch - 'A';
                rookSq = make_square(f, 0);
                right = (f > wkFile) ? WHITE_OO : WHITE_OOO;
            } else if (ch >= 'a' && ch <= 'h' && haveBK) {
                int f = ch - 'a';
                rookSq = make_square(f, 7);
                right = (f > bkFile) ? BLACK_OO : BLACK_OOO;
            } else {
                continue; // unrecognized char / missing king: skip silently
            }
            if (rookSq == SQ_NONE) continue; // K/Q/k/q with no matching rook found
            st->castlingRights |= right;
            castlingRookFrom[castling_right_index(right)] = rookSq;
        }
    }
    refresh_castling_mask();
}

// refresh_castling_mask rebuilds castlingRightsMask from the current king
// squares and the stored rook origins: moving from/to a king square clears
// that color's two rights; moving from/to a castling rook's origin clears
// that one right. Mirrors gomachine's Position.refreshCastleMask.
void Position::refresh_castling_mask() {
    for (int i = 0; i < SQUARE_NB; ++i) castlingRightsMask[i] = 0;
    if (pieces(WHITE, KING) && (st->castlingRights & (WHITE_OO | WHITE_OOO)))
        castlingRightsMask[king_square(WHITE)] |= (WHITE_OO | WHITE_OOO);
    if (pieces(BLACK, KING) && (st->castlingRights & (BLACK_OO | BLACK_OOO)))
        castlingRightsMask[king_square(BLACK)] |= (BLACK_OO | BLACK_OOO);
    if (st->castlingRights & WHITE_OO)  castlingRightsMask[castlingRookFrom[0]] |= WHITE_OO;
    if (st->castlingRights & WHITE_OOO) castlingRightsMask[castlingRookFrom[1]] |= WHITE_OOO;
    if (st->castlingRights & BLACK_OO)  castlingRightsMask[castlingRookFrom[2]] |= BLACK_OO;
    if (st->castlingRights & BLACK_OOO) castlingRightsMask[castlingRookFrom[3]] |= BLACK_OOO;
}

// X-FEN castling-field serialization: a right whose rook is the outermost on
// its side prints as K/Q/k/q (so standard positions round-trip to "KQkq");
// an inner rook prints as a Shredder file letter.
std::string Position::castling_field() const {
    std::string s;
    auto emit = [&](int right, Color c, bool kingside, char std) {
        if (!(st->castlingRights & right)) return;
        Square rookSq = castlingRookFrom[castling_right_index(right)];
        if (rookSq == outer_rook(c, kingside)) { s += std; return; }
        char f = char('A' + file_of(rookSq));
        s += (c == WHITE) ? f : char(std::tolower(f));
    };
    emit(WHITE_OO, WHITE, true, 'K');
    emit(WHITE_OOO, WHITE, false, 'Q');
    emit(BLACK_OO, BLACK, true, 'k');
    emit(BLACK_OOO, BLACK, false, 'q');
    return s;
}

U64 Position::compute_key() const {
    U64 k = 0;
    for (Square s = A1; s <= H8; s = Square(s + 1))
        if (board[s] != NO_PIECE)
            k ^= Zobrist::psq[board[s]][s];
    if (sideToMove == BLACK) k ^= Zobrist::side;
    k ^= Zobrist::castling[st->castlingRights];
    if (st->epSquare != SQ_NONE)
        k ^= Zobrist::enpassant[file_of(st->epSquare)];
    return k;
}

void Position::set(const std::string& fen) {
    init_castling_tables();
    std::memset(byTypeBB, 0, sizeof(byTypeBB));
    std::memset(byColorBB, 0, sizeof(byColorBB));
    for (int i = 0; i < SQUARE_NB; ++i) board[i] = NO_PIECE;

    st = &rootState;
    std::memset(st, 0, sizeof(StateInfo));
    st->epSquare = SQ_NONE;
    st->previous = nullptr;
    history_count = 0;

    std::istringstream ss(fen);
    std::string boardStr, stm, castle, ep;
    int halfmove = 0, fullmoveField = 1;
    ss >> boardStr >> stm >> castle >> ep >> halfmove >> fullmoveField;
    fullmove = fullmoveField > 0 ? fullmoveField : 1;

    int rank = 7, file = 0;
    for (char c : boardStr) {
        if (c == '/') { rank--; file = 0; }
        else if (isdigit(c)) file += c - '0';
        else {
            Color col = isupper(c) ? WHITE : BLACK;
            char lc = tolower(c);
            PieceType pt = lc == 'p' ? PAWN : lc == 'n' ? KNIGHT :
                           lc == 'b' ? BISHOP : lc == 'r' ? ROOK :
                           lc == 'q' ? QUEEN : KING;
            put_piece(make_piece(col, pt), make_square(file, rank));
            file++;
        }
    }

    sideToMove = (stm == "w") ? WHITE : BLACK;

    parse_castling(castle);

    if (ep != "-" && ep.size() == 2) {
        int f = ep[0] - 'a', r = ep[1] - '1';
        st->epSquare = make_square(f, r);
        // Validate ep is real (a pawn can actually capture)
        Color us = sideToMove;
        if (!(pawn_attacks(~us, st->epSquare) & pieces(us, PAWN)))
            st->epSquare = SQ_NONE;
    } else st->epSquare = SQ_NONE;

    st->rule50 = halfmove;
    st->pliesFromNull = 0;
    st->key = compute_key();

    // From-scratch init of the correction-history sub-keys (§CorrHist). Only
    // done here; do_move() mirrors every psq XOR incrementally from this point on.
    st->pawnKey = 0;
    st->nonPawnKey[WHITE] = st->nonPawnKey[BLACK] = 0;
    for (Square s = A1; s <= H8; s = Square(s + 1)) {
        Piece pc = board[s];
        if (pc == NO_PIECE) continue;
        if (type_of(pc) == PAWN) st->pawnKey ^= Zobrist::psq[pc][s];
        else st->nonPawnKey[color_of(pc)] ^= Zobrist::psq[pc][s];
    }

    set_check_info();
    game_key_history[history_count++] = st->key;
}

std::string Position::fen() const {
    std::ostringstream ss;
    for (int r = 7; r >= 0; --r) {
        int empty = 0;
        for (int f = 0; f < 8; ++f) {
            Piece pc = board[make_square(f, r)];
            if (pc == NO_PIECE) { empty++; continue; }
            if (empty) { ss << empty; empty = 0; }
            const char* pcs = " PNBRQK  pnbrqk";
            ss << pcs[pc];
        }
        if (empty) ss << empty;
        if (r) ss << '/';
    }
    ss << (sideToMove == WHITE ? " w " : " b ");
    std::string c = castling_field();
    ss << (c.empty() ? "-" : c) << ' ';
    ss << (st->epSquare == SQ_NONE ? "-" : SQ_NAMES[st->epSquare]);
    ss << ' ' << st->rule50 << ' ' << fullmove;
    return ss.str();
}

U64 Position::attackers_to(Square s, U64 occ) const {
    return attackers_to(byTypeBB, byColorBB, s, occ);
}

U64 Position::attackers_to(const U64 byType[PIECE_TYPE_NB], const U64 byColor[COLOR_NB],
                           Square s, U64 occ) {
    return (pawn_attacks(BLACK, s) & (byColor[WHITE] & byType[PAWN]))
         | (pawn_attacks(WHITE, s) & (byColor[BLACK] & byType[PAWN]))
         | (KnightAttacks[s] & byType[KNIGHT])
         | (rook_attacks(s, occ) & (byType[ROOK] | byType[QUEEN]))
         | (bishop_attacks(s, occ) & (byType[BISHOP] | byType[QUEEN]))
         | (KingAttacks[s] & byType[KING]);
}

bool Position::is_attacked(Square s, Color by) const {
    U64 occ = byTypeBB[0];
    if (pawn_attacks(~by, s) & pieces(by, PAWN)) return true;
    if (KnightAttacks[s] & pieces(by, KNIGHT)) return true;
    if (KingAttacks[s] & pieces(by, KING)) return true;
    if (rook_attacks(s, occ) & pieces(by, ROOK, QUEEN)) return true;
    if (bishop_attacks(s, occ) & pieces(by, BISHOP, QUEEN)) return true;
    return false;
}

// Compute pieces blocking sliding attacks on square s; also fill pinners.
template<bool AfterMove>
U64 Position::slider_blockers(U64 sliders, Square s, U64& pinners) const {
    U64 blockers = 0;
    pinners = 0;
    U64 snipers = ((rook_attacks(s, 0) & pieces(ROOK, QUEEN))
                 | (bishop_attacks(s, 0) & pieces(BISHOP, QUEEN))) & sliders;
    U64 occupancy = byTypeBB[0] ^ snipers;
    while (snipers) {
        Square sniperSq = pop_lsb(snipers);
        U64 b = between_bb(s, sniperSq) & occupancy;
        b &= ~square_bb(sniperSq);
        if (b && !more_than_one(b)) {
            blockers |= b;
            pinners |= square_bb(sniperSq);
        }
    }
    return blockers;
}

void Position::set_check_info() {
    Square ksq = king_square(sideToMove);
    st->checkers = attackers_to(ksq) & pieces(~sideToMove);
    st->blockersForKing[WHITE] = slider_blockers<false>(pieces(BLACK), king_square(WHITE), st->pinners[BLACK]);
    st->blockersForKing[BLACK] = slider_blockers<false>(pieces(WHITE), king_square(BLACK), st->pinners[WHITE]);
}

bool Position::is_capture(Move m) const {
    return (!empty(to_sq(m)) && type_of_move(m) != CASTLING) || type_of_move(m) == EN_PASSANT;
}

void Position::do_move(Move m, StateInfo& newSt) {
    U64 k = st->key ^ Zobrist::side;

    // Copy persistent fields
    newSt.castlingRights = st->castlingRights;
    newSt.epSquare = st->epSquare;
    newSt.rule50 = st->rule50 + 1;
    newSt.pliesFromNull = st->pliesFromNull + 1;
    newSt.previous = st;
    newSt.capturedPiece = NO_PIECE;
    // Carry forward the correction-history sub-keys; do_move mirrors every
    // psq XOR below into the pawn/non-pawn half it belongs to.
    newSt.pawnKey = st->pawnKey;
    newSt.nonPawnKey[WHITE] = st->nonPawnKey[WHITE];
    newSt.nonPawnKey[BLACK] = st->nonPawnKey[BLACK];

    Color us = sideToMove, them = ~us;
    Square from = from_sq(m), to = to_sq(m);
    Piece pc = board[from];
    MoveType mt = type_of_move(m);
    Piece captured = (mt == EN_PASSANT) ? make_piece(them, PAWN) : board[to];
    if (us == BLACK) fullmove++; // FEN fullmove increments after Black's move (display-only)

    // Move-aware NNUE threat delta (THREATDELTA=1): snapshot the pre-move piece
    // placement NOW, before the board mutation below, so push_delta can diff the OLD
    // board against the child. ~136 bytes; only when a search has attached an acc.
    const bool useDelta = nnueAcc && NNUE::threat_delta_enabled();
    NNUE::BoardSnapshot snap;
    if (useDelta) {
        std::memcpy(snap.byType, byTypeBB, sizeof(byTypeBB));
        std::memcpy(snap.byColor, byColorBB, sizeof(byColorBB));
        std::memcpy(snap.board, board, sizeof(board));
    }

    // Remove ep from key (will re-add if needed)
    if (st->epSquare != SQ_NONE)
        k ^= Zobrist::enpassant[file_of(st->epSquare)];
    newSt.epSquare = SQ_NONE;

    st = &newSt; // switch to new state before mutating

    if (mt == CASTLING) {
        // King move + rook move. `to` is the king's DESTINATION (g/c-file,
        // fixed even in FRC) — see move.h's CASTLING encoding doc. Side
        // (kingside/queenside) comes from castle_is_kingside(m), NOT a
        // to>from square compare: in Chess960 the king can already be on its
        // destination file (to==from), which would break that comparison.
        bool kingside = castle_is_kingside(m);
        int flag = (us == WHITE) ? (kingside ? WHITE_OO : WHITE_OOO)
                                 : (kingside ? BLACK_OO : BLACK_OOO);
        Square rfrom = castling_rook_square(flag), rto = RookTo[flag];
        k ^= Zobrist::psq[pc][from] ^ Zobrist::psq[pc][to];
        newSt.nonPawnKey[us] ^= Zobrist::psq[pc][from] ^ Zobrist::psq[pc][to]; // king (always non-pawn)
        Piece rook = make_piece(us, ROOK);
        k ^= Zobrist::psq[rook][rfrom] ^ Zobrist::psq[rook][rto];
        newSt.nonPawnKey[us] ^= Zobrist::psq[rook][rfrom] ^ Zobrist::psq[rook][rto];
        // Remove both movers FIRST, then place both — the only order that's
        // safe under every FRC origin/destination overlap (king doesn't
        // move, rook lands on the king's home square, rook already on its
        // destination, king lands on the rook's home square, …). A naive
        // move_piece(from,to) + move_piece(rfrom,rto) corrupts the
        // bitboards whenever any of those four squares coincide (including
        // the from==to no-op case, which XORs a piece's own bit to 0).
        remove_piece(from);
        remove_piece(rfrom);
        put_piece(pc, to);
        put_piece(rook, rto);
        captured = NO_PIECE;
    } else {
        if (captured != NO_PIECE) {
            Square capsq = to;
            if (mt == EN_PASSANT)
                capsq = Square(to - (us == WHITE ? NORTH : SOUTH));
            remove_piece(capsq);
            k ^= Zobrist::psq[captured][capsq];
            if (type_of(captured) == PAWN) newSt.pawnKey ^= Zobrist::psq[captured][capsq];
            else newSt.nonPawnKey[them] ^= Zobrist::psq[captured][capsq];
            newSt.rule50 = 0;
        }
        k ^= Zobrist::psq[pc][from] ^ Zobrist::psq[pc][to];
        if (type_of(pc) == PAWN) newSt.pawnKey ^= Zobrist::psq[pc][from] ^ Zobrist::psq[pc][to];
        else newSt.nonPawnKey[us] ^= Zobrist::psq[pc][from] ^ Zobrist::psq[pc][to];
        move_piece(from, to);
    }

    newSt.capturedPiece = captured;

    // Promotion: the generic branch above already moved the PAWN (pc) from→to
    // on the pawn key; here we swap "pawn at to" for "promoPiece at to",
    // moving that half of the key from pawnKey into nonPawnKey[us].
    if (mt == PROMOTION) {
        PieceType promo = promotion_type(m);
        Piece promoPiece = make_piece(us, promo);
        remove_piece(to);
        put_piece(promoPiece, to);
        k ^= Zobrist::psq[pc][to] ^ Zobrist::psq[promoPiece][to];
        newSt.pawnKey ^= Zobrist::psq[pc][to];
        newSt.nonPawnKey[us] ^= Zobrist::psq[promoPiece][to];
    }

    // Pawn special: reset rule50, set ep
    if (type_of(pc) == PAWN) {
        newSt.rule50 = 0;
        if ((int(to) ^ int(from)) == 16) { // double push
            Square epsq = Square((from + to) / 2);
            // Only set ep if an enemy pawn can capture
            if (pawn_attacks(us, epsq) & pieces(them, PAWN)) {
                newSt.epSquare = epsq;
                k ^= Zobrist::enpassant[file_of(epsq)];
            }
        }
    }

    // Castling rights update
    if (st->castlingRights &&
        (castlingRightsMask[from] || castlingRightsMask[to])) {
        int removed = castlingRightsMask[from] | castlingRightsMask[to];
        int before = st->castlingRights;
        newSt.castlingRights &= ~removed;
        if (before != newSt.castlingRights) {
            k ^= Zobrist::castling[before];
            k ^= Zobrist::castling[newSt.castlingRights];
        }
    }

    sideToMove = them;
    newSt.key = k;
    set_check_info();

    game_key_history[history_count++] = k;

    // Child board fully formed — fold the move into the incremental accumulator.
    if (nnueAcc) {
        if (useDelta) nnueAcc->push_delta(snap, *this);
        else          nnueAcc->push(*this);
    }
}

void Position::undo_move(Move m) {
    if (nnueAcc) nnueAcc->pop();
    sideToMove = ~sideToMove;
    Color us = sideToMove;
    Square from = from_sq(m), to = to_sq(m);
    MoveType mt = type_of_move(m);
    if (us == BLACK) fullmove--; // symmetric with do_move's increment

    history_count--;

    if (mt == PROMOTION) {
        remove_piece(to);
        put_piece(make_piece(us, PAWN), to);
    }

    if (mt == CASTLING) {
        bool kingside = castle_is_kingside(m);
        int flag = (us == WHITE) ? (kingside ? WHITE_OO : WHITE_OOO)
                                 : (kingside ? BLACK_OO : BLACK_OOO);
        Square rfrom = castling_rook_square(flag), rto = RookTo[flag];
        // Same remove-both-then-add-both pattern as do_move, run in reverse:
        // pull both pieces off their destinations before restoring either to
        // its origin (safe under every FRC origin/destination overlap).
        Piece king = board[to];
        Piece rook = board[rto];
        remove_piece(to);
        remove_piece(rto);
        put_piece(king, from);
        put_piece(rook, rfrom);
    } else {
        move_piece(to, from);
        if (st->capturedPiece != NO_PIECE) {
            Square capsq = to;
            if (mt == EN_PASSANT)
                capsq = Square(to - (us == WHITE ? NORTH : SOUTH));
            put_piece(st->capturedPiece, capsq);
        }
    }

    st = st->previous;
}

void Position::do_drop(Piece pc, Square s, StateInfo& newSt) {
    U64 k = st->key ^ Zobrist::side;

    newSt.castlingRights = st->castlingRights; // a drop never touches a king/rook square
    newSt.epSquare = SQ_NONE;                  // a drop is never a double pawn push
    newSt.rule50 = st->rule50 + 1;
    newSt.pliesFromNull = st->pliesFromNull + 1;
    newSt.previous = st;
    newSt.capturedPiece = NO_PIECE; // a drop never captures (target is always empty)
    newSt.pawnKey = st->pawnKey;
    newSt.nonPawnKey[WHITE] = st->nonPawnKey[WHITE];
    newSt.nonPawnKey[BLACK] = st->nonPawnKey[BLACK];

    Color us = sideToMove;
    if (st->epSquare != SQ_NONE)
        k ^= Zobrist::enpassant[file_of(st->epSquare)];
    if (us == BLACK) fullmove++; // mirrors do_move's display-only fullmove bump

    st = &newSt; // switch to new state before mutating

    put_piece(pc, s);
    k ^= Zobrist::psq[pc][s];
    if (type_of(pc) == PAWN) newSt.pawnKey ^= Zobrist::psq[pc][s];
    else newSt.nonPawnKey[us] ^= Zobrist::psq[pc][s];

    sideToMove = ~us;
    newSt.key = k;
    set_check_info();

    game_key_history[history_count++] = k;

    // No NNUE accumulator hook: Crazyhouse never attaches nnue_acc (its own
    // pocket-aware hand eval, not the shared board-only net — see
    // src/crazyhouse.cpp) — but guard anyway for safety/symmetry with do_move.
    if (nnueAcc) nnueAcc->push(*this);
}

void Position::undo_drop(Square s) {
    if (nnueAcc) nnueAcc->pop();
    sideToMove = ~sideToMove;
    Color us = sideToMove;
    if (us == BLACK) fullmove--; // symmetric with do_drop's increment

    history_count--;
    remove_piece(s);
    st = st->previous;
}

void Position::do_null_move(StateInfo& newSt) {
    std::memcpy(&newSt, st, sizeof(StateInfo));
    newSt.previous = st;
    U64 k = st->key ^ Zobrist::side;
    if (st->epSquare != SQ_NONE) {
        k ^= Zobrist::enpassant[file_of(st->epSquare)];
        newSt.epSquare = SQ_NONE;
    }
    newSt.key = k;
    newSt.rule50 = st->rule50 + 1;
    newSt.pliesFromNull = 0;
    st = &newSt;
    sideToMove = ~sideToMove;
    set_check_info();
    game_key_history[history_count++] = k;

    // Null move: no piece placement change, so the (color-absolute) halves are unchanged.
    if (nnueAcc) nnueAcc->pushNull();
}

void Position::undo_null_move() {
    if (nnueAcc) nnueAcc->pop();
    history_count--;
    st = st->previous;
    sideToMove = ~sideToMove;
}

bool Position::pseudo_legal(Move m) const {
    Color us = sideToMove;
    Square from = from_sq(m), to = to_sq(m);
    Piece pc = board[from];
    if (pc == NO_PIECE || color_of(pc) != us) return false;
    MoveType mt = type_of_move(m);
    // CASTLING's `to` is the castling ROOK's origin square in some encodings
    // and, here, the king's OWN destination square — which in Chess960 can be
    // occupied by our own king (already there) or, transiently, be read as
    // "our own piece" before the special-move bypass. Check the move-type
    // bypass BEFORE the own-piece-at-`to` filter so it can never reject a
    // castle for that reason.
    if (mt == CASTLING || mt == EN_PASSANT || mt == PROMOTION)
        return true; // trust generator for special moves; verified by legal()
    if (pieces(us) & square_bb(to)) return false;
    if (type_of(pc) == PAWN) {
        // handled via generator normally; be conservative
        U64 att = pawn_attacks(us, from);
        if ((att & square_bb(to)) && (pieces(~us) & square_bb(to))) return true;
        Direction up = us == WHITE ? NORTH : SOUTH;
        if (to == from + up && empty(to)) return true;
        if (to == from + up + up && empty(to) && empty(Square(from + up))
            && rank_of(from) == (us == WHITE ? 1 : 6)) return true;
        return false;
    }
    return BB::attacks<QUEEN>(from, byTypeBB[0]) & square_bb(to) &&
           ( (type_of(pc)==KNIGHT && (KnightAttacks[from]&square_bb(to)))
           ||(type_of(pc)==KING   && (KingAttacks[from]&square_bb(to)))
           ||(type_of(pc)==BISHOP && (bishop_attacks(from,byTypeBB[0])&square_bb(to)))
           ||(type_of(pc)==ROOK   && (rook_attacks(from,byTypeBB[0])&square_bb(to)))
           ||(type_of(pc)==QUEEN  && (queen_attacks(from,byTypeBB[0])&square_bb(to))) );
}

bool Position::legal(Move m) const {
    Color us = sideToMove;
    Square from = from_sq(m), to = to_sq(m);
    MoveType mt = type_of_move(m);
    Square ksq = king_square(us);

    if (mt == EN_PASSANT) {
        // Remove both pawns, check king safety
        Square capsq = Square(to - (us == WHITE ? NORTH : SOUTH));
        U64 occ = (byTypeBB[0] ^ square_bb(from) ^ square_bb(capsq)) | square_bb(to);
        return !(rook_attacks(ksq, occ) & pieces(~us, ROOK, QUEEN))
            && !(bishop_attacks(ksq, occ) & pieces(~us, BISHOP, QUEEN));
    }

    if (mt == CASTLING) {
        // Verify king path is not attacked (squares between king from/to)
        Direction step = to > from ? WEST : EAST; // iterate back toward king
        for (Square s = to; s != from; s = Square(s + step))
            if (is_attacked(s, ~us)) return false;
        return true;
    }

    if (type_of(board[from]) == KING) {
        // King must not move into check (occupancy without the king)
        U64 occ = byTypeBB[0] ^ square_bb(from);
        if (pawn_attacks(us, to) & pieces(~us, PAWN)) return false;
        if (KnightAttacks[to] & pieces(~us, KNIGHT)) return false;
        if (KingAttacks[to] & pieces(~us, KING)) return false;
        if (rook_attacks(to, occ) & pieces(~us, ROOK, QUEEN)) return false;
        if (bishop_attacks(to, occ) & pieces(~us, BISHOP, QUEEN)) return false;
        return true;
    }

    // Non-king moves while in check must resolve the check.
    if (st->checkers) {
        if (more_than_one(st->checkers)) return false; // double check → only king moves
        Square checker = lsb(st->checkers);
        // Legal target squares: capture the checker or interpose on the ray.
        // (between_bb is empty for a knight/pawn checker, so OR in the checker square.)
        if (!((between_bb(ksq, checker) | square_bb(checker)) & square_bb(to)))
            return false;
    }

    // Non-king: must not be a pinned piece moving off its pin ray
    if (blockers_for_king(us) & square_bb(from))
        return aligned(from, to, ksq);
    return true;
}

bool Position::gives_check(Move m) const {
    Color us = sideToMove, them = ~us;
    Square from = from_sq(m), to = to_sq(m);
    Square oppKing = king_square(them);
    MoveType mt = type_of_move(m);
    Piece pc = board[from];
    PieceType pt = type_of(pc);

    // Direct check by the (possibly promoted) piece from `to`
    U64 occ = byTypeBB[0];
    // simulate the primary piece movement for occupancy
    U64 newOcc = (occ ^ square_bb(from)) | square_bb(to);

    PieceType effPt = (mt == PROMOTION) ? promotion_type(m) : pt;
    U64 direct = 0;
    switch (effPt) {
        case PAWN:   direct = pawn_attacks(us, to); break;
        case KNIGHT: direct = KnightAttacks[to]; break;
        case BISHOP: direct = bishop_attacks(to, newOcc); break;
        case ROOK:   direct = rook_attacks(to, newOcc); break;
        case QUEEN:  direct = queen_attacks(to, newOcc); break;
        case KING:   direct = 0; break;
        default: break;
    }
    if (direct & square_bb(oppKing)) return true;

    // Discovered check: was `from` a blocker for opp king, and moved off the line?
    if ((blockers_for_king(them) & square_bb(from)) && !aligned(from, to, oppKing))
        return true;

    // Special moves can create odd discovered/ep checks — handle via full recompute
    if (mt == EN_PASSANT || mt == CASTLING) {
        // Fall back: harder cases, recompute attackers after simulated move.
        U64 o = byTypeBB[0];
        if (mt == EN_PASSANT) {
            Square capsq = Square(to - (us == WHITE ? NORTH : SOUTH));
            o = (o ^ square_bb(from) ^ square_bb(capsq)) | square_bb(to);
        } else {
            bool kingside = castle_is_kingside(m);
            int flag = (us == WHITE) ? (kingside ? WHITE_OO : WHITE_OOO)
                                     : (kingside ? BLACK_OO : BLACK_OOO);
            Square rto = RookTo[flag];
            // rook gives the check in castling
            if (rook_attacks(rto, (o ^ square_bb(from)) | square_bb(to)) & square_bb(oppKing))
                return true;
        }
        if ((rook_attacks(oppKing, o) & pieces(us, ROOK, QUEEN)) ||
            (bishop_attacks(oppKing, o) & pieces(us, BISHOP, QUEEN)))
            return true;
    }
    return false;
}

bool Position::is_draw(int ply) const {
    if (st->rule50 > 99) {
        if (!in_check()) return true;
        // If in check, must verify it's not checkmate — handled by search returning no moves.
        return true;
    }
    // Repetition: search back through history
    int end = std::min(st->rule50, st->pliesFromNull);
    if (end < 4) return false;
    U64 k = st->key;
    int cnt = 0;
    for (int i = history_count - 3; i >= history_count - 1 - end && i >= 0; i -= 2) {
        if (game_key_history[i] == k) {
            cnt++;
            // twofold within search tree counts as draw; also handle threefold
            if (i >= history_count - ply || cnt >= 2)
                return true;
        }
    }
    return false;
}

bool Position::has_repeated() const {
    int end = std::min(st->rule50, st->pliesFromNull);
    U64 k = st->key;
    for (int i = history_count - 3; i >= history_count - 1 - end && i >= 0; i -= 2)
        if (game_key_history[i] == k) return true;
    return false;
}

// Static Exchange Evaluation: is the sequence value >= threshold?
static const int SEEValues[PIECE_TYPE_NB] = {0, 100, 320, 330, 500, 900, 20000};

bool Position::see_ge(Move m, int threshold) const {
    if (type_of_move(m) != NORMAL) return VALUE_ZERO >= threshold; // approx for special

    Square from = from_sq(m), to = to_sq(m);
    int swap = SEEValues[type_of(board[to])] - threshold;
    if (swap < 0) return false;

    swap = SEEValues[type_of(board[from])] - swap;
    if (swap <= 0) return true;

    U64 occ = byTypeBB[0] ^ square_bb(from) ^ square_bb(to);
    Color stm = sideToMove;
    U64 attackers = attackers_to(to, occ);
    U64 bb;
    int res = 1;

    while (true) {
        stm = ~stm;
        attackers &= occ;
        U64 stmAttackers = attackers & pieces(stm);
        if (!stmAttackers) break;

        res ^= 1;

        if ((bb = stmAttackers & pieces(PAWN))) {
            if ((swap = SEEValues[PAWN] - swap) < res) break;
            occ ^= (bb & -bb);
            attackers |= bishop_attacks(to, occ) & pieces(BISHOP, QUEEN);
        } else if ((bb = stmAttackers & pieces(KNIGHT))) {
            if ((swap = SEEValues[KNIGHT] - swap) < res) break;
            occ ^= (bb & -bb);
        } else if ((bb = stmAttackers & pieces(BISHOP))) {
            if ((swap = SEEValues[BISHOP] - swap) < res) break;
            occ ^= (bb & -bb);
            attackers |= bishop_attacks(to, occ) & pieces(BISHOP, QUEEN);
        } else if ((bb = stmAttackers & pieces(ROOK))) {
            if ((swap = SEEValues[ROOK] - swap) < res) break;
            occ ^= (bb & -bb);
            attackers |= rook_attacks(to, occ) & pieces(ROOK, QUEEN);
        } else if ((bb = stmAttackers & pieces(QUEEN))) {
            if ((swap = SEEValues[QUEEN] - swap) < res) break;
            occ ^= (bb & -bb);
            attackers |= (bishop_attacks(to, occ) & pieces(BISHOP, QUEEN))
                       | (rook_attacks(to, occ) & pieces(ROOK, QUEEN));
        } else { // KING: can only capture if no defenders remain
            return (attackers & ~pieces(stm)) ? bool(res ^ 1) : bool(res);
        }
    }
    return bool(res);
}

Position& root_position() {
    static Position p;
    return p;
}
