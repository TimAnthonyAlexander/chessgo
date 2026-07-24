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
//
// LAZYACC2 (default OFF, env-gated — see nnue_accumulator.cpp lazy_acc2_enabled;
// implies LAZYACC): LAZYACC still pays changed_edges_delta's ENUMERATION (~12.5% of
// node self-time) eagerly on every do_move, even for the majority of children cut
// before eval. LAZYACC2 defers that too: push_delta stores only the post-move board
// (Slot::childBoard) plus the (cheap, king-squares-only) refresh decision; the delta
// itself is recomputed in materialize() — only for slots an eval actually reaches —
// from the two stored boards via the BoardSnapshot overload of changed_edges_delta.
// Byte-identical to LAZYACC v1 (same two boards, same pure function, just called
// later instead of at push time) — see materialize()'s LAZYACC2 branch in the .cpp.
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

        // --- LAZYACC2 (default-off, see nnue_accumulator.cpp lazy_acc2_enabled) ---
        // The board AFTER this slot's move (== the next slot's pre-move `oldb`). Only
        // populated when LAZYACC2 is on: push/push_delta/pushNull store it instead of
        // eagerly enumerating changed_edges_delta; materialize() recomputes a dirty
        // slot's delta from (parent.childBoard, this.childBoard) on demand. ~136 bytes;
        // unused (never read) when LAZYACC2 is off.
        BoardSnapshot        childBoard;

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

        // --- FINNY (default-off, see nnue_accumulator.cpp finny_enabled) ---
        // Each perspective's own king square AT this slot, always populated (regardless
        // of FINNY) by push/push_delta/pushNull/reset from the live board at the moment
        // the slot is formed. Cheap (two king_square() lsb reads) and harmless when FINNY
        // is off. materialize() has no live Position to re-derive this from when a
        // refreshed half is finally built, so it is captured up front instead.
        Square kingW = SQ_NONE, kingB = SQ_NONE;
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

    // FINNY (default OFF, see nnue_accumulator.cpp finny_enabled) — an accumulator
    // refresh cache ("Finny tables", after Koivisto's Luecx; ported from Stockfish's
    // AccumulatorCaches::Cache, nnue_accumulator.h). `feats` is base-refresh call site's
    // FULL active feature list (base ++ threat, exactly what build_half would consume) —
    // base indices live in [0, PsqSize), threat in [PsqSize, InputTotal) (nnue_arch.h),
    // disjoint ranges, so partitioning by that threshold recovers the same base/threat
    // split active_features produced without needing to re-derive it from the board.
    //
    // Design: one FinnyEntry per (king square, perspective) — 64 * 2 — keyed by the
    // LITERAL king square (not the coarser bucket|mirror key perspective_bucket_key
    // returns), mirroring SF's Cache<Size>::entries[SQUARE_NB][COLOR_NB] exactly. This is
    // valid because base_index(x, aRel, pt0, sq) with x = make_xform(ksq, persp) depends
    // on ksq/persp ONLY through x.off/x.orient — a pure function of (ksq, persp) alone —
    // so every base feature this perspective can ever emit while its king sits on `ksq`
    // is a pure function of (piece color-relative-to-persp, piece type, piece square);
    // nothing else about the rest of the board matters. A cached entry is therefore
    // reusable across completely unrelated positions that merely share this perspective's
    // king square.
    //
    // Diffing is done in FEATURE-INDEX space, not board/mailbox space (unlike SF's
    // get_changed_pieces): the entry remembers the base feature LIST it was last built
    // from; a fresh use computes the current base feature list (already partitioned out
    // of `feats` above) and hands (cached list, current list) to the SAME apply_diff
    // multiset-symmetric-difference primitive every other incremental path in this file
    // already relies on for bit-exactness (int16 column add/sub commute & associate, so
    // the result is independent of how the diff was computed or in what order it's
    // applied). This sidesteps needing a stored board/mailbox at all.
    //
    // Threats are NEVER cached (SF doesn't cache them either — its Finny cache covers
    // only the non-threat PSQFeatureSet accumulator, see nnue_feature_transformer.h's
    // separate PSQ/Threat AccumulatorStates): this call's threat sublist is added on top
    // of the (possibly-cached) base contribution via a plain ft_add loop, every time.
    //
    // Bit-exactness: acc == B0 + Σ_{f in feats} W0[f], grouped into two passes (base via
    // the cache's telescoped diff history, threat via a direct sum) instead of one pass
    // over the full list — int16 addition is commutative/associative, so regrouping by
    // base-vs-threat and by "already applied via a prior diff" vs "applied now" cannot
    // change the total. Equivalent to build_half(feats) provided the cache's remembered
    // feature list for (ksq, persp) truly reflects everything applied to its acc[] so far
    // — guaranteed by construction (every write path updates both together) and reset at
    // every clear_finny() (called from reset(), each new search root) so no cache entry
    // ever survives across searches.
    void build_half_finny(int16_t* acc, const std::vector<int>& feats, Square ksq, Color persp);

    // clear_finny resets every FinnyEntry to the "empty board" state (bias only, empty
    // base feature list) — called from reset() so no cache entry survives across a new
    // search root. The very first use of each entry thereafter is a full diff against
    // empty (== a full build), byte-identical to build_half's first-touch cost; only
    // later touches of that same king square/perspective get the cheap-diff benefit.
    void clear_finny();

    // ACCFUSE (default OFF, see nnue_accumulator.cpp acc_fuse_enabled): a fused/tiled
    // apply_diff. Each net-nonzero feature's column is expanded (by |delta| copies of
    // its pointer) into fuseAdd_ (delta>0) or fuseSub_ (delta<0) once, then the H-wide
    // accumulator is walked in TILE-sized chunks; within a tile, every column in both
    // lists is folded via pure int16 add/sub into a small stack buffer (ONE read and
    // ONE write of acc[i] per index, native int16 SIMD in the inner loop -- no int32
    // widen, no multiply). See apply_diff's ACCFUSE branch for the bit-exactness
    // argument and the amd64 int32-multiply regression this design avoids.
    static constexpr int AccFuseTile = 32;
    std::vector<const int16_t*> fuseAdd_, fuseSub_;

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

    // FINNY cache — one entry per (king square, perspective); see build_half_finny above.
    struct FinnyEntry {
        alignas(64) int16_t acc[H];  // bias + Σ cached base-feature columns (never threats)
        std::vector<int>    feats;   // the base feature list `acc` reflects (all < PsqSize)
    };
    FinnyEntry finny_[SQUARE_NB][COLOR_NB];
    // Reusable partition scratch for build_half_finny (capacity persists).
    std::vector<int> finnyBase_, finnyThreat_;

    int                  sp_ = 0;
};

} // namespace NNUE
