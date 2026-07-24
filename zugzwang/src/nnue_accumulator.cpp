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
    // SHIPPED arch-gated 2026-07-25: +1.44% NPS amd64 (se 0.65%, 17/24), byte-identical
    // (ASSERT-clean). The prefetch hint is x86-tuned — FT-column indices are feature-scattered,
    // not a stream the HW prefetcher already covers; arm64 benefit is unproven and the win is
    // marginal, so default-ON amd64 only. env APPLYPREFETCH=1/0 forces either arch.
    static const bool on = [] {
        const char* e = getenv("APPLYPREFETCH");
        if (e) return e[0] == '1';
#if defined(__aarch64__) || defined(__ARM_NEON)
        return false;   // arm64: unproven, default OFF
#else
        return true;    // amd64/x86: +1.44% NPS, default ON
#endif
    }();
    return on;
}

// LAZYACC (default ON — banked win): gates the deferred-apply accumulator scheme
// documented on AccStack in nnue_accumulator.h. When disabled (LAZYACC=0), every
// function below keeps EXACTLY its pre-LAZYACC body (the `else` branch of each
// `if (lazy_acc_enabled())`), so the eager path remains as a byte-identical fallback /
// debug oracle. Same getenv-once-via-static-lambda style as the other env flags here.
//
// Proven: byte-identical to eager (identical node counts + bestmoves, ASSERT-clean),
// measured +7.2% NPS on amd64 (coalla, 573.6k -> 615.0k mean, above the ~3% noise floor)
// and +17.8 +/- 13.0 Elo movetime SPRT @ 802 games (LLR climbing). Deferring the ~26%-of-
// node-time apply_diff for the majority of do_moves whose children are cut before eval
// (measured eval/do_move ratio 0.74 midgame, 0.12 endgame). LAZYACC=0 reverts to eager.
// LAZYACC2 (default OFF): extends LAZYACC by ALSO deferring changed_edges_delta's
// ENUMERATION (not just apply_diff) for a push_delta'd slot until materialize() reaches
// it. See nnue_accumulator.h's class-comment addendum + materialize()'s LAZYACC2 branch
// below for the full design/bit-exactness argument. LAZYACC2 requires LAZYACC — it is
// declared BEFORE lazy_acc_enabled() below so that function can fold it in (LAZYACC2=1
// implies lazy_acc_enabled()==true even if LAZYACC=0 was also set; LAZYACC2=0, the
// default, leaves lazy_acc_enabled() completely unaffected).
bool lazy_acc2_enabled() {
    // Default ON (banked): +14.6 +/- 11.1 Elo movetime SPRT @ 904 games (LLR climbing),
    // byte-identical. Defers the changed_edges_delta enumeration (12.5% of node self-time)
    // for the 26-88% of do_moves cut before eval, on top of LAZYACC's apply_diff deferral.
    // LAZYACC2=0 reverts to LAZYACC v1 (eager enumeration, lazy apply).
    static const bool on = [] { const char* e = getenv("LAZYACC2"); return !(e && e[0] == '0'); }();
    return on;
}

bool lazy_acc_enabled() {
    static const bool on = [] { const char* e = getenv("LAZYACC"); return !(e && e[0] == '0'); }();
    return on || lazy_acc2_enabled();
}

// ACCFUSE (default OFF): fused/tiled apply_diff. Profiling shows apply_diff at ~26.9%
// of node self-time and memory-bandwidth-bound: ft_add/ft_sub each stream an entire
// H=512 int16 (1 KB) weight column, but the current `apply` lambda does so as K
// SEPARATE full-H passes, one per net-nonzero feature -- every pass both reads AND
// writes the SAME acc[] array, so pass k+1 has a true RAW dependency on pass k's
// stores and the K cold column loads are forced to serialize behind that dependency
// chain instead of overlapping their memory latency.
//
// The fused path instead TILES over H (AccFuseTile-wide chunks, matching SF18's/
// Stormphrax's SIMD-tile approach ported to our int16 layout): for each tile it reads
// acc[] ONCE into a small int16 stack buffer, folds EVERY column's contribution into
// that buffer with a plain contiguous per-column add/sub loop, then writes acc[] back
// ONCE -- the RAW dependency between successive columns is against the tiny buffer
// (register/L1-resident for the whole tile) instead of against acc[] sitting behind
// each column's cold-cache-miss load, so the K column streams can issue back-to-back.
//
// int16-only, no multiply: an earlier revision accumulated in an `int32 buf` via
// `buf[i] += delta*(int)col[i]` -- correct, but on amd64 the compiler widens
// int16->int32 + vpmulld per element (~6x the instructions of the original's plain
// int16 vpaddw/vpsubw), went compute-bound, REGRESSED -64% NPS. This int16 version
// (delta expanded once at collect time into |delta| pointer copies in an ADD list or a
// SUB list, tile loop then pure `buf[i]+=col[i]` / `-=col[i]` = ft_add's/ft_sub's own
// int16 body) removes the multiply -- but STILL regressed -48% on amd64.
//
// ARCH-GATED TO ARM64 (2026-07-20, measured): the fusion is a genuine +30% NPS win on
// arm64 (M3, best-of-5: startpos 654k->869k, midgame 683k->888k) but a LOSS on amd64
// (coalla: int32 -64%, int16 -48%). Root cause is architectural, not an impl bug: on
// amd64 the original per-feature `for(i<H) acc[i]+=col[i]` already lowers to optimal
// vpaddw %zmm, and the server core's out-of-order engine + hardware prefetchers already
// hide the acc[] RAW round-trips -- there is simply no serialization latency left to
// recover, so the fused buffer's extra load/store layer only adds overhead. On M-series
// arm the memory latency is high enough that de-serializing the cold column loads pays.
// (SF's SIMDTiling helps SF because it register-tiles a MULTI-accumulator update -- acc
// + psqt + Finny -- a different, register-pressure-bound pattern than our single int16
// half's simple add loop; it does not imply a win for our shape on amd64.) So we compile
// the fused path in and default it ON only on arm64; on amd64/other it is a no-op and
// apply_diff always takes the original path. Byte-identical either way (identical node
// counts + bestmoves, ASSERT-clean incl. with LAZYACC). Set ACCFUSE=0 to force off on
// arm (debug/oracle).
//
// Bit-exactness: index-for-index the SAME sequence of int16 wraparound adds/subs the
// eager path performs, just accumulated into a tile buffer and grouped by index instead
// of by feature. int16 add/sub under two's-complement wraparound is a ring homomorphism
// from int, so regrouping/reordering cannot change the result.
bool acc_fuse_enabled() {
#if defined(__aarch64__) || defined(__ARM_NEON)
    // arm64: default ON (proven +30% NPS, byte-identical). ACCFUSE=0 disables.
    static const bool on = [] { const char* e = getenv("ACCFUSE"); return !(e && e[0] == '0'); }();
#else
    // amd64/other: always OFF -- the fused path regresses here (see comment above).
    static const bool on = false;
#endif
    return on;
}

// FINNY: accumulator refresh cache ("Finny tables") for the BASE (non-threat) half only.
// See AccStack::build_half_finny's doc comment (nnue_accumulator.h) for the full design +
// bit-exactness argument. Byte-identical either way (ASSERT-clean + node/score match).
// ARCH-GATED like ACCFUSE (2026-07-25): the base-refresh cache pays on arm64 but not amd64.
//   arm64: default ON  — measured +1-2% NPS (M3), byte-identical.
//   amd64: default OFF — measured -1.25% NPS on coalla (the per-refresh feature-list diff +
//          131 KB/context cache costs more than the fast-SIMD base re-enum it replaces, and
//          LAZYACC2 already thins refreshes). env FINNY=1/0 forces on/off on either arch.
bool finny_enabled() {
    static const bool on = [] {
        const char* e = getenv("FINNY");
        if (e) return e[0] == '1';            // explicit override on any arch
#if defined(__aarch64__) || defined(__ARM_NEON)
        return true;                          // arm64: default ON
#else
        return false;                         // amd64/other: default OFF
#endif
    }();
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
    // ACCFUSE: bounded by parent.size()+child.size() expanded by |delta| copies each
    // (delta is tiny -- usually +/-1, rarely +/-2 -- so 4*MaxActive is generous slack).
    fuseAdd_.reserve(static_cast<std::size_t>(4 * MaxActive));
    fuseSub_.reserve(static_cast<std::size_t>(4 * MaxActive));
    // LAZYACC: per-slot pending delta lists, reserved like the scratch above.
    for (Slot& s : slots_) {
        s.subW.reserve(MaxActive);
        s.addW.reserve(MaxActive);
        s.subB.reserve(MaxActive);
        s.addB.reserve(MaxActive);
    }
    // FINNY: base sublists are at most MaxActive (== the full base ++ threat bound);
    // reserve generously since the exact base-only bound (<=32 pieces) is smaller. NOTE:
    // clear_finny() (which reads g_net.B0i) is deliberately NOT called here -- a Context
    // (and this AccStack) can be constructed before NNUE::load() has run/succeeded (e.g.
    // the HCE-fallback case), at which point g_net.B0i is empty. clear_finny() is instead
    // called from reset(), which is only ever invoked when useAcc (== NNUE::loaded()) is
    // true (search.cpp: `if (useAcc) { C.accStack.reset(pos); ... }`), so g_net is
    // guaranteed fully populated by the time it runs.
    finnyBase_.reserve(MaxActive);
    finnyThreat_.reserve(MaxActive);
    for (auto& row : finny_)
        for (FinnyEntry& e : row)
            e.feats.reserve(MaxActive);
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

// build_half_finny — see the doc comment on the declaration (nnue_accumulator.h) for the
// full design/bit-exactness argument. Partitions `feats` (the exact list build_half would
// consume) into base ([0, PsqSize)) and threat ([PsqSize, InputTotal)) sublists using the
// disjoint-range invariant active_features/nnue_arch.h guarantee, diffs the base sublist
// against the (ksq, persp) cache entry's remembered base list via the shared apply_diff
// multiset-symmetric-difference primitive, then adds this call's threat sublist on top of
// the (now up-to-date) cached base contribution via a plain ft_add sum.
void AccStack::build_half_finny(int16_t* acc, const std::vector<int>& feats, Square ksq, Color persp) {
    finnyBase_.clear();
    finnyThreat_.clear();
    for (int f : feats) {
        if (f < PsqSize) finnyBase_.push_back(f);
        else             finnyThreat_.push_back(f);
    }

    FinnyEntry& e = finny_[ksq][persp];
    apply_diff(e.acc, e.feats, finnyBase_); // cached base feature set -> current base set
    e.feats = finnyBase_;                   // remember what e.acc now reflects

    std::memcpy(acc, e.acc, sizeof(int16_t) * H);
    for (int f : finnyThreat_) ft_add(acc, f); // threats are never cached (see doc comment)
}

// clear_finny — reset every FinnyEntry to the "empty board" state (bias only, empty base
// feature list), so no cache entry survives across a new search root. Called from reset().
void AccStack::clear_finny() {
    const int16_t* B0 = g_net.B0i.data();
    for (int s = 0; s < SQUARE_NB; ++s) {
        for (int c = 0; c < COLOR_NB; ++c) {
            FinnyEntry& e = finny_[s][c];
            std::memcpy(e.acc, B0, sizeof(int16_t) * H);
            e.feats.clear();
        }
    }
}

// apply_diff: count-array multiset symmetric difference, byte-identical in RESULT to a
// from-scratch build of `child` (int16 column adds commute & associate). Decrement
// counts for parent features, increment for child, then apply the net per-feature delta,
// touching only active indices and zeroing them back out for the next call.
void AccStack::apply_diff(int16_t* acc, const std::vector<int>& parent, const std::vector<int>& child) {
    int16_t* c = counts_.data();
    for (int f : parent) --c[f];
    for (int f : child)  ++c[f];

    if (acc_fuse_enabled()) {
        // ACCFUSE: collect the net-nonzero features first -- same clearing discipline
        // as the eager `apply` lambda below (c[f] = 0 once handled, so counts_ is left
        // all-zero for the next call) -- but instead of an (col,delta) pair, expand
        // delta HERE into |delta| repeated pointer copies of the column: d>0 pushes d
        // copies into fuseAdd_, d<0 pushes |d| copies into fuseSub_. delta is tiny
        // (usually +/-1, rarely +/-2), so this is a handful of extra pointers, not a
        // hot-path cost -- and it lets the tile loop below be PURE int16 add/sub with
        // no multiply (see acc_fuse_enabled's comment for why that matters on amd64).
        const int16_t* W0 = g_net.W0i.data();
        fuseAdd_.clear();
        fuseSub_.clear();
        auto collect = [&](const std::vector<int>& list) {
            for (int f : list) {
                const int d = c[f];
                if (d == 0) continue;
                const int16_t* col = W0 + static_cast<std::size_t>(f) * H;
                if (d > 0) { for (int k = 0; k < d; ++k)  fuseAdd_.push_back(col); }
                else       { for (int k = 0; k < -d; ++k) fuseSub_.push_back(col); }
                c[f] = 0;
            }
        };
        collect(parent);
        collect(child);

        // Tile over H: for each tile, read acc[] ONCE into a small int16 stack buffer,
        // fold every ADD column in with plain `buf[i] += col[i]` then every SUB column
        // with `buf[i] -= col[i]` (both contiguous, fixed trip count AccFuseTile, unit
        // stride -- auto-vectorizes to native int16 SIMD, vpaddw/vpsubw on amd64, NEON
        // on arm64, no widen and no multiply anywhere), then write acc[] back ONCE.
        // This is what de-serializes the column loads: the RAW dependency between
        // successive columns is now against the tiny buffer (register/L1-resident for
        // the whole tile) instead of against acc[] sitting behind each column's cold-
        // cache-miss load, so the column streams can issue back-to-back instead of
        // waiting turn for a shared memory location.
        const std::size_t nAdd = fuseAdd_.size();
        const std::size_t nSub = fuseSub_.size();
        const int16_t* const* addList = fuseAdd_.data();
        const int16_t* const* subList = fuseSub_.data();
        int16_t buf[AccFuseTile];
        for (int t = 0; t < H; t += AccFuseTile) {
            const int tend = t + AccFuseTile < H ? t + AccFuseTile : H;
            const int tw = tend - t;
            for (int i = 0; i < tw; ++i) buf[i] = acc[t + i];
            for (std::size_t k = 0; k < nAdd; ++k) {
                const int16_t* col = addList[k] + t;
                for (int i = 0; i < tw; ++i) buf[i] += col[i];
            }
            for (std::size_t k = 0; k < nSub; ++k) {
                const int16_t* col = subList[k] + t;
                for (int i = 0; i < tw; ++i) buf[i] -= col[i];
            }
            for (int i = 0; i < tw; ++i) acc[t + i] = buf[i];
        }
        return;
    }

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
    // FINNY: a new search root starts a fresh cache lifetime — no entry may survive
    // across searches (see clear_finny()'s doc comment / build_half_finny's design note
    // in the header). Gated on finny_enabled() purely to keep reset() a zero-overhead
    // no-op for the default-off path (128 entries' worth of memcpy otherwise); harmless
    // either way since finny_ is only ever read/written when finny_enabled() is true.
    if (finny_enabled()) clear_finny();
    Slot& s = slots_[0];
    s.kingW = pos.king_square(WHITE);
    s.kingB = pos.king_square(BLACK);
    enumerate_flat(pos, WHITE, s.fw);
    enumerate_flat(pos, BLACK, s.fb);
    if (finny_enabled()) {
        build_half_finny(s.w, s.fw, s.kingW, WHITE);
        build_half_finny(s.b, s.fb, s.kingB, BLACK);
    } else {
        build_half(s.w, s.fw);
        build_half(s.b, s.fb);
    }
    // LAZYACC: slot 0 is materialized right here (eager, always — the root is read
    // immediately by the caller in practice, and reset() is cheap relative to search),
    // so mark it clean. materialize()'s walk-to-clean-ancestor loop terminates on slot 0
    // unconditionally because of this — it is the base case, on or off.
    s.clean = true;
    // LAZYACC2: slot 0's childBoard is the "parent" board the first push/push_delta's
    // materialize recompute will read; only meaningful (and only ever read) when
    // LAZYACC2 is on, so skip the fill otherwise.
    if (lazy_acc2_enabled()) pos.fill_board_snapshot(s.childBoard);
}

void AccStack::push(const Position& pos) {
    Slot& dst = slots_[sp_ + 1];
    // FINNY: always record the child's own king squares (cheap — two lsb reads) so
    // materialize()'s later build_half_finny call (LAZYACC path) has a live-Position-free
    // way to know which cache entry to use for this slot's eventual refresh.
    dst.kingW = pos.king_square(WHITE);
    dst.kingB = pos.king_square(BLACK);

    if (lazy_acc_enabled()) {
        // LAZYACC: push() is the full-enumerate (THREATDELTA=0) path — record it as a
        // full refresh of BOTH halves from the child's own feature set. This is exactly
        // what the eager body below computes (build_half from dst.fw/fb), just deferred
        // until materialize() actually needs this slot's w[]/b[]. The enumerate itself
        // (attack-gen, not the bottleneck) still happens now, since fw/fb must reflect
        // the position AS IT IS NOW (the child) — only the expensive build_half apply is
        // deferred.
        //
        // LAZYACC2: nothing to defer here beyond what LAZYACC v1 already defers — push()
        // has no changed_edges_delta call to postpone (THREATDELTA=0 never enumerates a
        // delta at all), so this branch is IDENTICAL under v1 and v2. Still snapshot
        // childBoard when LAZYACC2 is on, purely so the invariant "every slot's
        // childBoard is valid whenever LAZYACC2 is on" holds even in this rare
        // THREATDELTA=0 combination (defensive; push_delta is the only caller under the
        // default THREATDELTA=1, and process-wide THREATDELTA is a single cached flag,
        // so push()/push_delta() are never actually interleaved within one run).
        dst.refW = true;
        dst.refB = true;
        enumerate_flat(pos, WHITE, dst.fw);
        enumerate_flat(pos, BLACK, dst.fb);
        dst.clean = false;
        if (lazy_acc2_enabled()) pos.fill_board_snapshot(dst.childBoard);
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
    // FINNY: always record the child's own king squares up front — needed by
    // materialize()'s later build_half_finny call on a refreshed half (LAZYACC/LAZYACC2
    // paths defer the actual build_half that far, by which point `pos` is long gone).
    dst.kingW = pos.king_square(WHITE);
    dst.kingB = pos.king_square(BLACK);

    if (lazy_acc_enabled()) {
        if (lazy_acc2_enabled()) {
            // LAZYACC2: defer the ENUMERATION too, not just the apply. Store the
            // post-move board (dst.childBoard) and the refresh decision (cheap —
            // king squares only, identical test to LAZYACC v1 below) now; the delta
            // itself (changed_edges_delta) is NOT computed here — it's recomputed in
            // materialize() from the stored (parent.childBoard, this.childBoard) pair,
            // only for a slot an eval actually reaches. Same mutual-exclusivity with
            // THREATGATE as v1 (plain refresh test, never the bucket-only fast path).
            pos.fill_board_snapshot(dst.childBoard);

            const bool refreshW = perspective_bucket_key(BB::lsb(oldb.pieces(WHITE, KING)), WHITE)
                                != perspective_bucket_key(pos.king_square(WHITE), WHITE);
            const bool refreshB = perspective_bucket_key(BB::lsb(oldb.pieces(BLACK, KING)), BLACK)
                                != perspective_bucket_key(pos.king_square(BLACK), BLACK);

            dst.refW = refreshW;
            dst.refB = refreshB;
            dst.clean = false;

            // Refreshed halves: enumerate the child's feature set NOW (pos is live) but
            // defer build_half to materialize() — same as v1. Non-refreshed halves: do
            // NOTHING now (not even the delta lists) — materialize() computes them.
            if (refreshW) enumerate_flat(pos, WHITE, dst.fw);
            if (refreshB) enumerate_flat(pos, BLACK, dst.fb);

            ++sp_;
            return;
        }

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
        if (finny_enabled()) build_half_finny(dst.w, dst.fw, dst.kingW, WHITE);
        else                 build_half(dst.w, dst.fw);
    } else {
        std::memcpy(dst.w, src.w, sizeof(dst.w));
        apply_diff(dst.w, dSubW_, dAddW_); // sub decremented, add incremented
    }
    // Black half: same.
    if (refreshB) {
        enumerate_flat(pos, BLACK, dst.fb);
        if (finny_enabled()) build_half_finny(dst.b, dst.fb, dst.kingB, BLACK);
        else                 build_half(dst.b, dst.fb);
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
    // A null move changes no piece placement, so both king squares are unchanged.
    dst.kingW = slots_[sp_].kingW;
    dst.kingB = slots_[sp_].kingB;

    if (lazy_acc_enabled()) {
        if (lazy_acc2_enabled()) {
            // LAZYACC2: a null move changes no piece placement, so the child's board is
            // literally the parent's board — copy the stored childBoard across (not the
            // live Position; pos isn't even passed to pushNull). materialize() will call
            // changed_edges_delta(parent.childBoard, this.childBoard, ...) on two IDENTICAL
            // boards: D (the per-piece-type XOR) is 0, so affected==D==0 and both the
            // base-768 loop and every threat loop (enumerate/fast/sf alike — all gated on
            // D/affected) iterate zero times => empty sub/add lists => apply_diff is a
            // pure memcpy(parent->this), byte-identical to the eager memcpy below.
            dst.childBoard = slots_[sp_].childBoard;
            dst.refW = false;
            dst.refB = false;
            dst.clean = false;
            ++sp_;
            return;
        }

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
//
// LAZYACC2 addendum: under LAZYACC2, a dirty non-refresh half has NO recorded subW/
// addW/subB/addB — push_delta deferred the enumeration itself, storing only
// s.childBoard (+ p.childBoard, already valid regardless of p.clean — childBoard is
// populated unconditionally at push time, unlike w[]/b[]). This loop recomputes that
// half's delta HERE, via the BoardSnapshot overload of changed_edges_delta(p.childBoard,
// s.childBoard, ...), into the shared dSubW_/dAddW_/dSubB_/dAddB_ scratch (same members
// push_delta's v1 branch already reuses per-call), then applies it exactly like v1.
// Bit-exactness: (p.childBoard, s.childBoard) is the SAME board pair push_delta's v1
// branch would have called changed_edges_delta on immediately, at push time — the
// function is pure, so computing it now vs then yields identical sub/add lists, and
// apply_diff's int16 adds commute/associate regardless of when they run (same argument
// as the class-comment / v1 doc above, one level further deferred).
void AccStack::materialize(int k) {
    int c = k;
    while (c > 0 && !slots_[c].clean) --c;

    const bool v2 = lazy_acc2_enabled();
    for (int j = c + 1; j <= k; ++j) {
        Slot& s = slots_[j];
        Slot& p = slots_[j - 1];

        if (v2) {
            if (!s.refW || !s.refB) {
                dSubW_.clear(); dAddW_.clear();
                dSubB_.clear(); dAddB_.clear();
                changed_edges_delta(p.childBoard, s.childBoard,
                                    /*doW=*/!s.refW, dSubW_, dAddW_,
                                    /*doB=*/!s.refB, dSubB_, dAddB_);
            }
            if (s.refW) {
                if (finny_enabled()) build_half_finny(s.w, s.fw, s.kingW, WHITE);
                else                 build_half(s.w, s.fw);
            } else {
                std::memcpy(s.w, p.w, sizeof(s.w));
                apply_diff(s.w, dSubW_, dAddW_);
            }
            if (s.refB) {
                if (finny_enabled()) build_half_finny(s.b, s.fb, s.kingB, BLACK);
                else                 build_half(s.b, s.fb);
            } else {
                std::memcpy(s.b, p.b, sizeof(s.b));
                apply_diff(s.b, dSubB_, dAddB_);
            }
        } else {
            if (s.refW) {
                if (finny_enabled()) build_half_finny(s.w, s.fw, s.kingW, WHITE);
                else                 build_half(s.w, s.fw);
            } else {
                std::memcpy(s.w, p.w, sizeof(s.w));
                apply_diff(s.w, s.subW, s.addW);
            }
            if (s.refB) {
                if (finny_enabled()) build_half_finny(s.b, s.fb, s.kingB, BLACK);
                else                 build_half(s.b, s.fb);
            } else {
                std::memcpy(s.b, p.b, sizeof(s.b));
                apply_diff(s.b, s.subB, s.addB);
            }
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
