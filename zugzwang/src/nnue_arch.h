#pragma once
#include <cstdint>

// Bit-exact architecture + quantization constants for gomachine's prod
// full-threats net (data/nnue/kb-mirror.bin, multilayer). Source of truth:
// gomachine/internal/nnue (see the porting spec). DO NOT change a value without
// re-deriving it from the Go reference — every one is load-bearing for bit-exactness.
namespace NNUE {

// Feature space
constexpr int InputDim       = 768;                      // 2 colors * 6 types * 64 sq (one king-bucket)
constexpr int NumKingBuckets = 16;
constexpr int PsqSize        = NumKingBuckets * InputDim; // 12288 — also the threat-feature offset
constexpr int ThreatBlock    = 79856;                    // SF full-threats index space
constexpr int InputTotal     = PsqSize + ThreatBlock;    // 92144 — FT input width

// Layer widths
constexpr int H  = 512;   // FT hidden width per perspective
constexpr int D2 = 16;    // tail L1 width
constexpr int D3 = 32;    // tail L2 width
constexpr int NB = 8;     // output buckets

// Quantization / scales (exact integer arithmetic — see spec §5)
constexpr int   ftQA    = 255;                          // FT weight+acc scale: W0i = round(W0*255)
constexpr int   int8QA  = 127;                          // u8 activation ceiling (maddubs can't saturate)
constexpr int   L1QB    = 64;                           // int8 L1 weight scale: L1W8 = clamp(round(L1W*64), +-127)
constexpr float L1Inv   = 1.0f / (127.0f * 64.0f);      // 1/8128 — L1 int32-dot descale
constexpr float CpScale = 400.0f;                       // raw output -> centipawns
constexpr int   ftShift = 9;                            // pairwise-u8: (a*b + ftRound) >> ftShift
constexpr int   ftRound = 1 << 8;                       // 256 (round-to-nearest for the >>9)

} // namespace NNUE
