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
    // Pondering: set by `go ponder`. The search ignores all time limits until the GUI sends
    // `ponderhit` (→ Search::ponderhit(), start the clock) or `stop` (abort). startTime is
    // still stamped at the `go ponder` moment, so post-ponderhit elapsed() includes ponder
    // time — matching SF's "budget spans pondering + real thinking" semantics.
    bool ponderMode = false;
    int64_t startTime = 0;
    // HTTP serve layer only: suppress the UCI "info"/"bestmove" stdout lines
    // (start() is reused verbatim by serve.cpp — the UCI loop still wants them,
    // the HTTP handlers read the returned Result instead).
    bool silent = false;
    // Number of principal variations to report, SF-style (UCI "MultiPV", SF
    // search.cpp:302-310). ONE iterative-deepening search produces all N lines at
    // the SAME depth: the ID loop runs an inner `pvIdx` loop, each pass searching
    // the root restricted to the not-yet-emitted root moves. 1 (the default, and
    // every pre-existing caller) is the exact single-PV search this engine has
    // always run — every SPSA margin and the whole SPRT/CCRL baseline depend on
    // that tree being unchanged, so the whole MultiPV apparatus is deliberately a
    // no-op at pvIdx==0 (see search.cpp's ID loop for the identity argument).
    // Clamped to the root's legal move count at start() entry.
    int multiPV = 1;
};

// One reported principal variation — the public, caller-facing shape of a
// MultiPV line (Result::lines). `score` is this engine's internal convention
// (VALUE_MATE-relative, see types.h), `depth` is the ID depth the line was
// completed at — identical across every line of one Result, which is the whole
// point of doing real MultiPV instead of N independent searches. selDepth is
// reserved (this engine does not track a selective depth yet, so it is 0).
struct Line {
    int score = 0;
    int depth = 0;
    int selDepth = 0;
    std::vector<Move> pv;
};

// Root move bookkeeping, ported from SF's RootMove (~sf18-arm/src/search.h:85-110).
// One entry per legal root move, built once at start() entry and carried across
// EVERY iterative-deepening iteration of that one search — that persistence is what
// makes MultiPV cheap (shared TT, shared root ordering) and what lets a fail-low
// move keep its previous ordering via the stable sort.
//
// score/prevScore/avgScore all start at -VALUE_INFINITE, SF's "never searched"
// sentinel; a move that neither is moveCount==1 nor beats alpha is reset to
// -VALUE_INFINITE after its search so that the STABLE sort pushes only the new PV
// to the front and preserves the relative order of everything else (SF
// search.cpp:1349-1352).
struct RootMove {
    RootMove() = default;
    explicit RootMove(Move m) : move(m), pv(1, m) {}

    // Sort in DESCENDING score order (SF search.h:93-96): best line first, ties
    // broken by the previous iteration's score so a genuinely stable ranking
    // survives an iteration where several moves failed low together.
    bool operator<(const RootMove& m) const {
        return m.score != score ? m.score < score : m.prevScore < prevScore;
    }
    bool operator==(const Move& m) const { return pv[0] == m; }

    Move move = MOVE_NONE;
    int  score     = -VALUE_INFINITE; // this iteration's score (clobbered every search)
    int  prevScore = -VALUE_INFINITE; // last iteration's score (SF previousScore)
    int  avgScore  = -VALUE_INFINITE; // running /2 blend (SF averageScore); seeds the
                                      // aspiration window for pvIdx > 0 lines ONLY
    int64_t effort = 0;               // nodes spent on this root move (SF RootMove::effort),
                                      // consumed by the NODEEFFORT time-management factor
    std::vector<Move> pv;             // pv[0] == move, always
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
    // The MultiPV lines from that same completed iteration, best first. ALWAYS
    // populated (size 1 when limits.multiPV == 1, which is every legacy caller),
    // and lines[0] is by construction the same line the scalar fields above
    // describe: lines[0].pv[0] == bestMove, lines[0].score == score,
    // lines[0].depth == depth. Callers that only want the best move keep reading
    // the scalars and are entirely unaffected.
    std::vector<Line> lines;
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

// A SearchGroup bundles K worker Contexts + ONE shared TranspositionTable +
// ONE shared std::atomic<bool> stop flag — the unit of Lazy SMP. Running a
// search over a group fans out across its K workers, all cooperating through
// the group's single TT (classic Lazy SMP). Like Context, its layout is
// private to search.cpp; callers hold an opaque SearchGroup& (from the serve
// pool via GroupLease) and pass it into start_group()/primary_context().
struct SearchGroup;

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
//
// resetShared: when true (default — every existing caller), start() clears
// ctx.stop and calls ctx.tt.new_search() at entry, exactly as before. Lazy-SMP
// (start_smp) passes false: multiple contexts SHARE one TT + one stop flag, so
// the driver does those two shared side-effects ONCE up front and each worker
// must NOT repeat them (a per-worker tt.new_search() would be N concurrent
// non-atomic RMWs on TT.generation; a per-worker stop=false could race a
// sibling's timeout). All other per-Context resets (nodeCount, tables, acc
// stack) still run per call. resetShared=true is byte-identical to before.
Result start(Context& ctx, Position& pos, const Limits& limits, bool resetShared = true);

// ---- Lazy SMP (multi-threaded search) ----
//
// Runs the search on `threads` Contexts concurrently: the calling thread plus
// (threads-1) helper std::threads, ALL sharing the one global TT (tt.h) and one
// shared atomic stop flag — the classic Lazy-SMP cooperation channel. threads<=1
// delegates to the exact single-thread path (start(default_context(), ...)), so
// Threads=1 is byte-identical (same tree, same bestmove, same stdout) to the
// pre-SMP engine. threads>1 picks the result from the worker that reached the
// greatest depth (tie -> greatest score) and prints exactly one bestmove line.
Result start_smp(Position& pos, const Limits& limits, int threads);

// Back-compat overload: always searches with default_context(). This is what
// the UCI loop (uci.cpp) and `bench` use — single-threaded, exactly as
// before this change.
void start(Position& pos, const Limits& limits);

int64_t now_ms();

// UCI setoption hook for the SPSA-tunable search margins (search.cpp's
// Tune struct), applied to default_context(). Returns false if `name`
// doesn't match a tune option.
bool set_tune_option(const std::string& name, int value);

// LmrBase/LmrDiv are sub-1-precision doubles (Tune::lmrBase/lmrDiv) but UCI
// `spin` options are integers — the wire value is the double x LMR_DOUBLE_SCALE
// (e.g. default lmrBase 0.7844 <-> spin value 7844). Shared by uci.cpp (option
// table defaults) and search.cpp (set_tune_option_impl's conversion back).
constexpr int LMR_DOUBLE_SCALE = 10000;

void init();  // one-time startup init (LMR table etc) for default_context()
void clear(); // clear history/killers/TT for a new game, on default_context()

// Sets/clears default_context()'s stop flag — the UCI "stop"/"quit"/
// "ucinewgame" cross-thread cancellation signal (uci.cpp's searchThread runs
// start() on a separate thread; the main stdin-reading thread calls this to
// interrupt it). Context is opaque here, hence a free function rather than
// letting callers touch default_context().stop directly.
void request_stop(bool value);

// Pondering (UCI). set_ponder(true) is called by the UCI layer right before launching a
// `go ponder` search; set_ponder(false) resets it on every ordinary `go`. ponderhit() is the
// `ponderhit` command handler — clears the flag so the running search starts honouring its
// time limits (clock measured from the original `go ponder` startTime). Both drive one
// process-wide atomic; only one UCI search runs at a time so no per-Context wiring is needed.
void set_ponder(bool value);
void ponderhit();

// Runs one search over `group` and returns the completed Result. This is the
// serve-path counterpart of start_smp(): K==1 is the exact single-thread
// start() fast path (byte-identical to a plain start(primary_context(group),
// ...) — no threads spawned); K>1 runs Lazy SMP over the group's K workers,
// all sharing the group's one TT (tt.new_search() ONCE) + one stop flag, with
// the same SF-style best-thread vote and aggregate node count as start_smp.
// The shared SMP core is literally the same routine start_smp uses; the only
// difference is which TT + stop + worker set it drives. limits.silent is
// honoured (serve always sets it), so this never writes to stdout.
Result start_group(SearchGroup& group, Position& pos, const Limits& limits);

// The group's worker-0 Context — a fully-usable single Context for callers
// that run a genuinely single-threaded search on a leased group (the rating/
// worst weakening path in serve_handlers, where extra SMP strength is
// pointless because the whole point is to play *weaker*). Sharing TT/stop with
// the group's other workers is irrelevant while none of them is running.
Context& primary_context(SearchGroup& group);

// ---- HTTP serve concurrency pool ----
//
// A fixed-size pool of G SearchGroups. Each group owns K worker Contexts + ONE
// shared TranspositionTable (sized ttMbPerGroup) + one shared stop flag — so a
// leased group runs a K-thread Lazy-SMP search, and up to G such searches run
// genuinely in parallel (peak threads = G*K, total resident TT ≈ G*ttMbPerGroup).
// Call init_pool() once at server startup; HTTP handlers then lease a group via
// GroupLease for the duration of one search and it's automatically returned to
// the pool (even on exception). K==1 makes this equivalent to the old
// one-Context-per-request pool (byte-identical single-thread search).
void init_pool(int groups, int threadsPerGroup, size_t ttMbPerGroup);
int pool_group_count();      // number of concurrent groups (G)
int pool_threads_per_group(); // workers per group (K)

SearchGroup& acquire_group(); // blocks until a group is free
void release_group(SearchGroup& group);

class GroupLease {
public:
    GroupLease();
    ~GroupLease();
    GroupLease(const GroupLease&) = delete;
    GroupLease& operator=(const GroupLease&) = delete;
    SearchGroup& group() { return *group_; }

private:
    SearchGroup* group_;
};

} // namespace Search
