#pragma once
#include "position.h"

// Public NNUE interface. Mirrors gomachine's eval contract exactly: evaluate()
// returns a SIDE-TO-MOVE-RELATIVE centipawn score, identical to the HCE it
// replaces — so it drops into Eval::evaluate with zero sign juggling.
namespace NNUE {

bool load(const char* path);         // parse the bullet float32 net; false on failure
bool loaded();                       // true once a net is installed
int  evaluate(const Position& pos);  // stm-relative centipawns (from-scratch forward)

} // namespace NNUE
