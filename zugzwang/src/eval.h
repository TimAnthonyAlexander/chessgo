#pragma once
#include "position.h"

namespace Eval {
void init();
int evaluate(const Position& pos); // returns score relative to side-to-move

// HCEBLEND root-gate: called once per search at the root. The HCE-resolution blend
// (see eval.cpp) only engages when the ROOT position — the one we're choosing a move
// for — is clearly losing, NOT at the many transiently-losing NODES a normal search
// tree contains. So a non-lost search is byte-identical to no-blend (zero regression),
// while a genuinely lost search gets the resistance resolution throughout. Thread-local
// (each Lazy-SMP worker sets its own from its root copy). No-op unless HCEBLEND is on.
void begin_search(const Position& rootPos);
}
