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
    // the HTTP handlers read the returned Result instead).
    bool silent = false;
};

// Result of a completed (or interrupted) iterative-deepening search —
// returned by start() from the last FULLY completed depth iteration (mirrors
// exactly what the UCI "info"/"bestmove" lines would have reported). score/pv
// use this engine's internal convention (VALUE_MATE-relative scores compose
// correctly across negation — see is_mate_score()/mate distance helpers in
// types.h); serve.cpp/serve_handlers.cpp convert to the gomachine-shaped
// {type,value} eval object.
struct Result {
    Move bestMove = MOVE_NONE;
    int score = 0;
    int depth = 0;
    int64_t nodes = 0;
    std::vector<Move> pv;
};

// ---- Concurrent search contexts ----
//
// Everything a search mutates (TT, history/killer/countermove/corrhist/
// continuation-history tables, the LMR reduction table, the node counter +
// stop flag, the incremental NNUE accumulator stack, and the tunable search
// margins) lives in a Context. Two searches with DIFFERENT Contexts can run
// fully concurrently on separate threads with zero shared mutable state; the
// only thing they share is the read-only NNUE net weights (loaded once,
// never mutated during search).
//
// Context's internals are private to search.cpp — callers only ever hold a
// Context& (an opaque handle) and pass it back into start()/Rating::*.
struct Context;

// default_context() is the single Context used by the UCI CLI path (bare
// `./zugzwang`, one search at a time) — its TT and stop flag are bound to
// the pre-existing global `TT` (tt.h) and the UCI engine's stop signal, so
// UCI/bench/golden-eval behavior is byte-identical to before this Context
// split.
Context& default_context();

// Runs one full iterative-deepening search against `pos` using `ctx`'s
// tables, returning the completed Result (also what a caller reading the
// context's own state during/after the call would see — but the return
// value is the intended read API; nothing outside search.cpp touches Context
// fields directly). Safe to call concurrently from different threads as long
// as each call uses a DIFFERENT Context (see the pool API below for how the
// HTTP serve layer gets one).
Result start(Context& ctx, Position& pos, const Limits& limits);

// Back-compat overload: always searches with default_context(). This is what
// the UCI loop (uci.cpp) and `bench` use — single-threaded, exactly as
// before this change.
void start(Position& pos, const Limits& limits);

int64_t now_ms();

// UCI setoption hook for the 8 SPSA-tunable search margins (search.cpp's
// Tune struct), applied to default_context(). Returns false if `name`
// doesn't match a tune option.
bool set_tune_option(const std::string& name, int value);

void init();  // one-time startup init (LMR table etc) for default_context()
void clear(); // clear history/killers/TT for a new game, on default_context()

// Sets/clears default_context()'s stop flag — the UCI "stop"/"quit"/
// "ucinewgame" cross-thread cancellation signal (uci.cpp's searchThread runs
// start() on a separate thread; the main stdin-reading thread calls this to
// interrupt it). Context is opaque here, hence a free function rather than
// letting callers touch default_context().stop directly.
void request_stop(bool value);

// ---- HTTP serve concurrency pool ----
//
// A fixed-size pool of N independent Contexts, each with its OWN
// TranspositionTable (sized ttMbEach) and its own copy of every other
// mutable search table — so up to N searches run genuinely in parallel.
// Call init_pool() once at server startup; HTTP handlers then lease a
// Context via ContextLease for the duration of one search and it's
// automatically returned to the pool (even on exception).
void init_pool(int size, size_t ttMbEach);
int pool_size();

Context& acquire_context(); // blocks until a Context is free
void release_context(Context& ctx);

class ContextLease {
public:
    ContextLease();
    ~ContextLease();
    ContextLease(const ContextLease&) = delete;
    ContextLease& operator=(const ContextLease&) = delete;
    Context& ctx() { return *ctx_; }

private:
    Context* ctx_;
};

} // namespace Search
