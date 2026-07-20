#pragma once
#include "position.h"
#include "move.h"

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

// Root DTZ probe → a fully-encoded legal zug Move (matched against generated legals so
// promotion/ep/castling flags are correct), or MOVE_NONE on miss. NOT thread-safe
// (Fathom's DTZ path); call only at the root before search, single-threaded.
Move probe_root(const Position& pos);

}  // namespace TB
