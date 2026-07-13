#pragma once
#include "position.h"
#include "move.h"
#include <atomic>
#include <cstdint>
#include <string>

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

// UCI setoption hook for the 8 SPSA-tunable search margins (search.cpp's
// Tune struct). Returns false if `name` doesn't match a tune option.
bool set_tune_option(const std::string& name, int value);

} // namespace Search
