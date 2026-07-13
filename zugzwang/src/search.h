#pragma once
#include "position.h"
#include "move.h"
#include <atomic>
#include <cstdint>

namespace Search {

struct Limits {
    int time[COLOR_NB] = {0, 0};
    int inc[COLOR_NB] = {0, 0};
    int movestogo = 0;
    int depth = 0;
    int movetime = 0;
    int64_t nodes = 0;
    bool infinite = false;
    int64_t startTime = 0;
};

extern std::atomic<bool> Stop;

void init();
void clear();                 // clear history/killers/TT for a new game
void start(Position& pos, const Limits& limits);
int64_t now_ms();

} // namespace Search
