#pragma once
#include "position.h"
#include "move.h"
#include <atomic>
#include <cstdint>
#include <string>
#include <vector>

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
    // HTTP serve layer only: suppress the UCI "info"/"bestmove" stdout lines
    // (start() is reused verbatim by serve.cpp — the UCI loop still wants them,
    // the HTTP handlers read the result via `lastResult` instead).
    bool silent = false;
};

// Result of the most recently completed (or interrupted) iterative-deepening
// search — populated by start() every time it runs, from the last FULLY
// completed depth iteration (mirrors exactly what the UCI "info"/"bestmove"
// lines would have reported). Consumed by serve.cpp; the UCI path ignores it.
// score/pv use this engine's internal convention (VALUE_MATE-relative scores
// compose correctly across negation — see is_mate_score()/mate distance
// helpers in types.h); serve.cpp converts to the gomachine-shaped {type,value}
// eval object.
struct Result {
    Move bestMove = MOVE_NONE;
    int score = 0;
    int depth = 0;
    int64_t nodes = 0;
    std::vector<Move> pv;
};
extern Result lastResult;

extern std::atomic<bool> Stop;

void init();
void clear();                 // clear history/killers/TT for a new game
void start(Position& pos, const Limits& limits);
int64_t now_ms();

// UCI setoption hook for the 8 SPSA-tunable search margins (search.cpp's
// Tune struct). Returns false if `name` doesn't match a tune option.
bool set_tune_option(const std::string& name, int value);

} // namespace Search
