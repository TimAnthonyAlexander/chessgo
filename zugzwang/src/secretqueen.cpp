#include "secretqueen.h"
#include "rules.h"   // Rules::parse_square only — no Position/legality dependency (see secretqueen.h's file doc)
#include "zobrist.h" // shared Zobrist::psq/side tables for SecretQueenState::key()

#include <algorithm>
#include <sstream>

using namespace BB;

namespace {

// ==================== small helpers ====================

constexpr const char* SQ_PCS = " PNBRQK  pnbrqk"; // indexed by Piece (types.h) — mirrors duck's DUCK_PCS

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

// Rebuilt from the mailbox per call — these positions are tiny and this is
// never a standard-search hot path (mirrors duck_occupied's own reasoning).
U64 sq_occupied(const SecretQueenState& s) {
    U64 bb = 0;
    for (Square sq = A1; sq <= H8; sq = Square(sq + 1))
        if (s.board[sq] != NO_PIECE) bb |= square_bb(sq);
    return bb;
}

U64 sq_color_bb(const SecretQueenState& s, Color c) {
    U64 bb = 0;
    for (Square sq = A1; sq <= H8; sq = Square(sq + 1))
        if (s.board[sq] != NO_PIECE && color_of(s.board[sq]) == c) bb |= square_bb(sq);
    return bb;
}

// Runtime-dispatched pseudo-attacks for a piece of type/color from `from` given
// occupancy `occ` — mirrors duck_pseudo_attacks.
U64 sq_pseudo_attacks(PieceType pt, Color c, Square from, U64 occ) {
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

Square sq_king_square(const SecretQueenState& s, Color c) {
    Piece want = make_piece(c, KING);
    for (Square sq = A1; sq <= H8; sq = Square(sq + 1))
        if (s.board[sq] == want) return sq;
    return SQ_NONE;
}

// castleMask[sq]: castling bits to KEEP when `sq` is touched (moved from/to).
// Mirrors duck.cpp's castle_mask_table.
const uint8_t* castle_mask_table() {
    static uint8_t table[64];
    static bool init = false;
    if (!init) {
        for (auto& v : table) v = 0xF;
        table[E1] &= ~(SQ_CASTLE_WK | SQ_CASTLE_WQ);
        table[A1] &= ~SQ_CASTLE_WQ;
        table[H1] &= ~SQ_CASTLE_WK;
        table[E8] &= ~(SQ_CASTLE_BK | SQ_CASTLE_BQ);
        table[A8] &= ~SQ_CASTLE_BQ;
        table[H8] &= ~SQ_CASTLE_BK;
        init = true;
    }
    return table;
}

// ==================== pawn move generation ====================

void add_pawn_move(std::vector<SecretQueenMove>& moves, Square from, Square to, int promoRank) {
    if (rank_of(to) == promoRank) {
        static const PieceType promoPieces[4] = {QUEEN, ROOK, BISHOP, KNIGHT};
        for (PieceType pt : promoPieces) moves.push_back(SecretQueenMove{from, to, pt, false});
        return;
    }
    moves.push_back(SecretQueenMove{from, to, NO_PIECE_TYPE, false});
}

// Every move an ordinary pawn of color `us` on `from` could make. No en passant
// (rule 2) — pushes, the double push from the home rank, and diagonal captures
// (including capturing the enemy king, which is how you win).
void gen_pawn(std::vector<SecretQueenMove>& moves, Square from, Color us, U64 occ, U64 enemy) {
    int forward, startRank, promoRank;
    if (us == WHITE) { forward = 8; startRank = 1; promoRank = 7; }
    else { forward = -8; startRank = 6; promoRank = 0; }

    int oneIdx = int(from) + forward;
    if (oneIdx >= 0 && oneIdx < 64) {
        Square one = Square(oneIdx);
        if (!(occ & square_bb(one))) {
            add_pawn_move(moves, from, one, promoRank);
            if (rank_of(from) == startRank) {
                Square two = Square(int(from) + 2 * forward);
                if (!(occ & square_bb(two))) moves.push_back(SecretQueenMove{from, two, NO_PIECE_TYPE, false});
            }
        }
    }

    U64 caps = BB::pawn_attacks(us, from) & enemy;
    while (caps) {
        Square to = pop_lsb(caps);
        add_pawn_move(moves, from, to, promoRank);
    }
}

void emit_targets(std::vector<SecretQueenMove>& moves, Square from, U64 targets) {
    while (targets) {
        Square to = pop_lsb(targets);
        moves.push_back(SecretQueenMove{from, to, NO_PIECE_TYPE, false});
    }
}

// Castling, minus the through-check condition — this variant has no check
// (rule 1), so only the rights, the rook and the empty squares matter. Fixed
// files: the start position is always standard here (no Chess960 crossover).
void gen_castling(const SecretQueenState& s, std::vector<SecretQueenMove>& moves, Square kingFrom, U64 occ) {
    if (s.side == WHITE) {
        if (kingFrom != E1 || s.board[E1] != W_KING) return;
        if ((s.castling & SQ_CASTLE_WK) && s.board[H1] == W_ROOK &&
            !(occ & square_bb(F1)) && !(occ & square_bb(G1))) {
            moves.push_back(SecretQueenMove{E1, G1, NO_PIECE_TYPE, true});
        }
        if ((s.castling & SQ_CASTLE_WQ) && s.board[A1] == W_ROOK &&
            !(occ & square_bb(B1)) && !(occ & square_bb(C1)) && !(occ & square_bb(D1))) {
            moves.push_back(SecretQueenMove{E1, C1, NO_PIECE_TYPE, true});
        }
        return;
    }
    if (kingFrom != E8 || s.board[E8] != B_KING) return;
    if ((s.castling & SQ_CASTLE_BK) && s.board[H8] == B_ROOK &&
        !(occ & square_bb(F8)) && !(occ & square_bb(G8))) {
        moves.push_back(SecretQueenMove{E8, G8, NO_PIECE_TYPE, true});
    }
    if ((s.castling & SQ_CASTLE_BQ) && s.board[A8] == B_ROOK &&
        !(occ & square_bb(B8)) && !(occ & square_bb(C8)) && !(occ & square_bb(D8))) {
        moves.push_back(SecretQueenMove{E8, C8, NO_PIECE_TYPE, true});
    }
}

} // namespace

// ==================== Move ====================

std::string SecretQueenMove::uci() const {
    std::string s = SQ_NAMES[from] + SQ_NAMES[to];
    if (promo != NO_PIECE_TYPE) s += promo_char(promo);
    return s;
}

bool secretqueen_parse_uci(const std::string& s, SecretQueenMove& out) {
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
    out = SecretQueenMove{};
    out.from = from;
    out.to = to;
    out.promo = promo;
    return true;
}

// ==================== FEN ====================

namespace {

// The six standard fields. The en-passant field is ALWAYS "-": this variant has
// no en passant (rule 2), so there is never a target to record.
std::string sq_core_fen(const SecretQueenState& s) {
    std::ostringstream ss;
    for (int r = 7; r >= 0; --r) {
        int empty = 0;
        for (int f = 0; f < 8; ++f) {
            Piece p = s.board[make_square(f, r)];
            if (p == NO_PIECE) {
                empty++;
                continue;
            }
            if (empty) {
                ss << empty;
                empty = 0;
            }
            ss << SQ_PCS[p];
        }
        if (empty) ss << empty;
        if (r) ss << '/';
    }
    ss << ' ' << (s.side == WHITE ? 'w' : 'b') << ' ';
    if (s.castling == 0) {
        ss << '-';
    } else {
        if (s.castling & SQ_CASTLE_WK) ss << 'K';
        if (s.castling & SQ_CASTLE_WQ) ss << 'Q';
        if (s.castling & SQ_CASTLE_BK) ss << 'k';
        if (s.castling & SQ_CASTLE_BQ) ss << 'q';
    }
    ss << " - " << s.halfmove << ' ' << s.fullmove;
    return ss.str();
}

std::string sq_secret_field(Square w, Square b) {
    std::string out = "[";
    out += (w == SQ_NONE) ? "-" : SQ_NAMES[w];
    out += "|";
    out += (b == SQ_NONE) ? "-" : SQ_NAMES[b];
    out += "]";
    return out;
}

} // namespace

std::string SecretQueenState::fen() const {
    return sq_core_fen(*this) + " " + sq_secret_field(secret[WHITE], secret[BLACK]);
}

std::string SecretQueenState::boardFen() const { return sq_core_fen(*this); }

std::string SecretQueenState::fenFor(Color viewer) const {
    Square w = (viewer == WHITE) ? secret[WHITE] : SQ_NONE;
    Square b = (viewer == BLACK) ? secret[BLACK] : SQ_NONE;
    return sq_core_fen(*this) + " " + sq_secret_field(w, b);
}

uint64_t SecretQueenState::key() const {
    uint64_t k = 0;
    for (Square sq = A1; sq <= H8; sq = Square(sq + 1)) {
        Piece p = board[sq];
        if (p != NO_PIECE) k ^= Zobrist::psq[p][sq];
    }
    // A hidden queen's square already contributed its PAWN key above; xor the
    // matching QUEEN key on top so a disguised queen hashes differently from
    // both a plain pawn and a real queen. Two positions with identical boards
    // but different secret assignments are genuinely different positions.
    if (secret[WHITE] != SQ_NONE) k ^= Zobrist::psq[W_QUEEN][secret[WHITE]];
    if (secret[BLACK] != SQ_NONE) k ^= Zobrist::psq[B_QUEEN][secret[BLACK]];
    if (side == BLACK) k ^= Zobrist::side;
    return k;
}

bool secretqueen_parse(const std::string& fen, SecretQueenState& out, std::string& err) {
    std::istringstream iss(fen);
    std::string placement, sideStr, castlingStr, epStr;
    if (!(iss >> placement >> sideStr >> castlingStr >> epStr)) {
        err = "invalid fen: too few fields";
        return false;
    }
    std::string halfStr, fullStr, secretStr;
    if (!(iss >> halfStr)) halfStr = "0";
    if (!(iss >> fullStr)) fullStr = "1";
    if (!(iss >> secretStr)) secretStr = "";

    SecretQueenState st;
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
                case 'K': st.castling |= SQ_CASTLE_WK; break;
                case 'Q': st.castling |= SQ_CASTLE_WQ; break;
                case 'k': st.castling |= SQ_CASTLE_BK; break;
                case 'q': st.castling |= SQ_CASTLE_BQ; break;
                default: break; // unknown chars ignored, mirroring duck_parse
            }
        }
    }

    // The en-passant field is accepted for FEN compatibility and DISCARDED —
    // this variant has no en passant (rule 2), the same way antichess.h accepts
    // and discards the castling field it doesn't have.
    (void)epStr;

    try {
        st.halfmove = std::max(0, std::stoi(halfStr));
    } catch (...) { st.halfmove = 0; }
    try {
        st.fullmove = std::max(1, std::stoi(fullStr));
    } catch (...) { st.fullmove = 1; }

    // Trailing "[<w>|<b>]". Absent entirely = no hidden queens, which is what a
    // plain chess FEN means and what perft/tests want.
    st.secret[WHITE] = SQ_NONE;
    st.secret[BLACK] = SQ_NONE;
    if (!secretStr.empty()) {
        if (secretStr.size() < 4 || secretStr.front() != '[' || secretStr.back() != ']') {
            err = "invalid fen: malformed secret field " + secretStr;
            return false;
        }
        std::string inner = secretStr.substr(1, secretStr.size() - 2);
        size_t bar = inner.find('|');
        if (bar == std::string::npos) {
            err = "invalid fen: secret field needs \"<w>|<b>\"";
            return false;
        }
        std::string wStr = inner.substr(0, bar);
        std::string bStr = inner.substr(bar + 1);
        for (int c = WHITE; c <= BLACK; ++c) {
            const std::string& tok = (c == WHITE) ? wStr : bStr;
            if (tok == "-" || tok.empty()) continue;
            Square sq = Rules::parse_square(tok);
            if (sq == SQ_NONE) { err = "invalid fen: bad secret square " + tok; return false; }
            // The one invariant this whole module leans on: a hidden queen is a
            // PAWN on the board (see the file doc). Reject anything else rather
            // than carry a state that movegen would silently misread.
            if (st.board[sq] != make_piece(Color(c), PAWN)) {
                err = "invalid fen: secret square " + tok + " does not hold a pawn of that color";
                return false;
            }
            st.secret[Color(c)] = sq;
        }
    }

    out = st;
    return true;
}

bool secretqueen_designate(SecretQueenState& s, Color c, Square sq, std::string& err) {
    if (!is_ok(sq)) { err = "invalid square"; return false; }
    if (s.secret[c] != SQ_NONE) { err = "that side already has a secret queen"; return false; }
    if (s.board[sq] != make_piece(c, PAWN)) { err = "that square does not hold one of your pawns"; return false; }
    s.secret[c] = sq;
    return true;
}

// ==================== Move generation ====================

bool secretqueen_captures_enemy_king(const SecretQueenState& s, const SecretQueenMove& m) {
    return s.board[m.to] == make_piece(~s.side, KING);
}

bool secretqueen_is_pawn_shaped(const SecretQueenState& s, const SecretQueenMove& m) {
    Piece mover = s.board[m.from];
    if (mover == NO_PIECE || type_of(mover) != PAWN) return false;
    Color us = color_of(mover);
    std::vector<SecretQueenMove> pawnMoves;
    gen_pawn(pawnMoves, m.from, us, sq_occupied(s), sq_color_bb(s, ~us));
    for (const SecretQueenMove& p : pawnMoves)
        if (p.to == m.to && p.promo == m.promo) return true;
    return false;
}

std::vector<SecretQueenMove> secretqueen_legal_moves_struct(const SecretQueenState& s) {
    Color us = s.side;
    U64 occ = sq_occupied(s);
    U64 own = sq_color_bb(s, us);
    U64 enemy = sq_color_bb(s, ~us);
    Square secret = s.secret[us];

    std::vector<SecretQueenMove> moves;
    moves.reserve(64);
    for (Square from = A1; from <= H8; from = Square(from + 1)) {
        Piece p = s.board[from];
        if (p == NO_PIECE || color_of(p) != us) continue;
        switch (type_of(p)) {
            case PAWN: {
                size_t before = moves.size();
                gen_pawn(moves, from, us, occ, enemy);
                if (from != secret) break;
                // OUR hidden queen: it is a queen too. A queen's move set is
                // otherwise a superset of a pawn's, so every queen target that a
                // pawn move already reached would be a duplicate — skip those,
                // including a promotion-rank square the push/capture just
                // covered (landing a queen there is what the =Q promotion
                // already does).
                U64 pawnReached = 0;
                for (size_t i = before; i < moves.size(); ++i) pawnReached |= square_bb(moves[i].to);
                U64 targets = sq_pseudo_attacks(QUEEN, us, from, occ) & ~own & ~pawnReached;
                emit_targets(moves, from, targets);
                break;
            }
            case KNIGHT: {
                emit_targets(moves, from, sq_pseudo_attacks(KNIGHT, us, from, occ) & ~own);
                break;
            }
            case KING: {
                emit_targets(moves, from, sq_pseudo_attacks(KING, us, from, occ) & ~own);
                gen_castling(s, moves, from, occ);
                break;
            }
            default: { // BISHOP, ROOK, QUEEN
                emit_targets(moves, from, sq_pseudo_attacks(type_of(p), us, from, occ) & ~own);
                break;
            }
        }
    }
    return moves;
}

std::vector<std::string> secretqueen_legal_moves(const SecretQueenState& s) {
    std::vector<SecretQueenMove> moves = secretqueen_legal_moves_struct(s);
    std::vector<std::string> out;
    out.reserve(moves.size());
    for (const SecretQueenMove& m : moves) out.push_back(m.uci());
    return out;
}

bool secretqueen_find_legal(const SecretQueenState& s, const SecretQueenMove& want, SecretQueenMove& out) {
    for (const SecretQueenMove& m : secretqueen_legal_moves_struct(s)) {
        if (m.from == want.from && m.to == want.to && m.promo == want.promo) {
            out = m;
            return true;
        }
    }
    return false;
}

// ==================== Apply ====================

SecretQueenState secretqueen_do_move(const SecretQueenState& s, const SecretQueenMove& m, bool& capturedKing,
                                     SecretQueenReveal& reveal) {
    SecretQueenState ns = s;
    Color us = s.side;
    Piece mover = ns.board[m.from];
    Piece captured = ns.board[m.to];
    capturedKing = captured != NO_PIECE && type_of(captured) == KING;
    reveal = SecretQueenReveal{};

    bool wasSecret = (m.from == s.secret[us]);
    // A normal pawn's every move is pawn-shaped by definition; the test only
    // does real work for a hidden queen, which is the one piece that can move
    // in a way its board representation could not.
    bool pawnShaped = (type_of(mover) == PAWN) && (!wasSecret || secretqueen_is_pawn_shaped(s, m));

    // Fifty-move clock: reset on a capture or a genuine pawn move. A hidden
    // queen's QUEEN move is reversible and must not reset it — and it reveals
    // anyway, so this only ever matters for that one ply.
    bool irreversible = (captured != NO_PIECE) || (type_of(mover) == PAWN && pawnShaped);

    ns.board[m.from] = NO_PIECE;
    if (m.promo != NO_PIECE_TYPE) ns.board[m.to] = make_piece(us, m.promo);
    else ns.board[m.to] = mover;

    if (m.castle) {
        switch (m.to) {
            case G1: ns.board[H1] = NO_PIECE; ns.board[F1] = W_ROOK; break;
            case C1: ns.board[A1] = NO_PIECE; ns.board[D1] = W_ROOK; break;
            case G8: ns.board[H8] = NO_PIECE; ns.board[F8] = B_ROOK; break;
            case C8: ns.board[A8] = NO_PIECE; ns.board[D8] = B_ROOK; break;
            default: break;
        }
    }

    // Did this capture the opponent's still-hidden queen? It comes off the board
    // unmasked — the capturer is told what they took (rule 7).
    if (captured != NO_PIECE && s.secret[~us] == m.to) {
        ns.secret[~us] = SQ_NONE;
        reveal.captured = true;
        reveal.square = m.to;
    }

    if (wasSecret) {
        if (m.promo != NO_PIECE_TYPE) {
            // It walked to the last rank as a pawn. It was already a queen, so it
            // lands as one whatever the promo suffix asked for, and it is
            // revealed (rule 8).
            ns.board[m.to] = make_piece(us, QUEEN);
            ns.secret[us] = SQ_NONE;
            reveal.promoted = true;
            reveal.square = m.to;
        } else if (!pawnShaped) {
            // A move no pawn could make — unmasked for good (rule 3).
            ns.board[m.to] = make_piece(us, QUEEN);
            ns.secret[us] = SQ_NONE;
            reveal.moved = true;
            reveal.square = m.to;
        } else {
            ns.secret[us] = m.to; // still hidden, just somewhere else
        }
    }

    const uint8_t* mask = castle_mask_table();
    ns.castling &= mask[m.from] & mask[m.to];

    ns.halfmove = irreversible ? 0 : ns.halfmove + 1;
    if (us == BLACK) ns.fullmove++;
    ns.side = ~us;
    return ns;
}

// ==================== Status ====================

std::string secretqueen_status_result(SecretQueenStatus st) {
    switch (st) {
        case SecretQueenStatus::WhiteWin: return "1-0";
        case SecretQueenStatus::BlackWin: return "0-1";
        case SecretQueenStatus::Draw: return "1/2-1/2";
        default: return "";
    }
}

std::string secretqueen_status_name(SecretQueenStatus st) {
    switch (st) {
        case SecretQueenStatus::WhiteWin: return "white_win";
        case SecretQueenStatus::BlackWin: return "black_win";
        case SecretQueenStatus::Draw: return "draw";
        default: return "ongoing";
    }
}

namespace {
constexpr int SQ_HALFMOVE_DRAW = 100; // 50-move rule, in half-moves
} // namespace

bool secretqueen_king_captured(const SecretQueenState& s) {
    return sq_king_square(s, WHITE) == SQ_NONE || sq_king_square(s, BLACK) == SQ_NONE;
}

SecretQueenStatus secretqueen_status(const SecretQueenState& s, const std::vector<uint64_t>& history) {
    // A captured king decides the game outright — the win condition (rule 1).
    if (sq_king_square(s, WHITE) == SQ_NONE) return SecretQueenStatus::BlackWin;
    if (sq_king_square(s, BLACK) == SQ_NONE) return SecretQueenStatus::WhiteWin;

    // No legal move at all is a draw. With king capture legal and no self-check
    // filter this is close to unreachable, but it is the honest reading of a
    // ruleset that has no checkmate to lose by.
    if (secretqueen_legal_moves_struct(s).empty()) return SecretQueenStatus::Draw;

    if (s.halfmove >= SQ_HALFMOVE_DRAW) return SecretQueenStatus::Draw;

    uint64_t k = s.key();
    int occurrences = 1; // s itself
    for (uint64_t h : history)
        if (h == k) occurrences++;
    if (occurrences >= 3) return SecretQueenStatus::Draw;

    return SecretQueenStatus::Ongoing;
}

// ==================== SAN ====================

namespace {
char san_piece_letter(PieceType pt) {
    static const char letters[7] = {0, 0, 'N', 'B', 'R', 'Q', 'K'};
    return letters[pt];
}
} // namespace

// Display-only, no disambiguation and no check/mate suffix — matching
// duck_san/antichess_san, and there is no check here to suffix anyway.
std::string secretqueen_san(const SecretQueenState& s, const SecretQueenMove& m) {
    if (m.castle) return (file_of(m.to) == 6 /* G */) ? "O-O" : "O-O-O";

    Piece mover = s.board[m.from];
    PieceType pt = type_of(mover);
    bool capture = s.board[m.to] != NO_PIECE;
    bool wasSecret = (m.from == s.secret[s.side]);

    // A hidden queen that just proved itself is written as the queen it is; one
    // still playing pawn moves is written as the pawn it still looks like. The
    // record then reads the way the players experienced the game.
    if (wasSecret && m.promo == NO_PIECE_TYPE && !secretqueen_is_pawn_shaped(s, m)) {
        std::string out(1, 'Q');
        if (capture) out += 'x';
        out += SQ_NAMES[m.to];
        return out;
    }

    if (pt == PAWN) {
        std::string out;
        if (capture) {
            out += char('a' + file_of(m.from));
            out += 'x';
        }
        out += SQ_NAMES[m.to];
        // A hidden queen reaching the last rank lands as a queen whatever the
        // suffix said (see secretqueen_do_move), so the record says =Q.
        if (m.promo != NO_PIECE_TYPE) out += std::string("=") + san_piece_letter(wasSecret ? QUEEN : m.promo);
        return out;
    }

    std::string out(1, san_piece_letter(pt));
    if (capture) out += 'x';
    out += SQ_NAMES[m.to];
    return out;
}

// ==================== Perft ====================

uint64_t secretqueen_perft(const SecretQueenState& s, int depth) {
    if (depth <= 0) return 1;
    std::vector<SecretQueenMove> moves = secretqueen_legal_moves_struct(s);
    if (depth == 1) return moves.size();
    uint64_t nodes = 0;
    for (const SecretQueenMove& m : moves) {
        bool capturedKing = false;
        SecretQueenReveal reveal;
        SecretQueenState ns = secretqueen_do_move(s, m, capturedKing, reveal);
        nodes += secretqueen_perft(ns, depth - 1);
    }
    return nodes;
}
