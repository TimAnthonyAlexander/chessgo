// SFNet incremental accumulator — Wave 4 of the SF-net experiment. Independent
// reimplementation; no Stockfish code is linked, copied or vendored. See
// docs/tasks/open/sf-net-experiment.md §B and docs/sfnet-wave4.md for the design and
// what the written spec got wrong.
//
// Implements the class declared in sfnet.h (SFNet::AccStack) — see that header's doc
// comment for the refresh rules. Reuses two pieces of already-verified machinery:
//   - the threat half's DELTA comes from NNUE::changed_edges_delta (nnue_features.cpp),
//     which is bit-identical to SF's FullThreats (proven Wave 2/3) — called with
//     baseSkipW=baseSkipB=true so it emits ONLY threat indices, never touching our own
//     net's base-768 space.
//   - the threat half's REFRESH GATE is NNUE::perspective_mirror (our own net's mirror
//     bit), which IS SF's FullThreats mirror bit too (both orient threats the same way
//     — see docs/sfnet-wave2.md §2's orientation proof).
// The base half's refresh/delta rules are NEW code (HalfKAv2_hm has no equivalent in
// our own net): ANY king move of a perspective forces a full rebuild of that half; a
// non-king-move's delta is derived directly from the changed squares (D = XOR of
// per-(color,type) occupancy bitboards — the same technique nnue_features.cpp's own
// base-768 D-loop already uses, just applied to HalfKAv2_hm's index formula instead of
// ours).

#include "sfnet_internal.h"
#include "sfnet_simd.h"
#include "nnue_features.h"
#include "nnue_arch.h"
#include "position.h"
#include "bitboard.h"
#include "types.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>

namespace SFNet {

namespace {

// SFNETPREFETCH — software-prefetch the NEXT feature's weight column while the
// arithmetic on the CURRENT one runs, in every loop that streams through
// net.weights (46 MB) or net.threatWeights (82 MB) — both far larger than any
// cache, so column touches here are cold-cache-miss-bound the same way our own
// net's apply_diff is (see nnue_accumulator.cpp's APPLYPREFETCH, "measured at
// ~26% of node self-time... memory-bandwidth-bound"). Wave 6's own `sample`
// profile on this machine shows the SAME shape: forward_pass (compute-bound,
// small cache-resident buffers) dropped ~37% after SIMD, but
// AccStack::delta_threat_apply (streaming the 82 MB array) did not shrink
// proportionally — consistent with it being latency/bandwidth-bound rather than
// ALU-bound, which is exactly the case a prefetch hint (not more vector width)
// addresses.
//
// Mirrors apply_prefetch_enabled()'s exact arch-gated convention (nnue_accumulator.cpp):
// the hint is x86-tuned (these column indices are feature-scattered, not a stream the
// HW prefetcher already covers); default ON amd64, default OFF arm64 (unproven benefit
// there — this machine can only measure arm64). SFNETPREFETCH=1/0 forces either arch.
bool sfnet_prefetch_enabled() {
    static const bool on = [] {
        const char* e = getenv("SFNETPREFETCH");
        if (e) return e[0] == '1';
#if defined(__aarch64__) || defined(__ARM_NEON)
        return false;   // arm64: unproven, default OFF
#else
        return true;    // amd64/x86: mirrors APPLYPREFETCH's shipped amd64 win
#endif
    }();
    return on;
}

// SFNETLAZYACC (Wave 9, default OFF — see docs/sfnet-wave9.md and the class comment on
// AccStack in sfnet.h): gates the deferred-apply accumulator scheme. When disabled
// (the default, or SFNETLAZYACC=0), every function below keeps EXACTLY its
// pre-SFNETLAZYACC body (the `else`/non-lazy branch), so the eager path remains a
// byte-identical fallback/debug oracle — same convention as nnue_accumulator.cpp's
// lazy_acc_enabled().
bool sfnet_lazyacc_enabled() {
    static const bool on = [] { const char* e = getenv("SFNETLAZYACC"); return e && e[0] == '1'; }();
    return on;
}

// Bit-exactness: __builtin_prefetch is a pure cache-occupancy hint — it never touches a
// register or a value the algorithm reads, so its presence or absence cannot change any
// accumulator's contents. Same argument as apply_diff's APPLYPREFETCH block.
inline void prefetch_col(const void* p) {
    __builtin_prefetch(p, /*rw=*/0, /*locality=*/3);
    __builtin_prefetch(reinterpret_cast<const char*>(p) + 64, 0, 3);
}

}  // namespace

AccStack::AccStack() : slots_(NumSlots) {}

// ---- full rebuilds --------------------------------------------------------------
//
// Wave 9: each rebuild is split into an ENUMERATION half (cheap — attack-gen/board
// scan, needs a live Position) and an APPLY half (expensive — streams weight columns
// out of the 46 MB / 82 MB weight arrays, needs only the already-enumerated index
// list). build_base/build_threat below are the eager composition of the two, used by
// reset() (always eager) and the non-lazy push()/push_delta() paths; SFNETLAZYACC's
// push()/push_delta() call the enumeration half now and defer the apply half to
// materialize() via apply_base_refresh/apply_threat_refresh.

void AccStack::threat_indices(const Position& pos, Color persp, std::vector<int>& out) const {
    NNUE::Features feat;
    NNUE::active_features(pos, persp, feat);
    out = feat.threat;  // SF-space threat indices, +NNUE::PsqSize offset (rebased on apply)
}

void AccStack::apply_base_refresh(HalfAcc& h, const std::vector<int>& feats) const {
    const Net& net = SFNet::net();
    std::memcpy(h.accumulation, net.biases.data(), sizeof(h.accumulation));
    std::memset(h.psqtAccumulation, 0, sizeof(h.psqtAccumulation));

    const bool pf = sfnet_prefetch_enabled();
    for (std::size_t n = 0; n < feats.size(); ++n) {
        const int i = feats[n];
        if (i < 0 || i >= PsqDims) die("base rebuild index out of range");
        if (pf && n + 1 < feats.size()) {
            const int ni = feats[n + 1];
            if (ni >= 0 && ni < PsqDims) prefetch_col(&net.weights[std::size_t(ni) * HalfDimensions]);
        }
        const std::int16_t* w = &net.weights[std::size_t(i) * HalfDimensions];
#if SFNET_USE_SIMD
        simd::col_add_i16<HalfDimensions>(h.accumulation, w);
#else
        for (int j = 0; j < HalfDimensions; ++j) h.accumulation[j] += w[j];
#endif
        const std::int32_t* p = &net.psqt[std::size_t(i) * PSQTBuckets];
        for (int k = 0; k < PSQTBuckets; ++k) h.psqtAccumulation[k] += p[k];
    }
}

void AccStack::apply_threat_refresh(HalfAcc& h, const std::vector<int>& feats) const {
    const Net& net = SFNet::net();
    std::memset(h.accumulation, 0, sizeof(h.accumulation));
    std::memset(h.psqtAccumulation, 0, sizeof(h.psqtAccumulation));

    const bool pf = sfnet_prefetch_enabled();
    for (std::size_t n = 0; n < feats.size(); ++n) {
        const int idx = feats[n] - NNUE::PsqSize;
        if (idx < 0 || idx >= ThreatDims) die("threat rebuild index out of range");
        if (pf && n + 1 < feats.size()) {
            const int ni = feats[n + 1] - NNUE::PsqSize;
            if (ni >= 0 && ni < ThreatDims) prefetch_col(&net.threatWeights[std::size_t(ni) * HalfDimensions]);
        }
        const std::int8_t* w = &net.threatWeights[std::size_t(idx) * HalfDimensions];
#if SFNET_USE_SIMD
        simd::col_add_i8widen_i16<HalfDimensions>(h.accumulation, w);
#else
        for (int j = 0; j < HalfDimensions; ++j) h.accumulation[j] += w[j];
#endif
        const std::int32_t* p = &net.threatPsqt[std::size_t(idx) * PSQTBuckets];
        for (int k = 0; k < PSQTBuckets; ++k) h.psqtAccumulation[k] += p[k];
    }
}

void AccStack::build_base(HalfAcc& h, const Position& pos, Color persp) const {
    const BaseTables& T = base_tables();
    std::vector<int> idx;
    base_indices(T, pos, persp, idx);
    apply_base_refresh(h, idx);
}

void AccStack::build_threat(HalfAcc& h, const Position& pos, Color persp) const {
    std::vector<int> feats;
    threat_indices(pos, persp, feats);
    apply_threat_refresh(h, feats);
}

// ---- deltas (non-king-move base; mirror-stable threat) --------------------------

// compute_base_delta — the enumeration half of delta_base: persp's OWN king did not
// move (caller guarantees this), so the base index's king-derived terms
// (flip/orient/bucket) are unchanged; only the D squares (pieces that actually
// changed) shift base columns. D is computed the same way nnue_features.cpp's
// changed_edges_delta computes it for its own (different-basis) base-768 loop: XOR of
// every (color, type) occupancy bitboard, old vs new — robust to castling / en
// passant / promotion without decoding move flags. Fills `sub`/`add` instead of
// applying — apply_base_delta does the (deferrable) column streaming.
void AccStack::compute_base_delta(const NNUE::BoardSnapshot& oldb, const Position& child, Color persp,
                                  std::vector<int>& sub, std::vector<int>& add) const {
    sub.clear();
    add.clear();
    const BaseTables& T = base_tables();
    const Square ksq = child.king_square(persp);  // == oldb's too; this perspective's king didn't move

    U64 D = 0;
    for (int c = WHITE; c <= BLACK; ++c)
        for (int pt = PAWN; pt <= KING; ++pt)
            D |= oldb.pieces(Color(c), PieceType(pt)) ^ child.pieces(Color(c), PieceType(pt));

    while (D) {
        const Square s = BB::pop_lsb(D);
        const Piece op = oldb.piece_on(s);
        const Piece np = child.piece_on(s);
        if (op != NO_PIECE) sub.push_back(make_base_index(T, persp, s, op, ksq));
        if (np != NO_PIECE) add.push_back(make_base_index(T, persp, s, np, ksq));
    }
}

// apply_base_delta — applies a base multiset delta (sub then add, same reordering
// argument as delta_threat_apply below: int16/int32 column add/sub commute and
// associate, so a two-pass sub-then-add is identical to compute_base_delta's original
// interleaved-per-square application).
void AccStack::apply_base_delta(HalfAcc& dst, const HalfAcc& src,
                                const std::vector<int>& sub, const std::vector<int>& add) const {
    dst = src;
    const Net& net = SFNet::net();
    for (int idx : sub) {
        if (idx < 0 || idx >= PsqDims) die("base delta index out of range (sub)");
        const std::int16_t* w = &net.weights[std::size_t(idx) * HalfDimensions];
#if SFNET_USE_SIMD
        simd::col_sub_i16<HalfDimensions>(dst.accumulation, w);
#else
        for (int j = 0; j < HalfDimensions; ++j) dst.accumulation[j] -= w[j];
#endif
        const std::int32_t* p = &net.psqt[std::size_t(idx) * PSQTBuckets];
        for (int k = 0; k < PSQTBuckets; ++k) dst.psqtAccumulation[k] -= p[k];
    }
    for (int idx : add) {
        if (idx < 0 || idx >= PsqDims) die("base delta index out of range (add)");
        const std::int16_t* w = &net.weights[std::size_t(idx) * HalfDimensions];
#if SFNET_USE_SIMD
        simd::col_add_i16<HalfDimensions>(dst.accumulation, w);
#else
        for (int j = 0; j < HalfDimensions; ++j) dst.accumulation[j] += w[j];
#endif
        const std::int32_t* p = &net.psqt[std::size_t(idx) * PSQTBuckets];
        for (int k = 0; k < PSQTBuckets; ++k) dst.psqtAccumulation[k] += p[k];
    }
}

// delta_base — the eager composition of compute_base_delta + apply_base_delta, used by
// the non-lazy push_delta() path.
void AccStack::delta_base(HalfAcc& dst, const HalfAcc& src, const NNUE::BoardSnapshot& oldb,
                          const Position& child, Color persp) const {
    std::vector<int> sub, add;
    compute_base_delta(oldb, child, persp, sub, add);
    apply_base_delta(dst, src, sub, add);
}

// delta_threat_apply — applies a threat multiset delta (SF-space indices, ThreatDims-
// wide) on top of the parent half. No count-array cancellation (unlike our own net's
// apply_diff, see nnue_accumulator.cpp) — a straight subtract-then-add of the same
// index still nets to the original value exactly (int16/int32 wraparound arithmetic is
// a ring, so (-x)+x == identity regardless of intermediate overflow); the count-array
// optimization is a Wave 6 perf concern, not a correctness one.
void AccStack::delta_threat_apply(HalfAcc& dst, const HalfAcc& src,
                                  const std::vector<int>& sub, const std::vector<int>& add) const {
    dst = src;
    const Net& net = SFNet::net();
    const bool pf = sfnet_prefetch_enabled();

    auto rebased = [](int v) { return v - NNUE::PsqSize; };
    for (std::size_t n = 0; n < sub.size(); ++n) {
        const int idx = rebased(sub[n]);
        if (idx < 0 || idx >= ThreatDims) die("threat delta index out of range (sub)");
        if (pf) {
            // Lookahead crosses into `add` once `sub` is exhausted, so the LAST sub
            // column's arithmetic overlaps the FIRST add column's fetch too.
            int ni = -1;
            if (n + 1 < sub.size()) ni = rebased(sub[n + 1]);
            else if (!add.empty())  ni = rebased(add[0]);
            if (ni >= 0 && ni < ThreatDims) prefetch_col(&net.threatWeights[std::size_t(ni) * HalfDimensions]);
        }
        const std::int8_t* w = &net.threatWeights[std::size_t(idx) * HalfDimensions];
#if SFNET_USE_SIMD
        simd::col_sub_i8widen_i16<HalfDimensions>(dst.accumulation, w);
#else
        for (int j = 0; j < HalfDimensions; ++j) dst.accumulation[j] -= w[j];
#endif
        const std::int32_t* p = &net.threatPsqt[std::size_t(idx) * PSQTBuckets];
        for (int k = 0; k < PSQTBuckets; ++k) dst.psqtAccumulation[k] -= p[k];
    }
    for (std::size_t n = 0; n < add.size(); ++n) {
        const int idx = rebased(add[n]);
        if (idx < 0 || idx >= ThreatDims) die("threat delta index out of range (add)");
        if (pf && n + 1 < add.size()) {
            const int ni = rebased(add[n + 1]);
            if (ni >= 0 && ni < ThreatDims) prefetch_col(&net.threatWeights[std::size_t(ni) * HalfDimensions]);
        }
        const std::int8_t* w = &net.threatWeights[std::size_t(idx) * HalfDimensions];
#if SFNET_USE_SIMD
        simd::col_add_i8widen_i16<HalfDimensions>(dst.accumulation, w);
#else
        for (int j = 0; j < HalfDimensions; ++j) dst.accumulation[j] += w[j];
#endif
        const std::int32_t* p = &net.threatPsqt[std::size_t(idx) * PSQTBuckets];
        for (int k = 0; k < PSQTBuckets; ++k) dst.psqtAccumulation[k] += p[k];
    }
}

// ---- SFNETLAZYACC materialize (Wave 9) -------------------------------------------
//
// Brings slots_[k]'s four halves up to date, each independently: walk back from k to
// the deepest ancestor already clean FOR THAT HALF (slot 0 is always clean for all
// four — reset() marks it so — so each walk terminates), then replay the recorded
// refresh/delta forward from there, marking each slot clean for that half as it goes.
//
// Bit-exactness: identical argument to NNUE::AccStack::materialize
// (nnue_accumulator.cpp) — every slot's refPsq/refThr + psqFeats/thrFeats (refresh) or
// psqSub/psqAdd/thrSub/thrAdd (delta) were captured back in push/push_delta/pushNull
// from the SAME (oldb, child) board pair the eager path would have used at that exact
// call site (base_indices, threat_indices/active_features and compute_base_delta/
// changed_edges_delta are pure functions of those boards). Applying a slot's recorded
// refresh/delta on top of the parent's materialized half — whenever that ends up
// happening — is identical to applying it immediately, since apply_base_refresh/
// apply_threat_refresh/apply_base_delta/delta_threat_apply's column adds/subs commute
// and associate (same ring argument used throughout this codebase). Chaining that from
// each half's clean ancestor up through k gives slots_[k] byte-identical to what eager
// push/push_delta/pushNull would have produced at each step along the way.
void AccStack::materialize(int k) {
    for (int c = WHITE; c <= BLACK; ++c) {
        // Base half.
        {
            int a = k;
            while (a > 0 && !slots_[a].cleanPsq[c]) --a;
            for (int j = a + 1; j <= k; ++j) {
                Slot& s = slots_[j];
                Slot& p = slots_[j - 1];
                if (s.refPsq[c]) apply_base_refresh(s.psq[c], s.psqFeats[c]);
                else             apply_base_delta(s.psq[c], p.psq[c], s.psqSub[c], s.psqAdd[c]);
                s.cleanPsq[c] = true;
            }
        }
        // Threat half — independent clean ancestor, since its refresh gate (mirror bit)
        // differs from the base's (any king move).
        {
            int a = k;
            while (a > 0 && !slots_[a].cleanThr[c]) --a;
            for (int j = a + 1; j <= k; ++j) {
                Slot& s = slots_[j];
                Slot& p = slots_[j - 1];
                if (s.refThr[c]) apply_threat_refresh(s.thr[c], s.thrFeats[c]);
                else             delta_threat_apply(s.thr[c], p.thr[c], s.thrSub[c], s.thrAdd[c]);
                s.cleanThr[c] = true;
            }
        }
    }
}

// ---- the six-method interface ----------------------------------------------------

void AccStack::reset(const Position& pos) {
    sp_ = 0;
    Slot& s = slots_[0];
    build_base(s.psq[WHITE], pos, WHITE);
    build_base(s.psq[BLACK], pos, BLACK);
    build_threat(s.thr[WHITE], pos, WHITE);
    build_threat(s.thr[BLACK], pos, BLACK);
    // SFNETLAZYACC: slot 0 is materialized eagerly right here (the root is read
    // immediately by the caller in practice), so mark all four halves clean — the
    // base case materialize()'s per-half walk always terminates on, on or off.
    s.cleanPsq[WHITE] = s.cleanPsq[BLACK] = true;
    s.cleanThr[WHITE] = s.cleanThr[BLACK] = true;
}

void AccStack::push(const Position& pos) {
    Slot& dst = slots_[sp_ + 1];

    if (sfnet_lazyacc_enabled()) {
        // push() is the full-enumerate (THREATDELTA=0 parity) path — record it as a
        // full refresh of all four halves from the child's own feature sets. The
        // enumeration itself (base_indices/threat_indices) still happens now, since it
        // must reflect the position AS IT IS NOW (the child) — only the expensive
        // apply is deferred to materialize().
        const BaseTables& T = base_tables();
        base_indices(T, pos, WHITE, dst.psqFeats[WHITE]);
        base_indices(T, pos, BLACK, dst.psqFeats[BLACK]);
        threat_indices(pos, WHITE, dst.thrFeats[WHITE]);
        threat_indices(pos, BLACK, dst.thrFeats[BLACK]);
        dst.refPsq[WHITE] = dst.refPsq[BLACK] = true;
        dst.refThr[WHITE] = dst.refThr[BLACK] = true;
        dst.cleanPsq[WHITE] = dst.cleanPsq[BLACK] = false;
        dst.cleanThr[WHITE] = dst.cleanThr[BLACK] = false;
        ++sp_;
        return;
    }

    build_base(dst.psq[WHITE], pos, WHITE);
    build_base(dst.psq[BLACK], pos, BLACK);
    build_threat(dst.thr[WHITE], pos, WHITE);
    build_threat(dst.thr[BLACK], pos, BLACK);
    ++sp_;
}

void AccStack::push_delta(const NNUE::BoardSnapshot& oldb, const Position& pos) {
    Slot& dst = slots_[sp_ + 1];

    const Square oldKW = oldb.king_square(WHITE);
    const Square oldKB = oldb.king_square(BLACK);
    const Square newKW = pos.king_square(WHITE);
    const Square newKB = pos.king_square(BLACK);
    // Only the moving side's king can differ old vs new; at most one of these is true.
    const bool kingMovedW = (oldKW != newKW);
    const bool kingMovedB = (oldKB != newKB);

    // Threat: refresh gate is the MIRROR BIT ONLY — reuse our own net's
    // perspective_mirror, which is also SF's FullThreats mirror bit (see file header).
    const bool mirrorFlipW = NNUE::perspective_mirror(oldKW, WHITE) != NNUE::perspective_mirror(newKW, WHITE);
    const bool mirrorFlipB = NNUE::perspective_mirror(oldKB, BLACK) != NNUE::perspective_mirror(newKB, BLACK);

    if (sfnet_lazyacc_enabled()) {
        // Base: coarser refresh than our own net (see class comment in sfnet.h) — ANY
        // king move of a perspective forces a full rebuild of that perspective's base
        // half. Enumeration/delta-collection happens now (oldb + pos both live); the
        // column-streaming apply is deferred to materialize().
        const BaseTables& T = base_tables();
        if (kingMovedW) { base_indices(T, pos, WHITE, dst.psqFeats[WHITE]); dst.refPsq[WHITE] = true; }
        else            { compute_base_delta(oldb, pos, WHITE, dst.psqSub[WHITE], dst.psqAdd[WHITE]); dst.refPsq[WHITE] = false; }
        if (kingMovedB) { base_indices(T, pos, BLACK, dst.psqFeats[BLACK]); dst.refPsq[BLACK] = true; }
        else            { compute_base_delta(oldb, pos, BLACK, dst.psqSub[BLACK], dst.psqAdd[BLACK]); dst.refPsq[BLACK] = false; }
        dst.cleanPsq[WHITE] = dst.cleanPsq[BLACK] = false;

        if (mirrorFlipW) { threat_indices(pos, WHITE, dst.thrFeats[WHITE]); dst.refThr[WHITE] = true; }
        else              dst.refThr[WHITE] = false;
        if (mirrorFlipB) { threat_indices(pos, BLACK, dst.thrFeats[BLACK]); dst.refThr[BLACK] = true; }
        else              dst.refThr[BLACK] = false;

        if (!mirrorFlipW || !mirrorFlipB) {
            // baseSkipW=baseSkipB=true: emit ONLY threat deltas (SF-space indices,
            // offset by NNUE::PsqSize) — never touch changed_edges_delta's base-768
            // loop, which is in OUR net's base space and would be the wrong basis for
            // HalfKAv2_hm. Computed now (boards live); applied later in materialize().
            std::vector<int> subW, addW, subB, addB;
            NNUE::changed_edges_delta(oldb, pos,
                                      /*doW=*/!mirrorFlipW, subW, addW,
                                      /*doB=*/!mirrorFlipB, subB, addB,
                                      /*baseSkipW=*/true, /*baseSkipB=*/true);
            if (!mirrorFlipW) { dst.thrSub[WHITE] = std::move(subW); dst.thrAdd[WHITE] = std::move(addW); }
            if (!mirrorFlipB) { dst.thrSub[BLACK] = std::move(subB); dst.thrAdd[BLACK] = std::move(addB); }
        }
        dst.cleanThr[WHITE] = dst.cleanThr[BLACK] = false;

        ++sp_;
        return;
    }

    const Slot& src = slots_[sp_];

    // Base: coarser refresh than our own net (see class comment in sfnet.h) — ANY king
    // move of a perspective forces a full rebuild of that perspective's base half.
    if (kingMovedW) build_base(dst.psq[WHITE], pos, WHITE);
    else            delta_base(dst.psq[WHITE], src.psq[WHITE], oldb, pos, WHITE);
    if (kingMovedB) build_base(dst.psq[BLACK], pos, BLACK);
    else            delta_base(dst.psq[BLACK], src.psq[BLACK], oldb, pos, BLACK);

    if (mirrorFlipW) build_threat(dst.thr[WHITE], pos, WHITE);
    if (mirrorFlipB) build_threat(dst.thr[BLACK], pos, BLACK);

    if (!mirrorFlipW || !mirrorFlipB) {
        // baseSkipW=baseSkipB=true: emit ONLY threat deltas (SF-space indices, offset by
        // NNUE::PsqSize like every other active_features()/changed_edges_delta caller) —
        // never touch changed_edges_delta's base-768 loop, which is in OUR net's base
        // space and would be the wrong basis for HalfKAv2_hm.
        std::vector<int> subW, addW, subB, addB;
        NNUE::changed_edges_delta(oldb, pos,
                                  /*doW=*/!mirrorFlipW, subW, addW,
                                  /*doB=*/!mirrorFlipB, subB, addB,
                                  /*baseSkipW=*/true, /*baseSkipB=*/true);
        if (!mirrorFlipW) delta_threat_apply(dst.thr[WHITE], src.thr[WHITE], subW, addW);
        if (!mirrorFlipB) delta_threat_apply(dst.thr[BLACK], src.thr[BLACK], subB, addB);
    }

    ++sp_;
}

void AccStack::pushNull() {
    Slot& dst = slots_[sp_ + 1];

    if (sfnet_lazyacc_enabled()) {
        // A null move changes no piece placement, so every half is exactly the
        // parent's — record that as an EMPTY delta (ref=false, empty sub/add) rather
        // than copying anything now; materialize() will memcpy the (by-then-
        // materialized) parent half and apply a no-op diff, i.e. a copy performed
        // lazily. Byte-identical to the eager copy below, just deferred.
        for (int c = WHITE; c <= BLACK; ++c) {
            dst.refPsq[c] = false;
            dst.psqSub[c].clear();
            dst.psqAdd[c].clear();
            dst.cleanPsq[c] = false;
            dst.refThr[c] = false;
            dst.thrSub[c].clear();
            dst.thrAdd[c].clear();
            dst.cleanThr[c] = false;
        }
        ++sp_;
        return;
    }

    // A null move changes no piece placement: every half is exactly the parent's.
    slots_[sp_ + 1] = slots_[sp_];
    ++sp_;
}

EvalPair AccStack::eval_pair(const Position& pos) {
    // SFNETLAZYACC: materialize the top slot on demand — this is the ONLY place a
    // dirty slot's psq[]/thr[] are ever actually needed, so it's the only place we pay
    // for the deferred apply work. A pushed slot whose eval is never read (TT hit /
    // terminal / beta cutoff) never reaches here and never pays for it.
    if (sfnet_lazyacc_enabled()) materialize(sp_);

    const Slot& top = slots_[sp_];
    const int bucket = (BB::popcount(pos.pieces()) - 1) / 4;
    const Color stm = pos.side_to_move();
    const Color persp[2] = {stm, ~stm};
    return forward_pass(top.psq, top.thr, persp, bucket);
}

int AccStack::eval(const Position& pos) {
    const EvalPair ev = eval_pair(pos);

#ifdef NNUE_ASSERT
    // From-scratch rebuild via the Wave 2/3 oracle — the incremental (psqt, positional)
    // pair must match int-exact. Same discipline as NNUE::AccStack (nnue_accumulator.cpp
    // eval(), lines ~750-768).
    const EvalPair oracle = evaluate_raw(pos);
    if (ev.psqt != oracle.psqt || ev.positional != oracle.positional) {
        std::fprintf(stderr,
            "SFNet acc drift sp=%d psqt(inc=%d fresh=%d) positional(inc=%d fresh=%d) fen=%s\n",
            sp_, ev.psqt, oracle.psqt, ev.positional, oracle.positional, pos.fen().c_str());
        std::abort();
    }
#endif

    return post_process(ev, pos);
}

}  // namespace SFNet
