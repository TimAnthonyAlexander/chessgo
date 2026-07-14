#pragma once
// Endpoint handlers for zugzwang's HTTP serve mode — mirror gomachine's
// internal/server handlers field-for-field (WIRING_RECON.md §A). Each takes
// the decoded JSON request body and returns the JSON response body; errors
// are reported by throwing ApiError (serve_json.h), caught centrally by
// serve.cpp's route wrapper.
#include "serve_json.h"
#include <mutex>

namespace Handlers {

// Rules-only endpoints (no shared Search:: state — safe to run concurrently
// with each other and with the search endpoints below).
json move(const json& body);
json legal_moves(const json& body);
json status(const json& body);
json perft(const json& body);

// Search-backed endpoints. zugzwang's search module (search.cpp) is a set of
// global tables (TT, history/killer/corrhist heuristics, node counter) with
// NO per-call isolation — unlike gomachine's pool of independent *Engine
// values, there is exactly one shared search state. These three handlers
// serialize on search_mutex() for their whole duration (including the
// rating-weakening path's per-candidate sub-searches) so concurrent HTTP
// requests can't interleave and corrupt that shared state. The rules-only
// handlers above never touch it and stay fully concurrent.
json best_move(const json& body);
json candidates(const json& body);
json analyze_game(const json& body);

// The one global lock guarding every call into Search::start (directly or via
// Rating::). Defined in serve_handlers.cpp.
std::mutex& search_mutex();

// Stockfish proxy: spawns a fresh `stockfish` subprocess per call (sf_uci.h)
// and drives it over UCI. It touches NO shared Search:: state (the SF process
// does its own search out-of-process), so it never takes search_mutex() and
// can run fully concurrently with /bestmove, /candidates, /analyze-game, and
// with itself.
json sf_best_move(const json& body);

} // namespace Handlers
