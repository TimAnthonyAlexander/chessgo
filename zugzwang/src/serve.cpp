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
#include "tt.h"
#include "zobrist.h"

#include <cstdio>
#include <functional>
#include <iostream>
#include <string>

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

// Routes intentionally NOT implemented this wave (WIRING_RECON.md Wave 1
// scope): Stockfish stays owned by gomachine (zugzwang doesn't spawn an SF
// process), and the Duck/Crazyhouse variant engines are Wave 3. 501, not 404,
// so a caller can tell "route exists on the contract, deliberately unbuilt
// here" apart from a plain typo'd path.
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
    for (int i = 2; i < argc; ++i) {
        std::string a = argv[i];
        if (a == "-addr" && i + 1 < argc) addr = argv[++i];
        else if (a == "-tt" && i + 1 < argc) ttSizeMB = std::stoi(argv[++i]);
    }

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
    TT.resize(static_cast<size_t>(ttSizeMB));

    // Force Position's one-time lazy static init (castling tables) to happen
    // here, single-threaded, before httplib's worker threads can race it on
    // their first concurrent /move-family request.
    {
        Position warm;
        warm.set("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
    }

    httplib::Server svr;

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

    register_not_implemented(svr, "/sf-bestmove",
        "stockfish is owned by gomachine (zugzwang does not spawn a Stockfish process) — "
        "route Stockfish traffic to gomachine's /sf-bestmove");
    register_not_implemented(svr, "/duck/legal-moves", "Duck Chess is Wave 3 (not yet implemented in zugzwang)");
    register_not_implemented(svr, "/duck/move", "Duck Chess is Wave 3 (not yet implemented in zugzwang)");
    register_not_implemented(svr, "/duck/bestmove", "Duck Chess is Wave 3 (not yet implemented in zugzwang)");
    register_not_implemented(svr, "/duck/analyze-game", "Duck Chess is Wave 3 (not yet implemented in zugzwang)");
    register_not_implemented(svr, "/crazyhouse/legal-moves", "Crazyhouse is Wave 3 (not yet implemented in zugzwang)");
    register_not_implemented(svr, "/crazyhouse/move", "Crazyhouse is Wave 3 (not yet implemented in zugzwang)");
    register_not_implemented(svr, "/crazyhouse/bestmove", "Crazyhouse is Wave 3 (not yet implemented in zugzwang)");

    std::cerr << "zugzwang serve: listening on " << host << ":" << port
              << " (TT " << ttSizeMB << "MB)\n";
    if (!svr.listen(host, port)) {
        std::cerr << "serve: failed to bind " << host << ":" << port << "\n";
        return 1;
    }
    return 0;
}
