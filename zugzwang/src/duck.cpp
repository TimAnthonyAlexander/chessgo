#include "duck.h"
#include "rules.h" // Rules::parse_square only — no Position/legality dependency (see duck.h's file doc)
#include "search.h" // Search::now_ms() only — no Search::Context/NNUE dependency (mirrors crazyhouse.cpp)
#include "weakening.h"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstring>
#include <random>
#include <sstream>

using namespace BB;

namespace {

// ==================== small helpers ====================

int abs_i(int x) { return x < 0 ? -x : x; }

constexpr const char* DUCK_PCS = " PNBRQK  pnbrqk"; // indexed by Piece (types.h) — mirrors crazyhouse's ZH_PCS

Piece piece_from_char(char c) {
    switch (c) {
        case 'P': return W_PAWN;
        case 'N': return W_KNIGHT;
        case 'B': return W_BISHOP;
        case 'R': return W_ROOK;
        case 'Q': return W_QUEEN;
        case 'K': return W_KING;
        case 'p': return B_PAWN;
        case 'n': return B_KNIGHT;
        case 'b': return B_BISHOP;
        case 'r': return B_ROOK;
        case 'q': return B_QUEEN;
        case 'k': return B_KING;
        default: return NO_PIECE;
    }
}

char promo_char(PieceType pt) {
    switch (pt) {
        case KNIGHT: return 'n';
        case BISHOP: return 'b';
        case ROOK: return 'r';
        case QUEEN: return 'q';
        default: return 0;
    }
}

PieceType promo_from_char(char c) {
    switch (c) {
        case 'n': case 'N': return KNIGHT;
        case 'b': case 'B': return BISHOP;
        case 'r': case 'R': return ROOK;
        case 'q': case 'Q': return QUEEN;
        default: return NO_PIECE_TYPE;
    }
}

// occ = every occupied square (pieces only). Rebuilt from the mailbox per
// call — Duck positions are tiny (<=64 squares) and this is never a
// standard-search hot path. Mirrors State.occupied().
U64 duck_occupied(const DuckState& s) {
    U64 bb = 0;
    for (Square sq = A1; sq <= H8; sq = Square(sq + 1))
        if (s.board[sq] != NO_PIECE) bb |= square_bb(sq);
    return bb;
}

// Mirrors State.colorBB(c).
U64 duck_color_bb(const DuckState& s, Color c) {
    U64 bb = 0;
    for (Square sq = A1; sq <= H8; sq = Square(sq + 1))
        if (s.board[sq] != NO_PIECE && color_of(s.board[sq]) == c) bb |= square_bb(sq);
    return bb;
}

U64 duck_bb(const DuckState& s) { return s.duck == SQ_NONE ? 0 : square_bb(s.duck); }

// Runtime-dispatched pseudo-attacks for a piece of type/color from `from`
// given occupancy `occ` (which should include the duck so a blocked ray is
// not an attack) — mirrors chess.PseudoAttacks(p, from, occ).
U64 duck_pseudo_attacks(PieceType pt, Color c, Square from, U64 occ) {
    switch (pt) {
        case PAWN: return BB::pawn_attacks(c, from);
        case KNIGHT: return BB::attacks<KNIGHT>(from);
        case BISHOP: return BB::attacks<BISHOP>(from, occ);
        case ROOK: return BB::attacks<ROOK>(from, occ);
        case QUEEN: return BB::attacks<QUEEN>(from, occ);
        case KING: return BB::attacks<KING>(from);
        default: return 0;
    }
}

Square duck_king_square(const DuckState& s, Color c) {
    Piece want = make_piece(c, KING);
    for (Square sq = A1; sq <= H8; sq = Square(sq + 1))
        if (s.board[sq] == want) return sq;
    return SQ_NONE;
}

// Reports whether square `sq` is attacked by any piece of color `by`, given
// occupancy `occ` (the duck blocks sliders when included in occ). Mirrors
// State.attacked.
bool duck_attacked(const DuckState& s, Square sq, Color by, U64 occ) {
    for (Square from = A1; from <= H8; from = Square(from + 1)) {
        Piece p = s.board[from];
        if (p == NO_PIECE || color_of(p) != by) continue;
        if (duck_pseudo_attacks(type_of(p), by, from, occ) & square_bb(sq)) return true;
    }
    return false;
}

bool duck_king_attacked(const DuckState& s, Color c, U64 occWithDuck) {
    Square ksq = duck_king_square(s, c);
    if (ksq == SQ_NONE) return false;
    return duck_attacked(s, ksq, ~c, occWithDuck);
}

// castleMask[sq]: castling bits to KEEP when `sq` is touched (moved from/to).
// Touching a king/rook home square clears the relevant rights. Mirrors
// gomachine's castleMask init().
const uint8_t* castle_mask_table() {
    static uint8_t table[64];
    static bool init = false;
    if (!init) {
        for (auto& v : table) v = 0xF;
        table[E1] &= ~(DUCK_CASTLE_WK | DUCK_CASTLE_WQ);
        table[A1] &= ~DUCK_CASTLE_WQ;
        table[H1] &= ~DUCK_CASTLE_WK;
        table[E8] &= ~(DUCK_CASTLE_BK | DUCK_CASTLE_BQ);
        table[A8] &= ~DUCK_CASTLE_BQ;
        table[H8] &= ~DUCK_CASTLE_BK;
        init = true;
    }
    return table;
}

} // namespace

// ==================== Move ====================

std::string DuckPieceMove::uci() const {
    std::string s = SQ_NAMES[from] + SQ_NAMES[to];
    if (promo != NO_PIECE_TYPE) s += promo_char(promo);
    return s;
}

bool duck_parse_piece_uci(const std::string& s, DuckPieceMove& out) {
    if (s.size() != 4 && s.size() != 5) return false;
    Square from = Rules::parse_square(s.substr(0, 2));
    if (from == SQ_NONE) return false;
    Square to = Rules::parse_square(s.substr(2, 2));
    if (to == SQ_NONE) return false;
    PieceType promo = NO_PIECE_TYPE;
    if (s.size() == 5) {
        promo = promo_from_char(s[4]);
        if (promo == NO_PIECE_TYPE) return false;
    }
    out = DuckPieceMove{};
    out.from = from;
    out.to = to;
    out.promo = promo;
    return true;
}

// ==================== FEN ====================

std::string DuckState::fen() const {
    std::ostringstream ss;
    for (int r = 7; r >= 0; --r) {
        int empty = 0;
        for (int f = 0; f < 8; ++f) {
            Square sq = make_square(f, r);
            Piece p = board[sq];
            if (p == NO_PIECE) {
                empty++;
                continue;
            }
            if (empty) {
                ss << empty;
                empty = 0;
            }
            ss << DUCK_PCS[p];
        }
        if (empty) ss << empty;
        if (r) ss << '/';
    }
    ss << ' ' << (side == WHITE ? 'w' : 'b') << ' ';
    if (castling == 0) {
        ss << '-';
    } else {
        if (castling & DUCK_CASTLE_WK) ss << 'K';
        if (castling & DUCK_CASTLE_WQ) ss << 'Q';
        if (castling & DUCK_CASTLE_BK) ss << 'k';
        if (castling & DUCK_CASTLE_BQ) ss << 'q';
    }
    ss << ' ' << (ep == SQ_NONE ? "-" : SQ_NAMES[ep]);
    ss << ' ' << halfmove << ' ' << fullmove;
    return ss.str();
}

bool duck_parse(const std::string& fen, const std::string& duckStr, DuckState& out, std::string& err) {
    std::istringstream iss(fen);
    std::string placement, sideStr, castlingStr, epStr;
    if (!(iss >> placement >> sideStr >> castlingStr >> epStr)) {
        err = "invalid fen: too few fields";
        return false;
    }
    std::string halfStr, fullStr;
    if (!(iss >> halfStr)) halfStr = "0";
    if (!(iss >> fullStr)) fullStr = "1";

    DuckState st;
    std::fill(std::begin(st.board), std::end(st.board), NO_PIECE);

    int file = 0, rank = 7;
    for (char c : placement) {
        if (c == '/') {
            if (file != 8) { err = "invalid fen: malformed board"; return false; }
            file = 0;
            rank--;
            continue;
        }
        if (c >= '1' && c <= '8') {
            file += (c - '0');
            continue;
        }
        if (rank < 0 || file > 7) { err = "invalid fen: malformed board"; return false; }
        Piece p = piece_from_char(c);
        if (p == NO_PIECE) { err = std::string("invalid fen: bad piece char '") + c + "'"; return false; }
        st.board[make_square(file, rank)] = p;
        file++;
    }
    if (file != 8 || rank != 0) { err = "invalid fen: malformed board"; return false; }

    if (sideStr == "w") st.side = WHITE;
    else if (sideStr == "b") st.side = BLACK;
    else { err = "invalid fen: bad side to move"; return false; }

    st.castling = 0;
    if (castlingStr != "-") {
        for (char c : castlingStr) {
            switch (c) {
                case 'K': st.castling |= DUCK_CASTLE_WK; break;
                case 'Q': st.castling |= DUCK_CASTLE_WQ; break;
                case 'k': st.castling |= DUCK_CASTLE_BK; break;
                case 'q': st.castling |= DUCK_CASTLE_BQ; break;
                default: break; // mirrors gomachine's parseCastling (ignores unknown chars)
            }
        }
    }

    st.ep = SQ_NONE;
    if (epStr != "-") {
        Square sq = Rules::parse_square(epStr);
        if (sq == SQ_NONE) { err = "invalid fen: bad en-passant square"; return false; }
        st.ep = sq;
    }

    try {
        st.halfmove = std::max(0, std::stoi(halfStr));
    } catch (...) { st.halfmove = 0; }
    try {
        st.fullmove = std::max(1, std::stoi(fullStr));
    } catch (...) { st.fullmove = 1; }

    st.duck = SQ_NONE;
    if (!duckStr.empty()) {
        Square sq = Rules::parse_square(duckStr);
        if (sq == SQ_NONE) { err = "invalid duck square: " + duckStr; return false; }
        if (st.board[sq] != NO_PIECE) { err = "duck square is occupied: " + duckStr; return false; }
        st.duck = sq;
    }

    out = st;
    return true;
}

// ==================== Move generation ====================

bool duck_captures_enemy_king(const DuckState& s, const DuckPieceMove& m) {
    return s.board[m.to] == make_piece(~s.side, KING);
}

namespace {

void emit_targets(std::vector<DuckPieceMove>& moves, Square from, U64 targets) {
    while (targets) {
        Square to = pop_lsb(targets);
        moves.push_back(DuckPieceMove{from, to, NO_PIECE_TYPE, false, false});
    }
}

void add_pawn_move(std::vector<DuckPieceMove>& moves, Square from, Square to, int promoRank, bool ep) {
    if (rank_of(to) == promoRank) {
        static const PieceType promoPieces[4] = {QUEEN, ROOK, BISHOP, KNIGHT};
        for (PieceType pt : promoPieces) moves.push_back(DuckPieceMove{from, to, pt, false, false});
        return;
    }
    moves.push_back(DuckPieceMove{from, to, NO_PIECE_TYPE, ep, false});
}

void gen_pawn(const DuckState& s, std::vector<DuckPieceMove>& moves, Square from, U64 occ, U64 enemy, U64 duckBB) {
    Color us = s.side;
    U64 occWithDuck = occ | duckBB;

    int forward;
    int startRank, promoRank;
    if (us == WHITE) { forward = 8; startRank = 1; promoRank = 7; }
    else { forward = -8; startRank = 6; promoRank = 0; }

    int oneIdx = int(from) + forward;
    if (oneIdx >= 0 && oneIdx < 64) {
        Square one = Square(oneIdx);
        if (!(occWithDuck & square_bb(one))) {
            add_pawn_move(moves, from, one, promoRank, false);
            if (rank_of(from) == startRank) {
                Square two = Square(int(from) + 2 * forward);
                if (!(occWithDuck & square_bb(two))) moves.push_back(DuckPieceMove{from, two, NO_PIECE_TYPE, false, false});
            }
        }
    }

    U64 att = duck_pseudo_attacks(PAWN, us, from, occWithDuck);
    U64 caps = att & enemy & ~duckBB;
    while (caps) {
        Square to = pop_lsb(caps);
        add_pawn_move(moves, from, to, promoRank, false);
    }

    if (s.ep != SQ_NONE && !(duckBB & square_bb(s.ep)) && (att & square_bb(s.ep))) {
        moves.push_back(DuckPieceMove{from, s.ep, NO_PIECE_TYPE, true, false});
    }
}

void gen_castling(const DuckState& s, std::vector<DuckPieceMove>& moves, Square kingFrom, U64 occWithDuck) {
    Color us = s.side;
    if (us == WHITE) {
        if (kingFrom != E1 || s.board[E1] != W_KING) return;
        if ((s.castling & DUCK_CASTLE_WK) && s.board[H1] == W_ROOK &&
            !(occWithDuck & square_bb(F1)) && !(occWithDuck & square_bb(G1))) {
            moves.push_back(DuckPieceMove{E1, G1, NO_PIECE_TYPE, false, true});
        }
        if ((s.castling & DUCK_CASTLE_WQ) && s.board[A1] == W_ROOK &&
            !(occWithDuck & square_bb(B1)) && !(occWithDuck & square_bb(C1)) && !(occWithDuck & square_bb(D1))) {
            moves.push_back(DuckPieceMove{E1, C1, NO_PIECE_TYPE, false, true});
        }
        return;
    }
    if (kingFrom != E8 || s.board[E8] != B_KING) return;
    if ((s.castling & DUCK_CASTLE_BK) && s.board[H8] == B_ROOK &&
        !(occWithDuck & square_bb(F8)) && !(occWithDuck & square_bb(G8))) {
        moves.push_back(DuckPieceMove{E8, G8, NO_PIECE_TYPE, false, true});
    }
    if ((s.castling & DUCK_CASTLE_BQ) && s.board[A8] == B_ROOK &&
        !(occWithDuck & square_bb(B8)) && !(occWithDuck & square_bb(C8)) && !(occWithDuck & square_bb(D8))) {
        moves.push_back(DuckPieceMove{E8, C8, NO_PIECE_TYPE, false, true});
    }
}

} // namespace

std::vector<DuckPieceMove> duck_legal_piece_moves(const DuckState& s) {
    Color us = s.side;
    U64 occ = duck_occupied(s);
    U64 duckBB = duck_bb(s);
    U64 occWithDuck = occ | duckBB;
    U64 own = duck_color_bb(s, us);
    U64 enemy = duck_color_bb(s, ~us);

    std::vector<DuckPieceMove> moves;
    moves.reserve(48);
    for (Square from = A1; from <= H8; from = Square(from + 1)) {
        Piece p = s.board[from];
        if (p == NO_PIECE || color_of(p) != us) continue;
        switch (type_of(p)) {
            case PAWN:
                gen_pawn(s, moves, from, occ, enemy, duckBB);
                break;
            case KNIGHT: {
                U64 targets = duck_pseudo_attacks(KNIGHT, us, from, occWithDuck) & ~own & ~duckBB;
                emit_targets(moves, from, targets);
                break;
            }
            case KING: {
                U64 targets = duck_pseudo_attacks(KING, us, from, occWithDuck) & ~own & ~duckBB;
                emit_targets(moves, from, targets);
                gen_castling(s, moves, from, occWithDuck);
                break;
            }
            default: { // BISHOP, ROOK, QUEEN — sliders blocked by pieces AND the duck.
                U64 targets = duck_pseudo_attacks(type_of(p), us, from, occWithDuck) & ~own & ~duckBB;
                emit_targets(moves, from, targets);
                break;
            }
        }
    }
    return moves;
}

// ==================== Apply ====================

DuckState duck_do_piece_move(const DuckState& s, const DuckPieceMove& m, bool& capturedKing) {
    DuckState ns = s;
    Piece mover = ns.board[m.from];
    Piece captured = ns.board[m.to];
    capturedKing = captured != NO_PIECE && type_of(captured) == KING;

    bool isCaptureOrPawn = captured != NO_PIECE || type_of(mover) == PAWN || m.ep;

    ns.board[m.from] = NO_PIECE;
    if (m.promo != NO_PIECE_TYPE) ns.board[m.to] = make_piece(color_of(mover), m.promo);
    else ns.board[m.to] = mover;

    if (m.ep) {
        Square capSq = (color_of(mover) == WHITE) ? Square(int(m.to) - 8) : Square(int(m.to) + 8);
        ns.board[capSq] = NO_PIECE;
    }
    if (m.castle) {
        switch (m.to) {
            case G1: ns.board[H1] = NO_PIECE; ns.board[F1] = W_ROOK; break;
            case C1: ns.board[A1] = NO_PIECE; ns.board[D1] = W_ROOK; break;
            case G8: ns.board[H8] = NO_PIECE; ns.board[F8] = B_ROOK; break;
            case C8: ns.board[A8] = NO_PIECE; ns.board[D8] = B_ROOK; break;
            default: break;
        }
    }

    const uint8_t* mask = castle_mask_table();
    ns.castling &= mask[m.from] & mask[m.to];

    ns.ep = SQ_NONE;
    if (type_of(mover) == PAWN) {
        int diff = int(m.to) - int(m.from);
        if (diff == 16 || diff == -16) ns.ep = Square((int(m.from) + int(m.to)) / 2);
    }

    ns.halfmove = isCaptureOrPawn ? 0 : ns.halfmove + 1;
    return ns;
}

DuckState duck_make_move(const DuckState& s, const DuckPieceMove& m, Square newDuck, bool& capturedKing) {
    DuckState ns = duck_do_piece_move(s, m, capturedKing);
    ns.duck = newDuck;
    if (s.side == BLACK) ns.fullmove++;
    ns.side = ~s.side;
    return ns;
}

bool duck_find_legal(const DuckState& s, const DuckPieceMove& want, DuckPieceMove& out) {
    for (const DuckPieceMove& m : duck_legal_piece_moves(s)) {
        if (m.from == want.from && m.to == want.to && m.promo == want.promo) {
            out = m;
            return true;
        }
    }
    return false;
}

// ==================== Status ====================

std::string duck_status_result(DuckStatus st) {
    switch (st) {
        case DuckStatus::WhiteWin: return "1-0";
        case DuckStatus::BlackWin: return "0-1";
        case DuckStatus::Draw: return "1/2-1/2";
        default: return "";
    }
}

std::string duck_status_name(DuckStatus st) {
    switch (st) {
        case DuckStatus::WhiteWin: return "white_win";
        case DuckStatus::BlackWin: return "black_win";
        case DuckStatus::Draw: return "draw";
        default: return "ongoing";
    }
}

namespace {
constexpr int DUCK_DRAW_MOVE_CAP = 300; // mirrors gomachine's drawMoveCap
DuckStatus duck_win_for(Color c) { return c == WHITE ? DuckStatus::WhiteWin : DuckStatus::BlackWin; }
} // namespace

DuckStatus duck_status_after(const DuckState& s, Color mover, bool capturedKing) {
    if (capturedKing) return duck_win_for(mover);
    if (duck_legal_piece_moves(s).empty()) return duck_win_for(mover); // side to move is stuck -> it loses
    if (s.fullmove > DUCK_DRAW_MOVE_CAP) return DuckStatus::Draw;
    return DuckStatus::Ongoing;
}

DuckStatus duck_status(const DuckState& s) {
    if (duck_king_square(s, WHITE) == SQ_NONE) return DuckStatus::BlackWin;
    if (duck_king_square(s, BLACK) == SQ_NONE) return DuckStatus::WhiteWin;
    if (duck_legal_piece_moves(s).empty()) return duck_win_for(~s.side);
    if (s.fullmove > DUCK_DRAW_MOVE_CAP) return DuckStatus::Draw;
    return DuckStatus::Ongoing;
}

bool duck_king_captured(const DuckState& s) {
    return duck_king_square(s, WHITE) == SQ_NONE || duck_king_square(s, BLACK) == SQ_NONE;
}

// ==================== Apply composite move ====================

bool duck_apply_composite(const DuckState& s, const std::string& move, DuckState& out, DuckPieceMove& outMove,
                           DuckStatus& outStatus, std::string& err) {
    size_t colon = move.find(':');
    if (colon == std::string::npos) {
        err = "move must be \"<pieceUCI>:<duckSquare>\"";
        return false;
    }
    std::string piecePart = move.substr(0, colon);
    std::string duckPart = move.substr(colon + 1);

    DuckPieceMove parsed;
    if (!duck_parse_piece_uci(piecePart, parsed)) {
        err = "invalid piece move: " + piecePart;
        return false;
    }
    DuckPieceMove pm;
    if (!duck_find_legal(s, parsed, pm)) {
        err = "illegal piece move: " + piecePart;
        return false;
    }

    Square duckSq = Rules::parse_square(duckPart);
    if (duckSq == SQ_NONE) {
        err = "invalid duck square: " + duckPart;
        return false;
    }

    bool capturedKingMid; // unused — recomputed by duck_make_move below
    DuckState mid = duck_do_piece_move(s, pm, capturedKingMid);
    if (mid.board[duckSq] != NO_PIECE) {
        err = "duck target is occupied: " + duckPart;
        return false;
    }
    if (s.duck != SQ_NONE && duckSq == s.duck) {
        err = "duck must move to a different square";
        return false;
    }

    bool capturedKing;
    DuckState ns = duck_make_move(s, pm, duckSq, capturedKing);
    outStatus = duck_status_after(ns, s.side, capturedKing);
    out = ns;
    outMove = pm;
    return true;
}

// ==================== SAN ====================

namespace {
char san_piece_letter(PieceType pt) {
    static const char letters[7] = {0, 0, 'N', 'B', 'R', 'Q', 'K'};
    return letters[pt];
}

std::string duck_piece_san(const DuckState& s, const DuckPieceMove& m) {
    if (m.castle) return (file_of(m.to) == 6 /* G */) ? "O-O" : "O-O-O";

    Piece mover = s.board[m.from];
    PieceType pt = type_of(mover);
    bool capture = s.board[m.to] != NO_PIECE || m.ep;

    if (pt == PAWN) {
        std::string out;
        if (capture) {
            out += char('a' + file_of(m.from));
            out += 'x';
        }
        out += SQ_NAMES[m.to];
        if (m.promo != NO_PIECE_TYPE) out += std::string("=") + san_piece_letter(m.promo);
        return out;
    }

    std::string out(1, san_piece_letter(pt));
    if (capture) out += 'x';
    out += SQ_NAMES[m.to];
    return out;
}
} // namespace

std::string duck_san(const DuckState& s, const DuckPieceMove& m, Square duckTo) {
    std::string piece = duck_piece_san(s, m);
    if (duckTo == SQ_NONE) return piece;
    return piece + " \U0001F986" + SQ_NAMES[duckTo];
}

// ==================== Eval ====================

namespace {

constexpr int DUCK_PIECE_VALUE[7] = {0, 100, 320, 330, 500, 900, 0}; // indexed by PieceType

int duck_capture_value(PieceType pt) { return pt == KING ? 100000 : DUCK_PIECE_VALUE[pt]; }

int duck_center_bonus(Square sq) {
    int f = file_of(sq), r = rank_of(sq);
    int df = 3 - abs_i(2 * f - 7) / 2; // 0..3, peak at files d/e
    int dr = 3 - abs_i(2 * r - 7) / 2;
    return (df + dr) * 4; // verbatim from gomachine's centerBonus init()
}

} // namespace

int duck_evaluate(const DuckState& s) {
    U64 occWithDuck = duck_occupied(s) | duck_bb(s);
    int score = 0; // White - Black

    for (Square sq = A1; sq <= H8; sq = Square(sq + 1)) {
        Piece p = s.board[sq];
        if (p == NO_PIECE) continue;
        int v = DUCK_PIECE_VALUE[type_of(p)] + duck_center_bonus(sq);
        score += (color_of(p) == WHITE) ? v : -v;
    }

    if (duck_king_attacked(s, WHITE, occWithDuck)) score -= 300;
    if (duck_king_attacked(s, BLACK, occWithDuck)) score += 300;

    return (s.side == BLACK) ? -score : score;
}

// ==================== Duck-placement heuristic ====================

namespace {

int sign_i(int x) { return x > 0 ? 1 : (x < 0 ? -1 : 0); }

// Squares STRICTLY between two aligned squares (rook/bishop/queen line).
// Empty if not aligned on a rank, file, or diagonal. Mirrors gomachine's
// between() (duck.go).
std::vector<Square> squares_between(Square a, Square b) {
    int fa = file_of(a), ra = rank_of(a);
    int fb = file_of(b), rb = rank_of(b);
    int df = sign_i(fb - fa), dr = sign_i(rb - ra);
    if (!((df == 0 || dr == 0) || (abs_i(fb - fa) == abs_i(rb - ra)))) return {};
    std::vector<Square> out;
    int f = fa + df, r = ra + dr;
    while (f != fb || r != rb) {
        if (f < 0 || f > 7 || r < 0 || r > 7) return {};
        out.push_back(make_square(f, r));
        f += df;
        r += dr;
    }
    return out;
}

// Squares in plain ascending a1..h8 order — NOT actually sorted by
// centerBonus, despite gomachine's centerOrder doc comment claiming
// "proximity to the center" and a stable-insertion-sort-by-bonus
// implementation. This mirrors gomachine's ACTUAL shipped runtime behavior,
// not its apparent intent: gomachine's package has centerBonus populated by
// an eval.go init() and centerOrder built (sorted, reading centerBonus) by a
// duck.go init() — and Go executes a package's init() functions FILE BY FILE
// in filename-sorted order, so "duck.go" runs before "eval.go". At the point
// centerOrder's stable sort runs, centerBonus is still the zero-value array,
// every comparison is a tie, and a stable sort makes zero swaps — leaving
// centerOrder exactly as built: a1,b1,...,h8. Verified empirically against a
// live gomachine server (WIRING_RECON-style cross-check): chooseDuck's
// branch-4 fallback consistently picks the lowest-index EMPTY square, e.g.
// "b1" over the empty, tied-max-bonus "d4"/"e4" in a position where both are
// candidates. Faithfully porting gomachine means porting what it actually
// DOES, not what its comments say it does — so this returns identity order,
// not a genuine center sort (which would silently diverge bot duck placement
// from gomachine's shipped behavior in every branch-4 fallback case).
const std::vector<Square>& center_order() {
    static std::vector<Square> order = [] {
        std::vector<Square> o;
        o.reserve(64);
        for (Square sq = A1; sq <= H8; sq = Square(sq + 1)) o.push_back(sq);
        return o;
    }();
    return order;
}

// Picks where the mover relocates the duck after making a piece move. A
// HEURISTIC (not searched): block the opponent's most dangerous reply, else
// sit on a neutral cramping square near the enemy king, else any central
// empty square. `mid` is the state AFTER the piece move but BEFORE the duck
// is relocated (its `duck` field still holds the CURRENT duck square, which
// the new square must differ from). Mirrors gomachine's chooseDuck exactly.
Square choose_duck(const DuckState& mid, Color mover) {
    Color opp = ~mover;
    U64 occ = duck_occupied(mid); // pieces only; the duck is being (re)placed
    Square prev = mid.duck;

    int bestVal = 0;
    Square bestFrom = SQ_NONE, bestTo = SQ_NONE;
    bool bestSlider = false;
    for (Square from = A1; from <= H8; from = Square(from + 1)) {
        Piece p = mid.board[from];
        if (p == NO_PIECE || color_of(p) != opp) continue;
        U64 att = duck_pseudo_attacks(type_of(p), opp, from, occ);
        U64 targets = att & duck_color_bb(mid, mover);
        while (targets) {
            Square to = pop_lsb(targets);
            int v = duck_capture_value(type_of(mid.board[to]));
            if (v > bestVal) {
                bestVal = v;
                bestFrom = from;
                bestTo = to;
                PieceType pt = type_of(p);
                bestSlider = (pt == BISHOP || pt == ROOK || pt == QUEEN);
            }
        }
    }

    if (bestSlider && bestTo != SQ_NONE) {
        for (Square sq : squares_between(bestFrom, bestTo)) {
            if (!(occ & square_bb(sq)) && sq != prev) return sq;
        }
    }

    Square ksq = duck_king_square(mid, opp);
    if (ksq != SQ_NONE) {
        U64 adj = duck_pseudo_attacks(KING, opp, ksq, occ);
        while (adj) {
            Square sq = pop_lsb(adj);
            if (!(occ & square_bb(sq)) && sq != prev) return sq;
        }
    }

    for (Square sq : center_order()) {
        if (!(occ & square_bb(sq)) && sq != prev) return sq;
    }
    return SQ_NONE; // unreachable on any real board (always empties available)
}

// Uniformly random legal duck square (empty, and not the duck's current
// square) in the post-piece-move state, or SQ_NONE if none exists. Mirrors
// gomachine's randomDuckSquare.
Square random_duck_square(const DuckState& mid, std::mt19937_64& rng) {
    U64 occ = duck_occupied(mid);
    Square prev = mid.duck;
    std::vector<Square> cands;
    cands.reserve(48);
    for (Square sq = A1; sq <= H8; sq = Square(sq + 1))
        if (!(occ & square_bb(sq)) && sq != prev) cands.push_back(sq);
    if (cands.empty()) return SQ_NONE;
    std::uniform_int_distribution<size_t> d(0, cands.size() - 1);
    return cands[d(rng)];
}

} // namespace

// ==================== Search ====================

namespace {

constexpr int DUCK_MATE_SCORE = 1'000'000;

int duck_mate_distance(int score) {
    constexpr int threshold = DUCK_MATE_SCORE - 10000;
    if (score >= threshold) return (DUCK_MATE_SCORE - score + 1) / 2;
    if (score <= -threshold) return -((DUCK_MATE_SCORE + score + 1) / 2);
    return 0;
}

int clamp_int(int v, int lo, int hi) { return v < lo ? lo : (v > hi ? hi : v); }

struct DuckSearchConfig {
    int depth = 3;
    int movetimeMs = 1000;
    uint64_t nodes = 0;
    double temperature = 0.0;
    double capDelta = 1.0;
    double winProbScale = 350.0; // 3.5 x pawn value (DUCK_PIECE_VALUE[PAWN] == 100)
    double duckRandom = 0.0;
};

// Depth ladder and duckRandom (sloppy duck-placement noise) unchanged from
// gomachine's applyRating (duckchess/search.go) — kept exactly as before. The
// piece-move weakening (temperature/capDelta) now uses the shared softmax
// model (Weakening::pick), same formulas as Rating::config_for_rating in
// rating.cpp.
void duck_apply_rating(DuckSearchConfig& cfg, int rating) {
    int r = clamp_int(rating, 700, 3500);
    if (r < 1600) cfg.depth = 1;
    else if (r < 2200) cfg.depth = 2;
    else if (r < 2800) cfg.depth = 3;
    else cfg.depth = 4;
    if (r < 2800) {
        double u = double(2800 - r) / double(2800 - 700);
        cfg.duckRandom = 0.92 * u * u;
    }

    constexpr double RFULL = 2850.0, RMIN = 700.0;
    int rc = clamp_int(rating, 700, 2900);
    if (rc >= RFULL) {
        cfg.temperature = 0.0;
        cfg.capDelta = 1.0;
        return;
    }
    double u2 = (RFULL - rc) / (RFULL - RMIN);
    if (u2 < 0.0) u2 = 0.0;
    if (u2 > 1.0) u2 = 1.0;
    cfg.temperature = 0.40 * std::pow(u2, 1.35);
    cfg.capDelta = 0.03 + 0.52 * std::pow(u2, 1.10);
}

DuckSearchConfig duck_resolve_config(const DuckLimits& lim) {
    DuckSearchConfig cfg;
    cfg.nodes = lim.nodes;
    if (lim.movetimeMs > 0) cfg.movetimeMs = lim.movetimeMs;
    if (lim.depth > 0) {
        cfg.depth = clamp_int(lim.depth, 1, 6);
    } else if (lim.rating > 0) {
        duck_apply_rating(cfg, lim.rating);
    } else if (lim.level >= 0) {
        duck_apply_rating(cfg, 700 + clamp_int(lim.level, 0, 10) * 280);
    }
    return cfg;
}

struct DuckSearcher {
    uint64_t nodes = 0;
    uint64_t maxNodes = 0;
    int64_t deadlineMs = 0; // 0 = no deadline
    bool stopped = false;

    bool stop() {
        if (stopped) return true;
        if (maxNodes > 0 && nodes >= maxNodes) { stopped = true; return true; }
        if (deadlineMs > 0 && (nodes & 1023) == 0 && Search::now_ms() >= deadlineMs) { stopped = true; return true; }
        return false;
    }
};

int duck_capture_or_ep_order_score(const DuckState& s, const DuckPieceMove& m) {
    Piece victim = s.board[m.to];
    if (victim == NO_PIECE) return m.ep ? DUCK_PIECE_VALUE[PAWN] : 0;
    return duck_capture_value(type_of(victim));
}

void duck_order_moves(const DuckState& s, std::vector<DuckPieceMove>& moves) {
    std::stable_sort(moves.begin(), moves.end(), [&](const DuckPieceMove& a, const DuckPieceMove& b) {
        return duck_capture_or_ep_order_score(s, a) > duck_capture_or_ep_order_score(s, b);
    });
}

// Shallow alpha-beta over PIECE moves. King captures resolve as terminal
// wins; a side with no legal move loses; duck placement at each ply is the
// choose_duck heuristic (not searched). Mirrors duckchess.negamax.
int duck_negamax(DuckSearcher& e, const DuckState& s, int depth, int alpha, int beta, int ply) {
    e.nodes++;
    if (e.stop()) return duck_evaluate(s);

    std::vector<DuckPieceMove> moves = duck_legal_piece_moves(s);
    if (moves.empty()) return -DUCK_MATE_SCORE + ply; // side to move is stuck -> it loses
    for (const DuckPieceMove& m : moves)
        if (duck_captures_enemy_king(s, m)) return DUCK_MATE_SCORE - ply; // capture the enemy king now -> win
    if (depth <= 0) return duck_evaluate(s);

    duck_order_moves(s, moves);
    int best = -DUCK_MATE_SCORE * 2;
    for (const DuckPieceMove& m : moves) {
        bool capturedKing;
        DuckState mid = duck_do_piece_move(s, m, capturedKing);
        Square duckSq = choose_duck(mid, s.side);
        DuckState child = duck_make_move(s, m, duckSq, capturedKing);
        int sc = -duck_negamax(e, child, depth - 1, -beta, -alpha, ply + 1);
        if (sc > best) best = sc;
        if (best > alpha) alpha = best;
        if (alpha >= beta) break;
    }
    return best;
}

struct DuckScoredMove {
    DuckPieceMove move;
    Square duck;
    int score;
};

uint64_t duck_seed_for(const DuckState& s) {
    std::string data = s.fen() + s.duckString();
    uint64_t h = 1469598103934665603ULL; // FNV-1a offset basis
    for (unsigned char c : data) {
        h ^= c;
        h *= 1099511628211ULL;
    }
    return h;
}

// Index of the root move to play. With no weakening (temperature and
// capDelta both at full-strength defaults) it is always 0 (the best).
// Otherwise picks via the shared softmax weakening model (Weakening::pick) —
// see weakening.h. The forced win/loss mate guard stays hand-rolled here
// (rather than relying solely on SoftmaxConfig::protectWinningMate) because
// duck mate scores use DUCK_MATE_SCORE=1e6, a different convention than the
// standard engine's is_mate_score() threshold; duck_mate_distance() is the
// reliable check for this engine's scores.
size_t duck_weaken_pick(const std::vector<DuckScoredMove>& results, const DuckSearchConfig& cfg,
                         std::mt19937_64& rng) {
    if (results.empty()) return 0;
    if (duck_mate_distance(results[0].score) > 0) return 0;
    if (cfg.temperature <= 0.0 && cfg.capDelta >= 1.0) return 0;

    std::vector<Weakening::Candidate> cands;
    cands.reserve(results.size());
    for (size_t i = 0; i < results.size(); i++)
        cands.push_back({static_cast<int>(i), results[i].score});

    Weakening::SoftmaxConfig sc;
    sc.sensitivity = cfg.temperature;
    sc.consistency = 1.8;
    sc.capDelta = cfg.capDelta;
    sc.winProbScale = cfg.winProbScale;
    sc.protectWinningMate = true;

    return Weakening::pick(cands, sc, rng);
}

} // namespace

std::string duck_result_move_string(const DuckResult& r) {
    return r.move.uci() + ":" + SQ_NAMES[r.duck]; // SQ_NAMES[SQ_NONE] == "-"
}

DuckResult duck_best_move(const DuckState& s, const DuckLimits& lim) {
    std::vector<DuckPieceMove> moves = duck_legal_piece_moves(s);
    if (moves.empty()) return DuckResult{};

    // Instant win: capture the enemy king now (first such move in generation
    // order, mirrors gomachine's BestMove exactly).
    for (const DuckPieceMove& m : moves) {
        if (duck_captures_enemy_king(s, m)) {
            bool capturedKing;
            DuckState mid = duck_do_piece_move(s, m, capturedKing);
            DuckResult r;
            r.move = m;
            r.duck = choose_duck(mid, s.side);
            r.score = DUCK_MATE_SCORE;
            r.mate = 1;
            r.hasMove = true;
            return r;
        }
    }

    DuckSearchConfig cfg = duck_resolve_config(lim);
    DuckSearcher e;
    e.maxNodes = cfg.nodes;
    if (cfg.movetimeMs > 0) e.deadlineMs = Search::now_ms() + cfg.movetimeMs;

    duck_order_moves(s, moves);

    std::vector<DuckScoredMove> results;
    results.reserve(moves.size());
    int alpha = -DUCK_MATE_SCORE * 2, beta = DUCK_MATE_SCORE * 2;
    for (const DuckPieceMove& m : moves) {
        bool capturedKing;
        DuckState mid = duck_do_piece_move(s, m, capturedKing);
        Square duckSq = choose_duck(mid, s.side);
        DuckState child = duck_make_move(s, m, duckSq, capturedKing);
        int sc = -duck_negamax(e, child, cfg.depth - 1, -beta, -alpha, 1);
        results.push_back({m, duckSq, sc});
        if (sc > alpha) alpha = sc;
    }

    std::stable_sort(results.begin(), results.end(), [](const DuckScoredMove& a, const DuckScoredMove& b) {
        if (a.score != b.score) return a.score > b.score;
        return a.move.uci() < b.move.uci();
    });

    std::mt19937_64 rng(duck_seed_for(s));
    DuckScoredMove chosen = results[duck_weaken_pick(results, cfg, rng)];

    Square duckSq = chosen.duck;
    if (cfg.duckRandom > 0 && duck_mate_distance(chosen.score) == 0) {
        std::uniform_real_distribution<double> ud(0.0, 1.0);
        if (ud(rng) < cfg.duckRandom) {
            bool capturedKing;
            DuckState mid = duck_do_piece_move(s, chosen.move, capturedKing);
            Square alt = random_duck_square(mid, rng);
            if (alt != SQ_NONE) duckSq = alt;
        }
    }

    DuckResult r;
    r.move = chosen.move;
    r.duck = duckSq;
    r.score = chosen.score;
    r.mate = duck_mate_distance(chosen.score);
    r.hasMove = true;
    return r;
}
