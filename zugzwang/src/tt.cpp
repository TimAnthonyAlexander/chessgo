#include "tt.h"
#include <cstdlib>
#include <cstring>
#if defined(__linux__)
#include <sys/mman.h>
#endif

TranspositionTable TT;

TranspositionTable::~TranspositionTable() { free(table); }

void TranspositionTable::resize(size_t mb) {
    free(table);
    size_t bytes = mb * 1024 * 1024;
    clusterCount = bytes / sizeof(Cluster);
    if (clusterCount == 0) clusterCount = 1;
    size_t allocBytes = clusterCount * sizeof(Cluster);
#if defined(__linux__)
    // Back the TT with transparent huge pages: the TT is a large, cache-cold,
    // random-access array, so 4 KB pages thrash the dTLB on every probe. 2 MB-align
    // the allocation and MADV_HUGEPAGE-advise it so the kernel collapses it into huge
    // pages (fewer dTLB misses on the search hot path). aligned_alloc requires size to
    // be a multiple of the alignment. Bit-exact: TT contents/indexing are unchanged —
    // this only changes the page size backing the same bytes (pure speed). NDEBUG-safe
    // no-op on kernels with THP disabled/never.
    const size_t hp = 2 * 1024 * 1024;
    size_t rounded = ((allocBytes + hp - 1) / hp) * hp;
    table = (Cluster*)aligned_alloc(hp, rounded);
    if (table) madvise(table, rounded, MADV_HUGEPAGE);
#else
    table = (Cluster*)aligned_alloc(64, allocBytes);
#endif
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
        int rDepth = replace->depth - ((generation - replace->gen()) & 0xF8);
        int eDepth = c.entry[i].depth - ((generation - c.entry[i].gen()) & 0xF8);
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
        tte->genBound = (uint8_t)(generation | (pv ? 4 : 0) | b); // gen(top5) | pv(bit2) | bound(low2)
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
