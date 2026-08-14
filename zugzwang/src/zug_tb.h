#pragma once
#include "position.h"
#include "move.h"
#include <vector>

// Syzygy endgame tablebase probing (Fathom, vendored in src/syzygy/). Ported from
// gomachine's internal/syzygy integration. Position→Fathom bitboard mapping is 1:1
// (both a1=0..h8=63 LERF).
//
// The inherited gomachine numbers were "+18.8 Elo root-DTZ, +30.5 Elo WDL-in-search".
// The second one needs a note, because what it measured no longer exists. Measured
// here, 24 ≤5-man roots at fixed depth 26 with the root DTZ ranking switched off:
// the old ungated flat probe finished the whole set in 13,946 nodes, against
// 20,506,758 for the current one. That 1500x is the "+30.5 Elo" — and it is the same
// mechanism that drew won endings, because every winning move returned the identical
// flat ±(VALUE_TB_WIN - ply) and the search had nothing left to choose with. It was
// already gone before this file's rule50 gate landed: the root ranking zeroes
// Search::Context::tbCardinality, which switches the in-search probe off entirely
// inside a ranked root. Same 24 roots in the SHIPPED configuration measure
// 56,053,174 nodes byte-identically before and after the gate.
//
// Where the in-search probe still runs — a root with more men than the tables hold,
// searching down into ≤5-man nodes, which is most of a real game — the SF-shaped
// version is FASTER, not slower: 16 six- and seven-man won roots at fixed depth 24
// go 14,004,212 nodes / 9,150 ms → 12,210,330 / 8,057 (-12.8% nodes, -11.9% time).
// Keeping cursed/blessed as an EXACT bound and writing the verdict to the TT at
// depth+6 more than pays for the probes the rule50 gate removes.
namespace TB {

// Initialize from a Syzygy directory. Returns true iff at least one table loaded
// (TB_LARGEST > 0 after tb_init). Safe to call with an empty/absent path (returns false).
bool init(const char* path);

bool     loaded();      // true once init() succeeded
unsigned max_pieces();  // TB_LARGEST — probe only when popcount(occupied) <= this

// WDL probe for internal search nodes. Returns false on a miss/failed probe; on a hit
// sets `result` to the RAW five-valued verdict from the side to move's point of view, on
// SF's WDLScore scale (~sf18-arm/src/syzygy/tbprobe.h:34):
//
//     -2 loss   -1 blessed loss   0 draw   +1 cursed win   +2 win
//
// The caller does the drawScore mapping, exactly as SF's Step 5 does (search.cpp:823-830).
// It used to return a normalized +1/0/-1 with cursed/blessed folded to draw; see the fold
// comment in zug_tb.cpp for why that fold belongs at the call site and not here.
//
// PRECONDITIONS THE CALLER MUST ENFORCE — all three, no exceptions:
//   * castling_rights() == 0   (Fathom's Pos carries no castling state)
//   * popcount(occupied) <= max_pieces()
//   * rule50_count() == 0
// The last one is not optional and is not a tuning choice. This calls tb_probe_wdl_impl
// directly, and Fathom's own wrapper `tb_probe_wdl` (src/syzygy/tbprobe.h:220-223) refuses
// with TB_RESULT_FAILED when rule50 != 0 for a documented reason: the WDL tables answer
// "is this won with a FRESH halfmove clock", so at rule50 > 0 a position whose win no
// longer fits inside the counter still reads +2. SF gates on `pos.rule50_count() == 0`
// (~sf18-arm/src/search.cpp:809) for the same reason. Skipping it is how a dead-drawn
// KNPvKB read +314.96 for 16 straight moves in a real game.
//
// Lock-free / thread-safe (unlike the DTZ path below).
bool probe_wdl(const Position& pos, int& result);

// ---- Root DTZ ranking (SF Tablebases::root_probe, ~sf18-arm/src/syzygy/tbprobe.cpp:1603,
//      and Tablebases::rank_root_moves, :1717) ----
//
// This is the half WDL-in-search structurally cannot do. WDL is FLAT across every
// winning move (all of them are "win"), so a search that only knows WDL cannot tell a
// move that PROGRESSES toward the next zeroing move from one that merely PRESERVES the
// win — it shuffles and the 50-move rule ends the game as a draw. DTZ is the ordering
// that separates them, and rank_root_moves() is how SF makes it available to a real
// search instead of short-circuiting it.

// SF's `constexpr int MAX_DTZ = 1 << 18` (~sf18-arm/src/syzygy/tbprobe.cpp:69). The
// rank bands are ±MAX_DTZ (certain), ±MAX_DTZ/2 (cursed/blessed) and 0 (draw).
constexpr int MAX_DTZ = 1 << 18;

// One ranked root move — SF's RootMove::{tbRank,tbScore} (~sf18-arm/src/search.h:107-108)
// for a single move, kept as a standalone struct so this header does not have to know
// about Search::RootMove (search.h includes nothing from here, and vice versa).
struct RootRank {
    Move move  = MOVE_NONE;
    int  rank  = 0;  // SF tbRank: ordering key ONLY, never a score. Higher = better.
    int  score = 0;  // SF tbScore, mapped onto ZUG's value scale (see zug_tb.cpp).
    int  dtz   = 0;  // signed DTZ from the ROOT, in plies. Diagnostics/tools only —
                     // rank/score already fold it in. 0 = draw.

    // Is `score` a CURSED WIN / BLESSED LOSS band value — the 1..50cp ordering nudge —
    // rather than this move's true rule50-aware value? True exactly for the two middle
    // branches of the tbScore expression in zug_tb.cpp (0 < |rank| < bound). The
    // distinction has to leave this struct because `score` alone cannot carry it: in the
    // certain bands (±VALUE_TB_WIN) and in the draw band (0) score IS the position's
    // value; in this band it deliberately is not, and reporting it produced a header that
    // contradicted its own PV. reported_score() (search.cpp) reports VALUE_DRAW here —
    // the tablebase's actual verdict on a spent win — and leaves ORDERING alone.
    bool cursed = false;
};

// Rank EVERY legal root move of `pos` by Syzygy DTZ, SF-style. Returns false (and leaves
// `out` empty) whenever the ranking is not available or not trustworthy — no tables, root
// outside TB cardinality, castling rights present (Fathom's Pos carries no castling
// state), a failed probe, or a Fathom move that does not match a generated legal. A false
// return means "fall back to the ordinary search", never "the position is a draw".
//
// On success `out` holds exactly one entry per legal move, in Fathom's order (the caller
// is expected to sort). `useRule50` is SF's Syzygy50MoveRule; `rankDTZ` is SF's flag for
// whether the DTZ distance breaks ties INSIDE the certain-win band (see the call site in
// search.cpp for zug's choice and why).
//
// THREAD SAFETY: safe to call concurrently. Fathom's DTZ path is not, so the probe itself
// is serialized on a mutex inside — see the comment on dtz_mutex() in zug_tb.cpp.
//
// `pos` is taken by non-const reference because the port needs SF's root-child draw
// correction (a move that repeats a third time or trips the 50-move rule is a draw, which
// Fathom cannot know — it has no game history). It is do_move/undo_move'd in balanced
// pairs and is byte-identical on return, with the NNUE accumulator detached across the
// walk so those probe moves never touch it.
bool rank_root_moves(Position& pos, bool useRule50, bool rankDTZ, std::vector<RootRank>& out);

}  // namespace TB
