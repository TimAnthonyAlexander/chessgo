// WASM entry point: exposes the UCI engine to JS as three C functions, meant
// to run inside a Web Worker (no cross-origin isolation / SharedArrayBuffer
// required — this is a deliberately SINGLE-THREADED build, see uci.cpp's
// __EMSCRIPTEN__ branch in go_cmd and Makefile.wasm). The JS side speaks
// plain UCI text, the same protocol Lichess's protocol.ts speaks to
// Stockfish — this file is the thin C shim between that JS driver and the
// engine's existing uci_init()/uci_command() (src/uci.cpp, src/uci.h).
//
//   zug_init()                     — one-time engine startup (safe to call
//                                     more than once; only the first call
//                                     does anything).
//   zug_load_net(ptr, len)         — load the pre-quantized net
//                                     (net.web.nnue bytes, fetched by JS and
//                                     copied into the wasm heap by the
//                                     caller) via NNUE::load_from_memory.
//                                     Returns 1 on success, 0 on failure
//                                     (bad magic/checksum/arch mismatch —
//                                     see nnue_web_format.h). Safe to call
//                                     before or after zug_init().
//   zug_command(line)              — feed ONE UCI command line in. All
//                                     engine output (info/bestmove/id/
//                                     option/... lines, plus the "info
//                                     string invalid fen"/"illegal position"
//                                     rejections from uci.cpp's FEN gate)
//                                     comes back through std::cout, which
//                                     Emscripten's runtime routes to the
//                                     `print` callback the JS caller passed
//                                     into the module factory (Module({
//                                     print: line => ... }))  — std::endl
//                                     flushes after every UCI line, so this
//                                     is synchronous and line-buffered, no
//                                     custom streambuf needed.
//
// Blocking is intentional: `go` now runs the search inline on the calling
// thread (uci.cpp), so zug_command("go ...") does not return until the
// search completes. That is correct here because this whole module lives in
// a Worker — the JS side just gets a message back when postMessage-driven
// glue code calls zug_command and it returns.
#include <emscripten.h>
#include <cstdint>
#include <cstddef>
#include <string>

#include "uci.h"
#include "nnue.h"

extern "C" {

EMSCRIPTEN_KEEPALIVE
void zug_init() {
    static bool done = false;
    if (done) return;
    uci_init();
    done = true;
}

EMSCRIPTEN_KEEPALIVE
int zug_load_net(const uint8_t* data, int len) {
    if (!data || len <= 0) return 0;
    return NNUE::load_from_memory(data, static_cast<std::size_t>(len)) ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE
void zug_command(const char* line) {
    zug_init(); // idempotent; covers a caller that forgets the explicit init call
    uci_command(line ? std::string(line) : std::string());
}

} // extern "C"
