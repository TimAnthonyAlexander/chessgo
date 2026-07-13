#pragma once
#include "types.h"

namespace Zobrist {
extern U64 psq[PIECE_NB][SQUARE_NB];
extern U64 enpassant[8];       // by file
extern U64 castling[16];       // by castling-rights mask
extern U64 side;               // side to move (applied when black)
void init();
}
