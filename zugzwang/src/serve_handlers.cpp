#include "serve_handlers.h"
#include "rules.h"
#include "rating.h"
#include "search.h"
#include "eval.h"
#include "movegen.h"
#include <algorithm>
#include <cctype>
#include <map>
#include <sstream>

namespace Handlers {

std::mutex& search_mutex() {
    static std::mutex m;
    return m;
}

namespace {

constexpr const char* START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

// Parses+validates `fen` into `pos`, throwing the gomachine-shaped 400
// ApiError on either failure tier — mirrors server.parseLegal exactly. The
// Rules::valid_fen_structure gate MUST run before pos.set() (see its doc
// comment: a missing king crashes Position::set() itself, not just fails a
// later legality check).
void parse_legal_or_throw(const std::string& fen, Position& pos) {
    if (!Rules::valid_fen_structure(fen)) throw ApiError{400, "invalid fen: malformed FEN string"};
    pos.set(fen);
    if (!Rules::position_legal(pos)) {
        throw ApiError{400, "illegal position: side not to move is in check, or a king is missing"};
    }
}

std::vector<std::string> json_str_vec(const json& j) {
    std::vector<std::string> out;
    if (j.is_array())
        for (const auto& e : j)
            if (e.is_string()) out.push_back(e.get<std::string>());
    return out;
}

std::vector<std::string> uci_pv(const std::vector<Move>& pv) {
    std::vector<std::string> out;
    out.reserve(pv.size());
    for (Move m : pv) out.push_back(move_to_uci(m));
    return out;
}

// gomachine's ClaimableDraws is a Go nil slice when empty (never `make`'d),
// which encoding/json marshals as `null`, not `[]`. Match that exactly rather
// than always emitting an array — a consumer checking `res.claimableDraws?.
// includes(...)` behaves identically either way, but the wire shape should
// still be byte-identical per WIRING_RECON.md's contract.
json claimable_draws_json(const std::vector<std::string>& draws) {
    if (draws.empty()) return nullptr;
    return draws;
}

// ---- perft (perft.cpp builds a standalone binary, not part of the `zugzwang`
// SRC list — so /perft gets its own small recursive implementation here). ----

uint64_t run_perft(Position& pos, int depth) {
    if (depth == 0) return 1;
    MoveList list;
    generate<ALL>(pos, list);
    uint64_t nodes = 0;
    StateInfo st;
    for (const ExtMove& em : list) {
        if (!pos.legal(em.move)) continue;
        if (depth == 1) { nodes++; continue; }
        pos.do_move(em.move, st);
        nodes += run_perft(pos, depth - 1);
        pos.undo_move(em.move);
    }
    return nodes;
}

std::map<std::string, uint64_t> run_perft_divide(Position& pos, int depth, uint64_t& total) {
    std::map<std::string, uint64_t> out;
    MoveList list;
    generate<ALL>(pos, list);
    StateInfo st;
    total = 0;
    for (const ExtMove& em : list) {
        if (!pos.legal(em.move)) continue;
        pos.do_move(em.move, st);
        uint64_t n = depth > 1 ? run_perft(pos, depth - 1) : 1;
        pos.undo_move(em.move);
        out[move_to_uci(em.move)] = n;
        total += n;
    }
    return out;
}

// ---- /candidates full-strength MultiPV (every legal move, no weakening) ----

struct CandidateLine {
    Move move = MOVE_NONE;
    int score = 0;
    int depth = 0;
    std::vector<Move> pv;
};

// Full-strength eval of every legal move at `pos`, ranked best-first. Mirrors
// searcher.MultiPV's MEANING (independent per-move search, best-first, PV =
// [move, ...continuation]); the mechanism differs from gomachine's single
// negamax-per-move call — see rating.cpp's root_scores doc for why (no
// exported fixed-depth negamax entry point here, only the full
// iterative-deepening Search::start). depth<=0 with movetime>0 splits the
// budget evenly across the legal moves (gomachine instead shares one
// iterative-deepening pass with a global time budget across all moves at
// once — a real but reasonable engineering deviation for Wave 1; see report).
std::vector<CandidateLine> multi_pv(Position& pos, int depth, int movetimeMs) {
    MoveList ml;
    Rules::generate_legal(pos, ml);

    int perMoveTimeMs = 0;
    if (depth <= 0) {
        int n = std::max<int>(1, static_cast<int>(ml.size()));
        perMoveTimeMs = std::max(5, movetimeMs / n);
    }

    std::vector<CandidateLine> out;
    out.reserve(ml.size());
    for (const ExtMove& em : ml) {
        Move m = em.move;
        StateInfo st;
        pos.do_move(m, st);

        CandidateLine line;
        line.move = m;
        if (depth > 0 && depth - 1 <= 0) {
            line.score = -Eval::evaluate(pos);
            line.depth = 1;
            line.pv = {m};
        } else {
            Search::Limits lim;
            lim.silent = true;
            if (depth > 0) lim.depth = depth - 1;
            else lim.movetime = perMoveTimeMs;
            Search::start(pos, lim);
            line.score = -Search::lastResult.score;
            line.depth = Search::lastResult.depth + 1;
            line.pv.push_back(m);
            for (Move pm : Search::lastResult.pv) line.pv.push_back(pm);
        }

        pos.undo_move(m);
        out.push_back(std::move(line));
    }

    std::stable_sort(out.begin(), out.end(),
                      [](const CandidateLine& a, const CandidateLine& b) { return a.score > b.score; });
    return out;
}

} // namespace

// ==================== rules-only handlers ====================

json move(const json& body) {
    std::string fen = body.value("fen", "");
    std::string moveStr = body.value("move", "");
    bool includeLegalMoves = body.value("includeLegalMoves", false);

    Position pos;
    parse_legal_or_throw(fen, pos);

    Move m = Rules::parse_uci_move(pos, moveStr);
    if (m == MOVE_NONE) {
        return json{{"legal", false}, {"reason", "illegal move"}};
    }

    std::vector<uint64_t> hist = Rules::history_keys(json_str_vec(body.value("history", json::array())));
    hist.push_back(pos.key()); // the position we're moving FROM

    std::string sanStr = Rules::san(pos, m);
    StateInfo st;
    pos.do_move(m, st);

    Rules::Status status = Rules::adjudicate(pos, hist);
    json resp = {
        {"legal", true},
        {"newFen", pos.fen()},
        {"san", sanStr},
        {"status", status.state},
        {"sideToMove", status.sideToMove},
        {"check", status.check},
        {"claimableDraws", claimable_draws_json(status.claimableDraws)},
    };
    if (!status.result.empty()) resp["result"] = status.result;
    if (includeLegalMoves) resp["legalMoves"] = Rules::legal_move_strings(pos, SQ_NONE);
    return resp;
}

json legal_moves(const json& body) {
    std::string fen = body.value("fen", "");
    std::string squareStr = body.value("square", "");

    Position pos;
    parse_legal_or_throw(fen, pos);

    Square from = squareStr.empty() ? SQ_NONE : Rules::parse_square(squareStr);
    std::vector<std::string> moves = Rules::legal_move_strings(pos, from);
    return json{{"moves", moves}, {"count", moves.size()}};
}

json status(const json& body) {
    std::string fen = body.value("fen", "");
    Position pos;
    parse_legal_or_throw(fen, pos);

    std::vector<uint64_t> hist = Rules::history_keys(json_str_vec(body.value("history", json::array())));
    Rules::Status st = Rules::adjudicate(pos, hist);

    json resp = {
        {"status", st.state},
        {"sideToMove", st.sideToMove},
        {"check", st.check},
        {"claimableDraws", claimable_draws_json(st.claimableDraws)},
    };
    if (!st.result.empty()) resp["result"] = st.result;

    std::string timeoutSide = body.value("timeoutSide", "");
    if (timeoutSide == "w" || timeoutSide == "b") {
        Color opponent = (timeoutSide == "w") ? BLACK : WHITE;
        if (Rules::can_anyone_mate(pos, opponent)) {
            resp["status"] = "timeout";
            resp["result"] = (opponent == WHITE) ? "1-0" : "0-1";
            resp["reason"] = "timeout";
        } else {
            resp["status"] = "draw-timeout-vs-insufficient-material";
            resp["result"] = "1/2-1/2";
            resp["reason"] = "timeout-vs-insufficient-material";
        }
    }
    return resp;
}

json perft(const json& body) {
    std::string fen = body.value("fen", "");
    int depth = body.value("depth", 0);
    bool divide = body.value("divide", false);

    Position pos;
    parse_legal_or_throw(fen, pos);
    if (depth < 1 || depth > 8) throw ApiError{400, "depth must be 1..8"};

    if (divide) {
        uint64_t total = 0;
        auto div = run_perft_divide(pos, depth, total);
        return json{{"nodes", total}, {"divide", div}};
    }
    return json{{"nodes", run_perft(pos, depth)}};
}

// ==================== search-backed handlers ====================

json best_move(const json& body) {
    std::lock_guard<std::mutex> lock(search_mutex());

    std::string fen = body.value("fen", "");
    Position pos;
    parse_legal_or_throw(fen, pos);

    std::vector<uint64_t> hist = Rules::history_keys(json_str_vec(body.value("history", json::array())));
    json limits = body.value("limits", json::object());

    bool worst = jbool(limits, "worst");
    bool hasRating = jhas(limits, "rating");
    bool hasLevel = jhas(limits, "level");
    int depth = limits.value("depth", 0);
    int movetimeMs = limits.value("movetime", 0);
    int64_t nodes = limits.value("nodes", static_cast<int64_t>(0));
    // aggr/book/fast: STUBBED (ignored) — see WIRING_RECON.md + the port report.
    // The rating weakening itself (the load-bearing knob) is real below.

    int64_t t0 = Search::now_ms();

    if (worst || hasRating || hasLevel) {
        Rating::WeakResult wr;
        int level;
        if (worst) {
            wr = Rating::best_move_worst(pos, hist);
            level = -1; // matches gomachine's BestMoveWorst (Level: -1)
        } else if (hasRating) {
            int rating = limits["rating"].get<int>();
            wr = Rating::best_move_for_rating(pos, rating, depth, movetimeMs, nodes, hist);
            // matches gomachine's ACTUAL BestMoveConfig (used by the rating
            // path): it never sets BestResult.Level, so it serializes as the
            // Go zero value 0 — NOT -1. (WIRING_RECON's summary table says
            // "-1 for book/rating/worst"; the source (engine.go:190-206)
            // disagrees for the rating path specifically. Went with source.)
            level = 0;
        } else {
            int lvl = limits["level"].get<int>();
            if (lvl < 0) lvl = 0;
            if (lvl > 10) lvl = 10;
            // STUB: legacy 0..10 level, approximated by linearly mapping onto
            // the rating ladder and reusing the SAME weakening pipeline as
            // `rating` — NOT gomachine's configForLevel table (different
            // curve; rankDepth capped at 6). Shape-preserving; `rating` is
            // the load-bearing knob per WIRING_RECON, this is a best-effort
            // fallback for the legacy field.
            int approxRating = Rating::RatingMin +
                                (Rating::RatingMax - Rating::RatingMin) * lvl / 10;
            wr = Rating::best_move_for_rating(pos, approxRating, depth, movetimeMs, nodes, hist);
            level = lvl;
        }

        if (wr.move == MOVE_NONE) {
            return json{{"bestmove", nullptr}, {"reason", "no legal moves"}};
        }
        int64_t elapsed = Search::now_ms() - t0;
        int64_t nps = elapsed > 0 ? (wr.nodes * 1000) / elapsed : 0;
        return json{
            {"bestmove", move_to_uci(wr.move)},
            {"san", Rules::san(pos, wr.move)},
            {"eval", eval_json(wr.score)},
            {"pv", uci_pv(wr.pv)},
            {"depth", wr.depth},
            {"nodes", wr.nodes},
            {"nps", nps},
            {"level", level},
            {"opening", nullptr}, // STUB: no opening-name table ported (Wave 1)
        };
    }

    // No rating/level/worst: full-strength search bounded by depth/movetime,
    // or gomachine's 1s default when neither is given (server.go:516-519).
    Rules::seed_history(pos, hist);
    Search::Limits lim;
    lim.silent = true;
    if (depth > 0 || movetimeMs > 0) {
        lim.depth = depth;
        lim.movetime = movetimeMs;
    } else {
        lim.movetime = 1000;
    }
    Search::start(pos, lim);
    const Search::Result& r = Search::lastResult;
    if (r.bestMove == MOVE_NONE) {
        return json{{"bestmove", nullptr}, {"reason", "no legal moves"}};
    }
    int64_t elapsed = Search::now_ms() - t0;
    int64_t nps = elapsed > 0 ? (r.nodes * 1000) / elapsed : 0;
    return json{
        {"bestmove", move_to_uci(r.bestMove)},
        {"san", Rules::san(pos, r.bestMove)},
        {"eval", eval_json(r.score)},
        {"pv", uci_pv(r.pv)},
        {"depth", r.depth},
        {"nodes", r.nodes},
        {"nps", nps},
        {"level", -1}, // matches SearchDirectLimits (server.go:452-456)
        {"opening", nullptr}, // STUB: no opening-name table ported (Wave 1)
    };
}

json candidates(const json& body) {
    std::lock_guard<std::mutex> lock(search_mutex());

    std::string fen = body.value("fen", "");
    Position pos;
    parse_legal_or_throw(fen, pos);

    json limits = body.value("limits", json::object());
    int multipv = limits.value("multipv", 0);
    int depth = limits.value("depth", 0);
    int movetimeMs = limits.value("movetime", 0);
    if (depth <= 0 && movetimeMs == 0) movetimeMs = 300; // server.go:283-285 default

    std::vector<uint64_t> hist = Rules::history_keys(json_str_vec(body.value("history", json::array())));
    Rules::seed_history(pos, hist);

    auto cands = multi_pv(pos, depth, movetimeMs);
    if (multipv > 0 && static_cast<size_t>(multipv) < cands.size()) cands.resize(multipv);

    json moves = json::array();
    for (const CandidateLine& c : cands) {
        moves.push_back(json{
            {"uci", move_to_uci(c.move)},
            {"san", Rules::san(pos, c.move)},
            {"eval", eval_json(c.score)},
            {"pv", uci_pv(c.pv)},
            {"depth", c.depth},
            {"opening", nullptr}, // STUB: no opening-name table ported (Wave 1)
        });
    }
    return json{{"opening", nullptr}, {"moves", moves}};
}

json analyze_game(const json& body) {
    std::lock_guard<std::mutex> lock(search_mutex());

    constexpr int kDefaultMoveTime = 100, kMinMoveTime = 100, kMaxMoveTime = 3000, kMaxMoves = 600;

    std::string startFen = body.value("startFen", "");
    if (startFen.empty()) startFen = START_FEN;
    std::vector<std::string> moves = json_str_vec(body.value("moves", json::array()));
    if (moves.size() > static_cast<size_t>(kMaxMoves)) throw ApiError{400, "too many moves"};

    int movetimeMs = body.value("movetime", 0);
    if (movetimeMs == 0) movetimeMs = kDefaultMoveTime;
    movetimeMs = std::max(kMinMoveTime, std::min(kMaxMoveTime, movetimeMs));

    Position pos;
    parse_legal_or_throw(startFen, pos);

    // Snapshot the FEN before each move (fens[i] = position before move i);
    // fens.size() == moves.size()+1. Mirrors analyze.go:86-97.
    std::vector<std::string> fens;
    fens.push_back(pos.fen());
    for (const std::string& uci : moves) {
        Move m = Rules::parse_uci_move(pos, uci);
        if (m == MOVE_NONE) throw ApiError{400, "illegal move in sequence: " + uci};
        StateInfo st;
        pos.do_move(m, st);
        fens.push_back(pos.fen());
    }

    // No book (we don't have one) and no game history threaded through search
    // (deliberately — analyze.go:163-171: game review wants the OBJECTIVE
    // best move/eval, not a practical anti-repetition playing decision).
    // Sequential, not gomachine's block-stealing worker-pool fan-out — same
    // JSON shape, just single-threaded (Wave 1; zugzwang has one shared
    // search state, see search_mutex()'s doc comment).
    json positions = json::array();
    for (const std::string& f : fens) {
        Position p;
        p.set(f);
        json entry = {
            {"fen", f},
            {"sideToMove", p.side_to_move() == WHITE ? "w" : "b"},
        };

        MoveList ml;
        Rules::generate_legal(p, ml);
        if (ml.size() == 0) {
            Rules::Status st = Rules::adjudicate(p, {});
            entry["eval"] = nullptr;
            entry["bestmove"] = nullptr;
            entry["bestSan"] = nullptr;
            entry["pv"] = json::array();
            entry["depth"] = 0;
            entry["terminal"] = true;
            entry["checkmate"] = st.state == "checkmate";
            entry["stalemate"] = st.state == "stalemate";
            positions.push_back(entry);
            continue;
        }

        Search::Limits lim;
        lim.silent = true;
        lim.movetime = movetimeMs;
        Search::start(p, lim);
        const Search::Result& r = Search::lastResult;

        entry["eval"] = eval_json(r.score);
        entry["bestmove"] = move_to_uci(r.bestMove);
        entry["bestSan"] = Rules::san(p, r.bestMove);
        entry["pv"] = uci_pv(r.pv);
        entry["depth"] = r.depth;
        entry["terminal"] = false;
        entry["checkmate"] = false;
        entry["stalemate"] = false;
        positions.push_back(entry);
    }

    return json{{"positions", positions}, {"count", positions.size()}};
}

} // namespace Handlers
