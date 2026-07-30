#pragma once
// Endpoint handlers for zugzwang's HTTP serve mode — mirror gomachine's
// internal/server handlers field-for-field (WIRING_RECON.md §A). Each takes
// the decoded JSON request body and returns the JSON response body; errors
// are reported by throwing ApiError (serve_json.h), caught centrally by
// serve.cpp's route wrapper.
#include "serve_json.h"

namespace Handlers {

// Rules-only endpoints (no Search:: state at all — safe to run fully
// concurrently with each other and with the search endpoints below; NOT
// gated on the search-context pool).
json move(const json& body);
json legal_moves(const json& body);
json status(const json& body);
json perft(const json& body);
// Search-free opening NAME/ECO classification: a pure book-key table lookup
// over `fen` + optional `history` (root->previous, same convention as
// /analyze and /candidates). Exists so a PHP-side /analyze eval-cache hit can
// still resolve the path-dependent opening name without paying for a full
// search — see opening_key_line/opening_json in serve_handlers.cpp, which
// this handler is just those two calls around parse_legal_or_throw.
json opening(const json& body);
// Search-free book probe: a pure Book::lookup() by book_key(fen), no search,
// no Search::Context. Exists so the PHP analysis board's `cacheOnly` mode
// (local-engine-in-browser users; AnalyzeController::resolveAnalysis) can
// still get the book's ~100-Elo-over-search move on a cache miss without
// paying for a full search — see serve_handlers.cpp, which wraps
// parse_legal_or_throw + Book::shared().lookup + Rules::parse_uci_move.
json book(const json& body);

// Search-backed endpoints. Each leases an independent Search::SearchGroup from
// the pool (Search::GroupLease, search.h/.cpp) for the duration of its search.
// A group is K worker Contexts sharing one TT + stop flag: the search fans out
// across them (Lazy SMP, K = -search-threads) via Search::start_group, so a
// single request gets the multi-thread search strength. Up to `-search-pool`
// (G) groups run concurrently (peak G*K threads), each with its own
// TT/history/corrhist/NNUE-accumulator state. A lease blocks (briefly) only
// when every group is busy, and never blocks the rules-only handlers above
// (they never touch the pool). The rating-weakening path runs single-threaded
// on the group's primary Context (weaker-by-design, no SMP benefit).
json best_move(const json& body);
json candidates(const json& body);
json analyze_game(const json& body);

// Stockfish proxy: spawns a fresh `stockfish` subprocess per call (sf_uci.h)
// and drives it over UCI. It touches NO Search:: state (the SF process does
// its own search out-of-process), so it never leases a pool context and can
// run fully concurrently with /bestmove, /candidates, /analyze-game, and
// with itself.
json sf_best_move(const json& body);

// Crazyhouse: a self-contained variant (src/crazyhouse.h) with its own rules
// + bot search; it never touches the standard Search::Context pool (no NNUE,
// its own shallow negamax), so these never lease a pool context either. Every
// request is stateless: the Crazyhouse FEN is self-describing (it carries the
// [pocket]) — mirrors gomachine's internal/server/crazyhouse.go handlers
// field-for-field.
json crazyhouse_legal_moves(const json& body);
json crazyhouse_move(const json& body);
json crazyhouse_best_move(const json& body);

// Duck Chess: a self-contained variant (src/duck.h) with its own rules + hand
// eval + shallow bot search; it never touches the standard Search::Context
// pool (no NNUE, no Position) so these never lease a pool context either.
// Every request is stateless: the piece board comes from `fen`, the duck's
// square from a separate `duck` field (mirrors gomachine's
// internal/server/duck.go handlers field-for-field).
json duck_legal_moves(const json& body);
json duck_move(const json& body);
// Named duck_bestmove (not duck_best_move) to avoid colliding with the
// module's own ::duck_best_move(DuckState,DuckLimits) — unqualified lookup
// inside namespace Handlers would otherwise resolve to this handler's own
// name first and never see the outer free function.
json duck_bestmove(const json& body);
json duck_analyze_game(const json& body);

// Antichess: a self-contained variant (src/antichess.h) with its own rules
// (forced-capture, inverted win condition, king-promotion) + its own real
// iterative-deepening search; it never touches the standard Search::Context
// pool (no NNUE, no Position) so these never lease a pool context either.
// Every request is stateless: the antichess FEN is fully self-describing (no
// pockets, no separate duck-square field, unlike Crazyhouse/Duck) — mirrors
// gomachine's forthcoming internal/server/antichess.go handlers field-for-field.
// Unlike duck_bestmove (renamed to dodge a collision), antichess.h's own
// antichess_legal_moves/antichess_best_move free functions are called from
// inside these handlers with an explicit leading `::` (global-scope
// qualifier) rather than renaming the handlers themselves — same problem
// (unqualified lookup from inside Handlers::antichess_legal_moves would
// otherwise resolve to itself), different fix.
json antichess_legal_moves(const json& body);
json antichess_move(const json& body);
json antichess_bestmove(const json& body);
json antichess_analyze_game(const json& body);

} // namespace Handlers
