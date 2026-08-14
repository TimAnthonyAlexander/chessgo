// `./zugzwang ratingtest ...` — the calibration harness for the rating ladder
// (rating.cpp's config_for_rating + weakening.cpp's curve/pick).
//
// WHY THIS EXISTS
// ---------------
// The bot ladder shipped for a long time with a defect that no test could see:
// because move selection scored errors in win-probability space, and that
// logistic saturates, every bot above ~1200cp of advantage played uniformly
// random legal moves. A rating-2488 bot would ignore a free rook for six
// consecutive moves and then hang a bishop. Nothing caught it because nothing
// measured strength as a function of HOW DECIDED the position already was —
// spot-checking a bot in a balanced position looks perfect, which is exactly the
// regime where the old model worked.
//
// So this harness measures two things the ladder must satisfy, and both are
// stratified by position type:
//
//   probe    — average centipawn loss per move, bucketed by |eval| of the
//              position. Every bucket must show monotone rating separation, and
//              the worst single giveaway must respect the severity cap. This is
//              the direct regression test for the saturation bug.
//   gauntlet — round-robin self-play between rating levels, reporting the score
//              and the Elo gap it implies. This is the end-to-end calibration:
//              a ladder can look fine per-move and still not separate in games.
//
// Neither mode is part of UCI or the HTTP serve API.
#include "bitboard.h"
#include "book.h"
#include "eval.h"
#include "move.h"
#include "movegen.h"
#include "nnue.h"
#include "openings.h"
#include "position.h"
#include "rating.h"
#include "rules.h"
#include "search.h"
#include "tt.h"
#include "weakening.h"
#include "zobrist.h"

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <deque>
#include <iostream>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace {

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

// The rating rungs both modes report on. Deliberately spans the whole weakened
// band including the two the Watch fillers actually use (1700..2600).
const std::vector<int> kLadder = {1000, 1400, 1800, 2200, 2500, 2800};

// The limits a Watch filler passes to /bestmove (hub/filler.go:
// fillerSearchDepth = 8, fillerMoveTimeCap = 250ms). Measuring with these means
// the harness exercises the exact configuration the reported bad games came
// from, cost caps included.
constexpr int kFillerDepthCap = 8;
constexpr int kFillerMoveTimeMs = 250;

void engine_init() {
    BB::init();
    Zobrist::init();
    Eval::init();
    Search::init();
    // default_context() searches against the GLOBAL TT, which starts unallocated
    // (tt.h: table == nullptr) — uci.cpp sizes it during UCI startup and serve.cpp
    // sizes per-group tables in init_pool(). This entry point does neither, so
    // without this the first probe search dereferences a null table.
    TT.resize(128);
    if (!NNUE::load("net.nnue"))
        std::cerr << "ratingtest: WARNING — net.nnue absent, falling back to the hand-crafted "
                     "eval. Numbers below will NOT reflect the shipped engine.\n";
    Book::shared().load("book.bin");
    Openings::load("openings.bin");
}

bool setup(Position& pos, const std::string& fen) {
    if (!Rules::valid_fen_structure(fen)) return false;
    pos.set(fen);
    return Rules::position_legal(pos);
}

// ---------------------------------------------------------------------------
// Ground truth: every legal move's true score, all at one depth
// ---------------------------------------------------------------------------
//
// One MultiPV search over all root moves. Using MultiPV rather than N separate
// searches is not an optimisation here either — the whole measurement is "how
// many centipawns did the bot give up versus the best move", which is only
// meaningful if every move's score comes from the same completed iteration.
struct Truth {
    std::vector<std::pair<Move, int>> score; // move -> true score, mover-relative
    int best = 0;                            // score of the best move
    bool ok = false;

    int loss_of(Move m) const {
        for (const auto& p : score)
            if (p.first == m) return best - p.second;
        return 0; // move not in the table: treat as no measurable loss
    }
};

Truth ground_truth(Search::Context& ctx, Position& pos, int depth) {
    Truth t;
    MoveList ml;
    Rules::generate_legal(pos, ml);
    if (ml.size() == 0) return t;

    Search::Limits lim;
    lim.depth = depth;
    lim.multiPV = static_cast<int>(ml.size());
    lim.silent = true;
    Search::Result r = Search::start(ctx, pos, lim);
    if (r.lines.empty()) return t;

    t.best = -VALUE_INFINITE;
    for (const Search::Line& l : r.lines) {
        if (l.pv.empty()) continue;
        t.score.push_back({l.pv[0], l.score});
        t.best = std::max(t.best, l.score);
    }
    t.ok = !t.score.empty();
    return t;
}

// ---------------------------------------------------------------------------
// Probe suite
// ---------------------------------------------------------------------------
//
// Curated so that every |eval| bucket is populated. The decided positions are
// the point: a suite of balanced middlegames would have shown the old model as
// flawless. Several carry a piece hanging outright, which is the specific thing
// the severity cap must never let a strong bot ignore.
const char* kProbeFens[] = {
    // --- near-equal: openings and balanced middlegames -----------------------
    "r1bqk2r/pp2bppp/2n1pn2/3p4/3P4/2NBPN2/PP3PPP/R1BQ1RK1 w kq - 0 1",
    "r1bqkb1r/pp3ppp/2n1pn2/2pp4/3P1B2/2N1PN2/PPP2PPP/R2QKB1R w KQkq - 0 1",
    "rnbqk2r/pp2ppbp/3p1np1/2p5/2PP4/2N1PN2/PP3PPP/R1BQKB1R w KQkq - 0 1",
    "r2qkb1r/pb1n1ppp/2p1pn2/1p6/2BP4/2N1PN2/PP3PPP/R1BQ1RK1 w kq - 0 1",
    // --- near-equal endgames (technique, not material) -----------------------
    "8/5pk1/6p1/7p/4R2P/5PK1/r5P1/8 w - - 0 1",
    "8/8/1p6/p1p3k1/P1P3p1/1P4P1/5K2/8 w - - 0 1",
    "8/2k5/3p4/p2P1p2/P2P1P2/8/8/4K3 w - - 0 1",
    // --- small-to-moderate edge ---------------------------------------------
    "r1bq1rk1/pp2ppbp/2np1np1/8/2BNP3/2N1BP2/PPPQ2PP/R3K2R w KQ - 0 1",
    "r2q1rk1/1b1nbppp/p2ppn2/1p6/3NPP2/1BN1B3/PPPQ2PP/2KR3R w - - 0 1",
    // --- clearly decided, still lots of material on ---------------------------
    "8/8/4kp2/3p4/p2P1B2/4KP2/5P2/8 w - - 0 1",
    "8/5pk1/6p1/7p/4R2P/5PK1/6P1/8 w - - 0 1",
    "8/8/4kp2/3p4/p2P1B2/4KP2/1b3P2/8 w - - 0 1",
    // --- decided AND a piece hanging: the free-rook cases --------------------
    // In each of these black's rook on d5 can be taken for nothing by exd5. A
    // bot of any rating in this band must take it; the old model played 22-26
    // distinct other moves instead.
    "r2q2k1/pp2bppp/2n1pn2/3r4/3PP3/2N2N2/PP2BPPP/R2Q1RK1 w - - 0 1",
    "r2q2k1/pp2bppp/2n1pn2/3r4/3PP3/2N2N2/PP2BPPP/R1BQ1RK1 w - - 0 1",
    "r2q2k1/pp2bp1p/2n1pn2/3r4/3PP3/2N2N2/PP2BPPP/R2QRRK1 w - - 0 1",
    "r5k1/pp2bppp/2n1pn2/3r4/3PP3/2N2N2/PP2BPPP/R2Q1RK1 w - - 0 1",
};

struct Bucket {
    const char* name;
    int lo, hi; // on |eval|, cp
};
const Bucket kBuckets[] = {
    {"|eval| 0-200", 0, 200},
    {"200-600", 200, 600},
    {"600-1200", 600, 1200},
    {"1200+", 1200, 1 << 30},
};
constexpr int kNumBuckets = int(sizeof(kBuckets) / sizeof(kBuckets[0]));

int bucket_of(int eval) {
    int a = std::abs(eval);
    for (int i = 0; i < kNumBuckets; ++i)
        if (a >= kBuckets[i].lo && a < kBuckets[i].hi) return i;
    return kNumBuckets - 1;
}

struct Stat {
    long long n = 0;
    long long sumLoss = 0;
    int maxLoss = 0;
    long long bigBlunders = 0; // moves losing > 300cp
    void add(int loss) {
        n++;
        sumLoss += loss;
        maxLoss = std::max(maxLoss, loss);
        if (loss > 300) bigBlunders++;
    }
    double mean() const { return n ? double(sumLoss) / double(n) : 0.0; }
};

int probe_main(int samples, int truthDepth, int threads) {
    const int nFens = int(sizeof(kProbeFens) / sizeof(kProbeFens[0]));

    // stats[rating][bucket]
    std::vector<std::vector<Stat>> stats(kLadder.size(), std::vector<Stat>(kNumBuckets));
    std::vector<int> bucketFens(kNumBuckets, 0);

    std::printf("ratingtest probe — %d positions x %d samples, ground truth at depth %d, %d threads\n",
                nFens, samples, truthDepth, threads);
    std::printf("bot limits: depth cap %d, movetime cap %dms (the Watch filler configuration)\n\n",
                kFillerDepthCap, kFillerMoveTimeMs);

    Search::init_pool(threads, 1, 32);
    std::atomic<int> nextFen{0};
    std::atomic<bool> bad{false};
    std::mutex mu;

    // One position per worker: ground truth, then every rating's samples against
    // it. Positions are independent, so this parallelises cleanly — each worker
    // holds its own group (own TT, own accumulator stack).
    auto worker = [&]() {
        Search::GroupLease lease;
        Search::Context& ctx = Search::primary_context(lease.group());
        for (;;) {
            int f = nextFen.fetch_add(1);
            if (f >= nFens) break;

            Position pos;
            if (!setup(pos, kProbeFens[f])) {
                std::lock_guard<std::mutex> g(mu);
                std::printf("ratingtest: ILLEGAL probe FEN: %s\n", kProbeFens[f]);
                bad = true;
                continue;
            }
            Truth t = ground_truth(ctx, pos, truthDepth);
            if (!t.ok) {
                std::lock_guard<std::mutex> g(mu);
                std::printf("ratingtest: no legal moves in probe FEN: %s\n", kProbeFens[f]);
                bad = true;
                continue;
            }
            int b = bucket_of(t.best);

            std::vector<std::vector<Stat>> local(kLadder.size(), std::vector<Stat>(kNumBuckets));
            for (size_t ri = 0; ri < kLadder.size(); ++ri) {
                for (int s = 0; s < samples; ++s) {
                    Position p2;
                    setup(p2, kProbeFens[f]);
                    std::vector<uint64_t> hist;
                    Rating::WeakResult wr = Rating::best_move_for_rating_single(
                        ctx, p2, kLadder[ri], kFillerDepthCap, kFillerMoveTimeMs, 0, hist);
                    if (wr.move == MOVE_NONE) continue;
                    local[ri][b].add(std::max(0, t.loss_of(wr.move)));
                }
            }

            std::lock_guard<std::mutex> g(mu);
            bucketFens[b]++;
            std::printf("  %-52s %+7d cp  %2d moves  -> %s\n", std::string(kProbeFens[f]).substr(0, 52).c_str(),
                        t.best, int(t.score.size()), kBuckets[b].name);
            // Per-position cpl for THIS position, before it is folded into the bucket
            // aggregate below. A bucket mean is an average over as few as three
            // positions and most decided positions score 0 for every rung, so a single
            // position routinely IS the bucket — and without this line there is no way
            // to tell which one, or which rung it punished. See the CHECKS section for
            // why the strongest rungs are the ones a position like that punishes.
            std::printf("      per-rating cpl:");
            for (size_t ri = 0; ri < kLadder.size(); ++ri)
                std::printf("  %d=%.0f/max%d", kLadder[ri], local[ri][b].mean(), local[ri][b].maxLoss);
            std::printf("\n");
            std::fflush(stdout);
            for (size_t ri = 0; ri < kLadder.size(); ++ri)
                for (int bb = 0; bb < kNumBuckets; ++bb) {
                    Stat& d = stats[ri][bb];
                    const Stat& s = local[ri][bb];
                    d.n += s.n;
                    d.sumLoss += s.sumLoss;
                    d.maxLoss = std::max(d.maxLoss, s.maxLoss);
                    d.bigBlunders += s.bigBlunders;
                }
        }
    };

    std::vector<std::thread> pool;
    for (int i = 0; i < threads; ++i) pool.emplace_back(worker);
    for (auto& th : pool) th.join();
    if (bad) return 1;

    auto table = [&](const char* title, auto cell) {
        std::printf("\n%s\n", title);
        std::printf("%8s", "rating");
        for (int b = 0; b < kNumBuckets; ++b) std::printf("%14s", kBuckets[b].name);
        std::printf("\n");
        for (size_t ri = 0; ri < kLadder.size(); ++ri) {
            std::printf("%8d", kLadder[ri]);
            for (int b = 0; b < kNumBuckets; ++b) {
                if (!stats[ri][b].n) { std::printf("%14s", "-"); continue; }
                std::printf("%14s", cell(stats[ri][b]).c_str());
            }
            std::printf("\n");
        }
        std::printf("%8s", "n pos");
        for (int b = 0; b < kNumBuckets; ++b) std::printf("%14d", bucketFens[b]);
        std::printf("\n");
    };

    table("AVERAGE CENTIPAWN LOSS PER MOVE  (must decrease down every column)",
          [](const Stat& s) { return std::to_string(int(s.mean() + 0.5)); });
    table("WORST SINGLE GIVEAWAY (cp)  (must respect the severity cap)",
          [](const Stat& s) { return std::to_string(s.maxLoss); });
    table("SHARE OF MOVES LOSING > 300cp",
          [](const Stat& s) {
              char buf[32];
              std::snprintf(buf, sizeof(buf), "%.1f%%", 100.0 * double(s.bigBlunders) / double(s.n));
              return std::string(buf);
          });

    // ---- assertions --------------------------------------------------------
    std::printf("\nCHECKS\n");
    int failures = 0;

    // 1. Rating separation must hold INSIDE every bucket. This is the check the
    //    old model failed: it separated beautifully at |eval| < 200 and not at
    //    all above it.
    //
    //    KNOWN, DIAGNOSED, NOT A LADDER DEFECT: the `1200+` bucket flags a `mono`
    //    inversion on most runs, at a rung that MOVES from run to run (2200 in one
    //    set of four runs, 2800 in the next). It is a defect of this MEASUREMENT,
    //    and the per-position line printed above is what shows it.
    //
    //    The bot is capped at kFillerDepthCap = 8 plies of ranking sight; the oracle
    //    it is scored against runs at truthDepth = 14. Wherever those two disagree
    //    about the best move, the bot is charged the difference — and the STRONGEST
    //    rungs are charged it hardest, because a near-zero selection window pins them
    //    to their own capped-depth best EVERY sample, while a wide window lets a weak
    //    rung stumble onto the oracle's move by luck and dilute the cell. Certainty is
    //    what the metric punishes, so the inversion sits wherever the disagreement is.
    //
    //    Worked example, `8/2k5/3p4/p2P1p2/P2P1P2/8/8/4K3 w - - 0 1` (a blocked pawn
    //    ending, 5 legal moves, in the 1200+ bucket). MultiPV, this engine, today:
    //      depth  8  e1f2 +1117 | e1d1 +227   <- the bot's own view, 890cp apart
    //      depth 14  e1d1 +1628 | e1f2 +1564  <- the oracle, 64cp apart the other way
    //    Rating 2800 (window 3cp, cap 10cp) therefore plays e1f2 30 times out of 30
    //    and measures 74cpl; rating 2500 (window 31cp) measures 37; rating 1000
    //    (window 249cp, ranking at depth 2, where the two moves are 1cp apart) splits
    //    its samples and also measures ~37. Same effect in a lost position with a
    //    search instability at one depth: a run where the depth-6 ranking preferred
    //    a move the depth-14 oracle scores 419cp worse put rating 2200 at 391cpl in
    //    that cell while 1800 and 2500 measured 0.
    //
    //    The bucket cannot absorb any of that: it holds 8 positions, most of them
    //    decided positions every rung plays perfectly (0cpl), so one such cell IS the
    //    bucket mean. More samples do not help — the offending cell is deterministic.
    //    The `0-200` and `200-600` buckets, whose positions all carry real per-move
    //    signal, separate monotonically and are the ones to read.
    //
    //    Deliberately NOT "fixed" by loosening this check or by re-recording the
    //    numbers. A fix means changing what the metric measures — scoring the bot
    //    against an oracle it is allowed to see, or requiring a bucket to hold enough
    //    positions that no single one can carry it — and that is a redesign of the
    //    gate, not a patch to it.
    for (int b = 0; b < kNumBuckets; ++b) {
        if (!stats[0][b].n) continue;
        // Sampling noise makes strict step-by-step monotonicity too brittle, so
        // flag only a CLEAR inversion (a rung more than 15% worse than the rung
        // below it). The end-to-end ordering is checked by `spread` below and,
        // properly, by the gauntlet.
        bool mono = true;
        for (size_t ri = 1; ri < kLadder.size(); ++ri)
            if (stats[ri][b].mean() > stats[ri - 1][b].mean() * 1.15 + 2.0) mono = false;
        // Separation must also be substantial, not just ordered.
        double top = stats.front()[b].mean(), bot = stats.back()[b].mean();
        bool spread = top > bot * 1.5 + 5.0;
        const char* verdict = (mono && spread) ? "PASS" : (mono ? "WEAK" : "FAIL");
        if (!mono || !spread) failures++;
        std::printf("  %-14s rating separation %-4s  (%d -> %d cpl across the ladder)\n",
                    kBuckets[b].name, verdict, int(top + 0.5), int(bot + 0.5));
    }

    // 2. The severity cap is an absolute promise. Allow a margin: the cap bounds
    //    the loss measured at the bot's OWN ranking depth, while `maxLoss` is
    //    measured at truthDepth, so a deep refutation the bot could not see is a
    //    legitimate overshoot. A gross overshoot is not.
    for (size_t ri = 0; ri < kLadder.size(); ++ri) {
        Weakening::SoftmaxConfig c = Weakening::curve_for_rating(kLadder[ri]);
        if (c.windowCp <= 0.0) continue;
        int worst = 0;
        for (int b = 0; b < kNumBuckets; ++b) worst = std::max(worst, stats[ri][b].maxLoss);
        std::printf("  rating %4d  window %5.0fcp  cap %5.0fcp   worst observed %5dcp  %s\n",
                    kLadder[ri], c.windowCp, c.capCp, worst,
                    worst <= c.capCp * 3.0 + 200.0 ? "ok" : "OVERSHOOT");
    }

    std::printf("\n%s\n", failures ? "PROBE: FAILURES ABOVE" : "PROBE: all buckets separate by rating");
    return failures ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Gauntlet: do the ratings actually beat each other?
// ---------------------------------------------------------------------------

// Short, standard, balanced opening lines given as UCI so they cannot be
// mistyped into an illegal FEN — the harness plays them out through the engine's
// own move parser and aborts loudly if any move is rejected.
const char* kOpeningLines[] = {
    "e2e4 c7c5 g1f3 d7d6",
    "e2e4 e7e5 g1f3 b8c6 f1b5 a7a6",
    "d2d4 g8f6 c2c4 e7e6 g1f3 b7b6",
    "d2d4 d7d5 c2c4 c7c6 g1f3 g8f6",
    "e2e4 e7e6 d2d4 d7d5 b1c3 g8f6",
    "c2c4 e7e5 b1c3 g8f6 g1f3 b8c6",
    "e2e4 c7c6 d2d4 d7d5 b1d2 d5e4",
    "d2d4 f7f5 g2g3 g8f6 f1g2 e7e6",
    "g1f3 d7d5 d2d4 g8f6 c2c4 e7e6",
    "e2e4 d7d5 e4d5 d8d5 b1c3 d5a5",
    "d2d4 g8f6 c2c4 g7g6 b1c3 f8g7",
    "e2e4 e7e5 g1f3 g8f6 f3e5 d7d6",
    "c2c4 c7c5 g1f3 g8f6 b1c3 b8c6",
    "d2d4 e7e6 c2c4 f8b4 b1c3 g8f6",
    "e2e4 g8f6 e4e5 f6d5 d2d4 d7d6",
    "b1c3 d7d5 d2d4 g8f6 c1f4 c7c6",
};

std::vector<std::string> split_ws(const std::string& s) {
    std::vector<std::string> out;
    size_t i = 0;
    while (i < s.size()) {
        while (i < s.size() && s[i] == ' ') i++;
        size_t j = i;
        while (j < s.size() && s[j] != ' ') j++;
        if (j > i) out.push_back(s.substr(i, j - i));
        i = j;
    }
    return out;
}

// Plays a UCI line from the start position and returns the resulting FEN.
// Returns "" if any move is illegal (a typo in the table above).
std::string fen_after_line(const std::string& line) {
    Position pos;
    pos.set("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
    std::deque<StateInfo> states;
    for (const std::string& mv : split_ws(line)) {
        Move m = Rules::parse_uci_move(pos, mv);
        if (m == MOVE_NONE) return "";
        states.emplace_back();
        pos.do_move(m, states.back());
    }
    return pos.fen();
}

enum class GameResult { WhiteWin, BlackWin, Draw };

// One full game, both sides driven through the SAME entry point the website
// uses (Rating::best_move_for_rating_single), with the Watch filler cost caps.
GameResult play_game(Search::Context& ctx, const std::string& startFen, int whiteRating,
                     int blackRating, int maxPlies) {
    Position pos;
    if (!setup(pos, startFen)) return GameResult::Draw;
    std::deque<StateInfo> states;
    std::vector<uint64_t> hist;

    for (int ply = 0; ply < maxPlies; ++ply) {
        Rules::Status st = Rules::adjudicate(pos, hist);
        if (st.state != "ongoing") {
            if (st.result == "1-0") return GameResult::WhiteWin;
            if (st.result == "0-1") return GameResult::BlackWin;
            return GameResult::Draw;
        }
        // Both engines would claim an available threefold/fifty-move draw; taking
        // it here is also what keeps a game from shuffling to the ply cap.
        if (!st.claimableDraws.empty()) return GameResult::Draw;

        int rating = pos.side_to_move() == WHITE ? whiteRating : blackRating;
        Rating::WeakResult wr = Rating::best_move_for_rating_single(
            ctx, pos, rating, kFillerDepthCap, kFillerMoveTimeMs, 0, hist);
        if (wr.move == MOVE_NONE) return GameResult::Draw;

        hist.push_back(pos.key());
        states.emplace_back();
        pos.do_move(wr.move, states.back());
    }
    return GameResult::Draw; // hit the ply cap
}

struct Pairing {
    int ratingA, ratingB;
    std::string startFen;
    bool aIsWhite;
};

struct Score {
    std::atomic<int> winA{0}, winB{0}, draw{0};
};

double elo_from_score(double s) {
    if (s <= 0.0005) return -800.0;
    if (s >= 0.9995) return 800.0;
    return -400.0 * std::log10(1.0 / s - 1.0);
}

int gauntlet_main(int gamesPerPair, int threads, int maxPlies) {
    // Every adjacent-and-beyond pair, so the table shows both fine separation
    // (1400 vs 1800) and gross separation (1000 vs 2800).
    std::vector<std::pair<int, int>> pairs;
    for (size_t i = 0; i < kLadder.size(); ++i)
        for (size_t j = i + 1; j < kLadder.size(); ++j) pairs.push_back({kLadder[i], kLadder[j]});

    const int nLines = int(sizeof(kOpeningLines) / sizeof(kOpeningLines[0]));
    std::vector<std::string> openings;
    for (int i = 0; i < nLines; ++i) {
        std::string f = fen_after_line(kOpeningLines[i]);
        if (f.empty()) {
            std::printf("ratingtest: ILLEGAL opening line, aborting: %s\n", kOpeningLines[i]);
            return 1;
        }
        openings.push_back(f);
    }

    // Build the full work list: each pair plays gamesPerPair games, colours
    // alternating so a colour bias cannot masquerade as a rating gap.
    std::vector<Pairing> work;
    for (size_t p = 0; p < pairs.size(); ++p)
        for (int g = 0; g < gamesPerPair; ++g)
            work.push_back({pairs[p].first, pairs[p].second,
                            openings[size_t(g / 2) % openings.size()], (g % 2) == 0});

    std::vector<Score> scores(pairs.size());
    auto pairIndex = [&](int a, int b) {
        for (size_t i = 0; i < pairs.size(); ++i)
            if (pairs[i].first == a && pairs[i].second == b) return i;
        return size_t(0);
    };

    std::printf("ratingtest gauntlet — %d pairs x %d games = %d games, %d threads, ply cap %d\n",
                int(pairs.size()), gamesPerPair, int(work.size()), threads, maxPlies);
    std::printf("bot limits: depth cap %d, movetime cap %dms (the Watch filler configuration)\n\n",
                kFillerDepthCap, kFillerMoveTimeMs);

    Search::init_pool(threads, 1, 16);
    std::atomic<size_t> next{0};
    std::atomic<int> done{0};
    const int total = int(work.size());

    auto worker = [&]() {
        Search::GroupLease lease;
        Search::Context& ctx = Search::primary_context(lease.group());
        for (;;) {
            size_t i = next.fetch_add(1);
            if (i >= work.size()) break;
            const Pairing& w = work[i];
            int wr = w.aIsWhite ? w.ratingA : w.ratingB;
            int br = w.aIsWhite ? w.ratingB : w.ratingA;
            GameResult r = play_game(ctx, w.startFen, wr, br, maxPlies);

            Score& s = scores[pairIndex(w.ratingA, w.ratingB)];
            bool aWon = (r == GameResult::WhiteWin && w.aIsWhite) ||
                        (r == GameResult::BlackWin && !w.aIsWhite);
            bool bWon = (r == GameResult::WhiteWin && !w.aIsWhite) ||
                        (r == GameResult::BlackWin && w.aIsWhite);
            if (r == GameResult::Draw) s.draw++;
            else if (aWon) s.winA++;
            else if (bWon) s.winB++;

            int d = ++done;
            if (d % 20 == 0 || d == total) {
                std::printf("\r  %d/%d games", d, total);
                std::fflush(stdout);
            }
        }
    };

    std::vector<std::thread> pool;
    for (int i = 0; i < threads; ++i) pool.emplace_back(worker);
    for (auto& t : pool) t.join();
    std::printf("\n\n");

    std::printf("%-16s %6s %6s %6s   %-9s %10s %10s\n", "pairing", "W", "L", "D", "score", "Elo gap",
                "expected");
    int failures = 0;
    for (size_t i = 0; i < pairs.size(); ++i) {
        int wA = scores[i].winA.load(), wB = scores[i].winB.load(), d = scores[i].draw.load();
        int n = wA + wB + d;
        if (!n) continue;
        // Score from the STRONGER side's point of view (pairs are ordered weak,
        // strong — so B is the stronger rating).
        double s = (double(wB) + 0.5 * double(d)) / double(n);
        double measured = elo_from_score(s);
        double expected = double(pairs[i].second - pairs[i].first);
        char label[32];
        std::snprintf(label, sizeof(label), "%d vs %d", pairs[i].first, pairs[i].second);
        // The stronger bot must at minimum win the matchup clearly. Exact Elo
        // agreement is not expected (self-play compresses gaps), but a rung that
        // fails to beat the one below it is a broken ladder.
        const char* flag = s > 0.60 ? "" : "  <-- NOT SEPARATING";
        if (s <= 0.60) failures++;
        std::printf("%-16s %6d %6d %6d   %6.1f%%   %+10.0f %10.0f%s\n", label, wB, wA, d, s * 100.0,
                    measured, expected, flag);
    }
    std::printf("\n%s\n",
                failures ? "GAUNTLET: FAILURES ABOVE — some rung does not beat the rung below it"
                         : "GAUNTLET: every rung beats every weaker rung");
    return failures ? 1 : 0;
}

void usage() {
    std::printf(
        "usage:\n"
        "  zugzwang ratingtest curve\n"
        "        print the rating -> (window, cap, rank depth) ladder\n"
        "  zugzwang ratingtest probe    [-samples N] [-truth-depth D] [-threads T]\n"
        "        average centipawn loss per move, bucketed by how decided the position is\n"
        "  zugzwang ratingtest gauntlet [-games N] [-threads T] [-max-plies P]\n"
        "        round-robin self-play between rating rungs\n");
}

int curve_main() {
    std::printf("%8s %10s %8s %8s %12s %10s\n", "rating", "rankDepth", "window", "cap",
                "consistency", "mode");
    for (int r = 700; r <= 3000; r += 100) {
        Rating::LevelConfig c = Rating::config_for_rating(r);
        std::printf("%8d %10d %6.0fcp %6.0fcp %12.2f %10s\n", r, c.rankDepth, c.windowCp, c.capCp,
                    c.consistency, c.clean ? "clean" : "weakened");
    }
    return 0;
}

} // namespace

int ratingtest_main(int argc, char** argv) {
    if (argc < 3) {
        usage();
        return 2;
    }
    std::string mode = argv[2];

    int samples = 30, truthDepth = 14;
    int games = 60, threads = int(std::thread::hardware_concurrency());
    int maxPlies = 300;
    if (threads < 1) threads = 1;
    if (threads > 8) threads = 8;

    for (int i = 3; i + 1 < argc; i += 2) {
        std::string k = argv[i];
        int v = std::atoi(argv[i + 1]);
        if (k == "-samples") samples = v;
        else if (k == "-truth-depth") truthDepth = v;
        else if (k == "-games") games = v;
        else if (k == "-threads") threads = v < 1 ? 1 : v;
        else if (k == "-max-plies") maxPlies = v;
    }

    engine_init();

    if (mode == "curve") return curve_main();
    if (mode == "probe") return probe_main(samples, truthDepth, threads);
    if (mode == "gauntlet") return gauntlet_main(games, threads, maxPlies);
    usage();
    return 2;
}
