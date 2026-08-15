// SFNet from-scratch forward pass — scalar reference only (no incremental
// accumulator, no SIMD, no search wiring). Independent reimplementation of the
// published HalfKAv2_hm + FullThreats architecture; no Stockfish code is linked,
// copied or vendored.
//
// Verified against ~/sf18-arm/src line by line (read-only reference, never modified):
//   - base features / king buckets / orientation: nnue/features/half_ka_v2_hm.{h,cpp}
//   - feature-transformer pairwise combine + psqt blend: nnue/nnue_feature_transformer.h
//     (transform(), the UseThreats branch, lines ~229-403 as of sf_18)
//   - bucket selection + OutputScale division: nnue/network.cpp (Network::evaluate)
//   - fc_0/ac_sqr_0/ac_0/fc_1/ac_1/fc_2 + the neuron-15 bypass: nnue/nnue_architecture.h
//     (propagate()), nnue/layers/{affine_transform,clipped_relu,sqr_clipped_relu}.h
//   - post-processing blend (Wave 4): evaluate.cpp's Eval::evaluate (nnue/complexity/
//     material/rule50), optimism = 0.
// Anything the written spec (docs/tasks/open/sf-net-experiment.md) got wrong or left
// ambiguous, and how it was resolved against the source above, is recorded in
// docs/sfnet-wave2.md (Waves 2/3) and docs/sfnet-wave4.md (Wave 4).
//
// Threat features are NOT reimplemented here — src/nnue_features.cpp's
// NNUE::active_features() is bit-identical to SF's FullThreats (see
// sf-net-experiment.md §2), so this file calls it and rebases its threat indices
// (which carry OUR net's +12288 PsqSize offset) onto SF's own 0-based 79856 space.
//
// This file also holds the DEFINITIONS of the helpers sfnet_internal.h declares
// (BaseTables, base_tables, base_indices, die, forward_pass, post_process) — that
// header exists so src/sfnet_accumulator.cpp (Wave 4's incremental accumulator) can
// reuse this exact code rather than re-deriving it. Moving code out of the old private
// anonymous namespace into named SFNet scope is a LINKAGE change only; every value
// below is byte-for-byte what Waves 2/3 already validated bit-exact against Stockfish
// over 560 positions (test/sfnet_corpus_ref.tsv) — re-verified after this refactor via
// `make sfnet_eval_test && ./test/sfnet_eval_test --self-check ...` (see docs/sfnet-wave4.md).

#include "sfnet.h"
#include "sfnet_internal.h"
#include "sfnet_simd.h"
#include "position.h"
#include "nnue_features.h"
#include "nnue_arch.h"
#include "bitboard.h"
#include "types.h"

#include <algorithm>
#include <cassert>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>

namespace SFNet {

// ---- shared fatal-error helper (declared in sfnet_internal.h) ----
[[noreturn]] void die(const char* what) {
    std::fprintf(stderr, "SFNet: %s\n", what);
    std::abort();
}

// ---- HalfKAv2_hm base features ------------------------------------------------------
// PS_NB = 11 planes * 64 = 704: W_PAWN,B_PAWN,W_KNIGHT,B_KNIGHT,W_BISHOP,B_BISHOP,
// W_ROOK,B_ROOK,W_QUEEN,B_QUEEN,KING (one shared plane for both colours). "W" = the
// perspective's own colour, "B" = the other colour (half_ka_v2_hm.h's
// PieceSquareIndex[COLOR_NB][PIECE_NB] convention comment: "W - us, B - them"). Built
// off our own Piece enum, which is byte-identical to SF's (W_PAWN=1..W_KING=6,
// B_PAWN=9..B_KING=14, NO_PIECE=0, PIECE_NB=16 with two unused slots at 7 and 15).
// PsPlaneSize/KingPlaneOffset and BaseTables itself are declared in sfnet_internal.h
// (shared with sfnet_accumulator.cpp, Wave 4) — this is their one definition, moved
// here verbatim from what used to be this file's private anonymous namespace (linkage
// change only; the values below are byte-for-byte what Wave 2/3 already validated).
BaseTables::BaseTables() {
    for (int persp = WHITE; persp <= BLACK; ++persp) {
        for (int pc = 0; pc < PIECE_NB; ++pc) {
            if (pc == NO_PIECE || pc == 7 || pc == 15) {
                pieceSquareIndex[persp][pc] = 0;  // unused slots; never looked up
                continue;
            }
            const Piece piece = Piece(pc);
            const PieceType pt = type_of(piece);
            if (pt == KING) {
                pieceSquareIndex[persp][pc] = KingPlaneOffset;
                continue;
            }
            // "W" plane = perspective's own colour, "B" plane = the other colour.
            const bool isOwn = (color_of(piece) == Color(persp));
            const int plane = (int(pt) - 1) * 2 + (isOwn ? 0 : 1);
            pieceSquareIndex[persp][pc] = plane * PsPlaneSize;
        }
    }

    // half_ka_v2_hm.h:75-85, transcribed verbatim and cross-checked directly against
    // ~/sf18-arm — SF's KingBuckets[SQUARE_NB] is indexed by the RAW SF Square enum
    // (A1=0..H8=63, identical numbering to ours), so row 0 of the literal listing IS
    // squares A1..H1: KingBuckets[A1] == 28*704. See docs/sfnet-wave2.md for why the
    // task spec's own "read rank 8 down to rank 1" framing of this table is backwards
    // and should be ignored in favour of the "KingBuckets[A1] == 28*704" sentence.
    static const int bucketOf[SQUARE_NB] = {
        28, 29, 30, 31, 31, 30, 29, 28,
        24, 25, 26, 27, 27, 26, 25, 24,
        20, 21, 22, 23, 23, 22, 21, 20,
        16, 17, 18, 19, 19, 18, 17, 16,
        12, 13, 14, 15, 15, 14, 13, 12,
         8,  9, 10, 11, 11, 10,  9,  8,
         4,  5,  6,  7,  7,  6,  5,  4,
         0,  1,  2,  3,  3,  2,  1,  0,
    };
    for (int s = 0; s < SQUARE_NB; ++s) kingBuckets[s] = bucketOf[s] * PsqDims / 32;

    // OrientTBL: king canonicalised to files e-h (opposite mirror sense from our own
    // net's make_xform, which canonicalises to a-d). File-only, so built directly
    // rather than transcribed — confirmed file-only against half_ka_v2_hm.h's literal
    // 64-entry table (every rank repeats the same 8-file pattern).
    for (int s = 0; s < SQUARE_NB; ++s)
        orientTbl[s] = (file_of(Square(s)) <= 3) ? 7 : 0;
}

const BaseTables& base_tables() {
    static const BaseTables T;
    return T;
}

// Active base-feature indices for one perspective, from scratch off the board.
// (make_base_index itself is declared `inline` in sfnet_internal.h — one definition,
// shared by both translation units.)
void base_indices(const BaseTables& T, const Position& pos, Color persp, std::vector<int>& out) {
    out.clear();
    const Square ksq = pos.king_square(persp);
    U64 occ = pos.pieces();
    while (occ) {
        const Square s = BB::pop_lsb(occ);
        const Piece pc = pos.piece_on(s);
        out.push_back(make_base_index(T, persp, s, pc, ksq));
    }
}

namespace {

// ---- Accumulators (per perspective, two independent feature sets) ------------------
// SFNet::HalfAcc (sfnet.h) is the shared per-perspective-per-feature-set state; this
// pairs two of them (PSQ base + FullThreats) the way build_accumulators below fills them.
struct Accumulators {
    HalfAcc psq[COLOR_NB];  // seeded from net.biases[]
    HalfAcc thr[COLOR_NB];  // seeded from zero — no threat bias array, no psqt bias at all
};

void build_accumulators(const Position& pos, const Net& net, Accumulators& acc) {
    const BaseTables& T = base_tables();
    std::vector<int> baseIdx;
    NNUE::Features feat;

    for (int c = WHITE; c <= BLACK; ++c) {
        HalfAcc& psq = acc.psq[c];
        HalfAcc& thr = acc.thr[c];

        std::memcpy(psq.accumulation, net.biases.data(), sizeof(psq.accumulation));
        std::memset(psq.psqtAccumulation, 0, sizeof(psq.psqtAccumulation));
        std::memset(thr.accumulation, 0, sizeof(thr.accumulation));
        std::memset(thr.psqtAccumulation, 0, sizeof(thr.psqtAccumulation));

        // Base (PSQ) half: feature-major weights/psqt, stride HalfDimensions / PSQTBuckets.
        base_indices(T, pos, Color(c), baseIdx);
        for (const int idx : baseIdx) {
            if (idx < 0 || idx >= PsqDims) die("base feature index out of range");
            const std::int16_t* w = &net.weights[std::size_t(idx) * HalfDimensions];
#if SFNET_USE_SIMD
            simd::col_add_i16<HalfDimensions>(psq.accumulation, w);
#else
            for (int j = 0; j < HalfDimensions; ++j) psq.accumulation[j] += w[j];
#endif
            const std::int32_t* p = &net.psqt[std::size_t(idx) * PSQTBuckets];
            for (int k = 0; k < PSQTBuckets; ++k) psq.psqtAccumulation[k] += p[k];
        }

        // Threat half: reuse our own (bit-identical-to-SF) FullThreats extraction.
        // active_features() encodes threat entries as OUR net's PsqSize (12288) plus
        // the 0-based SF threat index — rebase onto SF's own 79856-wide space.
        NNUE::active_features(pos, Color(c), feat);
        for (const int v : feat.threat) {
            const int idx = v - NNUE::PsqSize;
            if (idx < 0 || idx >= ThreatDims) die("threat feature index out of range");
            const std::int8_t* w = &net.threatWeights[std::size_t(idx) * HalfDimensions];
#if SFNET_USE_SIMD
            simd::col_add_i8widen_i16<HalfDimensions>(thr.accumulation, w);
#else
            for (int j = 0; j < HalfDimensions; ++j) thr.accumulation[j] += w[j];
#endif
            const std::int32_t* p = &net.threatPsqt[std::size_t(idx) * PSQTBuckets];
            for (int k = 0; k < PSQTBuckets; ++k) thr.psqtAccumulation[k] += p[k];
        }
    }
}

}  // namespace

// forward_pass — declared in sfnet_internal.h, shared verbatim by evaluate_raw (below)
// and SFNet::AccStack::eval (src/sfnet_accumulator.cpp, Wave 4). This is the exact
// arithmetic evaluate_raw used to run inline before the Wave 4 refactor — moved into
// its own function, not rewritten (see docs/sfnet-wave4.md's byte-identical-refactor
// note: `make sfnet_eval_test --self-check` still passes 560/560 after this move).
EvalPair forward_pass(const HalfAcc psq[2], const HalfAcc thr[2], const Color persp[2], int bucket) {
    const Net& net = SFNet::net();

    // Feature transformer: pairwise clamp+multiply, own-perspective block first
    // (nnue_feature_transformer.h transform(), UseThreats branch, scalar path).
    std::uint8_t ft[HalfDimensions];
    constexpr int Half = HalfDimensions / 2;  // 512
    for (int p = 0; p < 2; ++p) {
        const HalfAcc& ps = psq[persp[p]];
        const HalfAcc& th = thr[persp[p]];
#if SFNET_USE_SIMD
        simd::pairwise_combine_sf(ps.accumulation, th.accumulation, ft + Half * p, Half);
#else
        const int offset = Half * p;
        for (int j = 0; j < Half; ++j) {
            std::int32_t s0 = std::int32_t(ps.accumulation[j]) + std::int32_t(th.accumulation[j]);
            std::int32_t s1 = std::int32_t(ps.accumulation[j + Half]) + std::int32_t(th.accumulation[j + Half]);
            s0 = clampi(s0, 0, 255);
            s1 = clampi(s1, 0, 255);
            ft[offset + j] = std::uint8_t((unsigned(s0) * unsigned(s1)) / 512u);
        }
#endif
    }

    // psqt: own-minus-enemy for both feature sets, averaged.
    std::int32_t psqtOut = psq[persp[0]].psqtAccumulation[bucket]
                          - psq[persp[1]].psqtAccumulation[bucket];
    psqtOut = (psqtOut + thr[persp[0]].psqtAccumulation[bucket]
                        - thr[persp[1]].psqtAccumulation[bucket]) / 2;

    // Layer stack `bucket` — fc_0 (16 outputs, neuron 15 is a linear bypass) ->
    // sqr-clipped-relu(0..14) ‖ clipped-relu(0..14) -> fc_1 (32) -> clipped-relu -> fc_2 (1).
    const LayerStack& L = net.stacks[bucket];

    std::int32_t fc0[Fc0Out];
    for (int i = 0; i < Fc0Out; ++i) {
        const std::int8_t* w = &L.fc0w[i * HalfDimensions];
#if SFNET_USE_SIMD
        fc0[i] = L.fc0b[i] + simd::dot_u8i8_sf(ft, w, HalfDimensions);
#else
        std::int32_t sum = L.fc0b[i];
        for (int j = 0; j < HalfDimensions; ++j) sum += std::int32_t(w[j]) * std::int32_t(ft[j]);
        fc0[i] = sum;
#endif
    }

    // sqr_clipped_relu.h: min(127, (int64)fc0[i]*fc0[i] >> (2*WeightScaleBits+7)).
    // clipped_relu.h:     clamp(fc0[i] >> WeightScaleBits, 0, 127).
    // Only neurons 0..L2-1 (14) feed fc_1; neuron L2 (15) is the linear bypass and is
    // computed here only as `fc0[L2]` for `fwd` below — its sq/cr never enter `in1`.
    std::uint8_t in1[Fc1InPadded] = {};  // 32 wide; entries 30,31 stay zero-padded
    for (int i = 0; i < L2; ++i) {
        const std::int64_t sq64 = std::int64_t(fc0[i]) * std::int64_t(fc0[i]);
        const std::int32_t sq = std::int32_t(std::min<std::int64_t>(127, sq64 >> (2 * WeightScaleBits + 7)));
        const std::int32_t cr = clampi(fc0[i] >> WeightScaleBits, 0, 127);
        in1[i]      = std::uint8_t(sq);
        in1[L2 + i] = std::uint8_t(cr);
    }

    std::int32_t fc1[L3];
    for (int o = 0; o < L3; ++o) {
        const std::int8_t* w = &L.fc1w[o * Fc1InPadded];
#if SFNET_USE_SIMD
        fc1[o] = L.fc1b[o] + simd::dot_u8i8_sf(in1, w, Fc1InPadded);
#else
        std::int32_t sum = L.fc1b[o];
        for (int i = 0; i < Fc1InPadded; ++i) sum += std::int32_t(w[i]) * std::int32_t(in1[i]);
        fc1[o] = sum;
#endif
    }

    std::uint8_t a1[L3];
    for (int o = 0; o < L3; ++o) a1[o] = std::uint8_t(clampi(fc1[o] >> WeightScaleBits, 0, 127));

#if SFNET_USE_SIMD
    std::int32_t fc2 = L.fc2b[0] + simd::dot_u8i8_sf(a1, L.fc2w, Fc2In);
#else
    std::int32_t fc2 = L.fc2b[0];
    for (int i = 0; i < Fc2In; ++i) fc2 += std::int32_t(L.fc2w[i]) * std::int32_t(a1[i]);
#endif

    // nnue_architecture.h propagate(): fwdOut = fc0[FC_0_OUTPUTS] * (600*OutputScale) /
    // (127 * (1<<WeightScaleBits)) = fc0[15] * 9600 / 8128, plain int32 arithmetic (one
    // multiply, one truncating divide, in that order) exactly as SF computes it —
    // reproduced as written even though it can in principle overflow int32 for an
    // adversarial weight/feature combination; see docs/sfnet-wave2.md.
    const std::int32_t fwd = fc0[L2] * (600 * OutputScale) / (127 * (1 << WeightScaleBits));
    const std::int32_t positionalRaw = fc2 + fwd;

    return EvalPair{int(psqtOut / OutputScale), int(positionalRaw / OutputScale)};
}

EvalPair evaluate_raw(const Position& pos) {
    assert(!pos.in_check());
    if (!loaded()) die("no net loaded");
    const Net& net = SFNet::net();

    Accumulators acc;
    build_accumulators(pos, net, acc);

    // network.cpp: Network::evaluate — bucket picks BOTH the psqt column and the layer
    // stack; the same popcount, no separate "material" concept.
    const int bucket = (BB::popcount(pos.pieces()) - 1) / 4;
    const Color stm = pos.side_to_move();
    const Color persp[2] = {stm, ~stm};

    return forward_pass(acc.psq, acc.thr, persp, bucket);
}

// post_process — declared in sfnet_internal.h. SF's evaluate.cpp blend (nnue/
// complexity/material/rule50), reproduced verbatim (see docs/sfnet-wave4.md — this was
// cross-checked directly against ~/sf18-arm/src/evaluate.cpp's Eval::evaluate, not just
// against the written task spec): optimism is fixed at 0 (no root-average-score plumbing
// yet — that is a later wave), so its `optimism * (7191 + material) / 77871` term drops
// out entirely, and no cp rescale is applied (Wave 5). All-integer, all truncating
// division, in the exact order SF computes them.
//
// ---- Wave 5: the centipawn scale fit (docs/sfnet-wave5.md) ----
// SF's post-processed `v` (below) is on SF's own internal Value scale, not zug's
// pawn=100 cp scale that RFP/razoring/futility/SEE margins are tuned against — so it
// needs a rescale, or an SPRT would measure the mis-scaling rather than the net.
//
// SFNETK is that rescale, an integer PERCENT (SFNETK=100 == x1.00), read once from the
// env (same static-lambda-once pattern as THREATGATE/THREATDELTA in nnue_features.cpp)
// so it is tunable per SPRT run with no rebuild. Default 48 (k=0.48, i.e. ~100/208):
// this is NOT a fit against our own net's per-position cp — see docs/sfnet-wave5.md for
// why that corpus fit doesn't converge to a stable number (our net rails on nearly every
// position in the 560-FEN corpus, even the "most live" subset) — it is the SAME SF
// eval-scale -> zug pawn=100 ratio (PawnValue=208, ~sf18-arm/src/types.h:185) this
// codebase already uses in three other places to port SF's own margin constants onto
// zug's scale: Tune::capFutBase/capFutSlope (search.cpp ~995-1006, "ratio 100/208 ~=
// 0.4808"), Tune::capFutHistCoeff (same block), and RAZORQUAD (search.cpp ~3049-3052,
// "zug/SF pawn-value ratio 100/208"). A controlled material ladder (Wave 3's own
// instrument, tools/sfnet_material_ladder.py — SUB rungs, which hold the psqt bucket
// FIXED across a deficit of 400-580cp) measures our_eval/sf_full independently at
// 0.485 / 0.478 / 0.410 across three rungs — corroborating 0.48 from a controlled
// measurement, not the noisy real-game corpus. See docs/sfnet-wave5.md for both.
namespace {
int sfnet_k_percent() {
    static const int k = [] {
        if (const char* e = std::getenv("SFNETK")) {
            const int v = std::atoi(e);
            if (v > 0) return v;
        }
        return 48;
    }();
    return k;
}
}  // namespace

// Position::non_pawn_material(Color) in THIS codebase returns a bool (see position.h) —
// deliberately NOT used here; material is computed piece-by-piece with SF's own values.
int post_process(EvalPair ev, const Position& pos) {
    std::int32_t nnue = (125 * ev.psqt + 131 * ev.positional) / 128;
    const std::int32_t complexity = std::abs(ev.psqt - ev.positional);
    nnue -= nnue * complexity / 18236;

    constexpr std::int32_t KnightValue = 781, BishopValue = 825, RookValue = 1276, QueenValue = 2538;
    const std::int32_t pawns = pos.count(WHITE, PAWN) + pos.count(BLACK, PAWN);
    const std::int32_t nonPawnMaterial =
        KnightValue * (pos.count(WHITE, KNIGHT) + pos.count(BLACK, KNIGHT)) +
        BishopValue * (pos.count(WHITE, BISHOP) + pos.count(BLACK, BISHOP)) +
        RookValue   * (pos.count(WHITE, ROOK)   + pos.count(BLACK, ROOK))   +
        QueenValue  * (pos.count(WHITE, QUEEN)  + pos.count(BLACK, QUEEN));
    const std::int32_t material = 534 * pawns + nonPawnMaterial;

    std::int32_t v = (nnue * (77871 + material)) / 77871;  // optimism = 0
    v -= v * pos.rule50_count() / 199;
    v = (v * sfnet_k_percent()) / 100;  // Wave 5: SF Value scale -> zug pawn=100 cp scale
    return int(v);
}

int evaluate(const Position& pos) {
    return post_process(evaluate_raw(pos), pos);
}

bool self_check(const Position& pos, std::string* why) {
    auto fail = [&](const char* msg) {
        if (why) *why = msg;
        return false;
    };
    if (!loaded()) return fail("net not loaded");

    const BaseTables& T = base_tables();
    std::vector<int> baseIdx;
    NNUE::Features feat;

    for (int c = WHITE; c <= BLACK; ++c) {
        base_indices(T, pos, Color(c), baseIdx);
        if (baseIdx.size() != std::size_t(BB::popcount(pos.pieces())))
            return fail("base feature count != piece count");
        for (const int idx : baseIdx)
            if (idx < 0 || idx >= PsqDims) return fail("base feature index out of [0, PsqDims)");

        NNUE::active_features(pos, Color(c), feat);
        for (const int v : feat.threat) {
            const int idx = v - NNUE::PsqSize;
            if (idx < 0 || idx >= ThreatDims) return fail("threat feature index out of [0, ThreatDims)");
        }
    }

    // Both perspectives' accumulation vectors are HalfDimensions (1024) wide by
    // construction (HalfAcc::accumulation's array bound) — assert that bound matches
    // the architecture constant rather than trusting the struct layout silently.
    static_assert(sizeof(HalfAcc::accumulation) / sizeof(std::int16_t) == HalfDimensions,
                  "HalfAcc::accumulation must be exactly HalfDimensions wide");

    // Exercise the whole forward pass; build_accumulators/evaluate_raw abort() (via
    // die()) on any of the same range checks above, so reaching this point with no
    // abort is itself part of the check.
    const EvalPair ev = evaluate_raw(pos);
    if (ev.psqt < -32768 || ev.psqt > 32767) return fail("psqt output implausibly large");
    if (ev.positional < -32768 || ev.positional > 32767) return fail("positional output implausibly large");

    return true;
}

}  // namespace SFNet
