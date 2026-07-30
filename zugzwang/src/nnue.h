#pragma once
#include "position.h"
#include <cstdint>
#include <cstddef>

// Public NNUE interface. Mirrors gomachine's eval contract exactly: evaluate()
// returns a SIDE-TO-MOVE-RELATIVE centipawn score, identical to the HCE it
// replaces — so it drops into Eval::evaluate with zero sign juggling.
namespace NNUE {

bool load(const char* path);         // parse the bullet float32 net; false on failure
// WASM/no-filesystem entry point: load a pre-quantized "web format" net
// (nnue_web_format.h) straight from bytes JS handed in (there is no
// filesystem in the browser to fopen a path from). Same s_loaded bookkeeping
// as load() — NNUE::loaded() reflects whichever loader last ran.
bool load_from_memory(const std::uint8_t* data, std::size_t len);
bool loaded();                       // true once a net is installed
int  evaluate(const Position& pos);  // stm-relative centipawns (from-scratch forward)

} // namespace NNUE
