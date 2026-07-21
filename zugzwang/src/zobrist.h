#pragma once
#include "types.h"
#include "move.h"
#include <array>

namespace Zobrist {
extern U64 psq[PIECE_NB][SQUARE_NB];
extern U64 enpassant[8];       // by file
extern U64 castling[16];       // by castling-rights mask
extern U64 side;               // side to move (applied when black)
void init();

// Cuckoo upcoming-repetition detection (SF #15, Marcel van Kervinck's cuckoo
// algorithm — http://web.archive.org/web/20201107002606/https://marcelk.net/2013-04-06/paper/upcoming-rep-v2.pdf).
// Two hash tables mapping a reversible-move Zobrist delta back to the move that
// produces it, so a search node can detect "one move away from a 3-fold repeat"
// without a linear history scan. Populated once at the END of Zobrist::init();
// declared here (not static in zobrist.cpp) so both position.cpp (upcoming_repetition)
// and search.cpp (the two call sites) can reach them.
inline int H1(U64 h) { return int(h & 0x1fff); }
inline int H2(U64 h) { return int((h >> 16) & 0x1fff); }
extern std::array<U64, 8192>  cuckoo;
extern std::array<Move, 8192> cuckooMove;

// CUCKOO env flag, read once, default OFF. Gates: the do_move repetition-field
// calc (position.cpp) and both search call sites (search.cpp). Correctness-
// sensitive (a wrong draw-claim is a tactical blunder), so it must stay
// default-off until SPRT-verified. The cuckoo table init itself (Zobrist::init)
// is NOT gated — it's a one-time, board-independent startup cost, cheap and
// search-neutral regardless of this flag.
bool cuckoo_enabled();
}
