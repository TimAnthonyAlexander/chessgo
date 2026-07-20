#include "nnue_accumulator.h"
#include "nnue_internal.h"
#include "nnue_net.h"
#include "nnue_features.h"
#include "position.h"

#include <cstring>
#include <cstdio>
#include <cstdlib>

namespace NNUE {

namespace {

// APPLYPREFETCH — software-prefetch upcoming FT weight columns in apply_diff's
// hot loop. Default OFF; APPLYPREFETCH=1 to enable. Mirrors threat_delta_enabled's
// env-read style: getenv runs exactly once per process via a lambda-initialized
// `static const bool`. See apply_diff below for the design + bit-exactness note.
bool apply_prefetch_enabled() {
    static const bool on = [] { const char* e = getenv("APPLYPREFETCH"); return e && e[0] == '1'; }();
    return on;
}

// LAZYACC (default OFF): gates the deferred-apply accumulator scheme documented on
// AccStack in nnue_accumulator.h. When off, every function below keeps EXACTLY its
// pre-LAZYACC body (the `else` branch of each `if (lazy_acc_enabled())`), so default
// behavior — including byte-for-byte search — is provably unchanged by this feature's
// existence. Same getenv-once-via-static-lambda style as the other env flags here.
bool lazy_acc_enabled() {
    static const bool on = [] { const char* e = getenv("LAZYACC"); return e && e[0] == '1'; }();
    return on;
}

// ftAdd / ftSub — add or subtract feature f's int16 FT weight column into a half.
// Mirrors gomachine ftAdd/ftSub (enriched.go): W0i is feature-major, W0i[f*H + i].
// int16 wraparound add/sub, exactly as the from-scratch buildAccHalf.
inline void ft_add(int16_t* acc, int f) {
    const int16_t* col = g_net.W0i.data() + static_cast<std::size_t>(f) * H;
    for (int i = 0; i < H; ++i) acc[i] += col[i];
}
inline void ft_sub(int16_t* acc, int f) {
    const int16_t* col = g_net.W0i.data() + static_cast<std::size_t>(f) * H;
    for (int i = 0; i < H; ++i) acc[i] -= col[i];
}

} // namespace

AccStack::AccStack() : slots_(NumSlots), counts_(static_cast<std::size_t>(InputTotal), 0) {
    for (Slot& s : slots_) {
        s.fw.reserve(MaxActive);
        s.fb.reserve(MaxActive);
    }
    scratch_.base.reserve(MaxActive);
    scratch_.threat.reserve(MaxActive);
    dSubW_.reserve(MaxActive);
    dAddW_.reserve(MaxActive);
    dSubB_.reserve(MaxActive);
    dAddB_.reserve(MaxActive);
    // LAZYACC: per-slot pending delta lists, reserved like the scratch above.
    for (Slot& s : slots_) {
        s.subW.reserve(MaxActive);
        s.addW.reserve(MaxActive);
        s.subB.reserve(MaxActive);
        s.addB.reserve(MaxActive);
    }
}

void AccStack::enumerate_flat(const Position& pos, Color persp, std::vector<int>& out) {
    active_features(pos, persp, scratch_); // fills scratch_.base + scratch_.threat
    out.clear();
    out.insert(out.end(), scratch_.base.begin(), scratch_.base.end());
    out.insert(out.end(), scratch_.threat.begin(), scratch_.threat.end());
}

void AccStack::build_half(int16_t* acc, const std::vector<int>& feats) const {
    const int16_t* B0 = g_net.B0i.data();
    for (int i = 0; i < H; ++i) acc[i] = B0[i];
    for (int f : feats) ft_add(acc, f);
}

// apply_diff: count-array multiset symmetric difference, byte-identical in RESULT to a
// from-scratch build of `child` (int16 column adds commute & associate). Decrement
// counts for parent features, increment for child, then apply the net per-feature delta,
// touching only active indices and zeroing them back out for the next call.
void AccStack::apply_diff(int16_t* acc, const std::vector<int>& parent, const std::vector<int>& child) {
    int16_t* c = counts_.data();
    for (int f : parent) --c[f];
    for (int f : child)  ++c[f];

    // APPLYPREFETCH: apply_diff is measured at ~26% of node self-time, and it
    // is memory-bandwidth-bound -- each ft_add/ft_sub streams a full H=512
    // int16 (1 KB) weight column out of `g_net.W0i`, a net far larger than
    // any cache, so essentially every column touch is a cold-cache miss. The
    // hot loop below already knows the FULL feature index list up front
    // (`list`), so before finishing the CURRENT feature's H-wide add/sub we
    // can issue a hardware prefetch hint for the NEXT feature's column,
    // overlapping that load's latency with the current column's arithmetic
    // instead of stalling on it serially.
    //
    // `pf` is read into a local ONCE, outside the loop (a `static const bool`
    // load is already cheap, but this removes even that from the per-feature
    // hot path when the flag is off) -- so with APPLYPREFETCH unset, the loop
    // body is exactly the pre-existing code: `if (pf && ...)` short-circuits
    // to false at compile-visible-constant-per-call cost and NO prefetch
    // instruction executes.
    //
    // Bit-exactness: __builtin_prefetch is a pure hint -- it touches cache
    // occupancy only, never a register or memory value the algorithm reads.
    // Whether the hinted next feature ends up applied (d != 0) or cancels to
    // 0 and is skipped is irrelevant to correctness; a "wasted" prefetch on a
    // feature that turns out to net to zero costs nothing but a little
    // memory bandwidth. The result of apply_diff is therefore identical for
    // every value of APPLYPREFETCH.
    const bool pf = apply_prefetch_enabled();
    const int16_t* W0 = g_net.W0i.data();

    auto apply = [&](const std::vector<int>& list) {
        const std::size_t n = list.size();
        for (std::size_t k = 0; k < n; ++k) {
            const int f = list[k];
            if (pf && k + 1 < n) {
                // Prefetch the next feature's column: first cache line
                // explicitly, second line too (H=512 int16 = 1 KB = 16 lines;
                // the HW stream prefetcher takes over extending past that).
                const int16_t* nextCol = W0 + static_cast<std::size_t>(list[k + 1]) * H;
                __builtin_prefetch(nextCol, /*rw=*/0, /*locality=*/3);
                __builtin_prefetch(reinterpret_cast<const char*>(nextCol) + 64, 0, 3);
            }
            int d = c[f];
            if (d == 0) continue;
            if (d > 0) { for (; d > 0; --d) ft_add(acc, f); }
            else       { for (; d < 0; ++d) ft_sub(acc, f); }
            c[f] = 0; // handled: cancels dups + leaves counts_ zeroed for the next call
        }
    };
    apply(parent);
    apply(child);
}

void AccStack::reset(const Position& pos) {
    sp_ = 0;
    Slot& s = slots_[0];
    enumerate_flat(pos, WHITE, s.fw);
    enumerate_flat(pos, BLACK, s.fb);
    build_half(s.w, s.fw);
    build_half(s.b, s.fb);
    // LAZYACC: slot 0 is materialized right here (eager, always — the root is read
    // immediately by the caller in practice, and reset() is cheap relative to search),
    // so mark it clean. materialize()'s walk-to-clean-ancestor loop terminates on slot 0
    // unconditionally because of this — it is the base case, on or off.
    s.clean = true;
}

void AccStack::push(const Position& pos) {
    Slot& dst = slots_[sp_ + 1];

    if (lazy_acc_enabled()) {
        // LAZYACC: push() is the full-enumerate (THREATDELTA=0) path — record it as a
        // full refresh of BOTH halves from the child's own feature set. This is exactly
        // what the eager body below computes (build_half from dst.fw/fb), just deferred
        // until materialize() actually needs this slot's w[]/b[]. The enumerate itself
        // (attack-gen, not the bottleneck) still happens now, since fw/fb must reflect
        // the position AS IT IS NOW (the child) — only the expensive build_half apply is
        // deferred.
        dst.refW = true;
        dst.refB = true;
        enumerate_flat(pos, WHITE, dst.fw);
        enumerate_flat(pos, BLACK, dst.fb);
        dst.clean = false;
        ++sp_;
        return;
    }

    Slot& src = slots_[sp_];
    enumerate_flat(pos, WHITE, dst.fw);
    enumerate_flat(pos, BLACK, dst.fb);
    std::memcpy(dst.w, src.w, sizeof(dst.w));
    std::memcpy(dst.b, src.b, sizeof(dst.b));
    apply_diff(dst.w, src.fw, dst.fw);
    apply_diff(dst.b, src.fb, dst.fb);
    ++sp_;
}

void AccStack::push_delta(const BoardSnapshot& oldb, const Position& pos) {
    Slot& dst = slots_[sp_ + 1];

    if (lazy_acc_enabled()) {
        // LAZYACC lazy push_delta: RECORD what apply would do, don't do it. The delta
        // lists computed by changed_edges_delta are a pure function of (oldb, pos) —
        // both boards are live RIGHT NOW (oldb is a snapshot taken before this move,
        // pos is the fully-formed child) — so computing them here and applying them
        // later (in materialize) yields the identical int16 result as computing AND
        // applying them here (int16 column add/sub commute & associate; see the class
        // comment / materialize below for the full argument). Only the expensive part
        // (memcpy + apply_diff's weight-column streaming) is deferred.
        //
        // LAZYACC and THREATGATE are mutually exclusive: THREATGATE's bucket-only-cross
        // fast path (bucketOnlyW/B, emit_base_swap) is a separate default-off experiment
        // layered on top of the refresh/delta split, and folding it into the lazy record
        // format would mean also deferring emit_base_swap's board reads correctly, which
        // is unnecessary complexity for a washed experiment. So when LAZYACC is on, we
        // always use the PLAIN refresh test (any bucket/mirror cross => full refresh),
        // never the bucket-only fast path — i.e. exactly the THREATGATE-unset behavior.
        const bool refreshW = perspective_bucket_key(BB::lsb(oldb.pieces(WHITE, KING)), WHITE)
                            != perspective_bucket_key(pos.king_square(WHITE), WHITE);
        const bool refreshB = perspective_bucket_key(BB::lsb(oldb.pieces(BLACK, KING)), BLACK)
                            != perspective_bucket_key(pos.king_square(BLACK), BLACK);

        dst.refW = refreshW;
        dst.refB = refreshB;
        dst.clean = false;
        dst.subW.clear(); dst.addW.clear();
        dst.subB.clear(); dst.addB.clear();

        // Non-refreshed halves: compute the delta NOW (boards are live), store it —
        // apply_diff runs later, in materialize(), on top of whatever the parent slot's
        // half turns out to be at that time.
        changed_edges_delta(oldb, pos, !refreshW, dst.subW, dst.addW, !refreshB, dst.subB, dst.addB);
        // Refreshed halves: enumerate the child's feature set NOW (pos is live) but defer
        // the actual build_half (bias + Σ ftAdd) to materialize().
        if (refreshW) enumerate_flat(pos, WHITE, dst.fw);
        if (refreshB) enumerate_flat(pos, BLACK, dst.fb);

        ++sp_;
        return;
    }

    Slot& src = slots_[sp_];

    const Square oldKW = BB::lsb(oldb.pieces(WHITE, KING));
    const Square oldKB = BB::lsb(oldb.pieces(BLACK, KING));
    const Square newKW = pos.king_square(WHITE);
    const Square newKB = pos.king_square(BLACK);

    // Per-perspective bucket/mirror cross. Only the moving side's king moved, so at most
    // one of crossW/crossB is true.
    const bool crossW = perspective_bucket_key(oldKW, WHITE) != perspective_bucket_key(newKW, WHITE);
    const bool crossB = perspective_bucket_key(oldKB, BLACK) != perspective_bucket_key(newKB, BLACK);

    // THREATGATE: on a cross where the MIRROR bit didn't flip (bucket-only cross), threat
    // indices for that perspective are unaffected (they depend only on the mirror — see
    // perspective_mirror), so keep the threat half on the cheap changed_edges_delta path
    // and swap only the base columns (emit_base_swap) instead of a full rebuild. When
    // THREATGATE is unset, `gate` is false, bucketOnly* is always false, and refresh* ==
    // cross* — i.e. exactly the pre-THREATGATE behavior below.
    const bool gate = threat_gate_enabled();
    const bool bucketOnlyW = gate && crossW && perspective_mirror(oldKW, WHITE) == perspective_mirror(newKW, WHITE);
    const bool bucketOnlyB = gate && crossB && perspective_mirror(oldKB, BLACK) == perspective_mirror(newKB, BLACK);

    // Full from-scratch refresh only on: a mirror-flipping cross, or (gate off) any cross.
    const bool refreshW = crossW && !bucketOnlyW;
    const bool refreshB = crossB && !bucketOnlyB;
    // Delta-path perspectives: non-crossing (legacy delta) OR bucket-only-cross (gated).
    const bool deltaW = !refreshW;
    const bool deltaB = !refreshB;

    // Changed base+threat edges for the perspectives that are NOT refreshed. For a
    // bucket-only-cross perspective, baseSkip* tells changed_edges_delta to emit ONLY the
    // threat delta (still correct — mirror unchanged) and skip its base-768 D-loop, since
    // emit_base_swap below does the full base swap for that perspective instead.
    dSubW_.clear(); dAddW_.clear(); dSubB_.clear(); dAddB_.clear();
    changed_edges_delta(oldb, pos, deltaW, dSubW_, dAddW_, deltaB, dSubB_, dAddB_,
                        /*baseSkipW=*/bucketOnlyW, /*baseSkipB=*/bucketOnlyB);
    if (bucketOnlyW || bucketOnlyB)
        emit_base_swap(oldb, pos, bucketOnlyW, dSubW_, dAddW_, bucketOnlyB, dSubB_, dAddB_);

    // White half: rebuild from scratch on a mirror-flipping cross, else copy parent + delta
    // (delta now includes the base swap for a bucket-only cross, folded into the same lists).
    if (refreshW) {
        enumerate_flat(pos, WHITE, dst.fw);
        build_half(dst.w, dst.fw);
    } else {
        std::memcpy(dst.w, src.w, sizeof(dst.w));
        apply_diff(dst.w, dSubW_, dAddW_); // sub decremented, add incremented
    }
    // Black half: same.
    if (refreshB) {
        enumerate_flat(pos, BLACK, dst.fb);
        build_half(dst.b, dst.fb);
    } else {
        std::memcpy(dst.b, src.b, sizeof(dst.b));
        apply_diff(dst.b, dSubB_, dAddB_);
    }
    // NOTE: in the delta path dst.fw/dst.fb are left stale for deltaed halves — nothing
    // reads them (the next push_delta / refresh / eval never consults a slot's feature
    // list; only the legacy full-enumerate push() does, and it is never mixed in when
    // THREATDELTA=1). reset() and refreshed halves keep their lists valid regardless.
    ++sp_;
}

void AccStack::pushNull() {
    Slot& dst = slots_[sp_ + 1];

    if (lazy_acc_enabled()) {
        // LAZYACC: a null move changes no piece placement, so both halves are exactly
        // the parent's halves unchanged. Record that as an EMPTY delta (refW=refB=false,
        // empty sub/add) rather than copying anything now; materialize() will memcpy the
        // (by-then-materialized) parent half and apply a no-op diff — i.e. a copy,
        // performed lazily. Byte-identical to the eager memcpy below, just deferred.
        dst.refW = false;
        dst.refB = false;
        dst.subW.clear(); dst.addW.clear();
        dst.subB.clear(); dst.addB.clear();
        dst.clean = false;
        ++sp_;
        return;
    }

    Slot& src = slots_[sp_];
    std::memcpy(dst.w, src.w, sizeof(dst.w));
    std::memcpy(dst.b, src.b, sizeof(dst.b));
    dst.fw = src.fw; // child of a null node diffs against these (== parent's set)
    dst.fb = src.fb;
    ++sp_;
}

// materialize (LAZYACC only): brings slots_[k].w[]/b[] up to date by replaying every
// recorded-but-not-yet-applied refresh/delta from the deepest clean ancestor down to k.
//
// Bit-exactness argument: each slot j's refW/refB + subW/addW/subB/addB (or fw/fb, for a
// refresh) were captured back in push/push_delta/pushNull at the moment that slot was
// pushed, from the SAME (oldb, child) board pair the eager path would have used at that
// exact call site — changed_edges_delta and enumerate_flat are pure functions of those
// boards, and boards don't change after the fact (do_move/undo_move keep the stack in
// lockstep, so a slot's boards are gone by the time we get here, but the recorded lists
// already captured everything the boards could tell us). Applying a slot's recorded
// delta on top of slot j-1's materialized half — whenever that ends up happening — is
// therefore identical to applying it immediately: apply_diff's int16 column add/sub
// commute and associate, so the RESULT depends only on the delta lists and the parent
// half's values, never on wall-clock timing of when apply_diff runs. Chaining that
// argument from the clean ancestor c up through k gives slots_[k] byte-identical to what
// eager push/push_delta/pushNull would have produced at each step along the way.
//
// Slot 0 is always clean (reset() sets it), so the `while` below always terminates.
void AccStack::materialize(int k) {
    int c = k;
    while (c > 0 && !slots_[c].clean) --c;

    for (int j = c + 1; j <= k; ++j) {
        Slot& s = slots_[j];
        Slot& p = slots_[j - 1];

        if (s.refW) {
            build_half(s.w, s.fw);
        } else {
            std::memcpy(s.w, p.w, sizeof(s.w));
            apply_diff(s.w, s.subW, s.addW);
        }
        if (s.refB) {
            build_half(s.b, s.fb);
        } else {
            std::memcpy(s.b, p.b, sizeof(s.b));
            apply_diff(s.b, s.subB, s.addB);
        }
        s.clean = true;
    }
}

int AccStack::eval(const Position& pos) {
    // LAZYACC: materialize the top slot on demand -- this is the ONLY place a dirty
    // slot's w[]/b[] are ever actually needed, so it's the only place we pay for the
    // deferred apply_diff work. Every wasted push (TT/terminal-cut child whose eval is
    // never read) never reaches here and never pays for it.
    if (lazy_acc_enabled()) materialize(sp_);

    Slot& top = slots_[sp_];

#ifdef NNUE_ASSERT
    // From-scratch rebuild of both halves — the incremental halves must match int16-exact.
    int16_t rw[H], rb[H];
    std::vector<int> fw, fb;
    fw.reserve(MaxActive);
    fb.reserve(MaxActive);
    enumerate_flat(pos, WHITE, fw);
    enumerate_flat(pos, BLACK, fb);
    build_half(rw, fw);
    build_half(rb, fb);
    for (int i = 0; i < H; ++i) {
        if (top.w[i] != rw[i] || top.b[i] != rb[i]) {
            std::fprintf(stderr,
                "NNUE acc drift sp=%d i=%d w(inc=%d fresh=%d) b(inc=%d fresh=%d) fen=%s\n",
                sp_, i, top.w[i], rw[i], top.b[i], rb[i], pos.fen().c_str());
            std::abort();
        }
    }
#endif

    return NNUE::eval_from_halves(top.w, top.b, pos);
}

} // namespace NNUE
