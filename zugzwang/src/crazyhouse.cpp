#include "crazyhouse.h"
#include "bitboard.h"
#include "movegen.h"
#include "rules.h"
#include "search.h" // Search::now_ms() only — no Search::Context/NNUE dependency
#include "weakening.h"
#include "zobrist.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <iostream>
#include <random>
#include <sstream>

using namespace BB;

// ==================== Move ====================

std::string ZHMove::uci() const {
    if (isDrop) {
        static const char letter[PIECE_TYPE_NB] = {0, 'P', 'N', 'B', 'R', 'Q', 0};
        return std::string(1, letter[dropType]) + "@" + SQ_NAMES[to];
    }
    return move_to_uci(core);
}

bool zh_parse_move(const std::string& s, ZHMove& out) {
    if (s.size() == 4 && s[1] == '@') {
        PieceType pt;
        switch (s[0]) {
            case 'P': pt = PAWN; break;
            case 'N': pt = KNIGHT; break;
            case 'B': pt = BISHOP; break;
            case 'R': pt = ROOK; break;
            case 'Q': pt = QUEEN; break;
            default: return false;
        }
        Square to = Rules::parse_square(s.substr(2, 2));
        if (to == SQ_NONE) return false;
        out = ZHMove{};
        out.isDrop = true;
        out.dropType = pt;
        out.to = to;
        return true;
    }
    return false;
}

// ==================== FEN ====================

namespace {

constexpr const char* ZH_PCS = " PNBRQK  pnbrqk"; // indexed by Piece (types.h) — mirrors Position::fen()

// Strips "~" promotion marks from a board placement field, returning the
// cleaned field and the squares that carried a mark. Mirrors gomachine's
// crazyhouse.stripPromoMarks (state.go) exactly.
bool strip_promo_marks(const std::string& board, std::string& outBoard, std::vector<Square>& promo,
                        std::string& err) {
    outBoard.clear();
    int file = 0, rank = 7;
    Square lastSq = SQ_NONE;
    for (char c : board) {
        if (c == '/') {
            outBoard += c;
            file = 0;
            rank--;
        } else if (c >= '1' && c <= '8') {
            outBoard += c;
            file += (c - '0');
        } else if (c == '~') {
            if (lastSq == SQ_NONE) {
                err = "crazyhouse fen: stray ~";
                return false;
            }
            promo.push_back(lastSq);
        } else {
            if (rank < 0 || file > 7) {
                err = "crazyhouse fen: malformed board";
                return false;
            }
            lastSq = make_square(file, rank);
            outBoard += c;
            file++;
        }
    }
    return true;
}

// Tallies a FEN pocket string ("PPq" = white two pawns, black queen) — mirrors
// gomachine's crazyhouse.parsePocket.
bool parse_pocket(const std::string& s, int pockets[COLOR_NB][PIECE_TYPE_NB], std::string& err) {
    for (char c : s) {
        Color color = WHITE;
        char up = c;
        if (c >= 'a' && c <= 'z') {
            color = BLACK;
            up = char(c - ('a' - 'A'));
        }
        PieceType pt;
        switch (up) {
            case 'P': pt = PAWN; break;
            case 'N': pt = KNIGHT; break;
            case 'B': pt = BISHOP; break;
            case 'R': pt = ROOK; break;
            case 'Q': pt = QUEEN; break;
            default:
                err = "crazyhouse fen: bad pocket char";
                return false;
        }
        pockets[color][pt]++;
    }
    return true;
}

} // namespace

bool zh_parse(const std::string& fen, ZHPosition& out, std::string& err) {
    size_t sp = fen.find(' ');
    if (sp == std::string::npos) {
        err = "crazyhouse fen: missing fields";
        return false;
    }
    std::string placement = fen.substr(0, sp);
    std::string rest = fen.substr(sp + 1);

    std::string pocketStr;
    size_t lb = placement.find('[');
    if (lb != std::string::npos) {
        if (placement.empty() || placement.back() != ']') {
            err = "crazyhouse fen: malformed pocket";
            return false;
        }
        pocketStr = placement.substr(lb + 1, placement.size() - lb - 2);
        placement = placement.substr(0, lb);
    }

    std::string board;
    std::vector<Square> promoSquares;
    if (!strip_promo_marks(placement, board, promoSquares, err)) return false;

    std::string full = board + " " + rest;
    if (!Rules::valid_fen_structure(full)) {
        err = "crazyhouse fen: malformed FEN string";
        return false;
    }

    // Build directly into `out` (never a local ZHPosition moved/copied into
    // it): Position::st self-references &rootState (a member of the SAME
    // Position object) once set() runs, so moving or copying a Position by
    // value after that point would leave the destination's `st` dangling
    // into the source object's memory — see crazyhouse.h's ZHPosition doc.
    std::memset(out.pockets, 0, sizeof(out.pockets));
    out.promoted = 0;
    out.history.clear();
    out.appliedSt.reset();
    out.pos.set(full);
    if (!Rules::position_legal(out.pos)) {
        err = "crazyhouse fen: illegal position";
        return false;
    }
    if (!parse_pocket(pocketStr, out.pockets, err)) return false;
    for (Square sq : promoSquares) out.promoted |= square_bb(sq);

    return true;
}

std::string zh_pocket_string(const ZHPosition& z) {
    static const PieceType order[5] = {QUEEN, ROOK, BISHOP, KNIGHT, PAWN};
    static const char lower[PIECE_TYPE_NB] = {0, 'p', 'n', 'b', 'r', 'q', 0};
    std::string s;
    for (Color c : {WHITE, BLACK}) {
        for (PieceType pt : order) {
            char ch = lower[pt];
            if (c == WHITE) ch = char(ch - ('a' - 'A'));
            for (int n = 0; n < z.pockets[c][pt]; n++) s += ch;
        }
    }
    return s;
}

std::string zh_fen(const ZHPosition& z) {
    std::ostringstream ss;
    for (int r = 7; r >= 0; --r) {
        int empty = 0;
        for (int f = 0; f < 8; ++f) {
            Square sq = make_square(f, r);
            Piece pc = z.pos.piece_on(sq);
            if (pc == NO_PIECE) {
                empty++;
                continue;
            }
            if (empty) {
                ss << empty;
                empty = 0;
            }
            ss << ZH_PCS[pc];
            if (z.promoted & square_bb(sq)) ss << '~';
        }
        if (empty) ss << empty;
        if (r) ss << '/';
    }
    ss << '[' << zh_pocket_string(z) << ']';
    std::string full = z.pos.fen();
    ss << full.substr(full.find(' ')); // " w KQkq - 0 1" (leading space included)
    return ss.str();
}

uint64_t zh_key(const ZHPosition& z) {
    uint64_t h = 1469598103934665603ULL; // FNV-1a offset basis
    for (int c = 0; c < COLOR_NB; c++)
        for (int pt = PAWN; pt <= QUEEN; pt++)
            h = (h ^ uint64_t(z.pockets[c][pt])) * 1099511628211ULL;
    return z.pos.key() ^ (h * 0x9E3779B97F4A7C15ULL) ^ (uint64_t(z.promoted) * 0xD1B54A32D192ED03ULL);
}

// ==================== Movegen ====================

void zh_legal_moves(ZHPosition& z, std::vector<ZHMove>& out) {
    out.clear();
    MoveList ml;
    Rules::generate_legal(z.pos, ml);
    out.reserve(ml.size() + 32);
    for (const ExtMove& em : ml) {
        ZHMove m;
        m.core = em.move;
        out.push_back(m);
    }

    Color us = z.pos.side_to_move();
    bool any = false;
    for (int pt = PAWN; pt <= QUEEN; pt++)
        if (z.pockets[us][pt] > 0) {
            any = true;
            break;
        }
    if (!any) return;

    Square ksq = z.pos.king_square(us);
    U64 enemy = z.pos.pieces(~us);
    U64 occ = z.pos.pieces();
    static const PieceType order[5] = {QUEEN, ROOK, BISHOP, KNIGHT, PAWN};
    for (PieceType pt : order) {
        if (z.pockets[us][pt] == 0) continue;
        for (Square sq = A1; sq <= H8; sq = Square(sq + 1)) {
            if (!z.pos.empty(sq)) continue;
            if (pt == PAWN) {
                int r = rank_of(sq);
                if (r == 0 || r == 7) continue; // no pawn drops on rank 1/8
            }
            // A drop only ADDS a blocker on an empty square, so it can never
            // expose the king — legal iff the king stays unattacked once that
            // square is occupied (also rejects a drop that fails to block an
            // existing check). Mirrors gomachine's legalDrops exactly.
            if ((z.pos.attackers_to(ksq, occ | square_bb(sq)) & enemy) == 0) {
                ZHMove m;
                m.isDrop = true;
                m.dropType = pt;
                m.to = sq;
                out.push_back(m);
            }
        }
    }
}

bool zh_is_legal(ZHPosition& z, const ZHMove& m) {
    std::vector<ZHMove> moves;
    zh_legal_moves(z, moves);
    for (const ZHMove& lm : moves)
        if (lm == m) return true;
    return false;
}

bool zh_parse_and_validate(ZHPosition& z, const std::string& s, ZHMove& out) {
    ZHMove cand;
    if (zh_parse_move(s, cand)) {
        if (zh_is_legal(z, cand)) {
            out = cand;
            return true;
        }
        return false;
    }
    Move m = Rules::parse_uci_move(z.pos, s);
    if (m == MOVE_NONE) return false;
    out = ZHMove{};
    out.core = m;
    return true;
}

// ==================== Apply / undo ====================

void zh_do(ZHPosition& z, const ZHMove& m, StateInfo& st, ZHSnapshot& save) {
    std::memcpy(save.pockets, z.pockets, sizeof(save.pockets));
    save.promoted = z.promoted;

    Color us = z.pos.side_to_move();

    if (m.isDrop) {
        Piece pc = make_piece(us, m.dropType);
        z.pos.do_drop(pc, m.to, st);
        z.pockets[us][m.dropType]--;
        return;
    }

    // Identify the captured square BEFORE the move (en passant captures
    // behind `to`) — mirrors gomachine's advance() exactly.
    Square captureSq = to_sq(m.core);
    if (type_of_move(m.core) == EN_PASSANT)
        captureSq = Square(to_sq(m.core) - (us == WHITE ? NORTH : SOUTH));
    Piece victim = z.pos.piece_on(captureSq);
    bool victimPromoted = victim != NO_PIECE && (z.promoted & square_bb(captureSq)) != 0;

    z.pos.do_move(m.core, st);

    if (victim != NO_PIECE) {
        z.promoted &= ~square_bb(captureSq);
        PieceType pt = victimPromoted ? PAWN : type_of(victim);
        z.pockets[us][pt]++;
    }
    Square from = from_sq(m.core), to = to_sq(m.core);
    if (type_of_move(m.core) == PROMOTION) {
        z.promoted = (z.promoted & ~square_bb(from)) | square_bb(to);
    } else if (z.promoted & square_bb(from)) {
        z.promoted = (z.promoted & ~square_bb(from)) | square_bb(to);
    }
}

void zh_undo(ZHPosition& z, const ZHMove& m, const ZHSnapshot& save) {
    if (m.isDrop) z.pos.undo_drop(m.to);
    else z.pos.undo_move(m.core);
    std::memcpy(z.pockets, save.pockets, sizeof(z.pockets));
    z.promoted = save.promoted;
}

void zh_apply(ZHPosition& z, const ZHMove& m) {
    uint64_t preKey = zh_key(z);
    // One-shot mutation, never undone (mirrors gomachine's value-copy
    // applyLegal): the StateInfo must outlive this call (Position::st keeps
    // pointing into it), so it's heap-owned by z itself, not a local.
    z.appliedSt = std::make_unique<StateInfo>();
    ZHSnapshot save;
    zh_do(z, m, *z.appliedSt, save);
    z.history.push_back(preKey);
}

// ==================== Status ====================

ZHStatus zh_status(ZHPosition& z) {
    uint64_t k = zh_key(z);
    int reps = 1;
    for (uint64_t h : z.history)
        if (h == k) reps++;
    if (reps >= 3) return ZHStatus::Draw;

    std::vector<ZHMove> moves;
    zh_legal_moves(z, moves);
    if (moves.empty()) {
        if (z.pos.in_check())
            return (z.pos.side_to_move() == WHITE) ? ZHStatus::BlackWin : ZHStatus::WhiteWin;
        return ZHStatus::Draw;
    }
    if (z.pos.fullmove_number() > 400) return ZHStatus::Draw; // safety valve, mirrors drawMoveCap
    return ZHStatus::Ongoing;
}

std::string zh_status_result(ZHStatus st) {
    switch (st) {
        case ZHStatus::WhiteWin: return "1-0";
        case ZHStatus::BlackWin: return "0-1";
        case ZHStatus::Draw: return "1/2-1/2";
        default: return "";
    }
}

std::string zh_san(ZHPosition& z, const ZHMove& m) {
    std::string base;
    if (m.isDrop) {
        static const char letter[PIECE_TYPE_NB] = {0, 'P', 'N', 'B', 'R', 'Q', 0};
        base = std::string(1, letter[m.dropType]) + "@" + SQ_NAMES[m.to];
    } else {
        base = Rules::san(z.pos, m.core); // its own +/# suffix is STANDARD-chess-only; strip it
        while (!base.empty() && (base.back() == '+' || base.back() == '#')) base.pop_back();
    }

    StateInfo st;
    ZHSnapshot save;
    zh_do(z, m, st, save);
    if (z.pos.in_check()) {
        std::vector<ZHMove> next;
        zh_legal_moves(z, next);
        base += next.empty() ? "#" : "+";
    }
    zh_undo(z, m, save);
    return base;
}

// ==================== Eval ====================

namespace {

// Board-piece value (king excluded — handled via kingDanger). Verbatim from
// gomachine's crazyhouse.pieceValue (eval.go).
constexpr int pieceValue[PIECE_TYPE_NB] = {0, 100, 320, 330, 500, 900, 0};
// In-hand piece value — deliberately close to board value so the bot neither
// hoards nor dumps its pocket. Verbatim from gomachine's pocketValue.
constexpr int pocketValue[PIECE_TYPE_NB] = {0, 90, 250, 250, 280, 420, 0};

int capture_value(PieceType pt) { return pt == KING ? 100000 : pieceValue[pt]; }

int center_bonus(Square sq) {
    int f = file_of(sq), r = rank_of(sq);
    int df = 3 - std::abs(2 * f - 7) / 2; // 0..3, peak on the d/e files
    int dr = 3 - std::abs(2 * r - 7) / 2;
    return (df + dr) * 3;
}

int zh_king_danger(const ZHPosition& z, Color c) {
    if (z.pos.pieces(c, KING) == 0) return 0;
    Square ksq = z.pos.king_square(c);
    Color them = ~c;
    U64 enemy = z.pos.pieces(them);
    U64 occ = z.pos.pieces();

    int danger = 0;
    U64 zone = attacks<KING>(ksq) | square_bb(ksq);
    while (zone) {
        Square sq = pop_lsb(zone);
        if (z.pos.attackers_to(sq, occ) & enemy) danger += 12; // enemy piece already bears on the zone
        if (z.pos.empty(sq) && sq != ksq) danger += 5;         // empty landing square (drop target)
    }
    int hand = 0;
    for (int pt = PAWN; pt <= QUEEN; pt++) hand += z.pockets[them][pt];
    if (hand > 0) danger += hand * 8; // latent drop-mate pressure
    return danger;
}

} // namespace

int zh_evaluate(const ZHPosition& z) {
    int score = 0; // White - Black

    for (Square sq = A1; sq <= H8; sq = Square(sq + 1)) {
        Piece p = z.pos.piece_on(sq);
        if (p == NO_PIECE) continue;
        int v = pieceValue[type_of(p)] + center_bonus(sq);
        score += (color_of(p) == WHITE) ? v : -v;
    }

    for (int pt = PAWN; pt <= QUEEN; pt++) {
        score += z.pockets[WHITE][pt] * pocketValue[pt];
        score -= z.pockets[BLACK][pt] * pocketValue[pt];
    }

    score -= zh_king_danger(z, WHITE);
    score += zh_king_danger(z, BLACK);

    return (z.pos.side_to_move() == BLACK) ? -score : score;
}

// ==================== Search ====================

namespace {

constexpr int MATE_SCORE = 1'000'000;
constexpr int SCORE_INF = 2'000'000;

struct ZHConfig {
    int depth = 4;
    int movetimeMs = 1000;
    uint64_t nodes = 0;
    double temperature = 0.0;
    double capDelta = 1.0;
    double winProbScale = 350.0; // 3.5 x pawn value (pieceValue[PAWN] == 100)
};

int clamp_int(int v, int lo, int hi) { return v < lo ? lo : (v > hi ? hi : v); }

// Depth ladder unchanged from gomachine's applyRating (search.go) — this is the
// bot's tactical "sight" and stays exactly as before. The move-selection
// weakening (temperature/capDelta) now uses the shared softmax model
// (Weakening::pick), same formulas as Rating::config_for_rating in rating.cpp.
void apply_rating(ZHConfig& cfg, int rating) {
    int r = clamp_int(rating, 700, 3500);
    if (r < 1800) cfg.depth = 1;
    else if (r < 2400) cfg.depth = 2;
    else if (r < 3000) cfg.depth = 3;
    else cfg.depth = 4;

    constexpr double RFULL = 2850.0, RMIN = 700.0;
    int rc = clamp_int(rating, 700, 2900);
    if (rc >= RFULL) {
        cfg.temperature = 0.0;
        cfg.capDelta = 1.0;
        return;
    }
    double u = (RFULL - rc) / (RFULL - RMIN);
    if (u < 0.0) u = 0.0;
    if (u > 1.0) u = 1.0;
    cfg.temperature = 0.40 * std::pow(u, 1.35);
    cfg.capDelta = 0.03 + 0.52 * std::pow(u, 1.10);
}

ZHConfig resolve_config(const ZHLimits& lim) {
    ZHConfig cfg;
    cfg.nodes = lim.nodes;
    if (lim.movetimeMs > 0) cfg.movetimeMs = lim.movetimeMs;
    if (lim.depth > 0) cfg.depth = clamp_int(lim.depth, 1, 8);
    else if (lim.rating > 0) apply_rating(cfg, lim.rating);
    else if (lim.level >= 0) apply_rating(cfg, 700 + clamp_int(lim.level, 0, 10) * 280);
    return cfg;
}

struct ZHSearcher {
    uint64_t nodes = 0;
    uint64_t maxNodes = 0;
    int64_t deadlineMs = 0; // 0 = no deadline
    bool stopped = false;

    bool stop() {
        if (stopped) return true;
        if (maxNodes > 0 && nodes >= maxNodes) {
            stopped = true;
            return true;
        }
        if (deadlineMs > 0 && (nodes & 1023) == 0 && Search::now_ms() >= deadlineMs) {
            stopped = true;
            return true;
        }
        return false;
    }
};

int mate_distance(int score) {
    constexpr int threshold = MATE_SCORE - 10000;
    if (score >= threshold) {
        int plies = MATE_SCORE - score;
        return (plies + 1) / 2;
    }
    if (score <= -threshold) {
        int plies = MATE_SCORE + score;
        return -((plies + 1) / 2);
    }
    return 0;
}

bool zh_drop_gives_check(const ZHPosition& z, const ZHMove& m, Color us) {
    Square ek = z.pos.king_square(~us);
    if (ek == SQ_NONE) return false;
    U64 occ = z.pos.pieces() | square_bb(m.to);
    switch (m.dropType) {
        case PAWN: return (pawn_attacks(us, m.to) & square_bb(ek)) != 0;
        case KNIGHT: return (attacks<KNIGHT>(m.to) & square_bb(ek)) != 0;
        case BISHOP: return (attacks<BISHOP>(m.to, occ) & square_bb(ek)) != 0;
        case ROOK: return (attacks<ROOK>(m.to, occ) & square_bb(ek)) != 0;
        case QUEEN: return (attacks<QUEEN>(m.to, occ) & square_bb(ek)) != 0;
        default: return false;
    }
}

// Ranks a move for move ordering: winning captures (MVV-LVA) first, then
// checking drops, then promotions, then other drops, then quiet moves.
// Verbatim port of gomachine's moveOrderScore (search.go).
int move_order_score(const ZHPosition& z, const ZHMove& m) {
    Color us = z.pos.side_to_move();
    if (m.isDrop) {
        if (zh_drop_gives_check(z, m, us)) return 900;
        return 100 + pocketValue[m.dropType] / 10;
    }
    Piece victim = z.pos.piece_on(to_sq(m.core));
    if (victim != NO_PIECE) {
        Piece attacker = z.pos.piece_on(from_sq(m.core));
        return 10000 + capture_value(type_of(victim)) * 8 - pieceValue[type_of(attacker)];
    }
    if (type_of_move(m.core) == PROMOTION) return 800;
    return 0;
}

void order_moves(const ZHPosition& z, std::vector<ZHMove>& moves) {
    std::stable_sort(moves.begin(), moves.end(), [&](const ZHMove& a, const ZHMove& b) {
        return move_order_score(z, a) > move_order_score(z, b);
    });
}

int zh_quiesce(ZHSearcher& e, ZHPosition& z, int alpha, int beta, int ply) {
    e.nodes++;
    if (e.stop()) return 0;

    if (z.pos.in_check()) {
        std::vector<ZHMove> moves;
        zh_legal_moves(z, moves);
        if (moves.empty()) return -MATE_SCORE + ply;
        order_moves(z, moves);
        int best = -SCORE_INF;
        for (const ZHMove& m : moves) {
            StateInfo st;
            ZHSnapshot save;
            zh_do(z, m, st, save);
            int sc = -zh_quiesce(e, z, -beta, -alpha, ply + 1);
            zh_undo(z, m, save);
            if (sc > best) best = sc;
            if (best > alpha) alpha = best;
            if (alpha >= beta) break;
        }
        return best;
    }

    int standPat = zh_evaluate(z);
    if (standPat >= beta) return beta;
    if (standPat > alpha) alpha = standPat;

    std::vector<ZHMove> moves;
    zh_legal_moves(z, moves);
    std::vector<ZHMove> caps;
    for (const ZHMove& m : moves)
        if (!m.isDrop && z.pos.piece_on(to_sq(m.core)) != NO_PIECE) caps.push_back(m);
    order_moves(z, caps);
    for (const ZHMove& m : caps) {
        StateInfo st;
        ZHSnapshot save;
        zh_do(z, m, st, save);
        int sc = -zh_quiesce(e, z, -beta, -alpha, ply + 1);
        zh_undo(z, m, save);
        if (sc >= beta) return beta;
        if (sc > alpha) alpha = sc;
    }
    return alpha;
}

int zh_negamax(ZHSearcher& e, ZHPosition& z, int depth, int alpha, int beta, int ply) {
    e.nodes++;
    if (e.stop()) return 0;

    std::vector<ZHMove> moves;
    zh_legal_moves(z, moves);
    if (moves.empty()) {
        if (z.pos.in_check()) return -MATE_SCORE + ply;
        return 0; // stalemate
    }
    if (depth <= 0) return zh_quiesce(e, z, alpha, beta, ply);

    order_moves(z, moves);
    int best = -SCORE_INF;
    for (const ZHMove& m : moves) {
        StateInfo st;
        ZHSnapshot save;
        zh_do(z, m, st, save);
        int sc = -zh_negamax(e, z, depth - 1, -beta, -alpha, ply + 1);
        zh_undo(z, m, save);
        if (sc > best) best = sc;
        if (best > alpha) alpha = best;
        if (alpha >= beta) break;
    }
    return best;
}

struct ScoredMove {
    ZHMove move;
    int score;
};

uint64_t seed_for(const ZHPosition& z) {
    std::string f = zh_fen(z);
    uint64_t h = 1469598103934665603ULL;
    for (unsigned char c : f) {
        h ^= c;
        h *= 1099511628211ULL;
    }
    return h;
}

// Returns the index of the root move to play. With no weakening (temperature
// and capDelta both at full-strength defaults) it is always 0 (the best).
// Otherwise picks via the shared softmax weakening model (Weakening::pick) —
// see weakening.h. The forced-mate guard stays hand-rolled here (rather than
// relying solely on SoftmaxConfig::protectWinningMate) because crazyhouse mate
// scores use MATE_SCORE=1e6, a different convention than the standard engine's
// is_mate_score() threshold; mate_distance() is the reliable check for this
// engine's scores.
size_t weaken_pick(const std::vector<ScoredMove>& results, const ZHConfig& cfg, std::mt19937_64& rng) {
    if (results.empty()) return 0;
    if (mate_distance(results[0].score) > 0) return 0;
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

ZHResult zh_best_move(ZHPosition& z, const ZHLimits& lim) {
    std::vector<ZHMove> root;
    zh_legal_moves(z, root);
    if (root.empty()) return ZHResult{};

    ZHConfig cfg = resolve_config(lim);
    ZHSearcher e;
    e.maxNodes = cfg.nodes;
    if (cfg.movetimeMs > 0) e.deadlineMs = Search::now_ms() + cfg.movetimeMs;

    order_moves(z, root);
    std::vector<ScoredMove> completed;

    for (int depth = 1; depth <= cfg.depth; depth++) {
        std::vector<ScoredMove> scored;
        bool aborted = false;
        for (const ZHMove& m : root) {
            StateInfo st;
            ZHSnapshot save;
            zh_do(z, m, st, save);
            int sc = -zh_negamax(e, z, depth - 1, -SCORE_INF, SCORE_INF, 1);
            zh_undo(z, m, save);
            if (e.stopped) {
                aborted = true;
                break;
            }
            scored.push_back({m, sc});
        }
        if (aborted) break;
        std::stable_sort(scored.begin(), scored.end(), [](const ScoredMove& a, const ScoredMove& b) {
            if (a.score != b.score) return a.score > b.score;
            return a.move.uci() < b.move.uci();
        });
        completed = scored;
        root.clear();
        for (const ScoredMove& sm : completed) root.push_back(sm.move);
        if (!completed.empty() && mate_distance(completed[0].score) > 0) break;
        if (e.stop()) break;
    }

    ZHResult r;
    r.nodes = e.nodes;
    if (completed.empty()) {
        r.move = root[0].uci();
        r.hasMove = true;
        return r;
    }

    std::mt19937_64 rng(seed_for(z));
    size_t pick = weaken_pick(completed, cfg, rng);
    r.move = completed[pick].move.uci();
    r.score = completed[pick].score;
    r.mate = mate_distance(completed[pick].score);
    r.hasMove = true;
    r.depth = cfg.depth;
    return r;
}

// ==================== Perft ====================

uint64_t zh_perft(ZHPosition& z, int depth) {
    if (depth == 0) return 1;
    std::vector<ZHMove> moves;
    zh_legal_moves(z, moves);
    uint64_t nodes = 0;
    for (const ZHMove& m : moves) {
        if (depth == 1) {
            nodes++;
            continue;
        }
        StateInfo st;
        ZHSnapshot save;
        zh_do(z, m, st, save);
        nodes += zh_perft(z, depth - 1);
        zh_undo(z, m, save);
    }
    return nodes;
}

int zh_perft_main(int argc, char** argv) {
    if (argc < 4) {
        std::cerr << "usage: zugzwang zhperft <fen> <depth> [divide]\n";
        return 1;
    }
    std::string fen = argv[2];
    int depth = std::stoi(argv[3]);
    bool divide = argc > 4 && std::string(argv[4]) == "divide";

    BB::init();
    Zobrist::init();

    ZHPosition z;
    std::string err;
    if (!zh_parse(fen, z, err)) {
        std::cerr << "zhperft: " << err << "\n";
        return 1;
    }

    if (divide) {
        std::vector<ZHMove> moves;
        zh_legal_moves(z, moves);
        uint64_t total = 0;
        for (const ZHMove& m : moves) {
            StateInfo st;
            ZHSnapshot save;
            zh_do(z, m, st, save);
            uint64_t n = depth > 1 ? zh_perft(z, depth - 1) : 1;
            zh_undo(z, m, save);
            std::cout << m.uci() << ": " << n << "\n";
            total += n;
        }
        std::cout << "Total: " << total << "\n";
    } else {
        std::cout << zh_perft(z, depth) << "\n";
    }
    return 0;
}
