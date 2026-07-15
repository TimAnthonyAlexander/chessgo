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

    std::vector<Slot>    slots_;
    std::vector<int16_t> counts_;   // len InputTotal, kept all-zero between apply_diff calls
    Features             scratch_;  // reusable Features for enumerate_flat
    // Reusable per-perspective sub/add scratch for push_delta (capacity persists).
    std::vector<int>     dSubW_, dAddW_, dSubB_, dAddB_;
    int                  sp_ = 0;
};

} // namespace NNUE
