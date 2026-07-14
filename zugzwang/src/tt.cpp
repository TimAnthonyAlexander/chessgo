#include "tt.h"
#include <cstdlib>
#include <cstring>

TranspositionTable TT;

TranspositionTable::~TranspositionTable() { free(table); }

void TranspositionTable::resize(size_t mb) {
    free(table);
    size_t bytes = mb * 1024 * 1024;
    clusterCount = bytes / sizeof(Cluster);
    if (clusterCount == 0) clusterCount = 1;
    table = (Cluster*)aligned_alloc(64, clusterCount * sizeof(Cluster));
    clear();
}

void TranspositionTable::clear() {
    if (table) std::memset(table, 0, clusterCount * sizeof(Cluster));
    generation = 0;
}

int TranspositionTable::value_to_tt(int v, int ply) {
    if (v >= VALUE_MATE_IN_MAX_PLY) return v + ply;
    if (v <= -VALUE_MATE_IN_MAX_PLY) return v - ply;
    return v;
}

int TranspositionTable::value_from_tt(int v, int ply) {
    if (v == VALUE_NONE) return VALUE_NONE;
    if (v >= VALUE_MATE_IN_MAX_PLY) return v - ply;
    if (v <= -VALUE_MATE_IN_MAX_PLY) return v + ply;
    return v;
}

TTEntry* TranspositionTable::probe(U64 key, bool& found) const {
    Cluster& c = table[index(key)];
    // key16 MUST come from the LOW bits: the mul-high index() above is driven by
    // the HIGH bits of key, so a high-bit key16 (key>>48) would be correlated with
    // the cluster index — every key in a cluster would share it and collision
    // detection would collapse (Stockfish keys its verify on the low bits for the
    // same reason). uint16_t(key) is independent of index(key).
    uint16_t key16 = uint16_t(key);
    for (int i = 0; i < ClusterSize; ++i) {
        if (c.entry[i].key16 == key16 && c.entry[i].genBound) {
            found = true;
            return &c.entry[i];
        }
    }
    // Find entry to replace: lowest (depth - relative age)
    TTEntry* replace = &c.entry[0];
    for (int i = 1; i < ClusterSize; ++i) {
        int rDepth = replace->depth - ((generation - replace->gen()) & 0xFC);
        int eDepth = c.entry[i].depth - ((generation - c.entry[i].gen()) & 0xFC);
        if (rDepth > eDepth) replace = &c.entry[i];
    }
    found = false;
    return replace;
}

void TranspositionTable::store(TTEntry* tte, U64 key, int value, bool pv, Bound b,
                               int depth, Move m, int eval) {
    uint16_t key16 = uint16_t(key);  // low bits — independent of the mul-high index()
    // Preserve existing move if none supplied and same position
    if (m || tte->key16 != key16)
        tte->move = m;
    // Replace if deeper, different position, or exact bound
    if (b == BOUND_EXACT || tte->key16 != key16 || depth + 4 + (pv ? 2 : 0) > tte->depth) {
        tte->key16 = key16;
        tte->value = (int16_t)value;
        tte->eval = (int16_t)eval;
        tte->depth = (uint8_t)depth;
        tte->genBound = (uint8_t)(generation | b); // generation (upper bits) + bound (low 2)
    }
}

int TranspositionTable::hashfull() const {
    int cnt = 0;
    for (int i = 0; i < 1000 && i < (int)clusterCount; ++i)
        for (int j = 0; j < ClusterSize; ++j)
            if (table[i].entry[j].genBound && (table[i].entry[j].gen() == generation))
                cnt++;
    return cnt / ClusterSize;
}
