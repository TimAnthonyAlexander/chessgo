#pragma once
// Internal helpers shared between sfnet_eval.cpp (the from-scratch oracle, Wave 2/3 —
// see docs/sfnet-wave2.md) and sfnet_accumulator.cpp (the incremental accumulator,
// Wave 4 — see docs/sfnet-wave4.md). NOT part of the public SFNet API (sfnet.h) —
// only these two translation units include this file, and both DEFINE what's declared
// here inside sfnet_eval.cpp (its historical home; sfnet_accumulator.cpp only calls
// it). Every declaration below is either verbatim-moved from sfnet_eval.cpp's old
// anonymous namespace (linkage change only, values untouched — see the wave4 doc's
// byte-identical-refactor note) or new Wave 4 code.

#include "sfnet.h"
#include "types.h"
#include <cstdint>
#include <vector>

class Position;

namespace SFNet {

// ---- shared arithmetic / fatal-error helper ----
inline std::int32_t clampi(std::int32_t v, std::int32_t lo, std::int32_t hi) {
    return v < lo ? lo : (v > hi ? hi : v);
}
[[noreturn]] void die(const char* what);

// ---- HalfKAv2_hm base features (verified against ~/sf18-arm — docs/sfnet-wave2.md) ----
constexpr int PsPlaneSize = 64;
constexpr int KingPlaneOffset = 10 * PsPlaneSize;  // 640 — shared W/B king plane

struct BaseTables {
    int pieceSquareIndex[COLOR_NB][PIECE_NB]{};  // plane offset per (perspective, piece)
    int kingBuckets[SQUARE_NB]{};                // bucket*704, indexed by ksq^flip (UNmirrored)
    int orientTbl[SQUARE_NB]{};                  // 7 (files a-d) or 0 (files e-h), indexed by raw ksq

    BaseTables();
};
const BaseTables& base_tables();

// make_index — HalfKAv2_hm::make_index, verbatim structure:
//   flip  = 56 * perspective
//   index = (s ^ OrientTBL[ksq] ^ flip) + PieceSquareIndex[perspective][pc] + KingBuckets[ksq ^ flip]
inline int make_base_index(const BaseTables& T, Color persp, Square s, Piece pc, Square ksq) {
    const int flip = 56 * int(persp);
    return (int(s) ^ T.orientTbl[ksq] ^ flip) + T.pieceSquareIndex[persp][pc]
         + T.kingBuckets[int(ksq) ^ flip];
}

// Active base-feature indices for one perspective, from scratch off the board.
void base_indices(const BaseTables& T, const Position& pos, Color persp, std::vector<int>& out);

// ---- forward pass (spec §3.4) — shared verbatim by evaluate_raw (from scratch) and
// AccStack::eval (incremental), so there is exactly one implementation of this
// arithmetic to get right. `psq`/`thr` are indexed by absolute Color (WHITE/BLACK);
// `persp[0]/[1]` = (side to move, other side) selects which half is "own"/"enemy" and
// which psqt sign applies; `bucket` picks both the psqt column and the layer stack.
EvalPair forward_pass(const HalfAcc psq[2], const HalfAcc thr[2], const Color persp[2], int bucket);

// ---- post-processing (spec §3.5 / §A) — SF's evaluate.cpp blend, optimism = 0, no cp
// rescale (Wave 5). Shared by SFNet::evaluate() (from scratch) and AccStack::eval()
// (incremental) so there is exactly one implementation of the blend too.
int post_process(EvalPair ev, const Position& pos);

// ---- Wave 8: fc_0 sparsity probe (docs/sfnet-wave8.md) ----------------------------
// Read-only instrumentation of forward_pass's `ft[HalfDimensions]` activation vector —
// how many of the 1024 uint8 lanes are exactly zero after the pairwise clamp, which is
// the number that decides whether SF's AffineTransformSparseInput fc_0 (find_nnz +
// scrambled weight layout) could pay off here at all. Off by default (single bool
// check per forward_pass call, zero cost when false, and never changes ft[] or the
// returned EvalPair — the arithmetic is untouched either way, so this cannot affect
// any bit-exactness gate). g_sfnet_last_zero_count is overwritten by every forward_pass
// call while the probe is on; test/sfnet_sparsity_probe.cpp reads it right after each
// evaluate_raw() call, single-threaded, before the next call can clobber it.
extern bool g_sfnet_probe_sparsity;
extern int g_sfnet_last_zero_count;
// Same probe, but at SF's own ChunkSize=4 granularity (a 4-byte group counts as
// "nonzero" if ANY of its 4 bytes is nonzero) — the number that actually predicts
// AffineTransformSparseInput's speedup, since find_nnz skips whole 4-byte chunks, not
// individual bytes. HalfDimensions/4 = 256 chunks.
extern int g_sfnet_last_nonzero_chunks4;

}  // namespace SFNet
