#pragma once
#include <cstdint>
#include <cstddef>
#include <string>
#include <vector>

// SFNet — a second NNUE backend that evaluates with a Stockfish 18 network inside
// OUR search. Experiment only; see ../docs/tasks/open/sf-net-experiment.md.
//
// NO STOCKFISH CODE IS LINKED, COPIED OR VENDORED. This is an independent
// implementation of the published file format and forward pass, written against
// ~/sf18-arm as a specification. The loaded .nnue weights are GPLv3 data from the
// Stockfish project: fine to read locally for measurement, never shipped.
//
// Deliberately parallel to, not a template instantiation of, our own NNUE
// (src/nnue_*). Sharing would mean templating H/D2/D3/PsqSize through AccStack and
// the kernels to serve an experiment, and SF's accumulator is a different shape
// anyway (two feature sets, psqt lanes, a coarser refresh rule). Keeping the two
// apart means our net's generated code is provably untouched.

class Position;

namespace SFNet {

// ---- Architecture (the "big" net: HalfKAv2_hm + FullThreats) ----
// nnue_architecture.h:43-53, nnue_common.h:61-62.
constexpr int HalfDimensions = 1024;  // TransformedFeatureDimensionsBig
constexpr int L2 = 15;                // FC_0 outputs that reach fc_1 (a 16th is the bypass)
constexpr int L3 = 32;
constexpr int LayerStacks = 8;
constexpr int PSQTBuckets = 8;
constexpr int OutputScale = 16;
constexpr int WeightScaleBits = 6;

// HalfKAv2_hm: SQUARE_NB * PS_NB / 2, PS_NB = 11 planes * 64. half_ka_v2_hm.h:54,72.
constexpr int PsqDims = 22528;
// FullThreats index space; 79856 doubles as the "excluded" sentinel. full_threats.h:44.
constexpr int ThreatDims = 79856;

constexpr int Fc0Out = L2 + 1;   // 16 — neuron 15 is the linear bypass
constexpr int Fc1In = L2 * 2;    // 30 — sqr-relu(0..14) then relu(0..14)
constexpr int Fc1InPadded = 32;  // ceil_to_multiple(30, 32)
constexpr int Fc2In = L3;        // 32, already a multiple of 32

// One of the 8 layer stacks. Weights are row-major over the PADDED input width, exactly
// as they sit in the file — the permutation tricks in SF's headers
// (get_weight_index_scrambled, PackusEpi16Order) are in-memory SIMD layout only, and
// write_parameters un-permutes before writing, so the file is always natural order.
struct LayerStack {
    std::int32_t fc0b[Fc0Out];
    std::int8_t  fc0w[Fc0Out * HalfDimensions];
    std::int32_t fc1b[L3];
    std::int8_t  fc1w[L3 * Fc1InPadded];
    std::int32_t fc2b[1];
    std::int8_t  fc2w[Fc2In];
};

struct Net {
    // Feature transformer. Both weight arrays are FEATURE-MAJOR with stride
    // HalfDimensions; both psqt arrays are feature-major with stride PSQTBuckets
    // (nnue_accumulator.cpp:332,336,461-475).
    std::vector<std::int16_t> biases;         // HalfDimensions
    std::vector<std::int8_t>  threatWeights;  // ThreatDims * HalfDimensions  (~82 MB)
    std::vector<std::int16_t> weights;        // PsqDims * HalfDimensions     (~46 MB)
    std::vector<std::int32_t> threatPsqt;     // ThreatDims * PSQTBuckets
    std::vector<std::int32_t> psqt;           // PsqDims * PSQTBuckets
    std::vector<LayerStack>   stacks;         // LayerStacks

    std::string description;
    bool ok = false;
};

// Loads an SF18 .nnue file. Rejects anything whose version, top-level hash, feature-
// transformer hash or per-stack hash does not match the values RECOMPUTED from the
// architecture — so a small net, a differently-shaped net or a truncated file is
// refused rather than silently misread. Returns false and leaves loaded() == false.
bool load(const char* path);
bool loaded();
const Net& net();

// ---- Hash rules, recomputed rather than hardcoded ----
// Exposed so the loader test can assert them independently of the file.
std::uint32_t feature_transformer_hash();  // nnue_feature_transformer.h:126-130
std::uint32_t architecture_hash();         // nnue_architecture.h:74-86
std::uint32_t network_hash();              // network.h:113 — FT ^ arch

// ---- Wave 2: from-scratch forward pass (src/sfnet_eval.cpp) ----
// Pre-post-processing SF Value units: network.cpp's NetworkOutput{psqt, positional},
// i.e. Network::evaluate's return BEFORE evaluate.cpp's blend (spec §3.5 — not done
// yet, see docs/tasks/open/sf-net-experiment.md).
struct EvalPair {
    int psqt;
    int positional;
};

// Computes the SF-net eval from scratch off the current board: rebuilds both feature
// sets (PSQ base + FullThreats, reusing NNUE::active_features()'s threat half) for
// both perspectives, then runs the scalar reference forward pass (feature transformer
// pairwise-multiply, fc_0/ac_sqr_0‖ac_0/fc_1/ac_1/fc_2 plus the fc_0-neuron-15 linear
// bypass). No incremental accumulator, no SIMD — this is the from-scratch oracle,
// not the hot path. Requires SFNet::loaded(). Debug builds (no NDEBUG) assert
// !pos.in_check(); NDEBUG builds (the default CXXFLAGS) do not check this at runtime,
// matching this codebase's existing assert() convention.
EvalPair evaluate_raw(const Position& pos);

// self_check — internal-invariant check for one position, used by
// `sfnet_eval_test --self-check`: every base index lands in [0, PsqDims), every threat
// index (active_features()'s threat entries minus NNUE::PsqSize) lands in
// [0, ThreatDims), the base feature count equals the piece count on the board for both
// perspectives, and evaluate_raw() runs to completion without any of the above
// tripping. Returns true iff everything held; on failure, if `why` is non-null, writes
// a one-line reason. This is a checked-invariant probe, not a correctness oracle — it
// cannot tell you the *numbers* are right, only that no index escaped its array.
bool self_check(const Position& pos, std::string* why = nullptr);

}  // namespace SFNet
