// Link stubs for the Secret Queen rules gate (test/secretqueen_test.cpp).
//
// The test links src/rules.cpp (for Rules::parse_square) and src/duck.cpp (the
// cross-check reference), which drag in Position::do_move and duck's search
// respectively. Neither the NNUE accumulator nor a clock is used by anything the
// test asserts — this is a pure rules/movegen gate — so stubbing them keeps the
// test independent of the net file and of the whole search TU.
//
// If a future assertion needs a real eval or a real clock, delete the relevant
// stub and link the real object instead; the link error will say which.
#include "../src/nnue_accumulator.h"
#include "../src/search.h"

namespace NNUE {
bool threat_delta_enabled() { return false; }
void AccStack::push(const Position&) {}
void AccStack::push_delta(const BoardSnapshot&, const Position&) {}
void AccStack::pushNull() {}
} // namespace NNUE

namespace Search {
int64_t now_ms() { return 0; }
} // namespace Search
