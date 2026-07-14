#pragma once
#include "types.h"
#include "move.h"

enum Bound : uint8_t { BOUND_NONE = 0, BOUND_UPPER = 1, BOUND_LOWER = 2, BOUND_EXACT = 3 };

struct TTEntry {
    uint16_t key16;   // upper 16 bits of zobrist key
    Move     move;    // best move
    int16_t  value;   // score
    int16_t  eval;    // static eval
    uint8_t  depth;   // search depth
    uint8_t  genBound;// generation (6 bits) + bound (2 bits)

    Bound bound() const { return Bound(genBound & 3); }
    uint8_t gen() const { return genBound & ~3; }
};

class TranspositionTable {
public:
    ~TranspositionTable();
    void resize(size_t mb);
    void clear();
    void new_search() { generation += 4; }
    uint8_t gen() const { return generation; }

    TTEntry* probe(U64 key, bool& found) const;
    void store(TTEntry* tte, U64 key, int value, bool pv, Bound b, int depth, Move m, int eval);
    void prefetch(U64 key) const { __builtin_prefetch(&table[index(key)]); }

    int hashfull() const;

    // Adjust mate scores when storing/reading relative to root distance
    static int value_to_tt(int v, int ply);
    static int value_from_tt(int v, int ply);

private:
    static constexpr int ClusterSize = 4;
    struct alignas(64) Cluster { TTEntry entry[ClusterSize]; };
    Cluster* table = nullptr;
    size_t clusterCount = 0;
    uint8_t generation = 0;

    // Multiply-high mapping (Stockfish-style): avoids a 64-bit division on the
    // hottest path and works for any clusterCount (no power-of-two rounding).
    size_t index(U64 key) const {
        return (size_t)(((unsigned __int128)key * (unsigned __int128)clusterCount) >> 64);
    }
};

extern TranspositionTable TT;
