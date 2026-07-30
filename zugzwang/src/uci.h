#pragma once
#include <string>
// UCI CLI entry point (src/uci.cpp), invoked by main.cpp when no `serve`
// subcommand is given. Kept as a plain function (not renamed to `main`) so
// main.cpp can dispatch between this and serve_main (src/serve.h).
int uci_main();

// One-time engine startup (BB/Zobrist/Eval/Search init, TT resize, pos reset
// to startpos, and — native builds only — loading net.nnue/book.bin/syzygy
// off disk). Split out of uci_main() so the WASM entry point (src/wasm_main.cpp)
// can call it once before feeding commands, without pulling in uci_main()'s
// stdin loop (there is no stdin in a browser Worker).
void uci_init();

// Dispatches ONE UCI command line exactly as the uci_main() stdin loop used
// to inline — this IS that loop body, extracted verbatim so native behavior
// is unchanged. The WASM entry point calls this directly per command instead
// of going through std::cin. Returns false for "quit" (the old loop's break
// condition — there is no stdin loop to break out of anymore, so the signal
// is returned instead) and true otherwise; uci_main() stops reading stdin
// when it sees false. The wasm caller may ignore the return value (there is
// no stdin loop to stop — "quit" already ran stop_search() by the time this
// returns).
bool uci_command(const std::string& line);
