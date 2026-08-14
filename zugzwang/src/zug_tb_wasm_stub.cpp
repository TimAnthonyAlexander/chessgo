// WASM-only stand-in for src/zug_tb.cpp. The real implementation wraps Fathom
// (src/syzygy/tbprobe.cpp) to probe Syzygy endgame tablebases off disk — but
// there is no filesystem in the browser to point it at, and the wasm build
// deliberately excludes the syzygy sources entirely (Makefile.wasm), so
// nothing in this build ever links Fathom. search.cpp still calls
// TB::loaded()/probe_wdl()/rank_root_moves() unconditionally (gated at RUNTIME by
// `C.tune.syzygy && TB::loaded()`), so those symbols must exist for the link
// to succeed — this file supplies them as permanent no-ops: TB::loaded() is
// always false, so every TB::-gated branch in search.cpp is dead code at
// runtime, exactly like a native run with no syzygy/ directory present
// (see zug_tb.cpp's own doc comments — this is the same "not loaded" steady
// state, just decided at compile time instead of by a failed tb_init()).
#include "zug_tb.h"

namespace TB {

bool init(const char*) { return false; }
bool loaded() { return false; }
unsigned max_pieces() { return 0; }
bool probe_wdl(const Position&, int&) { return false; }
bool rank_root_moves(Position&, bool, bool, std::vector<RootRank>& out) {
    out.clear();
    return false;  // "not ranked" — start() falls straight through to the ordinary search
}

}  // namespace TB
