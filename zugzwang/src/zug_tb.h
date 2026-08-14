#pragma once
#include "position.h"
#include "move.h"
#include <vector>

// Syzygy endgame tablebase probing (Fathom, vendored in src/syzygy/). Ported from
// gomachine's internal/syzygy integration (measured +18.8 Elo root-DTZ + +30.5 Elo
// WDL-in-search). Position→Fathom bitboard mapping is 1:1 (both a1=0..h8=63 LERF).
namespace TB {

// Initialize from a Syzygy directory. Returns true iff at least one table loaded
// (TB_LARGEST > 0 after tb_init). Safe to call with an empty/absent path (returns false).
bool init(const char* path);

bool     loaded();      // true once init() succeeded
unsigned max_pieces();  // TB_LARGEST — probe only when popcount(occupied) <= this

// WDL probe for internal search nodes. Returns false on a miss/failed probe; on a hit
// sets `result` to a NORMALIZED verdict: +1 = win, 0 = draw, -1 = loss (Fathom's
// blessed-loss/cursed-win fold to draw, matching gomachine — the 50-move rule makes them
// draws). Caller MUST gate: castling_rights()==0 and popcount<=max_pieces(). Lock-free.
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
