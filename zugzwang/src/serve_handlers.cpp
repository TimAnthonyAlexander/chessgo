#include "serve_handlers.h"
#include "antichess.h"
#include "book.h"
#include "crazyhouse.h"
#include "duck.h"
#include "openings.h"
#include "rules.h"
#include "rating.h"
#include "search.h"
#include "secretqueen.h"
#include "secretqueen_bot.h"
#include "movegen.h"
#include "sf_uci.h"
#include <algorithm>
#include <cctype>
#include <cstdlib>
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
    return eval_json_parts(e.mate, e.score);
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

// ---- full-strength MultiPV lines (shared by /bestmove and /candidates) ----

// One reported analysis line, already rendered into wire types. `evalObj`/
// `depth` come from the BOOK for the book line and from the engine for the
// rest, deliberately un-normalized — see analysis_lines() for why the two are
// not made comparable.
struct AnalysisLine {
    Move move = MOVE_NONE;
    json evalObj;
    std::vector<std::string> pv; // UCI, pv[0] == move
    int depth = 0;
};

// Top-`n` lines for `pos`, best first, from ONE MultiPV search
// (Search::Limits::multiPV — SF's root-move + pvIdx loop, ~sf18-arm/src/
// search.cpp:341-383). Every engine line completes at the SAME iterative-
// deepening depth, which is the entire point: the predecessor here ran one
// independent start_group() PER MOVE behind a static-eval prefilter, so the
// lines landed at different depths, the evals were not comparable to each
// other or to the eval bar, and a mate that hangs material (Be5# in
// r4rk1/ppq2pBp/2pbp3/8/2B5/2nP3P/PPPnRP2/6RK w - -) was prefiltered out
// before it was ever searched. The real search finds mates because it
// searches.
//
// THE BOOK OUTRANKS THE ENGINE'S OWN LINES. book.bin is not an opening book in
// the usual "master-game popularity" sense: it is a Stockfish-computed
// best-move cache — hours of search per entry, storing {score, mate, depth,
// pv} — and it is worth roughly 100 Elo over our own search. Those ARE the
// best moves, so a book hit IS line 1, carrying the book's own eval, pv and
// depth, and is never re-ranked against engine scores (which would demote it
// on nothing but our own shallower opinion). The book move is then dropped
// from the engine's lines so that no first move appears twice.
std::vector<AnalysisLine> analysis_lines(Search::SearchGroup& group, Position& pos, Search::Limits lim, int n) {
    n = std::max(1, n);

    Move bookMove = MOVE_NONE;
    const Book::BookEntry* bookEntry = nullptr;
    if (Book::shared().loaded()) {
        if (const Book::BookEntry* e = Book::shared().lookup(Book::book_key(pos)); e && !e->pv.empty()) {
            // Movegen-validated, so a stale record can't yield an illegal move.
            if (Move bm = Rules::parse_uci_move(pos, e->pv[0]); bm != MOVE_NONE) {
                bookMove = bm;
                bookEntry = e;
            }
        }
    }

    // One search at multiPV = n. Worst case the book move is NOT among the n
    // engine lines, leaving n of them after the drop; we take n-1 and prepend
    // the book line, so n is always enough — no need to over-request.
    lim.silent = true;
    lim.multiPV = n;
    Search::Result r = Search::start_group(group, pos, lim);

    // The book decides the ORDER; the engine supplies the NUMBERS. Line 1 is the
    // book move, but rendered with the engine's own eval/pv/depth whenever the
    // engine searched it too (it nearly always does — book moves are strong). A
    // list that mixes the book's depth-22 Stockfish score with depth-12 engine
    // scores is not internally comparable and routinely renders line 1 as "worse"
    // than line 2, which reads as a broken board. This is also what the predecessor
    // did ("the book move gets an engine search too so its eval is at the same
    // depth as the other lines") — worth preserving.
    //
    // The book's own eval is NOT discarded: /bestmove reports it as the top-level
    // eval (the eval bar), where it is the better number and has nothing to be
    // compared against. Only the multi-line list is normalized to one source.
    const Search::Line* bookLine = nullptr;
    if (bookMove != MOVE_NONE)
        for (const Search::Line& l : r.lines)
            if (!l.pv.empty() && l.pv[0] == bookMove) { bookLine = &l; break; }

    std::vector<AnalysisLine> out;
    out.reserve(n);
    if (bookEntry) {
        // Fallback to the book's own record when the move is somehow absent from the
        // engine's n lines, so line 1 is populated in every case.
        if (bookLine) out.push_back({bookMove, eval_json(bookLine->score), uci_pv(bookLine->pv), bookLine->depth});
        else          out.push_back({bookMove, book_eval_json(*bookEntry), bookEntry->pv, bookEntry->depth});
    }
    for (const Search::Line& l : r.lines) {
        if (static_cast<int>(out.size()) >= n) break;
        if (l.pv.empty() || l.pv[0] == bookMove) continue;
        out.push_back({l.pv[0], eval_json(l.score), uci_pv(l.pv), l.depth});
    }
    return out;
}

// {"eco","name"} of the opening the move `m` LEADS TO — the deepest named
// position along baseKeys (root->pos, inclusive) plus m's child key. Pure book
// lookup, no search. Mirrors gomachine's per-candidate naming in
// handleCandidates. `pos` is restored before returning.
json line_opening_json(const std::vector<uint64_t>& baseKeys, Position& pos, Move m) {
    std::vector<uint64_t> childKeys = baseKeys;
    StateInfo st;
    pos.do_move(m, st);
    childKeys.push_back(Book::book_key(pos));
    pos.undo_move(m);
    return opening_json(childKeys);
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

// Search-free opening NAME/ECO classification — a pure book-key table lookup,
// no Search::Context, no TT, no engine involvement at all. `history` is
// root->previous FENs, exactly like /analyze and /candidates take it; absent
// or empty means classify from `fen` alone. Exists so a PHP-side eval-cache
// hit in front of /analyze can still resolve the path-dependent opening name
// without falling back to a full search for it.
json opening(const json& body) {
    std::string fen = body.value("fen", "");
    Position pos;
    parse_legal_or_throw(fen, pos);

    std::vector<std::string> historyFens = json_str_vec(body.value("history", json::array()));
    std::vector<uint64_t> baseKeys = opening_key_line(historyFens, pos);
    return json{{"opening", opening_json(baseKeys)}};
}

// Search-free book probe: a pure Book::lookup() by book_key(pos), no
// Search::Context, no TT — the exact same book consult /bestmove's
// full-strength path does, just without the search that normally follows a
// miss. Exists for the PHP analysis board's `cacheOnly` mode (the browser's
// local engine is doing the searching, so the server must never start one of
// its own) so a cache-miss position can still get the book's ~100-Elo-over-
// search move on a pure lookup. Movegen-validated exactly like /bestmove's
// book branches (Rules::parse_uci_move) — a stale record can't yield an
// illegal move. Mirrors book_eval_json's {type,value} shape (see its doc
// comment: BookEntry::score/mate are side-to-move relative, same convention
// as eval_json, so no sign flip is needed here either) so /book and /analyze
// never disagree about the same entry.
json book(const json& body) {
    std::string fen = body.value("fen", "");
    Position pos;
    parse_legal_or_throw(fen, pos);

    if (!Book::shared().loaded()) return json{{"hit", false}};

    const Book::BookEntry* e = Book::shared().lookup(Book::book_key(pos));
    if (!e || e->pv.empty()) return json{{"hit", false}};

    Move bm = Rules::parse_uci_move(pos, e->pv[0]);
    if (bm == MOVE_NONE) return json{{"hit", false}};

    return json{
        {"hit", true},
        {"eval", book_eval_json(*e)},
        {"bestmove", e->pv[0]},
        {"pv", e->pv},
        {"depth", e->depth},
    };
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
    std::vector<uint64_t> baseKeys = opening_key_line(historyFens, pos);
    json openingResp = opening_json(baseKeys);
    json limits = body.value("limits", json::object());

    bool worst = jbool(limits, "worst");
    bool hasRating = jhas(limits, "rating");
    bool hasLevel = jhas(limits, "level");
    int depth = limits.value("depth", 0);
    int movetimeMs = limits.value("movetime", 0);
    int multipv = limits.value("multipv", 0);
    int64_t nodes = limits.value("nodes", static_cast<int64_t>(0));
    // aggr/fast: STUBBED (ignored) — see WIRING_RECON.md + the port report.
    // `book` is now HONORED on the rating path below (was previously stubbed).
    // The rating weakening itself (the load-bearing knob) is real below.

    int64_t t0 = Search::now_ms();

    if (worst || hasRating || hasLevel) {
        // Opening book on the rating/level path: honor the `book` flag (the admin
        // engine-vs-engine "Opening book" toggle sends limits.book). A book hit
        // plays instantly, BEFORE any weakening — mirrors gomachine's rating-path
        // book. `worst` skips the book (it deliberately wants the worst move, not
        // theory). Movegen-validated, so a stale record can't yield an illegal move.
        if (!worst && jbool(limits, "book") && Book::shared().loaded()) {
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
                        {"level", -1}, // book move — same as the full-strength book hit
                        {"opening", openingResp},
                    };
                }
            }
        }

        Rating::WeakResult wr;
        int level;
        if (worst) {
            wr = Rating::best_move_worst(ctx, pos, hist);
            level = -1; // matches gomachine's BestMoveWorst (Level: -1)
        } else if (hasRating) {
            int rating = limits["rating"].get<int>();
            wr = Rating::best_move_for_rating(group, pos, rating, depth, movetimeMs, nodes, hist);
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
            wr = Rating::best_move_for_rating(group, pos, approxRating, depth, movetimeMs, nodes, hist);
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
    // analysis (no rating/level/worst). Skip when multipv > 1 — the book has one
    // move; the multi-PV branch below still puts it first, it just has to search
    // for lines 2..N as well, so it can't short-circuit here.
    if (multipv <= 1 && Book::shared().loaded()) {
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
    if (multipv > 1) {
        // Multi-PV: ONE search at multiPV = N (so every engine line lands at the
        // same depth), book-first — see analysis_lines() for the book rationale.
        std::vector<AnalysisLine> cands = analysis_lines(group, pos, lim, multipv);
        if (cands.empty()) {
            return json{{"bestmove", nullptr}, {"reason", "no legal moves"}};
        }

        json lines = json::array();
        for (const AnalysisLine& c : cands) {
            lines.push_back(json{
                {"bestmove", move_to_uci(c.move)},
                {"san", Rules::san(pos, c.move)},
                {"eval", c.evalObj},
                {"pv", c.pv},
                {"depth", c.depth},
                // The opening THIS line's first move leads to (deepest match
                // including that move) — what the analysis board's opening panel
                // labels each move with; null when unnamed.
                {"opening", line_opening_json(baseKeys, pos, c.move)},
            });
        }

        // Top-level = the eval bar. On a book hit this reports the BOOK's own
        // Stockfish-grade eval/pv/depth rather than line 1's normalized engine
        // numbers — the same thing the multipv<=1 short-circuit above returns, so
        // the eval bar reads identically whether or not the caller asked for
        // multiple lines. `lines` stays normalized for comparability; see
        // analysis_lines().
        const json& top = lines[0];
        json ev = top["eval"], pv = top["pv"], dep = top["depth"];
        if (Book::shared().loaded()) {
            if (const Book::BookEntry* e = Book::shared().lookup(Book::book_key(pos));
                e && !e->pv.empty() && Rules::parse_uci_move(pos, e->pv[0]) != MOVE_NONE) {
                ev = book_eval_json(*e);
                pv = e->pv;
                dep = e->depth;
            }
        }
        return json{
            {"bestmove", top["bestmove"]},
            {"san", top["san"]},
            {"eval", ev},
            {"pv", pv},
            {"depth", dep},
            {"lines", lines},
            {"opening", openingResp},
        };
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

// The opening explorer's move list: the current line's opening name plus the
// top-N moves, each with an eval, a PV, and the opening it leads to. Same ONE
// MultiPV search and the same book-first rule as /bestmove's `lines` (see
// analysis_lines) — the two endpoints must agree on line 1, they are two views
// of the same analysis. The response schema is frozen (`{opening, moves:
// [{uci, san, eval, pv, depth, opening}]}`): the opening explorer plus the
// BotGame and Engine-vs-Engine panels all consume it.
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

    Search::Limits lim;
    lim.depth = depth;
    lim.movetime = movetimeMs;
    std::vector<AnalysisLine> cands = analysis_lines(group, pos, lim, multipv > 0 ? multipv : 12);

    // Line up to and including the current position, reused to name the
    // opening EACH candidate move leads to (deepest match including that
    // move) — mirrors gomachine's baseKeys in handleCandidates.
    std::vector<uint64_t> baseKeys = opening_key_line(historyFens, pos);

    json moves = json::array();
    for (const AnalysisLine& c : cands) {
        moves.push_back(json{
            {"uci", move_to_uci(c.move)},
            {"san", Rules::san(pos, c.move)},
            {"eval", c.evalObj},
            {"pv", c.pv},
            {"depth", c.depth},
            {"opening", line_opening_json(baseKeys, pos, c.move)}, // opening this move leads to (null if unnamed)
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

    // Stockfish reports a TABLEBASE verdict over UCI as `cp 20000 - plies` for a win
    // and `-20000 - plies` for a loss (TB_CP, ~/sf18-arm/src/uci.cpp:531-541), which is
    // the same defect as zugzwang's own raw VALUE_TB_WIN: a consumer dividing by 100
    // renders "+200.00". SF's own non-decisive cp is bounded well under this band (a
    // Score is only InternalUnits when !is_decisive), so |cp| >= SF_TB_CP_FLOOR is an
    // unambiguous TB tag. Normalize it onto the same {value, tb} shape eval_json emits
    // so the site's Stockfish and the site's own engine read identically.
    constexpr int SF_TB_CP_FLOOR = 19000; // < 20000 - MAX_PLY, > any real SF cp
    json evalObj;
    if (!res.hasScore) {
        evalObj = json{{"type", "cp"}, {"value", 0}};
    } else if (res.isMate) {
        evalObj = json{{"type", "mate"}, {"value", res.value}};
    } else if (std::abs(res.value) >= SF_TB_CP_FLOOR) {
        const bool win = res.value > 0;
        evalObj = json{{"type", "cp"}, {"value", win ? TB_EVAL_CP : -TB_EVAL_CP},
                       {"tb", win ? "win" : "loss"}};
    } else {
        evalObj = json{{"type", "cp"}, {"value", res.value}};
    }

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

    json evalObj = eval_json_parts(res.mate, res.score);
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

    json evalObj = eval_json_parts(res.mate, res.score);
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
                json evalObj = eval_json_parts(res.mate, res.score);
                out["eval"] = evalObj;
                out["bestmove"] = duck_result_move_string(res);
                out["bestSan"] = duck_san(stp, res.move, res.duck);
            }
        }
        positions.push_back(out);
    }

    return json{{"positions", positions}, {"count", positions.size()}};
}

// ==================== Antichess ====================
// Self-contained variant (src/antichess.{h,cpp}) — its own rules
// (forced-capture, inverted win condition, king-promotion), no pockets, no
// separate duck-square field: the FEN alone fully describes a position, so
// every handler below just parses `fen` fresh (STATELESS, no history kept
// between requests, mirrors Duck/Crazyhouse). Never touches Search::Context
// (no NNUE — antichess has its own real iterative-deepening negamax, see
// antichess.h's file doc).

namespace {

// Parses+validates `fen`, throwing the shared 400 ApiError on failure —
// mirrors duck_parse_or_throw/crazyhouse's zh_parse-plus-throw call sites.
AntichessState antichess_parse_or_throw(const std::string& fen) {
    AntichessState s;
    std::string err;
    if (!antichess_parse(fen, s, err)) throw ApiError{400, err};
    return s;
}

// Parses a UCI move string and validates it against `s`'s legal moves,
// recovering the ep flag — mirrors zh_parse_and_validate/duck's analogous
// two-step (parse, then match against the generated legal list).
bool antichess_parse_and_validate(const AntichessState& s, const std::string& moveStr, AntichessMove& out) {
    AntichessMove parsed;
    if (!antichess_parse_uci(moveStr, parsed)) return false;
    return antichess_find_legal(s, parsed, out);
}

// Merges position/status fields into a response object — stamps newFen,
// sideToMove, status and result. Mirrors duck_result_json/zh_result_json;
// antichess has no pocket/duck-square field to add on top.
json antichess_result_json(json base, const AntichessState& s) {
    AntichessStatus st = antichess_status(s);
    base["newFen"] = s.fen();
    base["sideToMove"] = s.side == WHITE ? "w" : "b";
    base["status"] = antichess_status_name(st);
    std::string res = antichess_status_result(st);
    base["result"] = res.empty() ? json(nullptr) : json(res);
    return base;
}

AntichessLimits antichess_limits_from_json(const json& limits) {
    AntichessLimits lim = antichess_default_limits();
    if (jhas(limits, "rating")) lim.rating = limits["rating"].get<int>();
    if (jhas(limits, "level")) lim.level = limits["level"].get<int>();
    lim.depth = limits.value("depth", 0);
    lim.nodes = static_cast<uint64_t>(limits.value("nodes", static_cast<int64_t>(0)));
    lim.movetimeMs = limits.value("movetime", 0);
    return lim;
}

constexpr int kAntichessAnalyzeDefaultMoveTime = 250;
constexpr int kAntichessAnalyzeMaxMoveTime = 3000;
constexpr int kAntichessAnalyzeMaxMoves = 600;

} // namespace

// Legal moves (UCI, incl. king-promotion "k") for the side to move — the
// compulsory-capture filter already applied inside ::antichess_legal_moves
// (called via an explicit `::` qualifier: antichess.h's free function has the
// exact same name as this handler, so an unqualified call from inside this
// function's own body would otherwise resolve to itself — see
// serve_handlers.h's doc comment on this handler).
json antichess_legal_moves(const json& body) {
    std::string fen = body.value("fen", "");
    AntichessState s = antichess_parse_or_throw(fen);
    return json{{"moves", ::antichess_legal_moves(s)}};
}

// Validates and applies a single move, returning the resulting position and
// its terminal status. An illegal or malformed move throws a 400 ApiError
// (caught centrally by serve.cpp's wrap()) rather than returning a
// legal:false 200 — antichess.h's own antichess_apply documents exactly this
// "throws ApiError on illegal" contract; this handler reimplements it in two
// steps (rather than calling antichess_apply directly) purely to get the SAN
// string from the PRE-move state.
json antichess_move(const json& body) {
    std::string fen = body.value("fen", "");
    std::string moveStr = body.value("move", "");
    AntichessState s = antichess_parse_or_throw(fen);

    AntichessMove m;
    if (!antichess_parse_and_validate(s, moveStr, m)) {
        throw ApiError{400, "illegal move: " + moveStr};
    }
    std::string sanStr = antichess_san(s, m); // computed BEFORE mutating s
    AntichessState ns = antichess_do_move(s, m);
    return antichess_result_json(json{{"legal", true}, {"san", sanStr}}, ns);
}

// Searches for and APPLIES the bot's best move, honoring rating/level
// weakening exactly like duck_bestmove/crazyhouse_best_move. No `history` in
// the request (mirrors those two endpoints) — a single-shot call has no game
// history to thread through repetition detection.
json antichess_bestmove(const json& body) {
    std::string fen = body.value("fen", "");
    AntichessState s = antichess_parse_or_throw(fen);
    AntichessLimits lim = antichess_limits_from_json(body.value("limits", json::object()));

    AntichessResult res = ::antichess_best_move(s, lim);
    if (!res.hasMove) {
        return antichess_result_json(
            json{{"bestmove", nullptr}, {"san", nullptr}, {"eval", nullptr}, {"reason", "no legal moves"}}, s);
    }

    std::string sanStr = antichess_san(s, res.move); // computed BEFORE mutating s
    AntichessState ns = antichess_do_move(s, res.move);

    json evalObj = eval_json_parts(res.mate, res.score);
    return antichess_result_json(json{{"bestmove", res.move.uci()}, {"san", sanStr}, {"eval", evalObj}}, ns);
}

// Replays `moves` from the standard antichess start (games always start
// there — no [startFen] field, mirrors duck_analyze_game's no-startFen
// rationale) and evaluates every resulting position at FULL strength
// (ignores rating — antichess_default_limits() leaves level at -1/unset),
// bounded by `movetime` ms per position. Sequential, single-threaded per
// request; same JSON shape convention as duck_analyze_game, but antichess has
// its own {white_win,black_win,draw,ongoing} status/result vocabulary instead
// of duck's checkmate/stalemate split (see antichess_status_name's doc), so
// each entry reports `result` directly instead of separate checkmate/
// stalemate booleans.
//
// Response: { positions: [ {ply, fen, sideToMove, eval|null, bestmove|null,
// bestSan|null, terminal, result|null} ], count }
json antichess_analyze_game(const json& body) {
    std::vector<std::string> moves = json_str_vec(body.value("moves", json::array()));
    if (moves.size() > static_cast<size_t>(kAntichessAnalyzeMaxMoves)) throw ApiError{400, "too many moves"};

    int movetimeMs = body.value("movetime", 0);
    if (movetimeMs <= 0) movetimeMs = kAntichessAnalyzeDefaultMoveTime;
    if (movetimeMs > kAntichessAnalyzeMaxMoveTime) movetimeMs = kAntichessAnalyzeMaxMoveTime;

    // Replay sequentially, snapshotting one AntichessState per position
    // (moves.size()+1): index i is the position after i moves (index 0 is
    // the start).
    AntichessState s = antichess_parse_or_throw(ANTICHESS_START_FEN);
    std::vector<AntichessState> states;
    states.reserve(moves.size() + 1);
    states.push_back(s);
    for (const std::string& uci : moves) {
        AntichessMove m;
        if (!antichess_parse_and_validate(s, uci, m)) {
            throw ApiError{400, "illegal move in sequence: " + uci};
        }
        s = antichess_do_move(s, m);
        states.push_back(s);
    }

    // `history` accumulates PRIOR position keys only (never the current
    // state's own key — antichess_status/antichess_best_move already count
    // `s.key()` itself internally, see antichess.h's doc on both), appended
    // AFTER each position is analyzed so it's correct for the next ply.
    std::vector<uint64_t> history;
    history.reserve(states.size());

    json positions = json::array();
    for (size_t i = 0; i < states.size(); i++) {
        const AntichessState& sp = states[i];
        AntichessStatus status = antichess_status(sp, history);
        bool terminal = status != AntichessStatus::Ongoing;
        std::string res = antichess_status_result(status);

        json out = {
            {"ply", i},
            {"fen", sp.fen()},
            {"sideToMove", sp.side == WHITE ? "w" : "b"},
            {"eval", nullptr},
            {"bestmove", nullptr},
            {"bestSan", nullptr},
            {"terminal", terminal},
            {"result", res.empty() ? json(nullptr) : json(res)},
        };

        if (!terminal) {
            AntichessLimits lim = antichess_default_limits(); // level -1 => no rating/level => full strength
            lim.movetimeMs = movetimeMs;
            AntichessResult r = ::antichess_best_move(sp, lim, history);
            if (r.hasMove) {
                json evalObj = eval_json_parts(r.mate, r.score);
                out["eval"] = evalObj;
                out["bestmove"] = r.move.uci();
                out["bestSan"] = antichess_san(sp, r.move);
            }
        }
        positions.push_back(out);
        history.push_back(sp.key());
    }

    return json{{"positions", positions}, {"count", positions.size()}};
}

// ==================== Secret Queen ====================
// Self-contained variant (src/secretqueen.{h,cpp}) with a bot that reuses the
// real search (src/secretqueen_bot.{h,cpp}). Stateless: the canonical FEN's
// trailing "[e2|h7]" field carries the hidden queens, so every handler parses
// `fen` fresh like Duck/Crazyhouse/Antichess.
//
// THE ONE THING TO GET RIGHT: these responses carry a canonical FEN that names
// both secrets, and three redacted views. The caller forwards ONE view per
// recipient and never the canonical one. See serve_handlers.h's doc block and
// ../docs/tasks/open/secret-queen.md.
//
// As with antichess, this module's own free functions share names with these
// handlers, so calls to them are written with an explicit leading `::`.

namespace {

SecretQueenState secretqueen_parse_or_throw(const std::string& fen) {
    SecretQueenState s;
    std::string err;
    if (!::secretqueen_parse(fen, s, err)) throw ApiError{400, err};
    return s;
}

// Stamps the position onto a response: the canonical FEN plus every redacted
// view, so the caller never has to construct one (and so there is exactly one
// implementation of redaction, here in the engine that owns the rules).
json secretqueen_result_json(json base, const SecretQueenState& s) {
    SecretQueenStatus st = ::secretqueen_status(s);
    base["newFen"] = s.fen();           // canonical — names BOTH secrets, server only
    base["fenWhite"] = s.fenFor(WHITE); // safe to send to White
    base["fenBlack"] = s.fenFor(BLACK); // safe to send to Black
    base["boardFen"] = s.boardFen();    // safe to send to spectators
    base["sideToMove"] = s.side == WHITE ? "w" : "b";
    base["status"] = ::secretqueen_status_name(st);
    std::string res = ::secretqueen_status_result(st);
    base["result"] = res.empty() ? json(nullptr) : json(res);
    base["kingCaptured"] = ::secretqueen_king_captured(s);
    return base;
}

json reveal_json(const SecretQueenReveal& r) {
    return json{
        {"moved", r.moved},
        {"captured", r.captured},
        {"promoted", r.promoted},
        {"square", r.square == SQ_NONE ? json(nullptr) : json(SQ_NAMES[r.square])},
    };
}

SecretQueenLimits secretqueen_limits_from_json(const json& limits) {
    SecretQueenLimits lim = secretqueen_default_limits();
    if (jhas(limits, "rating")) lim.rating = limits["rating"].get<int>();
    lim.depth = limits.value("depth", 0);
    lim.nodes = static_cast<uint64_t>(limits.value("nodes", static_cast<int64_t>(0)));
    lim.movetimeMs = limits.value("movetime", 0);
    return lim;
}

} // namespace

// Designates a side's secret queen, returning the new canonical FEN. Kept in the
// engine so the FEN's secret-field format has exactly one writer — a caller
// composing "[e2|h7]" by hand is a second implementation waiting to disagree.
//
// Body: { fen, color: "w"|"b", square: "e2" }
json secretqueen_designate(const json& body) {
    std::string fen = body.value("fen", "");
    std::string colorStr = body.value("color", "");
    std::string squareStr = body.value("square", "");

    SecretQueenState s = secretqueen_parse_or_throw(fen);
    if (colorStr != "w" && colorStr != "b") throw ApiError{400, "color must be \"w\" or \"b\""};
    Color c = (colorStr == "w") ? WHITE : BLACK;

    Square sq = Rules::parse_square(squareStr);
    if (sq == SQ_NONE) throw ApiError{400, "invalid square: " + squareStr};

    std::string err;
    if (!::secretqueen_designate(s, c, sq, err)) throw ApiError{400, err};
    return secretqueen_result_json(json{{"designated", SQ_NAMES[sq]}}, s);
}

// Legal moves for the side to move, in ITS OWN information set (its hidden queen
// moves like a queen; the opponent's is just a pawn). Safe to hand to that
// player and to nobody else — the list names queen moves from their secret
// square.
json secretqueen_legal_moves(const json& body) {
    std::string fen = body.value("fen", "");
    SecretQueenState s = secretqueen_parse_or_throw(fen);
    return json{{"moves", ::secretqueen_legal_moves(s)}};
}

// Validates and applies one move. An illegal move throws a 400 (mirrors
// antichess_move rather than duck_move's legal:false 200). `reveal` reports what
// the move unmasked, so the caller can narrate it.
json secretqueen_move(const json& body) {
    std::string fen = body.value("fen", "");
    std::string moveStr = body.value("move", "");
    SecretQueenState s = secretqueen_parse_or_throw(fen);

    SecretQueenMove parsed, m;
    if (!::secretqueen_parse_uci(moveStr, parsed) || !::secretqueen_find_legal(s, parsed, m)) {
        throw ApiError{400, "illegal move: " + moveStr};
    }
    std::string sanStr = ::secretqueen_san(s, m); // computed BEFORE mutating s

    bool capturedKing = false;
    SecretQueenReveal reveal;
    SecretQueenState ns = ::secretqueen_do_move(s, m, capturedKing, reveal);
    return secretqueen_result_json(json{{"legal", true}, {"san", sanStr}, {"reveal", reveal_json(reveal)}}, ns);
}

// Searches for and APPLIES the bot's move, honoring rating weakening. Unlike the
// other variants' bestmove handlers this one runs the real NNUE search (see
// secretqueen_bot.h for why that is sound here), so it leases a pool Context —
// which happens inside secretqueen_best_move.
json secretqueen_bestmove(const json& body) {
    std::string fen = body.value("fen", "");
    SecretQueenState s = secretqueen_parse_or_throw(fen);
    SecretQueenLimits lim = secretqueen_limits_from_json(body.value("limits", json::object()));

    SecretQueenResult res = ::secretqueen_best_move(s, lim);
    if (!res.hasMove) {
        return secretqueen_result_json(
            json{{"bestmove", nullptr}, {"san", nullptr}, {"eval", nullptr}, {"reason", "no legal moves"}}, s);
    }

    std::string sanStr = ::secretqueen_san(s, res.move); // computed BEFORE mutating s
    bool capturedKing = false;
    SecretQueenReveal reveal;
    SecretQueenState ns = ::secretqueen_do_move(s, res.move, capturedKing, reveal);

    json evalObj = eval_json_parts(res.mate, res.score);
    return secretqueen_result_json(
        json{{"bestmove", res.move.uci()}, {"san", sanStr}, {"eval", evalObj}, {"reveal", reveal_json(reveal)}}, ns);
}

} // namespace Handlers
