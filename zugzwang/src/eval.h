#pragma once
#include "position.h"

namespace Eval {
void init();
int evaluate(const Position& pos); // returns score relative to side-to-move
}
