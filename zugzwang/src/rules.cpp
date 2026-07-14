#include "rules.h"
#include "bitboard.h"
#include <cctype>
#include <cstring>
#include <sstream>

namespace Rules {

bool valid_fen_structure(const std::string& fen) {
    std::istringstream ss(fen);
    std::string board, stm;
    if (!(ss >> board >> stm)) return false;
    if (stm != "w" && stm != "b") return false;
    int ranks = 1, files = 0, whiteKings = 0, blackKings = 0;
    for (char c : board) {
        if (c == '/') {
            if (files != 8) return false;
            ranks++;
            files = 0;
        } else if (std::isdigit(static_cast<unsigned char>(c))) {
            files += c - '0';
        } else if (std::strchr("pnbrqkPNBRQK", c) != nullptr) {
            files += 1;
            if (c == 'K') whiteKings++;
            if (c == 'k') blackKings++;
        } else {
            return false;
        }
    }
    return files == 8 && ranks == 8 && whiteKings == 1 && blackKings == 1;
}

void generate_legal(const Position& pos, MoveList& out) {
    MoveList pseudo;
    generate<ALL>(pos, pseudo);
    out.last = out.moves;
    for (const ExtMove& m : pseudo)
        if (pos.legal(m.move)) out.add(m.move);
}

std::vector<std::string> legal_move_strings(const Position& pos, Square from) {
    MoveList ml;
    generate_legal(pos, ml);
    std::vector<std::string> out;
    out.reserve(ml.size());
    for (const ExtMove& m : ml) {
        if (from != SQ_NONE && from_sq(m.move) != from) continue;
        out.push_back(move_to_uci(m.move));
    }
    return out;
}

Square parse_square(const std::string& s) {
    if (s.size() != 2) return SQ_NONE;
    int f = s[0] - 'a', r = s[1] - '1';
    if (f < 0 || f > 7 || r < 0 || r > 7) return SQ_NONE;
    return make_square(f, r);
}

Move parse_uci_move(const Position& pos, const std::string& s) {
    MoveList ml;
    generate_legal(pos, ml);
    // Pass 1: king-captures-rook form for castling (e.g. "e1h1") — the
    // canonical Chess960/Lichess UCI convention, unambiguous even in the rare
    // case where a plain king step shares its king-two-square string with a
    // castle. Mirrors gomachine's ParseUCIMove (both castling UCI conventions
    // accepted; king-captures-rook checked first).
    Color us = pos.side_to_move();
    for (const ExtMove& m : ml) {
        if (type_of_move(m.move) != CASTLING) continue;
        bool kingside = castle_is_kingside(m.move);
        int flag = (us == WHITE) ? (kingside ? WHITE_OO : WHITE_OOO)
                                 : (kingside ? BLACK_OO : BLACK_OOO);
        Square rfrom = pos.castling_rook_square(flag);
        if (SQ_NAMES[from_sq(m.move)] + SQ_NAMES[rfrom] == s) return m.move;
    }
    // Pass 2: canonical move_to_uci form (king-two-square castles + all other
    // moves) — this is what zugzwang (and gomachine) actually EMIT.
    for (const ExtMove& m : ml)
        if (move_to_uci(m.move) == s) return m.move;
    return MOVE_NONE;
}

namespace {
constexpr char PieceLetter[PIECE_TYPE_NB] = {0, 0, 'N', 'B', 'R', 'Q', 'K'};

// Minimal file/rank/square disambiguation for a non-pawn move, mirroring
// chess.Position.sanDisambiguation: only needed when >1 piece of the same
// type can legally reach the same target square.
std::string san_disambiguation(const Position& pos, Move m, PieceType pt) {
    MoveList ml;
    generate_legal(pos, ml);
    bool sameFile = false, sameRank = false, others = false;
    Square from = from_sq(m), to = to_sq(m);
    for (const ExtMove& o : ml) {
        if (o.move == m || to_sq(o.move) != to) continue;
        if (type_of(pos.piece_on(from_sq(o.move))) != pt) continue;
        others = true;
        if (file_of(from_sq(o.move)) == file_of(from)) sameFile = true;
        if (rank_of(from_sq(o.move)) == rank_of(from)) sameRank = true;
    }
    if (!others) return "";
    if (!sameFile) return std::string(1, char('a' + file_of(from)));
    if (!sameRank) return std::string(1, char('1' + rank_of(from)));
    return SQ_NAMES[from];
}
} // namespace

std::string san(Position& pos, Move m) {
    std::string s;
    MoveType mt = type_of_move(m);

    if (mt == CASTLING) {
        // Side comes from castle_is_kingside(m), not a from/to square compare:
        // in Chess960 the king can already be on its destination file
        // (to_sq(m) == from_sq(m)), which a file comparison can't disambiguate.
        s = castle_is_kingside(m) ? "O-O" : "O-O-O";
    } else {
        Piece moving = pos.piece_on(from_sq(m));
        PieceType pt = type_of(moving);
        bool capture = pos.piece_on(to_sq(m)) != NO_PIECE || mt == EN_PASSANT;

        if (pt == PAWN) {
            if (capture) {
                s += char('a' + file_of(from_sq(m)));
                s += 'x';
            }
            s += SQ_NAMES[to_sq(m)];
            if (mt == PROMOTION) {
                s += '=';
                s += PieceLetter[promotion_type(m)];
            }
        } else {
            s += PieceLetter[pt];
            s += san_disambiguation(pos, m, pt);
            if (capture) s += 'x';
            s += SQ_NAMES[to_sq(m)];
        }
    }

    // Check / checkmate suffix.
    StateInfo st;
    pos.do_move(m, st);
    if (pos.in_check()) {
        MoveList ml;
        generate_legal(pos, ml);
        s += ml.size() == 0 ? '#' : '+';
    }
    pos.undo_move(m);

    return s;
}

bool insufficient_material(const Position& pos) {
    for (Color c : {WHITE, BLACK}) {
        if (pos.pieces(c, PAWN) | pos.pieces(c, ROOK) | pos.pieces(c, QUEEN))
            return false;
    }
    int wN = pos.count(WHITE, KNIGHT), bN = pos.count(BLACK, KNIGHT);
    U64 wB = pos.pieces(WHITE, BISHOP), bB = pos.pieces(BLACK, BISHOP);
    int wBc = BB::popcount(wB), bBc = BB::popcount(bB);
    int minors = wN + bN + wBc + bBc;

    if (minors == 0) return true;               // K v K
    if (minors == 1) return true;                // K+minor v K
    if (minors == 2 && wN == 0 && bN == 0 && wBc == 1 && bBc == 1) {
        Square ws = BB::lsb(wB), bs = BB::lsb(bB);
        return ((file_of(ws) + rank_of(ws)) & 1) == ((file_of(bs) + rank_of(bs)) & 1);
    }
    return false;
}

bool can_anyone_mate(const Position& pos, Color c) {
    if (pos.pieces(c, PAWN) | pos.pieces(c, ROOK) | pos.pieces(c, QUEEN)) return true;
    int knights = pos.count(c, KNIGHT), bishops = pos.count(c, BISHOP);
    return knights + bishops >= 2;
}

bool position_legal(const Position& pos) {
    if (pos.pieces(WHITE, KING) == 0 || pos.pieces(BLACK, KING) == 0) return false;
    if (BB::popcount(pos.pieces(WHITE, KING)) != 1) return false;
    if (BB::popcount(pos.pieces(BLACK, KING)) != 1) return false;
    Color us = pos.side_to_move();
    Color opp = ~us;
    if (pos.is_attacked(pos.king_square(opp), us)) return false; // side not to move is in check
    return true;
}

int repetition_count(uint64_t key, const std::vector<uint64_t>& history) {
    int count = 1; // the current position
    for (uint64_t k : history)
        if (k == key) count++;
    return count;
}

Status adjudicate(const Position& pos, const std::vector<uint64_t>& history) {
    Status st;
    st.state = "ongoing";
    st.check = pos.in_check();
    st.sideToMove = pos.side_to_move() == WHITE ? "w" : "b";

    MoveList ml;
    generate_legal(pos, ml);
    if (ml.size() == 0) {
        if (pos.in_check()) {
            st.state = "checkmate";
            st.result = pos.side_to_move() == WHITE ? "0-1" : "1-0";
        } else {
            st.state = "stalemate";
            st.result = "1/2-1/2";
        }
        return st;
    }

    if (insufficient_material(pos)) {
        st.state = "draw-insufficient-material";
        st.result = "1/2-1/2";
        return st;
    }

    int reps = repetition_count(pos.key(), history);
    if (reps >= 5) {
        st.state = "draw-fivefold";
        st.result = "1/2-1/2";
        return st;
    }
    if (pos.rule50_count() >= 150) {
        st.state = "draw-seventyfive";
        st.result = "1/2-1/2";
        return st;
    }

    if (reps >= 3) st.claimableDraws.push_back("threefold");
    if (pos.rule50_count() >= 100) st.claimableDraws.push_back("fifty");
    return st;
}

std::vector<uint64_t> history_keys(const std::vector<std::string>& fens) {
    std::vector<uint64_t> keys;
    keys.reserve(fens.size());
    for (const std::string& f : fens) {
        if (f.empty() || !valid_fen_structure(f)) continue; // best-effort: skip unparsable/garbage FENs
        Position p;
        p.set(f);
        if (!position_legal(p)) continue;
        keys.push_back(p.key());
    }
    return keys;
}

void seed_history(Position& pos, const std::vector<uint64_t>& historyKeys) {
    constexpr size_t kCapacity = 1024; // Position::game_key_history's fixed size
    uint64_t current = pos.key();
    size_t total = historyKeys.size() + 1; // + current position
    size_t skip = total > kCapacity ? total - kCapacity : 0;

    pos.history_count = 0;
    for (size_t i = skip; i < historyKeys.size(); ++i)
        pos.game_key_history[pos.history_count++] = historyKeys[i];
    pos.game_key_history[pos.history_count++] = current;
}

} // namespace Rules
