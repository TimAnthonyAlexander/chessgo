#pragma once
#include "position.h"
#include "move.h"

enum GenType { CAPTURES, QUIETS, ALL };

struct ExtMove {
    Move move;
    int  score;
    // histScore: cached butterfly+continuation-history sum for general quiets (set by
    // score_moves during ordering), reused by the LMR reduction read to avoid a second
    // conthist lookup. INT_MIN sentinel = "not cached" (ttMove/killer/counter/capture)
    // → LMR recomputes. Only consulted when the LMRHIST toggle is on.
    int  histScore;
    operator Move() const { return move; }
    void operator=(Move m) { move = m; }
};

struct MoveList {
    ExtMove moves[256];
    ExtMove* last;
    MoveList() : last(moves) {}
    ExtMove* begin() { return moves; }
    ExtMove* end() { return last; }
    const ExtMove* begin() const { return moves; }
    const ExtMove* end() const { return last; }
    size_t size() const { return last - moves; }
    void add(Move m) { (last++)->move = m; }
};

template <GenType T>
ExtMove* generate(const Position& pos, ExtMove* moveList);

// Convenience: fill a MoveList with pseudo-legal moves of a type
template <GenType T>
inline void generate(const Position& pos, MoveList& list) {
    list.last = generate<T>(pos, list.moves);
}
