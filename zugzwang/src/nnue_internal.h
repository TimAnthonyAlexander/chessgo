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

} // namespace NNUE
