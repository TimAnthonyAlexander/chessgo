#pragma once
#include <cstdint>
#include <cstddef>
#include <string>
#include <vector>
#include "types.h"

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
namespace NNUE { struct BoardSnapshot; }

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

// ---- Wave 4: post-processing + incremental accumulator ----
// docs/tasks/open/sf-net-experiment.md §A/§B, docs/sfnet-wave4.md.

// HalfAcc — one feature set's state for one perspective: the FT half (int16, width
// HalfDimensions) plus its psqt lanes (int32, width PSQTBuckets). AccStack keeps two
// of these per perspective (PSQ base + FullThreats — see AccStack's doc comment) and
// forward_pass (sfnet_internal.h, shared by evaluate_raw and AccStack::eval) consumes
// exactly this shape, so both the from-scratch oracle and the incremental accumulator
// run the identical forward-pass code over identically-shaped state.
struct HalfAcc {
    std::int16_t accumulation[HalfDimensions];
    std::int32_t psqtAccumulation[PSQTBuckets];
};

// evaluate — from-scratch SF eval, POST-PROCESSED (§3.5's nnue/complexity/material/
// rule50 blend, optimism = 0, no cp rescale — that is Wave 5). Mirrors NNUE::evaluate:
// the path taken when no accumulator is attached to the Position. Requires
// SFNet::loaded().
int evaluate(const Position& pos);

// AccStack — the SF backend's incremental accumulator. Exposes the SAME six methods as
// NNUE::AccStack (nnue_accumulator.h): AccStack(); reset(pos); push(pos);
// push_delta(oldb, pos); pushNull(); pop(); eval(pos) — so src/engine_backend.h's
// EngineAccStack alias can select either backend at compile time with identical call
// sites everywhere else in the engine.
//
// State per node: TWO feature sets (PSQ base, FullThreats) x TWO perspectives, each a
// HalfAcc. The base seeds from net.biases; the threat accumulation and BOTH psqt
// accumulators seed from zero (§3.3 — there is no threat bias array and no psqt bias
// at all).
//
// Refresh rules are DELIBERATELY DIFFERENT from our own net's AccStack — this is the
// whole risk this wave is about, see docs/sfnet-wave4.md for what got verified:
//   - threat: gated on the MIRROR BIT ONLY (NNUE::perspective_mirror) — a king move
//     that crosses a king-bucket boundary without crossing the mirror line keeps
//     threats on the delta path, reusing NNUE::changed_edges_delta(...,
//     baseSkipW=true, baseSkipB=true) (bit-identical to SF's FullThreats — proven in
//     Wave 2/3). Excluded threat indices (>= ThreatDims) never reach the accumulator.
//   - base: COARSER than our own net — ANY king move of a perspective forces a full
//     base rebuild for that perspective (SF's HalfKAv2_hm has no bucket-aware cheap
//     path). A non-king-move's base delta is derived directly from the changed
//     squares (D = XOR of per-(color,type) occupancy, the same technique
//     nnue_features.cpp's own base-768 D-loop uses) — NOT nnue_features.cpp's base
//     delta itself, which is in OUR base space and is the wrong basis for HalfKAv2_hm.
//
// Under -DNNUE_ASSERT, eval() rebuilds both feature sets from scratch (via
// evaluate_raw, the Wave 2/3 oracle) and aborts on ANY drift from the incrementally
// maintained state — same discipline as NNUE::AccStack (nnue_accumulator.cpp:750-768).
// Gated at test/sfnet_acc_test.cpp.
//
// SFNETLAZYACC (Wave 9, default OFF — see sfnet_accumulator.cpp sfnet_lazyacc_enabled):
// deferred-apply accumulator, mirroring NNUE::AccStack's LAZYACC (nnue_accumulator.h/
// .cpp) against THIS net's shape. The eager scheme above streams weight columns out of
// net.weights (~46 MB) / net.threatWeights (~82 MB) on every push/push_delta, but most
// children are cut (TT hit / terminal / beta cutoff) before their accumulator is ever
// read by eval() — same "most pushes are wasted work" argument LAZYACC's doc comment
// makes for our own net. When SFNETLAZYACC=1, push/push_delta/pushNull only RECORD the
// pending refresh-or-delta into the new top Slot; eval_pair() materializes on demand,
// walking up from the deepest clean ancestor and replaying the recorded deltas in
// order — byte-identical to the eager result (same delta lists, same int16/int32
// column adds, just applied later; commute/associate argument identical to LAZYACC's).
//
// One real difference from LAZYACC: our own net's AccStack tracks ONE clean flag per
// slot (w[]/b[] always refresh/delta together). Here base and threat have DIFFERENT
// refresh gates (base: any king move of that perspective; threat: the mirror bit
// only — see the refresh-rules paragraph above), so a slot can be clean for one
// feature set and dirty for the other at the same ply. Slot therefore carries FOUR
// independent clean/refresh flags (cleanPsq/cleanThr x WHITE/BLACK) and materialize()
// walks each of the 4 halves back to ITS OWN nearest clean ancestor independently.
class AccStack {
public:
    AccStack();

    // reset rebuilds slot 0 from scratch for pos and points the stack at it (sp = 0).
    void reset(const Position& pos);

    // push computes the child slot by fully re-enumerating and rebuilding BOTH feature
    // sets for BOTH perspectives off the current board (pos == the child, called after
    // Position::do_move has fully formed it) — the parity/debug path taken when
    // THREATDELTA=0 (position.cpp's useDelta gate is shared with the default backend;
    // see docs/sfnet-wave4.md).
    void push(const Position& pos);

    // push_delta is the move-aware path (position.cpp's default, THREATDELTA=1):
    // `oldb` is the pre-move board snapshot Position::do_move captures BEFORE
    // mutating in place; `pos` is the fully-formed child. See the class comment above
    // for the refresh rules.
    void push_delta(const NNUE::BoardSnapshot& oldb, const Position& pos);

    // pushNull duplicates the top slot — a null move changes no piece placement, so
    // every accumulator half is unchanged.
    void pushNull();

    // pop discards the top slot (call after Position::undo_move / undo_null_move).
    void pop() { --sp_; }

    // eval returns the POST-PROCESSED SF value (nnue/complexity/material/rule50 blend,
    // optimism = 0, no cp rescale) of the top accumulator. With -DNNUE_ASSERT it first
    // checks the incremental (psqt, positional) pair against evaluate_raw()'s
    // from-scratch rebuild and aborts on any drift.
    int eval(const Position& pos);

    // eval_pair — the pre-post-processing (psqt, positional) pair, i.e. eval() minus
    // the NNUE_ASSERT check and the post_process call. NOT one of the six methods
    // EngineAccStack's alias depends on (NNUE::AccStack has no equivalent) — this
    // exists purely so test/sfnet_acc_test.cpp (Wave 4's gate) can compare the
    // incremental state against evaluate_raw()'s oracle at every node of a real
    // do_move/undo_move tree and report a (checked, failed) count, instead of relying
    // solely on -DNNUE_ASSERT's hard abort-on-drift. Non-const (Wave 9): under
    // SFNETLAZYACC it must call materialize(), which writes into slots_.
    EvalPair eval_pair(const Position& pos);

private:
    struct Slot {
        HalfAcc psq[COLOR_NB];  // seeded from net.biases
        HalfAcc thr[COLOR_NB];  // seeded from zero

        // --- SFNETLAZYACC (Wave 9, default OFF — see sfnet_accumulator.cpp
        // sfnet_lazyacc_enabled). See the class comment above for why base and threat
        // need INDEPENDENT clean/refresh state instead of one shared pair. When lazy
        // materialization is enabled, push/push_delta/pushNull no longer populate
        // psq[]/thr[] eagerly — they only RECORD what would need to happen, and
        // clean{Psq,Thr} track whether psq[]/thr[] currently hold that recorded
        // result. materialize(k) is the only place that ever turns a dirty half clean.
        bool cleanPsq[COLOR_NB] = {false, false};  // true iff psq[c] is up to date
        bool cleanThr[COLOR_NB] = {false, false};  // true iff thr[c] is up to date
        bool refPsq[COLOR_NB] = {false, false};    // true => psq[c] is a from-scratch
                                                    // refresh (psqFeats[c] holds the
                                                    // enumerated base indices); false =>
                                                    // a delta from the parent's psq[c]
                                                    // (psqSub[c]/psqAdd[c], applied via
                                                    // apply_base_delta)
        bool refThr[COLOR_NB] = {false, false};    // same, for thr[c]/thrFeats[c]/
                                                    // thrSub[c]+thrAdd[c]
        std::vector<int> psqFeats[COLOR_NB];       // used when refPsq[c]
        std::vector<int> thrFeats[COLOR_NB];       // used when refThr[c] (SF-space
                                                    // threat idx, +NNUE::PsqSize offset,
                                                    // same encoding active_features()
                                                    // already produces)
        std::vector<int> psqSub[COLOR_NB], psqAdd[COLOR_NB];  // used when !refPsq[c]
        std::vector<int> thrSub[COLOR_NB], thrAdd[COLOR_NB];  // used when !refThr[c]
    };

    // Deepest reachable ply is bounded by MAX_PLY; +8 slack for the child pushed at
    // the deepest node — same bound NNUE::AccStack uses (nnue_accumulator.h).
    static constexpr int NumSlots = MAX_PLY + 8;

    void build_base(HalfAcc& h, const Position& pos, Color persp) const;
    void build_threat(HalfAcc& h, const Position& pos, Color persp) const;
    void delta_base(HalfAcc& dst, const HalfAcc& src, const NNUE::BoardSnapshot& oldb,
                    const Position& child, Color persp) const;
    void delta_threat_apply(HalfAcc& dst, const HalfAcc& src,
                            const std::vector<int>& sub, const std::vector<int>& add) const;

    // --- SFNETLAZYACC helpers (Wave 9) ---
    // threat_indices — the enumeration half of build_threat, split out so it can be
    // called eagerly (pos is live) while the expensive apply is deferred to
    // apply_threat_refresh. Byte-identical list to what build_threat's own
    // active_features() call would produce.
    void threat_indices(const Position& pos, Color persp, std::vector<int>& out) const;
    // apply_base_refresh / apply_threat_refresh — the apply half of build_base /
    // build_threat, taking an already-enumerated feature list instead of re-deriving
    // it from a (possibly long-gone, by materialize() time) Position.
    void apply_base_refresh(HalfAcc& h, const std::vector<int>& feats) const;
    void apply_threat_refresh(HalfAcc& h, const std::vector<int>& feats) const;
    // compute_base_delta — the enumeration half of delta_base (the D-loop), split out
    // so it can be called eagerly (oldb + child are both live at push_delta time)
    // while apply_base_delta's column streaming is deferred to materialize().
    void compute_base_delta(const NNUE::BoardSnapshot& oldb, const Position& child, Color persp,
                            std::vector<int>& sub, std::vector<int>& add) const;
    void apply_base_delta(HalfAcc& dst, const HalfAcc& src,
                          const std::vector<int>& sub, const std::vector<int>& add) const;
    // materialize brings slots_[k]'s FOUR halves (psq/thr x WHITE/BLACK) up to date,
    // each walking independently to its own deepest clean ancestor and replaying the
    // recorded refresh/delta forward — same bit-exactness argument as NNUE::AccStack's
    // materialize (nnue_accumulator.cpp): every recorded list is a pure function of
    // boards that were live at push time, and int16/int32 column add/sub commute and
    // associate, so applying it later is identical to applying it immediately.
    void materialize(int k);

    std::vector<Slot> slots_;
    int sp_ = 0;
};

}  // namespace SFNet
