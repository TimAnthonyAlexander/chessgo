#pragma once
#include <cstdint>

// Internal NNUE plumbing shared between the from-scratch evaluator (nnue_eval.cpp)
// and the incremental accumulator (nnue_accumulator.cpp). Not part of the public
// NNUE interface (nnue.h) — these are engine-internal.

class Position;

namespace NNUE {

// eval_from_halves runs the multilayer forward pass from two prebuilt int16 FT
// accumulator halves (accW = White-perspective, accB = Black-perspective — the exact
// output of buildAccHalf), oriented to the side to move, with the material bucket
// derived from pos. It is the SINGLE forward shared by evaluate() and the incremental
// stack: bit-exactness of the incremental path reduces to "incremental halves ==
// from-scratch halves" (pure int16), since the forward is identical. Lives in
// nnue_eval.cpp (where the pairwise/int8-dot/GEMV kernels live).
int eval_from_halves(const int16_t* accW, const int16_t* accB, const Position& pos);

// SATDIAG (default OFF, see nnue_eval.cpp): per-eval count of SCReLU pre-activations
// that landed on a rail (<=0 -> "lo", >=1 -> "hi") in the L1 (D2=16) and L2 (D3=32)
// tail layers. All-rails means the tail output is a constant and the eval carries no
// information about the position — the mechanism behind the flat lost-position eval.
// `l1live` (= D2 - l1lo - l1hi) is the load-bearing field and is maintained on every
// eval, not just under SATDIAG: zero live lanes means the tail output is a constant.
// The l2* counters are diagnostics only and are filled only when SATDIAG=1.
// `ovLo`/`ovHi` are the largest distances any L1 pre-activation sat BEYOND a rail
// (how far below 0, how far above 1). They matter because the clamp is what destroys
// the gradient, not the layer: the pre-activations still vary continuously with the
// position even when every output is pinned. If the overshoot is large and varies,
// the information is still there and can be recovered without leaving the net.
struct SatDiag { int l1lo = 0, l1hi = 0, l1live = 0, l2lo = 0, l2hi = 0;
                 float ovLo = 0.0f, ovHi = 0.0f; };
extern thread_local SatDiag g_satdiag;
bool satdiag_enabled();
bool sattrack_enabled();   // true iff SATFIX or SATDIAG wants the tally maintained

} // namespace NNUE
