#include "antichess.h"
#include "rules.h"      // Rules::parse_square only — no Position/legality dependency (see antichess.h's file doc)
#include "weakening.h"
#include "zobrist.h"    // shared Zobrist::psq/enpassant/side tables for AntichessState::key()
#include "serve_json.h" // ApiError — thrown only by antichess_apply's convenience wrapper

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cmath>
#include <cstring>
#include <random>
#include <sstream>

using namespace BB;

namespace {

// ==================== small helpers ====================

constexpr const char* AC_PCS = " PNBRQK  pnbrqk"; // indexed by Piece (types.h) — mirrors duck's DUCK_PCS

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

// Promotion letters — antichess uniquely allows KING here (=>'k'), unlike
// every other move-parsing path in this codebase.
char promo_char(PieceType pt) {
    switch (pt) {
        case KNIGHT: return 'n';
        case BISHOP: return 'b';
        case ROOK: return 'r';
        case QUEEN: return 'q';
        case KING: return 'k';
        default: return 0;
    }
}

PieceType promo_from_char(char c) {
    switch (c) {
        case 'n': case 'N': return KNIGHT;
        case 'b': case 'B': return BISHOP;
        case 'r': case 'R': return ROOK;
        case 'q': case 'Q': return QUEEN;
        case 'k': case 'K': return KING;
        default: return NO_PIECE_TYPE;
    }
}

// Occupancy/color bitboards rebuilt from the mailbox per call — antichess
// positions are tiny and this is never a standard-search hot path (mirrors
// duck.cpp's identical choice).
U64 ac_occupied(const AntichessState& s) {
    U64 bb = 0;
    for (Square sq = A1; sq <= H8; sq = Square(sq + 1))
        if (s.board[sq] != NO_PIECE) bb |= square_bb(sq);
    return bb;
}

U64 ac_color_bb(const AntichessState& s, Color c) {
    U64 bb = 0;
    for (Square sq = A1; sq <= H8; sq = Square(sq + 1))
        if (s.board[sq] != NO_PIECE && color_of(s.board[sq]) == c) bb |= square_bb(sq);
    return bb;
}

// Runtime-dispatched pseudo-attacks for a piece of type/color from `from`
// given occupancy `occ`. There is no duck square here (unlike duck.cpp) —
// straight board occupancy.
U64 ac_pseudo_attacks(PieceType pt, Color c, Square from, U64 occ) {
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

int clamp_int(int v, int lo, int hi) { return v < lo ? lo : (v > hi ? hi : v); }

int64_t ac_now_ms() {
    using namespace std::chrono;
    return duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count();
}

} // namespace

// ==================== Move ====================

std::string AntichessMove::uci() const {
    std::string s = SQ_NAMES[from] + SQ_NAMES[to];
    if (promo != NO_PIECE_TYPE) s += promo_char(promo);
    return s;
}

bool antichess_parse_uci(const std::string& s, AntichessMove& out) {
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
    out = AntichessMove{};
    out.from = from;
    out.to = to;
    out.promo = promo;
    return true;
}

// ==================== FEN ====================

std::string AntichessState::fen() const {
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
            ss << AC_PCS[p];
        }
        if (empty) ss << empty;
        if (r) ss << '/';
    }
    ss << ' ' << (side == WHITE ? 'w' : 'b') << ' ';
    ss << '-'; // antichess has no castling at all — always emit "-" (matches python-chess's own serialization)
    ss << ' ' << (ep == SQ_NONE ? "-" : SQ_NAMES[ep]);
    ss << ' ' << halfmove << ' ' << fullmove;
    return ss.str();
}

bool antichess_parse(const std::string& fen, AntichessState& out, std::string& err) {
    std::istringstream iss(fen);
    std::string placement, sideStr, castlingStr, epStr;
    if (!(iss >> placement >> sideStr >> castlingStr >> epStr)) {
        err = "invalid fen: too few fields";
        return false;
    }
    (void)castlingStr; // parsed-and-discarded: antichess has no castling (see AntichessState's doc)
    std::string halfStr, fullStr;
    if (!(iss >> halfStr)) halfStr = "0";
    if (!(iss >> fullStr)) fullStr = "1";

    AntichessState st;
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

    out = st;
    return true;
}

uint64_t AntichessState::key() const {
    uint64_t k = 0;
    for (Square sq = A1; sq <= H8; sq = Square(sq + 1)) {
        Piece p = board[sq];
        if (p != NO_PIECE) k ^= Zobrist::psq[p][sq];
    }
    if (ep != SQ_NONE) k ^= Zobrist::enpassant[file_of(ep)];
    if (side == BLACK) k ^= Zobrist::side;
    return k;
}

// ==================== Move generation ====================

bool antichess_is_capture(const AntichessState& s, const AntichessMove& m) {
    if (m.ep) return true;
    return s.board[m.to] != NO_PIECE;
}

namespace {

void emit_targets(std::vector<AntichessMove>& moves, Square from, U64 targets) {
    while (targets) {
        Square to = pop_lsb(targets);
        moves.push_back(AntichessMove{from, to, NO_PIECE_TYPE, false});
    }
}

// A pawn reaching the last rank may promote to Q/R/B/N, OR KING — antichess
// uniquely allows king-promotion (see antichess.h's file doc); every other
// variant/module in this codebase excludes KING here.
void add_pawn_move(std::vector<AntichessMove>& moves, Square from, Square to, int promoRank, bool ep) {
    if (rank_of(to) == promoRank) {
        static const PieceType promoPieces[5] = {QUEEN, ROOK, BISHOP, KNIGHT, KING};
        for (PieceType pt : promoPieces) moves.push_back(AntichessMove{from, to, pt, false});
        return;
    }
    moves.push_back(AntichessMove{from, to, NO_PIECE_TYPE, ep});
}

void gen_pawn(const AntichessState& s, std::vector<AntichessMove>& moves, Square from, U64 occ, U64 enemy) {
    Color us = s.side;
    int forward, startRank, promoRank;
    if (us == WHITE) { forward = 8; startRank = 1; promoRank = 7; }
    else { forward = -8; startRank = 6; promoRank = 0; }

    int oneIdx = int(from) + forward;
    if (oneIdx >= 0 && oneIdx < 64) {
        Square one = Square(oneIdx);
        if (!(occ & square_bb(one))) {
            add_pawn_move(moves, from, one, promoRank, false);
            if (rank_of(from) == startRank) {
                Square two = Square(int(from) + 2 * forward);
                if (!(occ & square_bb(two))) moves.push_back(AntichessMove{from, two, NO_PIECE_TYPE, false});
            }
        }
    }

    U64 att = BB::pawn_attacks(us, from);
    U64 caps = att & enemy;
    while (caps) {
        Square to = pop_lsb(caps);
        add_pawn_move(moves, from, to, promoRank, false);
    }

    if (s.ep != SQ_NONE && (att & square_bb(s.ep))) {
        moves.push_back(AntichessMove{from, s.ep, NO_PIECE_TYPE, true});
    }
}

// Pseudo-legal generation ONLY — no forced-capture filter applied yet (see
// antichess_legal_moves_struct, which is the public entry point). There is no
// self-check filter anywhere in this file: antichess has no check concept at
// all, so a king move/capture is generated exactly like any other piece's.
std::vector<AntichessMove> pseudo_moves(const AntichessState& s) {
    Color us = s.side;
    U64 occ = ac_occupied(s);
    U64 own = ac_color_bb(s, us);
    U64 enemy = ac_color_bb(s, ~us);

    std::vector<AntichessMove> moves;
    moves.reserve(48);
    for (Square from = A1; from <= H8; from = Square(from + 1)) {
        Piece p = s.board[from];
        if (p == NO_PIECE || color_of(p) != us) continue;
        PieceType pt = type_of(p);
        if (pt == PAWN) {
            gen_pawn(s, moves, from, occ, enemy);
            continue;
        }
        U64 targets = ac_pseudo_attacks(pt, us, from, occ) & ~own;
        emit_targets(moves, from, targets);
    }
    return moves;
}

} // namespace

std::vector<AntichessMove> antichess_legal_moves_struct(const AntichessState& s) {
    std::vector<AntichessMove> moves = pseudo_moves(s);

    bool anyCapture = false;
    for (const AntichessMove& m : moves) {
        if (antichess_is_capture(s, m)) { anyCapture = true; break; }
    }
    if (!anyCapture) return moves; // no capture exists -> every pseudo-legal move is legal

    // Compulsory capture: only captures are legal when at least one exists.
    std::vector<AntichessMove> captures;
    captures.reserve(moves.size());
    for (const AntichessMove& m : moves)
        if (antichess_is_capture(s, m)) captures.push_back(m);
    return captures;
}

std::vector<std::string> antichess_legal_moves(const AntichessState& s) {
    std::vector<AntichessMove> moves = antichess_legal_moves_struct(s);
    std::vector<std::string> out;
    out.reserve(moves.size());
    for (const AntichessMove& m : moves) out.push_back(m.uci());
    return out;
}

bool antichess_find_legal(const AntichessState& s, const AntichessMove& want, AntichessMove& out) {
    for (const AntichessMove& m : antichess_legal_moves_struct(s)) {
        if (m.from == want.from && m.to == want.to && m.promo == want.promo) {
            out = m;
            return true;
        }
    }
    return false;
}

// ==================== Apply ====================

AntichessState antichess_do_move(const AntichessState& s, const AntichessMove& m) {
    AntichessState ns = s;
    Piece mover = ns.board[m.from];
    Piece captured = ns.board[m.to];
    bool isCaptureOrPawn = captured != NO_PIECE || type_of(mover) == PAWN || m.ep;

    ns.board[m.from] = NO_PIECE;
    ns.board[m.to] = (m.promo != NO_PIECE_TYPE) ? make_piece(color_of(mover), m.promo) : mover;

    if (m.ep) {
        Square capSq = (color_of(mover) == WHITE) ? Square(int(m.to) - 8) : Square(int(m.to) + 8);
        ns.board[capSq] = NO_PIECE;
    }

    ns.ep = SQ_NONE;
    if (type_of(mover) == PAWN) {
        int diff = int(m.to) - int(m.from);
        if (diff == 16 || diff == -16) ns.ep = Square((int(m.from) + int(m.to)) / 2);
    }

    ns.halfmove = isCaptureOrPawn ? 0 : ns.halfmove + 1;
    if (s.side == BLACK) ns.fullmove++;
    ns.side = ~s.side;
    return ns;
}

AntichessState antichess_apply(const AntichessState& s, const std::string& uciMove) {
    AntichessMove parsed;
    if (!antichess_parse_uci(uciMove, parsed)) throw ApiError{400, "invalid move: " + uciMove};
    AntichessMove m;
    if (!antichess_find_legal(s, parsed, m)) throw ApiError{400, "illegal move: " + uciMove};
    return antichess_do_move(s, m);
}

// ==================== Status ====================

std::string antichess_status_result(AntichessStatus st) {
    switch (st) {
        case AntichessStatus::WhiteWin: return "1-0";
        case AntichessStatus::BlackWin: return "0-1";
        case AntichessStatus::Draw: return "1/2-1/2";
        default: return "";
    }
}

std::string antichess_status_name(AntichessStatus st) {
    switch (st) {
        case AntichessStatus::WhiteWin: return "white_win";
        case AntichessStatus::BlackWin: return "black_win";
        case AntichessStatus::Draw: return "draw";
        default: return "ongoing";
    }
}

namespace {
constexpr int AC_HALFMOVE_DRAW = 100; // 50-move rule, in half-moves
AntichessStatus ac_win_for(Color c) { return c == WHITE ? AntichessStatus::WhiteWin : AntichessStatus::BlackWin; }
} // namespace

AntichessStatus antichess_status(const AntichessState& s, const std::vector<uint64_t>& history) {
    // INVERTED win condition: the side to move wins the instant it has no
    // legal move. This single check subsumes "no pieces left" too — a side
    // with zero pieces on the board trivially has zero legal moves (the
    // per-square scan in pseudo_moves finds nothing of its own color to
    // move), so no separate "no pieces" branch is needed.
    if (antichess_legal_moves_struct(s).empty()) return ac_win_for(s.side);

    if (s.halfmove >= AC_HALFMOVE_DRAW) return AntichessStatus::Draw;

    uint64_t k = s.key();
    int occurrences = 1; // s itself
    for (uint64_t h : history)
        if (h == k) occurrences++;
    if (occurrences >= 3) return AntichessStatus::Draw;

    return AntichessStatus::Ongoing;
}

// ==================== SAN ====================

std::string antichess_san(const AntichessState& s, const AntichessMove& m) {
    Piece mover = s.board[m.from];
    PieceType pt = type_of(mover);
    bool capture = antichess_is_capture(s, m);

    if (pt == PAWN) {
        std::string out;
        if (capture) {
            out += char('a' + file_of(m.from));
            out += 'x';
        }
        out += SQ_NAMES[m.to];
        if (m.promo != NO_PIECE_TYPE) out += std::string("=") + char(std::toupper(promo_char(m.promo)));
        return out;
    }

    static const char letters[7] = {0, 0, 'N', 'B', 'R', 'Q', 'K'};
    std::string out(1, letters[pt]);
    if (capture) out += 'x';
    out += SQ_NAMES[m.to];
    return out;
}

// ==================== Eval ====================

namespace {

// Indexed by PieceType (NO_PIECE_TYPE..KING). The king is an ordinary piece
// in antichess (no special "infinite" value) — given a modest mid-piece
// value since it is a normal capture target/liability like anything else.
constexpr int AC_PIECE_VALUE[7] = {0, 100, 300, 300, 500, 900, 200};

// INVERTED material, mover-relative: fewer of MY pieces is good (I win at
// zero), and MORE of the opponent's remaining material is also good for me
// (it keeps THEM further from their own zero — this is a zero-sum race, not
// a shared resource). This is the opposite sign convention from every other
// eval in this codebase.
int material_term(const AntichessState& s) {
    int mine = 0, theirs = 0;
    for (Square sq = A1; sq <= H8; sq = Square(sq + 1)) {
        Piece p = s.board[sq];
        if (p == NO_PIECE) continue;
        int v = AC_PIECE_VALUE[type_of(p)];
        if (color_of(p) == s.side) mine += v;
        else theirs += v;
    }
    return theirs - mine;
}

// Light forced-capture/mobility term, mover-relative and heavily damped (the
// material term above dominates; this only nudges the search toward
// FORCING favorable exchanges rather than blindly hanging pieces). My own
// pieces the opponent could capture are GOOD for me (their next compulsory-
// capture obligation sheds MY material for me); the opponent's pieces I
// could capture are BAD for me (my own compulsory-capture obligation forces
// me to eat one, shedding THEIR material while mine survives untouched).
int forcedness_term(const AntichessState& s) {
    U64 occ = ac_occupied(s);
    U64 mineBB = ac_color_bb(s, s.side);
    U64 theirsBB = ac_color_bb(s, ~s.side);

    int hangingMine = 0, hangingTheirs = 0;
    for (Square from = A1; from <= H8; from = Square(from + 1)) {
        Piece p = s.board[from];
        if (p == NO_PIECE) continue;
        U64 att = ac_pseudo_attacks(type_of(p), color_of(p), from, occ);
        if (color_of(p) == s.side) {
            U64 targets = att & theirsBB;
            while (targets) hangingTheirs += AC_PIECE_VALUE[type_of(s.board[pop_lsb(targets)])];
        } else {
            U64 targets = att & mineBB;
            while (targets) hangingMine += AC_PIECE_VALUE[type_of(s.board[pop_lsb(targets)])];
        }
    }
    return (hangingMine - hangingTheirs) / 2;
}

// Same idea as forcedness_term, but DEDUPES attacked squares (a union of
// target bitboards) before summing values, instead of summing once per
// ATTACKING piece. The original term above double/triple-counts any enemy
// piece attacked by more than one of ours (or vice versa) — a piece can only
// ever be captured once, so counting it 2-3x systematically overstates how
// forcing a position is. This is a pure correctness fix over forcedness_term,
// not a new heuristic; kept as a separate function (rather than editing
// forcedness_term in place) so antichess_evaluate_legacy below can still
// reproduce the ORIGINAL (buggy) term byte-for-byte as the self-play
// baseline profile.
int forcedness_term_v2(const AntichessState& s) {
    U64 occ = ac_occupied(s);
    U64 mineBB = ac_color_bb(s, s.side);
    U64 theirsBB = ac_color_bb(s, ~s.side);

    U64 theirsHanging = 0; // union of their pieces attacked by mine
    U64 mineHanging = 0;   // union of my pieces attacked by theirs
    for (Square from = A1; from <= H8; from = Square(from + 1)) {
        Piece p = s.board[from];
        if (p == NO_PIECE) continue;
        U64 att = ac_pseudo_attacks(type_of(p), color_of(p), from, occ);
        if (color_of(p) == s.side) theirsHanging |= (att & theirsBB);
        else mineHanging |= (att & mineBB);
    }

    auto sum_value = [&](U64 bb) {
        int total = 0;
        while (bb) total += AC_PIECE_VALUE[type_of(s.board[pop_lsb(bb)])];
        return total;
    };
    return (sum_value(mineHanging) - sum_value(theirsHanging)) / 2;
}

// Cheap mobility proxy, mover-relative and heavily damped: counts ATTACKED
// squares only (not quiet pawn pushes — a deliberate simplification to keep
// this a single pseudo-attacks pass per side, no move-list allocation, since
// eval runs at every leaf). More of my own mobility is a mild plus (more
// options before I'm eventually forced into a bad compulsory capture); more
// of the opponent's mobility is a mild minus for the same reason mirrored.
// Only meant to break ties in QUIET (non-forced) nodes — material and the
// forcedness term above both dominate this in any position with captures on.
int mobility_count(const AntichessState& s, Color c) {
    U64 occ = ac_occupied(s);
    U64 own = ac_color_bb(s, c);
    int count = 0;
    for (Square from = A1; from <= H8; from = Square(from + 1)) {
        Piece p = s.board[from];
        if (p == NO_PIECE || color_of(p) != c) continue;
        count += popcount(ac_pseudo_attacks(type_of(p), c, from, occ) & ~own);
    }
    return count;
}

int mobility_term_v2(const AntichessState& s) {
    return mobility_count(s, s.side) - mobility_count(s, ~s.side);
}

} // namespace

// Pre-improvement eval, kept byte-for-byte: material_term + the ORIGINAL
// (double-counting) forcedness_term. Used only as the self-play baseline
// profile and as the harness's fixed "greedy" reference opponent — see
// antichess.h's doc on this function.
int antichess_evaluate_legacy(const AntichessState& s) { return material_term(s) + forcedness_term(s); }

// Live eval: material + the corrected forcedness term + a light mobility
// tie-breaker (see forcedness_term_v2 / mobility_term_v2 above for what
// changed and why). Gated behind the Step-3 self-play gate like everything
// else in this module's candidate profile.
int antichess_evaluate(const AntichessState& s) {
    return material_term(s) + forcedness_term_v2(s) + mobility_term_v2(s);
}

// ==================== Search ====================
//
// Antichess strength comes from DEPTH, not eval sophistication: compulsory
// capture collapses the branching factor to ~1-3 in most positions, so a
// plain alpha-beta reaches deep cheaply. This is why (unlike Duck/Crazyhouse,
// which run a shallow hand-rolled negamax) antichess gets a REAL iterative-
// deepening search: a transposition table (forced lines transpose heavily),
// killer/history move ordering, and a quiescence pass that keeps resolving
// forced-capture chains past the nominal horizon so those sequences are never
// cut off mid-way.

namespace {

constexpr int AC_WIN_SCORE = 1'000'000;   // side-to-move-has-no-move terminal score, ply-adjusted
constexpr int AC_MAX_PLY = 128;           // killer-table size / search recursion safety bound
constexpr int AC_MAX_DEPTH = 40;          // safety cap; ID stops earlier via time/node budget in practice
constexpr int AC_QMAX_EXTRA_PLY = 64;     // hard cap on qsearch's forced-capture-chain extension

int ac_mate_distance(int score) {
    constexpr int threshold = AC_WIN_SCORE - 1000;
    if (score >= threshold) return (AC_WIN_SCORE - score + 1) / 2;
    if (score <= -threshold) return -((AC_WIN_SCORE + score + 1) / 2);
    return 0;
}

// ---- Transposition table (own, small, self-contained — NOT Search::TT: this
// variant never touches Search::Context, see antichess.h's file doc) ----
enum class Bound : uint8_t { None, Exact, Lower, Upper };
struct TTEntry {
    uint64_t key = 0;
    int score = 0;
    uint8_t depth = 0;
    Bound bound = Bound::None;
    AntichessMove move;
};
constexpr size_t AC_TT_BITS = 18; // 262144 entries (a few MB) — fresh per search call, no cross-game leakage
constexpr size_t AC_TT_SIZE = size_t(1) << AC_TT_BITS;
constexpr uint64_t AC_TT_MASK = AC_TT_SIZE - 1;

// Per-search-call mutable state: TT, killers, history, node/time budget. One
// instance per antichess_best_move call — nothing here is shared across
// concurrent requests (mirrors the search-pool's "no shared mutable state"
// convention, just at variant scale).
struct AntichessSearcher {
    std::vector<TTEntry> tt;
    AntichessMove killers[AC_MAX_PLY][2];
    int history[COLOR_NB][64][64] = {};
    uint64_t nodes = 0;
    uint64_t maxNodes = 0;
    int64_t deadlineMs = 0; // 0 = no deadline
    bool stopped = false;
    // true = candidate profile (improved eval + quiet-node LMR); false =
    // legacy/baseline profile for the self-play A/B gate (see antichess.h's
    // doc on antichess_best_move_ex). Defaults true so any code that forgets
    // to set it explicitly gets the live behavior, never a silent regression.
    bool candidate = true;

    AntichessSearcher() : tt(AC_TT_SIZE) {}

    bool stop() {
        if (stopped) return true;
        if (maxNodes > 0 && nodes >= maxNodes) { stopped = true; return true; }
        if (deadlineMs > 0 && (nodes & 1023) == 0 && ac_now_ms() >= deadlineMs) { stopped = true; return true; }
        return false;
    }

    TTEntry* probe(uint64_t key) {
        TTEntry& e = tt[key & AC_TT_MASK];
        return e.key == key ? &e : nullptr;
    }
    void store(uint64_t key, int score, int depth, Bound bound, const AntichessMove& move) {
        TTEntry& e = tt[key & AC_TT_MASK];
        if (e.key != key || depth >= e.depth) e = TTEntry{key, score, uint8_t(depth), bound, move};
    }

    int eval_of(const AntichessState& s) const {
        return candidate ? antichess_evaluate(s) : antichess_evaluate_legacy(s);
    }
};

// Same profile switch as AntichessSearcher::eval_of, for the handful of call
// sites (single-legal-move shortcuts) that score a position before an
// AntichessSearcher exists.
int ac_eval_profiled(const AntichessState& s, bool candidateMode) {
    return candidateMode ? antichess_evaluate(s) : antichess_evaluate_legacy(s);
}

int capture_value(const AntichessState& s, const AntichessMove& m) {
    if (m.ep) return AC_PIECE_VALUE[PAWN];
    Piece victim = s.board[m.to];
    return victim == NO_PIECE ? 0 : AC_PIECE_VALUE[type_of(victim)];
}

// TT move first, then captures (highest value first — most nodes here are
// ALL-captures anyway thanks to the forced rule), then killers, then history.
void order_moves(AntichessSearcher& e, const AntichessState& s, std::vector<AntichessMove>& moves,
                  const AntichessMove& ttMove, int ply) {
    auto score_of = [&](const AntichessMove& m) {
        if (m == ttMove) return 1'000'000;
        int cap = capture_value(s, m);
        if (cap > 0) return 100'000 + cap;
        if (ply < AC_MAX_PLY && (m == e.killers[ply][0] || m == e.killers[ply][1])) return 50'000;
        return e.history[s.side][m.from][m.to];
    };
    std::stable_sort(moves.begin(), moves.end(),
                      [&](const AntichessMove& a, const AntichessMove& b) { return score_of(a) > score_of(b); });
}

// Resolves forced-capture chains past the main search's horizon via a
// stand-pat quiescence: a node with no capture available is a quiet leaf
// (return the static eval); a node WITH captures available has, by the
// compulsory rule, ONLY captures as its move list, so it is inherently
// forcing — recurse through every one of them rather than standing pat.
//
// Shares the SAME transposition table as negamax (stored at depth 0, so a
// deeper negamax entry is always trusted here, while a qsearch-computed
// entry is never mistaken by negamax for a real-depth result — same
// depth-tagging convention every alpha-beta engine with a shared qsearch/
// main-search TT uses). This is the load-bearing piece: forced-capture
// chains reached via different move orders transpose CONSTANTLY, and
// without memoizing them qsearch alone can blow up combinatorially on
// positions with several simultaneous capture options (see the file's
// search doc comment — TT is "the big strength multiplier" specifically
// because of this).
int qsearch(AntichessSearcher& e, const AntichessState& s, int alpha, int beta, int ply) {
    e.nodes++;
    if (e.stop()) return e.eval_of(s);

    uint64_t key = s.key();
    int origAlpha = alpha;
    AntichessMove ttMove;
    if (TTEntry* tte = e.probe(key)) {
        if (tte->bound == Bound::Exact) return tte->score;
        if (tte->bound == Bound::Lower && tte->score > alpha) alpha = tte->score;
        else if (tte->bound == Bound::Upper && tte->score < beta) beta = tte->score;
        if (alpha >= beta) return tte->score;
        ttMove = tte->move;
    }

    std::vector<AntichessMove> moves = antichess_legal_moves_struct(s);
    if (moves.empty()) return AC_WIN_SCORE - ply; // no legal move -> side to move wins

    bool forced = antichess_is_capture(s, moves[0]); // uniform: either every move here captures, or none do
    if (!forced || ply > AC_MAX_PLY + AC_QMAX_EXTRA_PLY) return e.eval_of(s);

    order_moves(e, s, moves, ttMove, 0);
    int best = -AC_WIN_SCORE * 2;
    AntichessMove bestMove = moves[0];
    for (const AntichessMove& m : moves) {
        AntichessState child = antichess_do_move(s, m);
        int sc = -qsearch(e, child, -beta, -alpha, ply + 1);
        if (sc > best) { best = sc; bestMove = m; }
        if (best > alpha) alpha = best;
        if (alpha >= beta) break;
    }

    Bound bound = (best <= origAlpha) ? Bound::Upper : ((best >= beta) ? Bound::Lower : Bound::Exact);
    if (!e.stopped) e.store(key, best, 0, bound, bestMove);
    return best;
}

// Main iterative-deepening negamax with alpha-beta, a transposition table,
// and killer/history-ordered moves. `path` is the sequence of position keys
// from the game's start through the CURRENT node (oldest first, `s.key()`
// always last) — used to score an in-search repetition as a draw (0) rather
// than search past it uselessly or misjudge it as decisive.
int negamax(AntichessSearcher& e, const AntichessState& s, int depth, int alpha, int beta, int ply,
            std::vector<uint64_t>& path) {
    e.nodes++;
    if (e.stop()) return e.eval_of(s);

    uint64_t key = path.back(); // == s.key(), computed once by the caller before pushing
    int reps = 0;
    for (uint64_t k : path)
        if (k == key) reps++;
    if (reps >= 3) return VALUE_DRAW;

    int origAlpha = alpha;
    AntichessMove ttMove;
    if (TTEntry* tte = e.probe(key)) {
        if (tte->depth >= depth) {
            if (tte->bound == Bound::Exact) return tte->score;
            if (tte->bound == Bound::Lower && tte->score > alpha) alpha = tte->score;
            else if (tte->bound == Bound::Upper && tte->score < beta) beta = tte->score;
            if (alpha >= beta) return tte->score;
        }
        ttMove = tte->move;
    }

    std::vector<AntichessMove> moves = antichess_legal_moves_struct(s);
    if (moves.empty()) return AC_WIN_SCORE - ply;
    if (depth <= 0) return qsearch(e, s, alpha, beta, ply);

    order_moves(e, s, moves, ttMove, ply);

    int best = -AC_WIN_SCORE * 2;
    AntichessMove bestMove = moves[0];
    int moveIndex = 0;
    for (const AntichessMove& m : moves) {
        AntichessState child = antichess_do_move(s, m);
        path.push_back(child.key());

        // Late-move reduction: ONLY on quiet (non-capture) moves, ordered
        // late. In this variant that combination is rare exactly where it
        // matters least: any node with a capture available has, by the
        // compulsory rule, NOTHING BUT captures in `moves` (order_moves
        // already sorts every one of those first), so LMR structurally
        // never touches a forced-capture line — the tactical strength this
        // module's file doc calls out stays untouched. It only fires in
        // WIDE, quiet nodes (the opening, sparse endgames) — precisely the
        // ~20-35-move-wide positions the ID loop otherwise only sees 3-4 ply
        // into (see this module's Step-1/2 measurement doc), so a modest
        // reduction there buys several more ply of effective depth for the
        // same time budget. Always re-searched at full depth on a fail-high,
        // so it can never mis-rank a move — only cost extra time when wrong.
        bool isCap = antichess_is_capture(s, m);
        int reduction = 0;
        if (e.candidate && depth >= 3 && moveIndex >= 2 && !isCap) {
            reduction = 1 + (moveIndex >= 6 ? 1 : 0) + (depth >= 7 ? 1 : 0);
            if (reduction > depth - 1) reduction = depth - 1;
        }

        int sc;
        if (reduction > 0) {
            sc = -negamax(e, child, depth - 1 - reduction, -alpha - 1, -alpha, ply + 1, path);
            if (sc > alpha) sc = -negamax(e, child, depth - 1, -beta, -alpha, ply + 1, path);
        } else {
            sc = -negamax(e, child, depth - 1, -beta, -alpha, ply + 1, path);
        }
        path.pop_back();
        moveIndex++;

        if (sc > best) { best = sc; bestMove = m; }
        if (best > alpha) alpha = best;
        if (alpha >= beta) {
            if (!isCap) {
                if (ply < AC_MAX_PLY) {
                    e.killers[ply][1] = e.killers[ply][0];
                    e.killers[ply][0] = m;
                }
                e.history[s.side][m.from][m.to] += depth * depth;
            }
            break;
        }
    }

    Bound bound = (best <= origAlpha) ? Bound::Upper : ((best >= beta) ? Bound::Lower : Bound::Exact);
    if (!e.stopped) e.store(key, best, depth, bound, bestMove);
    return best;
}

// A tiny, deliberately minimal opening nudge (per this module's spec): from
// the exact standard start position, prefer 1.e3 first in ROOT move
// ordering (antichess is a known first-player win via 1.e3 in the real
// game). This only affects search ordering at equal values, never overrides
// what the search actually finds better.
bool is_standard_start(const AntichessState& s) {
    static const AntichessState start = [] {
        AntichessState st;
        std::string err;
        antichess_parse(ANTICHESS_START_FEN, st, err);
        return st;
    }();
    if (s.side != WHITE || s.ep != SQ_NONE || s.fullmove != 1) return false;
    return std::memcmp(s.board, start.board, sizeof(s.board)) == 0;
}

void apply_opening_nudge(const AntichessState& s, std::vector<AntichessMove>& rootMoves) {
    if (!is_standard_start(s)) return;
    for (size_t i = 0; i < rootMoves.size(); ++i) {
        if (rootMoves[i].from == E2 && rootMoves[i].to == E3) {
            std::swap(rootMoves[0], rootMoves[i]);
            return;
        }
    }
}

// ==================== Opening book (candidate profile only) ====================
//
// Deliberately tiny: a book entry is only trusted here because it is a
// PROVEN game-theoretic result, not because search/theory "likes" it, and
// each one passed this module's Step-3 self-play gate (candidate beats the
// legacy/baseline profile head-to-head) before being added — see this
// module's file doc for the full measurement methodology. Matched by EXACT
// board position (a plain memcmp helper per entry), not a hash map: with
// one or two entries a linear scan is simpler and just as fast, and it keeps
// every entry's provenance readable as its own named check rather than
// buried in an opaque table.
//
// Sources (both cross-checked against the ResearchGate abstract and
// antichess.org's "Losing Openings" solved-move table, 2026-07):
//   - Watkins, M. "Losing Chess: 1. e3 wins for White" (2016) — exhaustive
//     proof-number search shows 1. e3 is a FORCED WIN for White against
//     EVERY Black reply. This is the book's only entry: it needs no Black
//     reply table because the result holds unconditionally.
//   - antichess.org/losing-openings: 1. d4, 1. e4, 1. d3, 1. Nc3, 1. Nf3,
//     1. f4, 1. h4, 1. h3, 1. b4, 1. f3, 1. a3, 1. c3 are independently
//     proven LOSING first moves for White — the book therefore never
//     considers them; 1. e3 is the only entry that could ever fire from the
//     start position.
//
// Defined OUTSIDE this anonymous namespace (below, after it closes) so it has
// external linkage matching antichess.h's declaration — the declaration
// brought in by that #include is what the calls inside this namespace bind
// to; this comment stays here since this is where the book's rationale and
// every entry's sourcing belongs, next to is_standard_start/apply_opening_nudge.

struct AntichessSearchConfig {
    int depth = AC_MAX_DEPTH;
    int movetimeMs = 1000;
    uint64_t nodes = 0;
    bool clean = true;
    int rankDepth = 6;
    double temperature = 0.0;
    double capDelta = 1.0;
    double winProbScale = 350.0; // 3.5 x pawn value (AC_PIECE_VALUE[PAWN] == 100), matches duck/rating conventions
};

constexpr double AC_RMIN = 700.0, AC_RFULL = 2850.0, AC_RMAX = 3500.0;

// Clones Rating::config_for_rating / duck_apply_rating's temperature/capDelta
// softmax formula VERBATIM (per this module's spec: bands 700/2850/3500,
// temperature = 0.40*u^1.35, capDelta = 0.03+0.52*u^1.10). The depth/movetime
// ladder is antichess-specific — this variant's strength lever is search
// depth (12-25 ply realistic), not a small fixed 1..4 cap like Duck's.
void antichess_apply_rating(AntichessSearchConfig& cfg, int rating) {
    int r = clamp_int(rating, int(AC_RMIN), int(AC_RMAX));
    double s = double(r - AC_RMIN) / double(AC_RMAX - AC_RMIN);
    cfg.rankDepth = clamp_int(int(2.0 + 10.0 * s + 0.5), 2, 12);
    cfg.movetimeMs = clamp_int(int(80.0 * std::pow(2000.0 / 80.0, s)), 80, 2000);

    cfg.clean = (r >= int(AC_RMAX));
    if (cfg.clean) {
        cfg.depth = AC_MAX_DEPTH;
        cfg.movetimeMs = 2000;
        cfg.temperature = 0.0;
        cfg.capDelta = 1.0;
        return;
    }

    double u = (AC_RFULL - double(clamp_int(rating, int(AC_RMIN), int(AC_RFULL)))) / (AC_RFULL - AC_RMIN);
    if (u < 0.0) u = 0.0;
    if (u > 1.0) u = 1.0;
    cfg.temperature = 0.40 * std::pow(u, 1.35);
    cfg.capDelta = 0.03 + 0.52 * std::pow(u, 1.10);
}

AntichessSearchConfig antichess_resolve_config(const AntichessLimits& lim) {
    AntichessSearchConfig cfg;
    cfg.nodes = lim.nodes;
    if (lim.movetimeMs > 0) cfg.movetimeMs = lim.movetimeMs;

    if (lim.depth > 0) {
        cfg.depth = clamp_int(lim.depth, 1, AC_MAX_DEPTH);
        cfg.clean = true;
    } else if (lim.rating > 0) {
        antichess_apply_rating(cfg, lim.rating);
    } else if (lim.level >= 0) {
        antichess_apply_rating(cfg, 700 + clamp_int(lim.level, 0, 10) * 280);
    } else {
        cfg.clean = true; // no rating/level/depth given -> full strength (matches /candidates' convention)
    }
    return cfg;
}

uint64_t ac_seed_for(const AntichessState& s) {
    std::string data = s.fen();
    uint64_t h = 1469598103934665603ULL; // FNV-1a offset basis
    for (unsigned char c : data) {
        h ^= c;
        h *= 1099511628211ULL;
    }
    return h;
}

// FULL-STRENGTH branch: single-PV iterative deepening, driven by
// movetimeMs/nodes/depth. Keeps the previous iteration's result whenever a
// deeper iteration is aborted mid-pass by the time/node budget (classic ID
// safety — never return a half-searched iteration over a fully-searched
// shallower one), except at depth 1 where a partial result still beats none.
// Shared candidate-only book check for BOTH search branches (clean/full-
// strength AND weakened/rating-limited) — a book hit is a proven fact about
// the position, independent of the caller's rating dial, so it is consulted
// FIRST by both branches, before either one even looks at rootMoves.size()
// or constructs a searcher. This is the single place antichess_book_lookup is
// called from (no duplicated table, no per-branch copy — see antichess.h's
// file doc on why the weakened branch needs this too: every actual website
// bot game routes through run_weakened_search via limits.rating, so a book
// that only run_clean_search consulted would never fire in a real bot game).
// Returns true (and fills `out`) on a hit; `out` is untouched on a miss.
bool ac_try_book_move(const AntichessState& s, bool candidateMode, AntichessResult& out) {
    if (!candidateMode) return false; // legacy/baseline profile never sees the book (self-play gate fidelity)
    AntichessMove book;
    if (!antichess_book_lookup(s, book)) return false;
    AntichessMove verified;
    if (!antichess_find_legal(s, book, verified)) return false;
    AntichessState child = antichess_do_move(s, verified);
    out.move = verified;
    out.hasMove = true;
    out.depth = 0;
    out.fromBook = true;
    out.score = -ac_eval_profiled(child, candidateMode);
    out.mate = ac_mate_distance(out.score);
    return true;
}

AntichessResult run_clean_search(const AntichessState& s, int maxDepth, int movetimeMs, uint64_t nodesCap,
                                  const std::vector<uint64_t>& history, bool candidateMode) {
    AntichessResult result;
    if (ac_try_book_move(s, candidateMode, result)) return result;

    std::vector<AntichessMove> rootMoves = antichess_legal_moves_struct(s);
    if (rootMoves.empty()) return result; // hasMove = false: no legal move (already a terminal position)

    if (rootMoves.size() == 1) {
        AntichessState child = antichess_do_move(s, rootMoves[0]);
        result.move = rootMoves[0];
        result.hasMove = true;
        result.depth = 1;
        result.score = -ac_eval_profiled(child, candidateMode);
        result.mate = ac_mate_distance(result.score);
        return result;
    }

    AntichessSearcher e;
    e.candidate = candidateMode;
    e.maxNodes = nodesCap;
    if (movetimeMs > 0) e.deadlineMs = ac_now_ms() + movetimeMs;

    apply_opening_nudge(s, rootMoves);

    std::vector<uint64_t> path = history;
    path.push_back(s.key());

    AntichessMove bestMove = rootMoves[0];
    int bestScore = -AC_WIN_SCORE * 2;
    int completedDepth = 0;

    for (int depth = 1; depth <= maxDepth; ++depth) {
        AntichessMove ttMove = bestMove;
        order_moves(e, s, rootMoves, ttMove, 0);

        int alpha = -AC_WIN_SCORE * 2, beta = AC_WIN_SCORE * 2;
        AntichessMove iterBest = rootMoves[0];
        int iterBestScore = -AC_WIN_SCORE * 2;
        bool fullyDone = true;
        int moveIndex = 0;

        for (const AntichessMove& m : rootMoves) {
            if (e.stop()) { fullyDone = false; break; }
            AntichessState child = antichess_do_move(s, m);
            path.push_back(child.key());

            // Root-level LMR mirrors negamax's (see that function's comment):
            // quiet, late-ordered moves get a reduced first look and an
            // automatic full-depth re-search on a fail-high, so it only ever
            // costs time, never misidentifies the best root move.
            bool isCap = antichess_is_capture(s, m);
            int reduction = 0;
            if (e.candidate && depth >= 4 && moveIndex >= 4 && !isCap) {
                reduction = 1 + (moveIndex >= 8 ? 1 : 0);
                if (reduction > depth - 1) reduction = depth - 1;
            }

            int sc;
            if (reduction > 0) {
                sc = -negamax(e, child, depth - 1 - reduction, -alpha - 1, -alpha, 1, path);
                if (sc > alpha) sc = -negamax(e, child, depth - 1, -beta, -alpha, 1, path);
            } else {
                sc = -negamax(e, child, depth - 1, -beta, -alpha, 1, path);
            }
            path.pop_back();
            moveIndex++;

            if (sc > iterBestScore) { iterBestScore = sc; iterBest = m; }
            if (iterBestScore > alpha) alpha = iterBestScore;
        }

        if (fullyDone || completedDepth == 0) {
            bestMove = iterBest;
            bestScore = iterBestScore;
            completedDepth = depth;
        }
        if (!fullyDone) break;
        if (ac_mate_distance(bestScore) > 0) break; // found a forced win — no need to search deeper
    }

    result.move = bestMove;
    result.score = bestScore;
    result.mate = ac_mate_distance(bestScore);
    result.hasMove = true;
    result.depth = completedDepth;
    result.nodes = e.nodes;
    return result;
}

// WEAKENED branch: ranks every root move at a rating-scaled shallow depth
// (mirrors duck_best_move / Rating::root_scores), then Weakening::pick's
// win-prob softmax chooses among them. Checks the SAME book as run_clean_search
// (via ac_try_book_move) FIRST, regardless of rating — see that function's
// doc: this is the only branch a real website bot game ever reaches
// (limits.rating routes here for every rating below 3500), so a book that
// skipped this branch would never fire in an actual game. 1.e3 is simply the
// standard/only-sensible antichess first move, not a "too strong for this
// rating" move — a human of any strength plays it; Weakening::pick's softmax
// still governs every move AFTER book exit, so a low-rated bot's play still
// visibly weakens starting move 2.
AntichessResult run_weakened_search(const AntichessState& s, const AntichessSearchConfig& cfg,
                                     const std::vector<uint64_t>& history, bool candidateMode) {
    AntichessResult result;
    if (ac_try_book_move(s, candidateMode, result)) return result;

    std::vector<AntichessMove> rootMoves = antichess_legal_moves_struct(s);
    if (rootMoves.empty()) return result;

    if (rootMoves.size() == 1) {
        AntichessState child = antichess_do_move(s, rootMoves[0]);
        result.move = rootMoves[0];
        result.hasMove = true;
        result.depth = 1;
        result.score = -ac_eval_profiled(child, candidateMode);
        result.mate = ac_mate_distance(result.score);
        return result;
    }

    AntichessSearcher e;
    e.candidate = candidateMode;
    if (cfg.movetimeMs > 0) e.deadlineMs = ac_now_ms() + cfg.movetimeMs;
    e.maxNodes = cfg.nodes;

    order_moves(e, s, rootMoves, AntichessMove{}, 0);

    std::vector<uint64_t> path = history;
    path.push_back(s.key());

    int rankDepth = cfg.rankDepth < 1 ? 1 : cfg.rankDepth;
    std::vector<int> scores;
    scores.reserve(rootMoves.size());
    for (const AntichessMove& m : rootMoves) {
        if (e.stop()) break; // remainder scored with a cheap static-eval floor below
        AntichessState child = antichess_do_move(s, m);
        path.push_back(child.key());
        int sc = -negamax(e, child, rankDepth - 1, -AC_WIN_SCORE * 2, AC_WIN_SCORE * 2, 1, path);
        path.pop_back();
        scores.push_back(sc);
    }
    for (size_t i = scores.size(); i < rootMoves.size(); ++i) {
        AntichessState child = antichess_do_move(s, rootMoves[i]);
        scores.push_back(-ac_eval_profiled(child, candidateMode));
    }

    std::vector<Weakening::Candidate> cands;
    cands.reserve(rootMoves.size());
    for (size_t i = 0; i < rootMoves.size(); ++i) cands.push_back({int(i), scores[i]});

    Weakening::SoftmaxConfig sc;
    sc.sensitivity = cfg.temperature;
    sc.consistency = 1.8;
    sc.capDelta = cfg.capDelta;
    sc.winProbScale = cfg.winProbScale;
    sc.protectWinningMate = true;

    std::mt19937_64 rng(ac_seed_for(s));
    size_t pick = Weakening::pick(cands, sc, rng);

    result.move = rootMoves[pick];
    result.score = scores[pick];
    result.mate = ac_mate_distance(result.score);
    result.hasMove = true;
    result.depth = rankDepth;
    result.nodes = e.nodes;
    return result;
}

// Measurement-only: same iterative-deepening root loop as run_clean_search,
// but records every root move's score at the deepest COMPLETED iteration
// instead of collapsing to a single best move — powers the antichess-bench
// harness's "top root moves" printout (antichess.h's
// antichess_root_scores_for_test doc). Deliberately NOT reused by
// run_clean_search itself (that function's inner loop is on the hot path and
// stays allocation-light); this is only ever called from the perft_test
// harness.
std::vector<AntichessRootScore> ac_root_scores_impl(const AntichessState& s, int movetimeMs, bool candidateMode) {
    std::vector<AntichessRootScore> lastCompleted;
    std::vector<AntichessMove> rootMoves = antichess_legal_moves_struct(s);
    if (rootMoves.empty()) return lastCompleted;

    AntichessSearcher e;
    e.candidate = candidateMode;
    if (movetimeMs > 0) e.deadlineMs = ac_now_ms() + movetimeMs;
    if (candidateMode) apply_opening_nudge(s, rootMoves);

    std::vector<uint64_t> path;
    path.push_back(s.key());

    AntichessMove bestMove = rootMoves[0];
    for (int depth = 1; depth <= AC_MAX_DEPTH; ++depth) {
        AntichessMove ttMove = bestMove;
        order_moves(e, s, rootMoves, ttMove, 0);

        int alpha = -AC_WIN_SCORE * 2, beta = AC_WIN_SCORE * 2;
        std::vector<AntichessRootScore> iterScores;
        iterScores.reserve(rootMoves.size());
        int iterBestScore = -AC_WIN_SCORE * 2;
        bool fullyDone = true;

        for (const AntichessMove& m : rootMoves) {
            if (e.stop()) { fullyDone = false; break; }
            AntichessState child = antichess_do_move(s, m);
            path.push_back(child.key());
            int sc = -negamax(e, child, depth - 1, -beta, -alpha, 1, path);
            path.pop_back();
            iterScores.push_back({m, sc});
            if (sc > iterBestScore) { iterBestScore = sc; bestMove = m; }
            if (iterBestScore > alpha) alpha = iterBestScore;
        }

        if (fullyDone) lastCompleted = iterScores;
        if (!fullyDone) break;
        if (ac_mate_distance(iterBestScore) > 0) break;
    }

    std::sort(lastCompleted.begin(), lastCompleted.end(),
              [](const AntichessRootScore& a, const AntichessRootScore& b) { return a.score > b.score; });
    return lastCompleted;
}

} // namespace

AntichessResult antichess_best_move(const AntichessState& s, const AntichessLimits& lim,
                                     const std::vector<uint64_t>& history) {
    return antichess_best_move_ex(s, lim, history, /*candidateMode=*/true);
}

AntichessResult antichess_best_move_ex(const AntichessState& s, const AntichessLimits& lim,
                                        const std::vector<uint64_t>& history, bool candidateMode) {
    AntichessSearchConfig cfg = antichess_resolve_config(lim);
    if (cfg.clean) return run_clean_search(s, cfg.depth, cfg.movetimeMs, cfg.nodes, history, candidateMode);
    return run_weakened_search(s, cfg, history, candidateMode);
}

std::vector<AntichessRootScore> antichess_root_scores_for_test(const AntichessState& s, int movetimeMs,
                                                                 bool candidateMode) {
    return ac_root_scores_impl(s, movetimeMs, candidateMode);
}

bool antichess_is_standard_start_for_test(const AntichessState& s) { return is_standard_start(s); }

bool antichess_book_lookup(const AntichessState& s, AntichessMove& out) {
    if (is_standard_start(s)) {
        out = AntichessMove{E2, E3, NO_PIECE_TYPE, false};
        return true;
    }
    return false;
}

// ==================== Perft (validation only) ====================

uint64_t antichess_perft(const AntichessState& s, int depth) {
    if (depth == 0) return 1;
    std::vector<AntichessMove> moves = antichess_legal_moves_struct(s);
    if (depth == 1) return moves.size();
    uint64_t nodes = 0;
    for (const AntichessMove& m : moves) {
        AntichessState child = antichess_do_move(s, m);
        nodes += antichess_perft(child, depth - 1);
    }
    return nodes;
}
