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

AccStack::AccStack() : slots_(NumSlots) {}

// ---- full rebuilds --------------------------------------------------------------

void AccStack::build_base(HalfAcc& h, const Position& pos, Color persp) const {
    const Net& net = SFNet::net();
    std::memcpy(h.accumulation, net.biases.data(), sizeof(h.accumulation));
    std::memset(h.psqtAccumulation, 0, sizeof(h.psqtAccumulation));

    const BaseTables& T = base_tables();
    std::vector<int> idx;
    base_indices(T, pos, persp, idx);
    for (const int i : idx) {
        if (i < 0 || i >= PsqDims) die("base rebuild index out of range");
        const std::int16_t* w = &net.weights[std::size_t(i) * HalfDimensions];
        for (int j = 0; j < HalfDimensions; ++j) h.accumulation[j] += w[j];
        const std::int32_t* p = &net.psqt[std::size_t(i) * PSQTBuckets];
        for (int k = 0; k < PSQTBuckets; ++k) h.psqtAccumulation[k] += p[k];
    }
}

void AccStack::build_threat(HalfAcc& h, const Position& pos, Color persp) const {
    const Net& net = SFNet::net();
    std::memset(h.accumulation, 0, sizeof(h.accumulation));
    std::memset(h.psqtAccumulation, 0, sizeof(h.psqtAccumulation));

    NNUE::Features feat;
    NNUE::active_features(pos, persp, feat);
    for (const int v : feat.threat) {
        const int idx = v - NNUE::PsqSize;
        if (idx < 0 || idx >= ThreatDims) die("threat rebuild index out of range");
        const std::int8_t* w = &net.threatWeights[std::size_t(idx) * HalfDimensions];
        for (int j = 0; j < HalfDimensions; ++j) h.accumulation[j] += w[j];
        const std::int32_t* p = &net.threatPsqt[std::size_t(idx) * PSQTBuckets];
        for (int k = 0; k < PSQTBuckets; ++k) h.psqtAccumulation[k] += p[k];
    }
}

// ---- deltas (non-king-move base; mirror-stable threat) --------------------------

// delta_base — persp's OWN king did not move (caller guarantees this), so the base
// index's king-derived terms (flip/orient/bucket) are unchanged; only the D squares
// (pieces that actually changed) shift base columns. D is computed the same way
// nnue_features.cpp's changed_edges_delta computes it for its own (different-basis)
// base-768 loop: XOR of every (color, type) occupancy bitboard, old vs new — robust to
// castling / en passant / promotion without decoding move flags.
void AccStack::delta_base(HalfAcc& dst, const HalfAcc& src, const NNUE::BoardSnapshot& oldb,
                          const Position& child, Color persp) const {
    dst = src;
    const Net& net = SFNet::net();
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
        if (op != NO_PIECE) {
            const int idx = make_base_index(T, persp, s, op, ksq);
            if (idx < 0 || idx >= PsqDims) die("base delta index out of range (sub)");
            const std::int16_t* w = &net.weights[std::size_t(idx) * HalfDimensions];
            for (int j = 0; j < HalfDimensions; ++j) dst.accumulation[j] -= w[j];
            const std::int32_t* p = &net.psqt[std::size_t(idx) * PSQTBuckets];
            for (int k = 0; k < PSQTBuckets; ++k) dst.psqtAccumulation[k] -= p[k];
        }
        if (np != NO_PIECE) {
            const int idx = make_base_index(T, persp, s, np, ksq);
            if (idx < 0 || idx >= PsqDims) die("base delta index out of range (add)");
            const std::int16_t* w = &net.weights[std::size_t(idx) * HalfDimensions];
            for (int j = 0; j < HalfDimensions; ++j) dst.accumulation[j] += w[j];
            const std::int32_t* p = &net.psqt[std::size_t(idx) * PSQTBuckets];
            for (int k = 0; k < PSQTBuckets; ++k) dst.psqtAccumulation[k] += p[k];
        }
    }
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
    for (const int v : sub) {
        const int idx = v - NNUE::PsqSize;
        if (idx < 0 || idx >= ThreatDims) die("threat delta index out of range (sub)");
        const std::int8_t* w = &net.threatWeights[std::size_t(idx) * HalfDimensions];
        for (int j = 0; j < HalfDimensions; ++j) dst.accumulation[j] -= w[j];
        const std::int32_t* p = &net.threatPsqt[std::size_t(idx) * PSQTBuckets];
        for (int k = 0; k < PSQTBuckets; ++k) dst.psqtAccumulation[k] -= p[k];
    }
    for (const int v : add) {
        const int idx = v - NNUE::PsqSize;
        if (idx < 0 || idx >= ThreatDims) die("threat delta index out of range (add)");
        const std::int8_t* w = &net.threatWeights[std::size_t(idx) * HalfDimensions];
        for (int j = 0; j < HalfDimensions; ++j) dst.accumulation[j] += w[j];
        const std::int32_t* p = &net.threatPsqt[std::size_t(idx) * PSQTBuckets];
        for (int k = 0; k < PSQTBuckets; ++k) dst.psqtAccumulation[k] += p[k];
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
}

void AccStack::push(const Position& pos) {
    Slot& dst = slots_[sp_ + 1];
    build_base(dst.psq[WHITE], pos, WHITE);
    build_base(dst.psq[BLACK], pos, BLACK);
    build_threat(dst.thr[WHITE], pos, WHITE);
    build_threat(dst.thr[BLACK], pos, BLACK);
    ++sp_;
}

void AccStack::push_delta(const NNUE::BoardSnapshot& oldb, const Position& pos) {
    Slot& dst = slots_[sp_ + 1];
    const Slot& src = slots_[sp_];

    const Square oldKW = oldb.king_square(WHITE);
    const Square oldKB = oldb.king_square(BLACK);
    const Square newKW = pos.king_square(WHITE);
    const Square newKB = pos.king_square(BLACK);
    // Only the moving side's king can differ old vs new; at most one of these is true.
    const bool kingMovedW = (oldKW != newKW);
    const bool kingMovedB = (oldKB != newKB);

    // Base: coarser refresh than our own net (see class comment in sfnet.h) — ANY king
    // move of a perspective forces a full rebuild of that perspective's base half.
    if (kingMovedW) build_base(dst.psq[WHITE], pos, WHITE);
    else            delta_base(dst.psq[WHITE], src.psq[WHITE], oldb, pos, WHITE);
    if (kingMovedB) build_base(dst.psq[BLACK], pos, BLACK);
    else            delta_base(dst.psq[BLACK], src.psq[BLACK], oldb, pos, BLACK);

    // Threat: refresh gate is the MIRROR BIT ONLY — reuse our own net's
    // perspective_mirror, which is also SF's FullThreats mirror bit (see file header).
    const bool mirrorFlipW = NNUE::perspective_mirror(oldKW, WHITE) != NNUE::perspective_mirror(newKW, WHITE);
    const bool mirrorFlipB = NNUE::perspective_mirror(oldKB, BLACK) != NNUE::perspective_mirror(newKB, BLACK);

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
    // A null move changes no piece placement: every half is exactly the parent's.
    slots_[sp_ + 1] = slots_[sp_];
    ++sp_;
}

EvalPair AccStack::eval_pair(const Position& pos) const {
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
