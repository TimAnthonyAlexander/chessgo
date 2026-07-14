// HTTP `serve` subcommand: mirrors gomachine's stateless internal/server API
// (WIRING_RECON.md §A) over cpp-httplib + nlohmann/json, wrapping zugzwang's
// existing rules core (Rules::) and search (Search::/Rating::). Every
// handler rebuilds a Position from the request's `fen` per call — no
// per-request/game state is kept here, matching gomachine's "stateless
// localhost HTTP/JSON API" contract exactly.
#include "serve.h"
#include "serve_handlers.h"
#include "vendor/httplib.h"

#include "bitboard.h"
#include "eval.h"
#include "nnue.h"
#include "position.h"
#include "search.h"
#include "sf_uci.h"
#include "tt.h"
#include "zobrist.h"

#include <algorithm>
#include <cstdio>
#include <functional>
#include <iostream>
#include <string>
#include <thread>

namespace {

using RouteFn = std::function<json(const json&)>;

// Wraps a Handlers:: function into an httplib handler: decodes the JSON
// body, dispatches, and encodes the result — translating ApiError into the
// matching HTTP status + {"error":...} body, and any other exception into a
// 500 "internal engine error" (mirrors server.recoverPanics: a Go panic
// inside a handler becomes a clean 500 instead of a dropped connection; here
// an uncaught C++ exception gets the same treatment instead of crashing the
// process).
httplib::Server::Handler wrap(RouteFn fn) {
    return [fn](const httplib::Request& req, httplib::Response& res) {
        res.set_header("Content-Type", "application/json");
        json body = json::parse(req.body, /*cb=*/nullptr, /*allow_exceptions=*/false);
        if (body.is_discarded()) {
            res.status = 400;
            res.set_content(json{{"error", "invalid JSON: parse error"}}.dump(), "application/json");
            return;
        }
        try {
            res.set_content(fn(body).dump(), "application/json");
        } catch (const ApiError& e) {
            res.status = e.code;
            res.set_content(json{{"error", e.message}}.dump(), "application/json");
        } catch (const std::exception&) {
            res.status = 500;
            res.set_content(json{{"error", "internal engine error"}}.dump(), "application/json");
        } catch (...) {
            res.status = 500;
            res.set_content(json{{"error", "internal engine error"}}.dump(), "application/json");
        }
    };
}

// Routes intentionally NOT implemented yet (WIRING_RECON.md Wave 3 scope):
// Duck Chess (Crazyhouse shipped — see the /crazyhouse/* routes below).
// 501, not 404, so a caller can tell "route exists on the contract,
// deliberately unbuilt here" apart from a plain typo'd path.
void register_not_implemented(httplib::Server& svr, const char* path, const char* why) {
    auto handler = [why](const httplib::Request&, httplib::Response& res) {
        res.status = 501;
        res.set_content(json{{"error", std::string(why)}}.dump(), "application/json");
    };
    svr.Post(path, handler);
}

bool split_host_port(const std::string& addr, std::string& host, int& port) {
    size_t colon = addr.rfind(':');
    if (colon == std::string::npos) return false;
    host = addr.substr(0, colon);
    try {
        port = std::stoi(addr.substr(colon + 1));
    } catch (...) {
        return false;
    }
    return true;
}

} // namespace

int serve_main(int argc, char** argv) {
    // Distinct DEFAULT port from gomachine's 6466 (WIRING_RECON.md Wave 1
    // checklist) — the two can run side by side on one host. -addr overrides.
    std::string addr = "127.0.0.1:6476";
    int ttSizeMB = 128;
    // -search-pool N: how many searches can run genuinely concurrently (each
    // with its own Search::Context — TT, history/corrhist tables, NNUE
    // accumulator; see search.h). Default mirrors gomachine's per-request
    // engine pool sizing: min(hardware_concurrency, 6). -tt's total is split
    // evenly across the pool (floor 8MB/context) rather than each context
    // getting the full -tt size, so `-tt 128` doesn't balloon into
    // `128 * poolSize` MB resident.
    int searchPoolSize = static_cast<int>(std::min(6u, std::max(1u, std::thread::hardware_concurrency())));
    std::string sfPath; // -sf-path override for SFUCI::resolve_path() (empty = env/PATH/fallbacks)
    for (int i = 2; i < argc; ++i) {
        std::string a = argv[i];
        if (a == "-addr" && i + 1 < argc) addr = argv[++i];
        else if (a == "-tt" && i + 1 < argc) ttSizeMB = std::stoi(argv[++i]);
        else if (a == "-search-pool" && i + 1 < argc) searchPoolSize = std::stoi(argv[++i]);
        else if (a == "-sf-path" && i + 1 < argc) sfPath = argv[++i];
    }
    if (searchPoolSize < 1) searchPoolSize = 1;
    SFUCI::set_path_override(sfPath);

    std::string host;
    int port;
    if (!split_host_port(addr, host, port)) {
        std::cerr << "serve: -addr must be host:port (got \"" << addr << "\")\n";
        return 1;
    }

    BB::init();
    Zobrist::init();
    Eval::init();
    Search::init();
    if (NNUE::load("net.nnue")) {
        std::cerr << "NNUE: loaded net.nnue\n";
    } else {
        std::cerr << "NNUE: net.nnue absent — using HCE\n";
    }
    // default_context()'s TT (used only by the legacy 2-arg Search::start(),
    // which nothing in `serve` mode calls — every search-backed handler leases
    // a pool Context instead) — resized mainly so it's never left as an
    // unresized (unusable) table if anything ever falls back to it.
    TT.resize(static_cast<size_t>(ttSizeMB));

    // The concurrency pool: N independent Search::Contexts, each with its own
    // TT (total -tt split evenly, floor 8MB) — this is what actually serves
    // /bestmove, /candidates, /analyze-game concurrently (search.h's
    // Context/ContextLease doc comments have the full story).
    size_t ttPerContextMB = std::max<size_t>(8, static_cast<size_t>(ttSizeMB) / static_cast<size_t>(searchPoolSize));
    Search::init_pool(searchPoolSize, ttPerContextMB);

    if (std::string sfFound = SFUCI::resolve_path(); !sfFound.empty()) {
        std::cerr << "stockfish: found at " << sfFound << "\n";
    } else {
        std::cerr << "stockfish: not found (set -sf-path / SF_PATH / STOCKFISH_PATH, "
                      "or install to PATH) — /sf-bestmove will 503\n";
    }

    // Force Position's one-time lazy static init (castling tables) to happen
    // here, single-threaded, before httplib's worker threads can race it on
    // their first concurrent /move-family request.
    {
        Position warm;
        warm.set("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
    }

    httplib::Server svr;

    // httplib's own worker-thread pool is shared across EVERY route (there is
    // no per-route pool). A search handler that's blocked inside
    // Search::ContextLease waiting for a free pool Context still occupies one
    // of these worker threads for the whole wait — so if this pool were left
    // at httplib's default (~hardware_concurrency, i.e. comparable to
    // searchPoolSize), a burst of concurrent search requests could saturate
    // every httplib worker thread (some searching, the rest just blocked
    // waiting their turn on the pool) and starve /move, /legal-moves,
    // /status, /perft, /healthz, and even new connections entirely — exactly
    // the "rules-only handlers must stay fully concurrent, never gated on the
    // pool" requirement this file's routes below promise. Size it generously
    // (independent of searchPoolSize) so there are always plenty of threads
    // free for rules-only work no matter how many search requests are queued
    // up waiting on the (much smaller) search-context pool.
    constexpr size_t kHttpThreads = 128;
    svr.new_task_queue = [] { return new httplib::ThreadPool(kHttpThreads); };

    svr.Get("/healthz", [](const httplib::Request&, httplib::Response& res) {
        res.set_content(json{{"status", "ok"}}.dump(), "application/json");
    });

    svr.Post("/move", wrap(Handlers::move));
    svr.Post("/legal-moves", wrap(Handlers::legal_moves));
    svr.Post("/status", wrap(Handlers::status));
    svr.Post("/perft", wrap(Handlers::perft));
    svr.Post("/bestmove", wrap(Handlers::best_move));
    svr.Post("/candidates", wrap(Handlers::candidates));
    svr.Post("/analyze-game", wrap(Handlers::analyze_game));
    svr.Post("/sf-bestmove", wrap(Handlers::sf_best_move));

    register_not_implemented(svr, "/duck/legal-moves", "Duck Chess is Wave 3 (not yet implemented in zugzwang)");
    register_not_implemented(svr, "/duck/move", "Duck Chess is Wave 3 (not yet implemented in zugzwang)");
    register_not_implemented(svr, "/duck/bestmove", "Duck Chess is Wave 3 (not yet implemented in zugzwang)");
    register_not_implemented(svr, "/duck/analyze-game", "Duck Chess is Wave 3 (not yet implemented in zugzwang)");

    // Crazyhouse: a self-contained variant module (src/crazyhouse.{h,cpp}) —
    // its own rules/pockets/drops/eval/search, no Search::Context pool
    // involvement (WIRING_RECON.md Wave 3).
    svr.Post("/crazyhouse/legal-moves", wrap(Handlers::crazyhouse_legal_moves));
    svr.Post("/crazyhouse/move", wrap(Handlers::crazyhouse_move));
    svr.Post("/crazyhouse/bestmove", wrap(Handlers::crazyhouse_best_move));

    std::cerr << "zugzwang serve: listening on " << host << ":" << port
              << " (TT " << ttSizeMB << "MB, search-pool " << searchPoolSize
              << "x" << ttPerContextMB << "MB)\n";
    if (!svr.listen(host, port)) {
        std::cerr << "serve: failed to bind " << host << ":" << port << "\n";
        return 1;
    }
    return 0;
}
