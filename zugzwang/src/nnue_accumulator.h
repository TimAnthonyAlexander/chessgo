#pragma once
#include <cstdint>
#include <vector>
#include "nnue_arch.h"
#include "nnue_features.h"
#include "types.h"

class Position;

namespace NNUE {

// AccStack — the per-search, ply-indexed INCREMENTAL feature-transformer accumulator
// that replaces the from-scratch buildAccHalf on every static eval. This is a C++ port
// of gomachine's EnrichedStack DEFAULT (non-move-aware) path: the "correct by
// construction" multiset-diff (enriched_acc.go:9-25). Per push it re-enumerates the
// child's full feature set (cheap — attack-gen is not the bottleneck) and applies only
// the MULTISET SYMMETRIC DIFFERENCE vs the parent's stored set, so the eval becomes a
// bare forward pass over the maintained halves. The move-aware O(changed-edges) delta
// (gomachine enriched_delta.go, "~14% NPS") is a later optimization that reuses this
// exact machinery.
//
// Correctness is by construction — the diff is the exact symmetric difference of two
// int16-column sets, and int16 column add/sub commute & associate, so the maintained
// half is byte-identical to a from-scratch rebuild regardless of order or of king-bucket
// crossings (a king move simply re-enumerates the moving side's whole base block into a
// new bucket copy; the diff subtracts every old-bucket base feature and adds every
// new-bucket one). Build with -DNNUE_ASSERT to check the invariant against a scratch
// rebuild at every eval.
//
// Lifecycle: the search owns one AccStack, attaches it to the Position for the duration
// of the search (Position::set_nnue_acc), and calls reset() at the root. Position's
// do_move/undo_move/do_null_move/undo_null_move then drive push/pushNull/pop in lockstep,
// so the top slot always corresponds to the current position. Outside search the
// Position carries no stack and every eval takes the from-scratch path (nnue_eval.cpp).
//
// LAZYACC (default OFF, env-gated — see nnue_accumulator.cpp lazy_acc_enabled): the
// eager scheme above pays apply_diff (~26% of node self-time) on EVERY do_move, but
// most children are cut (TT hit / terminal / beta cutoff) before their accumulator is
// ever read by eval() — measured eval/do_move ratio is 0.74 midgame, 0.12 endgame. When
// LAZYACC=1, push/push_delta/pushNull only RECORD the pending refresh-or-delta into the
// new top Slot and mark it dirty (clean=false); eval() materializes on demand, walking
// up from the deepest clean ancestor and replaying the recorded deltas in order. This is
// byte-identical to the eager result (same delta lists, same int16 adds, just applied
// later) — see the bit-exactness comment above materialize() in the .cpp.
class AccStack {
public:
    AccStack();

    // reset rebuilds slot 0 from scratch for pos and points the stack at it (sp = 0).
    void reset(const Position& pos);

    // push computes the child slot from its parent plus the CURRENT board. Call AFTER
    // Position::do_move has fully formed the child (pos is the child): it enumerates the
    // child's features and applies the multiset diff vs the parent slot.
    void push(const Position& pos);

    // push_delta is the move-aware O(changed-edges) variant of push (gated by
    // THREATDELTA=1): instead of re-enumerating the child's full feature set, it copies
    // the parent half and applies only the changed base+threat edges computed from the
    // pre-move board `oldb` (captured by do_move before it mutated Position) vs the child
    // `pos`. A perspective whose king crossed a bucket/mirror boundary is refreshed from
    // scratch (its delta would be invalid); the other is deltaed. Result is byte-identical
    // to push() — ASSERT gates the invariant.
    void push_delta(const BoardSnapshot& oldb, const Position& pos);

    // pushNull duplicates the top slot — a null move changes no piece placement, so the
    // (color-absolute) accumulator halves and feature sets are unchanged.
    void pushNull();

    // pop discards the top slot (call after Position::undo_move / undo_null_move).
    void pop() { --sp_; }

    // eval returns the static eval of the top accumulator, oriented to the side to move.
    // With -DNNUE_ASSERT it first checks the incremental halves against a from-scratch
    // rebuild (int16 => must be EXACTLY equal) and aborts on drift.
    int eval(const Position& pos);

private:
    // maxActive bounds active features per perspective — matches gomachine's
    // maxEnrichedActive (<=32 pieces + <=256 threat edges).
    static constexpr int MaxActive = 32 + 256;
    // Deepest reachable ply is bounded by MAX_PLY (search + qsearch share the ply
    // counter and stop at MAX_PLY); +8 slack for the child pushed at the deepest node.
    static constexpr int NumSlots = MAX_PLY + 8;

    struct Slot {
        alignas(64) int16_t w[H];      // White-perspective half (== B0i + Σ ftAdd(fw))
        alignas(64) int16_t b[H];      // Black-perspective half
        std::vector<int>    fw, fb;    // active (base++threat) features, UNSORTED, distinct

        // --- LAZYACC (default-off, see nnue_accumulator.cpp lazy_acc_enabled) ---
        // When lazy materialization is enabled, push/push_delta/pushNull no longer
        // populate w[]/b[] eagerly -- they only RECORD what would need to happen,
        // and `clean` tracks whether w[]/b[] currently hold that recorded result.
        // `materialize(k)` is the only place that ever turns a dirty slot clean.
        bool clean = false;                 // true iff w[]/b[] are up to date for this slot
        bool refW = false, refB = false;    // true => this half is a from-scratch refresh
                                             // (fw/fb hold the enumerated child features,
                                             // built via build_half); false => this half is
                                             // a delta from the parent (sub*/add* below,
                                             // applied via apply_diff on top of the parent's
                                             // materialized half).
        std::vector<int>    subW, addW;     // pending White delta lists (when !refW)
        std::vector<int>    subB, addB;     // pending Black delta lists (when !refB)
    };

    // enumerate_flat fills `out` with persp's active features as a single flat list
    // (base block then threat block — disjoint index ranges, so all indices are distinct).
    // Reuses the golden-verified active_features enumerator; `out`'s capacity persists.
    void enumerate_flat(const Position& pos, Color persp, std::vector<int>& out);

    // build_half rebuilds a half from scratch: bias then + every feature column.
    void build_half(int16_t* acc, const std::vector<int>& feats) const;

    // apply_diff applies the multiset symmetric difference (child − parent) to acc via
    // the count-array scratch (O(|parent|+|child|)); leaves counts_ all-zero for reuse.
    void apply_diff(int16_t* acc, const std::vector<int>& parent, const std::vector<int>& child);

    // materialize (LAZYACC only) brings slots_[k] up to date: walks up from k to the
    // deepest already-clean ancestor c (slot 0 is always clean after reset — the walk
    // always terminates), then replays the recorded refresh/delta at each depth c+1..k
    // in order, marking each slot clean as it goes. See nnue_accumulator.cpp for the
    // full correctness argument (bit-exactness vs the eager path).
    void materialize(int k);

    std::vector<Slot>    slots_;
    std::vector<int16_t> counts_;   // len InputTotal, kept all-zero between apply_diff calls
    Features             scratch_;  // reusable Features for enumerate_flat
    // Reusable per-perspective sub/add scratch for push_delta (capacity persists).
    std::vector<int>     dSubW_, dAddW_, dSubB_, dAddB_;
    int                  sp_ = 0;
};

} // namespace NNUE
