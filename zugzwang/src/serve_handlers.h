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

} // namespace Handlers
