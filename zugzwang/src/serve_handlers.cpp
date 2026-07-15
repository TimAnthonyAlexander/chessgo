#include "serve_handlers.h"
#include "book.h"
#include "crazyhouse.h"
#include "duck.h"
#include "openings.h"
#include "rules.h"
#include "rating.h"
#include "search.h"
#include "eval.h"
#include "movegen.h"
#include "sf_uci.h"
#include <algorithm>
#include <cctype>
#include <map>
#include <sstream>

namespace Handlers {

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

// {"type","value"} eval object from a book entry — mirrors gomachine's
// bookEval (server.go), which is deliberately simpler than eval_json above:
// a book record stores mate/score directly rather than one VALUE_MATE-
// relative int, so there's no mate-distance arithmetic to do here.
json book_eval_json(const Book::BookEntry& e) {
    if (e.mate != 0) return json{{"type", "mate"}, {"value", e.mate}};
    return json{{"type", "cp"}, {"value", e.score}};
}

// ---- opening NAME/ECO classification (gomachine's openingFor/Classify) ----
// The openings table is keyed by gomachine's NATIVE Zobrist scheme
// (Book::book_key, NOT zugzwang's own Position::key()), so the request's
// `history` FENs must be re-walked through book_key() independently of
// Rules::history_keys (which produces zugzwang's OWN keys, used only for
// in-search repetition detection). Mirrors server.go's historyKeys+
// append(pos.Key()) pairing inside openingFor/handleCandidates.

// Ordered gomachine-Zobrist key line (root -> `pos`, inclusive) for a game
// whose prior positions are `historyFens` (oldest-first, the same raw
// `history` field Rules::history_keys consumes). Unparsable/illegal FENs are
// skipped — same best-effort behavior as Rules::history_keys.
std::vector<uint64_t> opening_key_line(const std::vector<std::string>& historyFens, const Position& pos) {
    std::vector<uint64_t> keys;
    keys.reserve(historyFens.size() + 1);
    for (const std::string& f : historyFens) {
        if (f.empty() || !Rules::valid_fen_structure(f)) continue;
        Position p;
        p.set(f);
        if (!Rules::position_legal(p)) continue;
        keys.push_back(Book::book_key(p));
    }
    keys.push_back(Book::book_key(pos));
    return keys;
}

// {"eco","name"} for a key line, or null when no position along it is a named
// opening — mirrors a nil *openings.Opening marshaling to JSON null.
json opening_json(const std::vector<uint64_t>& keyLine) {
    Openings::Opening o;
    if (Openings::classify(keyLine, o)) return json{{"eco", o.eco}, {"name", o.name}};
    return nullptr;
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
std::vector<CandidateLine> multi_pv(Search::SearchGroup& group, Position& pos, int depth, int movetimeMs) {
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
            // SMP per candidate sub-search: fans out across the group's K
            // workers on its shared TT (K==1 => byte-identical single thread).
            Search::Result r = Search::start_group(group, pos, lim);
            line.score = -r.score;
            line.depth = r.depth + 1;
            line.pv.push_back(m);
            for (Move pm : r.pv) line.pv.push_back(pm);
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
    Search::GroupLease lease;
    Search::SearchGroup& group = lease.group();
    // Rating/worst weakening runs single-threaded on the group's primary
    // Context (extra SMP strength is pointless when the goal is to play weaker);
    // the full-strength path below fans out across the whole group via
    // start_group. Both released together when `lease` goes out of scope (RAII).
    Search::Context& ctx = Search::primary_context(group);

    std::string fen = body.value("fen", "");
    Position pos;
    parse_legal_or_throw(fen, pos);

    std::vector<std::string> historyFens = json_str_vec(body.value("history", json::array()));
    std::vector<uint64_t> hist = Rules::history_keys(historyFens);
    // Opening NAME/ECO for the REQUEST position (root->current, inclusive) —
    // same for every branch below (book-hit, weakened, and full-strength),
    // mirrors gomachine's openingFor(pos, req.History) being called with the
    // same `pos`/`req.History` at all three call sites in handleBestMove.
    json openingResp = opening_json(opening_key_line(historyFens, pos));
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
            wr = Rating::best_move_worst(ctx, pos, hist);
            level = -1; // matches gomachine's BestMoveWorst (Level: -1)
        } else if (hasRating) {
            int rating = limits["rating"].get<int>();
            wr = Rating::best_move_for_rating(ctx, pos, rating, depth, movetimeMs, nodes, hist);
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
            wr = Rating::best_move_for_rating(ctx, pos, approxRating, depth, movetimeMs, nodes, hist);
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
            {"opening", openingResp},
        };
    }

    // Opening book: serve a precomputed result instantly for full-strength
    // analysis (no rating/level/worst — mirrors gomachine's bookHit at the
    // exact same call site, server.go handleBestMove, and zugzwang's own UCI
    // try_book_move). Movegen-validated: a stale/wrong record can never yield
    // an illegal move here.
    if (Book::shared().loaded()) {
        if (const Book::BookEntry* e = Book::shared().lookup(Book::book_key(pos));
            e && !e->pv.empty()) {
            Move bm = Rules::parse_uci_move(pos, e->pv[0]);
            if (bm != MOVE_NONE) {
                return json{
                    {"bestmove", move_to_uci(bm)},
                    {"san", Rules::san(pos, bm)},
                    {"eval", book_eval_json(*e)},
                    {"pv", e->pv},
                    {"depth", e->depth},
                    {"nodes", 0},
                    {"nps", 0},
                    {"level", -1}, // matches gomachine's book-hit Level (-1)
                    {"opening", openingResp},
                };
            }
        }
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
    Search::Result r = Search::start_group(group, pos, lim);
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
        {"opening", openingResp},
    };
}

// Deliberately does NOT probe the book: gomachine's own handleCandidates
// (server.go) never calls bookHit either — the analysis-board eval bar wants
// a real per-move search score for EVERY legal move (including the book
// move), not a book shortcut for just one of them. Parity means matching
// that omission, not adding a probe gomachine itself doesn't have here.
json candidates(const json& body) {
    Search::GroupLease lease;
    Search::SearchGroup& group = lease.group();

    std::string fen = body.value("fen", "");
    Position pos;
    parse_legal_or_throw(fen, pos);

    json limits = body.value("limits", json::object());
    int multipv = limits.value("multipv", 0);
    int depth = limits.value("depth", 0);
    int movetimeMs = limits.value("movetime", 0);
    if (depth <= 0 && movetimeMs == 0) movetimeMs = 300; // server.go:283-285 default

    std::vector<std::string> historyFens = json_str_vec(body.value("history", json::array()));
    std::vector<uint64_t> hist = Rules::history_keys(historyFens);
    Rules::seed_history(pos, hist);

    auto cands = multi_pv(group, pos, depth, movetimeMs);
    if (multipv > 0 && static_cast<size_t>(multipv) < cands.size()) cands.resize(multipv);

    // Line up to and including the current position, reused to name the
    // opening EACH candidate move leads to (deepest match including that
    // move) — mirrors gomachine's baseKeys in handleCandidates.
    std::vector<uint64_t> baseKeys = opening_key_line(historyFens, pos);

    json moves = json::array();
    for (const CandidateLine& c : cands) {
        std::vector<uint64_t> childKeys = baseKeys;
        StateInfo st;
        pos.do_move(c.move, st);
        childKeys.push_back(Book::book_key(pos));
        pos.undo_move(c.move);

        moves.push_back(json{
            {"uci", move_to_uci(c.move)},
            {"san", Rules::san(pos, c.move)},
            {"eval", eval_json(c.score)},
            {"pv", uci_pv(c.pv)},
            {"depth", c.depth},
            {"opening", opening_json(childKeys)}, // opening this move leads to (null if unnamed)
        });
    }
    return json{{"opening", opening_json(baseKeys)}, {"moves", moves}};
}

json analyze_game(const json& body) {
    Search::GroupLease lease;
    Search::SearchGroup& group = lease.group();

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
    // Positions analyzed sequentially, not gomachine's block-stealing
    // worker-pool fan-out — same JSON shape. Each position's search DOES fan
    // out across the leased group's K workers via start_group (Lazy SMP);
    // concurrent /analyze-game calls each get their own group via the lease
    // above, so the two levels of parallelism don't oversubscribe past G*K.
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
        Search::Result r = Search::start_group(group, p, lim);

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

// ==================== Stockfish proxy ====================

// Deliberately does NOT lease a Search::Context: the Stockfish subprocess
// does its own search entirely out-of-process, touching none of zugzwang's
// Search:: state, so this can run concurrently with the search-backed
// handlers above and with itself.
json sf_best_move(const json& body) {
    std::string fen = body.value("fen", "");
    int elo = body.value("elo", 0);
    int movetimeMs = body.value("movetime", 0);
    int depth = body.value("depth", 0);

    Position pos;
    parse_legal_or_throw(fen, pos);

    std::string path = SFUCI::resolve_path();
    if (path.empty()) {
        throw ApiError{503, "stockfish not found (set SF_PATH or STOCKFISH_PATH, or add it to PATH)"};
    }

    SFUCI::BestMoveResult res = SFUCI::query(path, fen, elo, movetimeMs, depth);
    if (res.bestmove.empty()) {
        return json{{"bestmove", nullptr}, {"reason", "no legal move"}};
    }

    Move m = Rules::parse_uci_move(pos, res.bestmove);
    if (m == MOVE_NONE) {
        return json{{"bestmove", nullptr}, {"reason", "no legal move"}};
    }

    json evalObj = res.hasScore
        ? json{{"type", res.isMate ? "mate" : "cp"}, {"value", res.value}}
        : json{{"type", "cp"}, {"value", 0}};

    return json{
        {"bestmove", res.bestmove},
        {"san", Rules::san(pos, m)},
        {"eval", evalObj},
    };
}

// ==================== Crazyhouse ====================
// Self-contained variant (src/crazyhouse.{h,cpp}) — its own rules, pockets,
// drops and pocket-aware hand eval/search; never touches Search::Context (no
// NNUE — see crazyhouse.h's file doc for why). Mirrors gomachine's
// internal/server/crazyhouse.go handlers field-for-field.

namespace {

std::string zh_status_name(ZHStatus st) {
    // A Crazyhouse win is always a checkmate (its only decisive result) — NOT
    // a king capture (that's Duck) — so it must not reuse "white_win"/
    // "black_win" (the client labels those "king captured"). Mirrors
    // gomachine's crazyhouseStatusName.
    switch (st) {
        case ZHStatus::WhiteWin:
        case ZHStatus::BlackWin:
            return "checkmate";
        case ZHStatus::Draw:
            return "draw";
        default:
            return "ongoing";
    }
}

// Merges position/status fields into a response object — stamps newFen
// (canonical, incl. [pocket]), pocket, sideToMove, status and result. Mirrors
// gomachine's crazyhouseResult.
json zh_result_json(json base, ZHPosition& z) {
    ZHStatus st = zh_status(z);
    base["newFen"] = zh_fen(z);
    base["pocket"] = zh_pocket_string(z);
    base["sideToMove"] = z.pos.side_to_move() == WHITE ? "w" : "b";
    base["status"] = zh_status_name(st);
    std::string res = zh_status_result(st);
    base["result"] = res.empty() ? json(nullptr) : json(res);
    return base;
}

} // namespace

json crazyhouse_legal_moves(const json& body) {
    std::string fen = body.value("fen", "");
    ZHPosition z;
    std::string err;
    if (!zh_parse(fen, z, err)) throw ApiError{400, err};

    std::vector<ZHMove> moves;
    zh_legal_moves(z, moves);
    std::vector<std::string> out;
    out.reserve(moves.size());
    for (const ZHMove& m : moves) out.push_back(m.uci());
    return json{{"moves", out}};
}

json crazyhouse_move(const json& body) {
    std::string fen = body.value("fen", "");
    std::string moveStr = body.value("move", "");
    ZHPosition z;
    std::string err;
    if (!zh_parse(fen, z, err)) throw ApiError{400, err};

    ZHMove m;
    if (!zh_parse_and_validate(z, moveStr, m)) {
        return json{{"legal", false}, {"error", "illegal move: " + moveStr}};
    }
    std::string sanStr = zh_san(z, m); // computed BEFORE mutating z
    zh_apply(z, m);
    return zh_result_json(json{{"legal", true}, {"san", sanStr}}, z);
}

json crazyhouse_best_move(const json& body) {
    std::string fen = body.value("fen", "");
    ZHPosition z;
    std::string err;
    if (!zh_parse(fen, z, err)) throw ApiError{400, err};

    json limits = body.value("limits", json::object());
    ZHLimits lim;
    lim.level = -1;
    if (jhas(limits, "rating")) lim.rating = limits["rating"].get<int>();
    if (jhas(limits, "level")) lim.level = limits["level"].get<int>();
    lim.depth = limits.value("depth", 0);
    lim.nodes = static_cast<uint64_t>(limits.value("nodes", static_cast<int64_t>(0)));
    lim.movetimeMs = limits.value("movetime", 0);

    ZHResult res = zh_best_move(z, lim);
    if (!res.hasMove) {
        return zh_result_json(
            json{{"bestmove", nullptr}, {"san", nullptr}, {"eval", nullptr}, {"reason", "no legal moves"}}, z);
    }

    ZHMove m;
    if (!zh_parse_and_validate(z, res.move, m)) {
        // Defensive: the search must only ever return a legal move.
        throw ApiError{500, "search produced an illegal move"};
    }
    std::string sanStr = zh_san(z, m); // computed BEFORE mutating z
    zh_apply(z, m);

    json evalObj = (res.mate != 0) ? json{{"type", "mate"}, {"value", res.mate}}
                                    : json{{"type", "cp"}, {"value", res.score}};
    return zh_result_json(json{{"bestmove", res.move}, {"san", sanStr}, {"eval", evalObj}}, z);
}

// ==================== Duck Chess ====================
// Self-contained variant (src/duck.{h,cpp}) — its own rules, hand eval, and
// shallow bot search; never touches Search::Context (no NNUE, no Position —
// see duck.h's file doc for why). Mirrors gomachine's internal/server/duck.go
// and duck_analyze.go handlers field-for-field.

namespace {

// Merges position/status fields into a response object — stamps newFen,
// duck, sideToMove, status and result, the shape shared by /duck/move and
// /duck/bestmove. Mirrors gomachine's duckResult.
json duck_result_json(json base, const DuckState& st, DuckStatus status) {
    base["newFen"] = st.fen();
    base["duck"] = st.duckString();
    base["sideToMove"] = st.side == WHITE ? "w" : "b";
    base["status"] = duck_status_name(status);
    std::string res = duck_status_result(status);
    base["result"] = res.empty() ? json(nullptr) : json(res);
    return base;
}

DuckState duck_parse_or_throw(const std::string& fen, const std::string& duckStr) {
    DuckState st;
    std::string err;
    if (!duck_parse(fen, duckStr, st, err)) throw ApiError{400, err};
    return st;
}

DuckLimits duck_limits_from_json(const json& limits) {
    DuckLimits lim = duck_default_limits();
    if (jhas(limits, "rating")) lim.rating = limits["rating"].get<int>();
    if (jhas(limits, "level")) lim.level = limits["level"].get<int>();
    lim.depth = limits.value("depth", 0);
    lim.nodes = static_cast<uint64_t>(limits.value("nodes", static_cast<int64_t>(0)));
    lim.movetimeMs = limits.value("movetime", 0);
    return lim;
}

constexpr int kDuckAnalyzeDefaultMoveTime = 250;
constexpr int kDuckAnalyzeMaxMoveTime = 3000;
constexpr int kDuckAnalyzeMaxMoves = 600;

} // namespace

// handleDuckLegalMoves equivalent: legal PIECE moves (UCI) for the side to
// move. No self-check filter; king-captures ARE included; duck target
// squares are the client's to compute.
json duck_legal_moves(const json& body) {
    std::string fen = body.value("fen", "");
    std::string duckStr = body.value("duck", "");
    DuckState st = duck_parse_or_throw(fen, duckStr);

    std::vector<DuckPieceMove> pms = duck_legal_piece_moves(st);
    std::vector<std::string> moves;
    moves.reserve(pms.size());
    for (const DuckPieceMove& m : pms) moves.push_back(m.uci());
    return json{{"moves", moves}};
}

// handleDuckMove equivalent: validates and applies a composite move,
// returning the resulting position and its terminal status.
json duck_move(const json& body) {
    std::string fen = body.value("fen", "");
    std::string duckStr = body.value("duck", "");
    std::string moveStr = body.value("move", "");
    DuckState st = duck_parse_or_throw(fen, duckStr);

    DuckState ns;
    DuckPieceMove pm;
    DuckStatus status;
    std::string err;
    if (!duck_apply_composite(st, moveStr, ns, pm, status, err)) {
        return json{{"legal", false}, {"error", err}};
    }
    std::string sanStr = duck_san(st, pm, ns.duck); // rendered from the PRE-move state
    return duck_result_json(json{{"legal", true}, {"san", sanStr}}, ns, status);
}

// handleDuckBestMove equivalent: searches for and APPLIES the bot's best
// composite move, returning it plus the resulting position/status.
json duck_bestmove(const json& body) {
    std::string fen = body.value("fen", "");
    std::string duckStr = body.value("duck", "");
    DuckState st = duck_parse_or_throw(fen, duckStr);

    DuckLimits lim = duck_limits_from_json(body.value("limits", json::object()));

    DuckResult res = duck_best_move(st, lim);
    if (!res.hasMove) {
        return duck_result_json(
            json{{"bestmove", nullptr}, {"san", nullptr}, {"eval", nullptr}, {"reason", "no legal moves"}}, st,
            duck_status(st));
    }

    std::string sanStr = duck_san(st, res.move, res.duck);
    DuckState ns;
    DuckPieceMove appliedMove;
    DuckStatus status;
    std::string err;
    if (!duck_apply_composite(st, duck_result_move_string(res), ns, appliedMove, status, err)) {
        // Defensive: the search must only ever return a legal move.
        throw ApiError{500, "search produced an illegal move"};
    }

    json evalObj = (res.mate != 0) ? json{{"type", "mate"}, {"value", res.mate}}
                                    : json{{"type", "cp"}, {"value", res.score}};
    return duck_result_json(
        json{{"bestmove", duck_result_move_string(res)}, {"san", sanStr}, {"eval", evalObj}}, ns, status);
}

// handleDuckAnalyzeGame equivalent: replays the composite `moves` from the
// standard start (no duck) and evaluates every resulting position at full
// strength, bounded by `movetime` ms per position. Sequential (not
// gomachine's goroutine fan-out) — same JSON shape, single-threaded per
// request; duck search is already shallow (depth <=4) so this stays fast
// enough for the website's post-game review use.
//
// Response: { positions: [ {ply, fen, duck, sideToMove, eval|null,
// bestmove|null, bestSan|null, terminal, checkmate, stalemate} ], count }
json duck_analyze_game(const json& body) {
    std::vector<std::string> moves = json_str_vec(body.value("moves", json::array()));
    if (moves.size() > static_cast<size_t>(kDuckAnalyzeMaxMoves)) throw ApiError{400, "too many moves"};

    int movetimeMs = body.value("movetime", 0);
    if (movetimeMs <= 0) movetimeMs = kDuckAnalyzeDefaultMoveTime;
    if (movetimeMs > kDuckAnalyzeMaxMoveTime) movetimeMs = kDuckAnalyzeMaxMoveTime;

    // Replay sequentially, snapshotting one DuckState per position
    // (moves.size()+1): index i is the position after i moves (index 0 is
    // the start).
    DuckState st = duck_parse_or_throw(DUCK_START_FEN, "");
    std::vector<DuckState> states;
    states.reserve(moves.size() + 1);
    states.push_back(st);
    for (const std::string& mv : moves) {
        DuckState ns;
        DuckPieceMove pm;
        DuckStatus status;
        std::string err;
        if (!duck_apply_composite(st, mv, ns, pm, status, err)) {
            throw ApiError{400, "illegal move in sequence: " + mv + ": " + err};
        }
        st = ns;
        states.push_back(st);
    }

    json positions = json::array();
    for (size_t i = 0; i < states.size(); i++) {
        const DuckState& stp = states[i];
        DuckStatus status = duck_status(stp);
        bool terminal = status != DuckStatus::Ongoing;
        json out = {
            {"ply", i},
            {"fen", stp.fen()},
            {"duck", stp.duckString()},
            {"sideToMove", stp.side == WHITE ? "w" : "b"},
            {"eval", nullptr},
            {"bestmove", nullptr},
            {"bestSan", nullptr},
            {"terminal", terminal},
            {"checkmate", false},
            {"stalemate", false},
        };
        if (terminal) {
            // A king missing from the board => it was captured => a decisive
            // win ("checkmate"); otherwise the terminal is non-decisive (no
            // legal move or the draw cap) => "stalemate".
            if (duck_king_captured(stp)) out["checkmate"] = true;
            else out["stalemate"] = true;
        } else {
            DuckLimits lim = duck_default_limits(); // Level -1 => NO rating/level => full strength
            lim.movetimeMs = movetimeMs;
            DuckResult res = duck_best_move(stp, lim);
            if (res.hasMove) {
                json evalObj = (res.mate != 0) ? json{{"type", "mate"}, {"value", res.mate}}
                                                : json{{"type", "cp"}, {"value", res.score}};
                out["eval"] = evalObj;
                out["bestmove"] = duck_result_move_string(res);
                out["bestSan"] = duck_san(stp, res.move, res.duck);
            }
        }
        positions.push_back(out);
    }

    return json{{"positions", positions}, {"count", positions.size()}};
}

} // namespace Handlers
