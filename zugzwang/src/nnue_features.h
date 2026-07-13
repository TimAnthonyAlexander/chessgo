#pragma once
#include <vector>
#include "position.h"
#include "types.h"

// Active NNUE feature indices for one perspective (White or Black), computed
// from-scratch off the current board. See spec §2 (base = king-bucketed +
// horizontally-mirrored PSQ; threat = SF full-threats via sfThreatIndex).
//
// IMPORTANT index conventions (bit-exact with gomachine):
//   - base indices  live in [0, PsqSize)          = [0, 12288)
//   - threat indices live in [PsqSize, InputTotal) = [12288, 92144)
//   - gomachine PieceType is 0-indexed (Pawn=0..King=5); chesshce is 1-indexed
//     (PAWN=1..KING=6) — subtract 1 when forming the feature index.
//   - gomachine Color: White=0, Black=1 (matches chesshce WHITE=0/BLACK=1).
namespace NNUE {

struct Features {
    std::vector<int> base;    // [0, 12288)
    std::vector<int> threat;  // [12288, 92144)
};

// Fills `out` with the active base+threat features for `persp`. The perspective's
// own king selects the bucket + horizontal mirror, applied to every feature square.
void active_features(const Position& pos, Color persp, Features& out);

} // namespace NNUE
