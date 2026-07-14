// Top-level entry point: dispatches between the UCI CLI (default, no args —
// SPRTs / fastchess / EvE-UCI all rely on bare `./zugzwang` speaking UCI on
// stdin/stdout) and the HTTP `serve` subcommand (`./zugzwang serve [-addr
// host:port]`, WIRING_RECON.md Wave 1) that mirrors gomachine's stateless
// engine API for the website.
#include "uci.h"
#include "serve.h"
#include "crazyhouse.h"
#include <string>

int main(int argc, char** argv) {
    if (argc > 1 && std::string(argv[1]) == "serve") {
        return serve_main(argc, argv);
    }
    // `./zugzwang zhperft <fen> <depth> [divide]` — Crazyhouse perft, a
    // standalone validation tool (not part of UCI/serve); see crazyhouse.h.
    if (argc > 1 && std::string(argv[1]) == "zhperft") {
        return zh_perft_main(argc, argv);
    }
    return uci_main();
}
