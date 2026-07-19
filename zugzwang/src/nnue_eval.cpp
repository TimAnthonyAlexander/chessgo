#include "nnue.h"
#include "nnue_internal.h"
#include "nnue_arch.h"
#include "nnue_net.h"
#include "nnue_features.h"
#include "position.h"
#include "bitboard.h"
#include "types.h"

#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdlib>

// Bit-exact port of gomachine's prod full-threats forward pass — the multilayer
// int8-L1 path (enriched_int8.go `evalFromHalvesInt8` + enriched.go `Eval`).
//
// gomachine is the reference; every arithmetic detail is replicated:
//   * the int16 feature-transformer accumulator wraps like Go's int16 (+= narrows
//     to int16_t, which is two's-complement wraparound on the target platforms);
//   * dotU8I8 SATURATES each (u8·i8 + u8·i8) pair to int16 before summing into
//     int32 — that saturation is PART OF the defined int8 forward, not a HW quirk;
//   * the float tail GEMVs accumulate each output in i-ASCENDING order and must
//     NOT fuse `a + b*c` into an FMA (Go's gc does not), hence FP_CONTRACT OFF.
//
// Compile without -ffast-math / -ffp-contract=fast (the standard -O3 build uses
// -ffp-contract=on, which honors the pragma below and leaves the tail un-fused).
#pragma STDC FP_CONTRACT OFF

namespace NNUE {
namespace {

// ---------------------------------------------------------------------------
// Micro-opt env flags (default OFF). Both mirror threat_delta_enabled's style
// exactly: a lambda-initialized `static const bool`, so getenv runs exactly
// once per process regardless of how many times the eval path is hit inside
// search. Each flag is independent, byte-identical when off, and documented
// at its use site below (dot_u8i8 for DOTSPLIT, eval_from_halves for
// ROUNDFAST).
// ---------------------------------------------------------------------------

// DOTSPLIT — 4-way accumulator split of the int8 L1 dot kernel (dot_u8i8).
// Default OFF; DOTSPLIT=1 to enable. See dot_u8i8 below for the bit-exactness
// argument (int32 addition is associative/non-overflowing on this data).
static inline bool dotsplit_enabled() {
    static const bool on = [] { const char* e = getenv("DOTSPLIT"); return e && e[0] == '1'; }();
    return on;
}

// ROUNDFAST — branchless round-half-away-from-zero replacing std::round at
// the tail of eval_from_halves (avoids a libm roundf32 call, measured ~1.4%
// of node self-time). Default OFF; ROUNDFAST=1 to enable. See eval_from_halves
// for the (rare, measured) float-boundary caveat.
static inline bool roundfast_enabled() {
    static const bool on = [] { const char* e = getenv("ROUNDFAST"); return e && e[0] == '1'; }();
    return on;
}

// ---------------------------------------------------------------------------
// Stage helpers — each mirrors exactly one gomachine kernel (file:line noted),
// kept tiny + static so they can be unit-tested against the Go formulas.
// ---------------------------------------------------------------------------

// materialBucket arithmetic (multilayer.go:141-154): divisor = ceil(32/NB);
// bucket = clamp((occupied_count - 2) / divisor, 0, NB-1). Integer division,
// truncating toward zero exactly as Go.
static inline int bucket_from_count(int occ_count) {
    if (NB <= 1) return 0;
    const int divisor = (32 + NB - 1) / NB;  // = 4 for NB=8
    int b = (occ_count - 2) / divisor;
    if (b < 0) return 0;
    if (b >= NB) return NB - 1;
    return b;
}

static inline int material_bucket(const Position& pos) {
    return bucket_from_count(BB::popcount(pos.pieces()));
}

// screluF (multilayer.go:157-165): clamp x to [0,1] then square.
static inline float screlu(float x) {
    if (x < 0.0f) return 0.0f;
    if (x > 1.0f) x = 1.0f;
    return x * x;
}

// pairwiseU8Scalar (kernels.go:250-267): the int8-path pairwise FT activation for
// one output. a=clamp(lo,0,ftQA), b=clamp(hi,0,ftQA); u8 = (a*b + ftRound) >> ftShift.
// With ftQA=255, ftRound=256, ftShift=9 the max is (255*255+256)>>9 = 127, so the
// result always fits u8.
static inline uint8_t pairwise_u8(int16_t lo, int16_t hi) {
    int a = lo;
    if (a < 0) a = 0; else if (a > ftQA) a = ftQA;
    int b = hi;
    if (b < 0) b = 0; else if (b > ftQA) b = ftQA;
    return static_cast<uint8_t>((a * b + ftRound) >> ftShift);
}

// dotU8I8Scalar (kernels.go:279-296): models VPMADDUBSW+VPMADDWD EXACTLY. For each
// adjacent (u8,i8) pair form the int16 sum a[i]*w[i]+a[i+1]*w[i+1], SATURATE it to
// int16 [-32768,32767], then accumulate into int32 (no further saturation). An odd
// trailing element contributes a single product (|255*127| < 2^15, cannot saturate).
static inline int32_t dot_u8i8_scalar(const uint8_t* a, const int8_t* w, int n) {
    int32_t acc = 0;
    int i = 0;
    for (; i + 2 <= n; i += 2) {
        int32_t p = static_cast<int32_t>(a[i])     * static_cast<int32_t>(w[i])
                  + static_cast<int32_t>(a[i + 1]) * static_cast<int32_t>(w[i + 1]);
        if (p > 32767) p = 32767;
        else if (p < -32768) p = -32768;
        acc += p;
    }
    if (i < n)  // odd tail: single product, cannot saturate
        acc += static_cast<int32_t>(a[i]) * static_cast<int32_t>(w[i]);
    return acc;
}

// dot_u8i8: SIMD dispatch that is PROVABLY bit-exact with dot_u8i8_scalar above,
// not just "close enough" — the scalar int16 saturation is a modeled HW quirk of
// VPMADDUBSW+VPMADDWD, but it can be proven to NEVER actually fire on real data:
//
//   * a[] (the pairwise_u8 activation) is documented above to satisfy
//     a[i] = (a*b + 256) >> 9 with a,b in [0,255], whose max is
//     (255*255+256)>>9 = 127. So a[i] in [0,127], NOT the full u8 range.
//   * w[] is int8 clamped to +/-127 (L1QB quantization), so w[i] in [-127,127].
//   * Each product a[i]*w[i] in [-127*127, 127*127] = [-16129, 16129].
//   * Each adjacent PAIR-SUM (what the scalar loop saturates) is therefore in
//     [-32258, 32258], which is strictly INSIDE int16 range [-32768, 32767].
//     The saturation branch in dot_u8i8_scalar can never trigger on real
//     accumulator/weight data — only on adversarial inputs outside the
//     documented ranges (which never occur: see pairwise_u8 and the net's
//     int8 weight clamp).
//   * Because saturation never fires, the scalar result reduces to the plain
//     Sigma a[i]*w[i] over i in [0,n) — exactly what a widening dot-product
//     instruction (VPDPBUSD / vdotq) computes with NO intermediate int16 step.
//   * int32 cannot overflow either: n<=512 terms x max 16129 ~= 8.26M,
//     far under 2^31.
//
// So on the real a[]/w[] domain, dot_u8i8_scalar and a direct widening-dot SIMD
// implementation compute the IDENTICAL int32 value, term for term, associative
// or not (there's only one order: ascending i, matching the widening instructions).
#if defined(__AVX512VNNI__)
#include <immintrin.h>
// DOTSPLIT (AVX512VNNI): the baseline loop below is ONE `__m512i` accumulator
// read-and-written by every `_mm512_dpbusd_epi32` in strict sequence — a
// single RAW dependency chain. `_mm512_dpbusd_epi32` has multi-cycle latency
// but the port throughput allows more than one in flight per cycle on
// VNNI-capable cores (Ice Lake/Zen4+), so a single chain leaves throughput on
// the table waiting on latency. DOTSPLIT=1 uses 4 INDEPENDENT `__m512i`
// accumulators, round-robin over 4 disjoint 64-lane sub-ranges of the same
// 512-wide dot, combined via 3x `_mm512_add_epi32` (+ a scalar/tail merge)
// only at the very end.
//
// Bit-exactness: int32 addition is exactly associative and commutative, and
// per this file's own overflow proof above (max magnitude ~8.26M term, <=512
// terms, far under 2^31), no partial sum here can overflow either. Summing
// the same 512 per-lane products in 4 independent partial groups instead of
// one long chain changes only the ORDER accumulation happens in, not the
// terms or their values -- the final int32 total is bit-for-bit identical to
// the single-chain loop. When DOTSPLIT is unset, this is exactly the
// pre-existing single-chain code (the `else` branch below is untouched).
static inline int32_t dot_u8i8(const uint8_t* a, const int8_t* w, int n) {
    if (dotsplit_enabled()) {
        __m512i vacc0 = _mm512_setzero_si512();
        __m512i vacc1 = _mm512_setzero_si512();
        __m512i vacc2 = _mm512_setzero_si512();
        __m512i vacc3 = _mm512_setzero_si512();
        int i = 0;
        for (; i + 256 <= n; i += 256) {
            __m512i va0 = _mm512_loadu_si512(reinterpret_cast<const void*>(a + i));
            __m512i vw0 = _mm512_loadu_si512(reinterpret_cast<const void*>(w + i));
            vacc0 = _mm512_dpbusd_epi32(vacc0, va0, vw0);
            __m512i va1 = _mm512_loadu_si512(reinterpret_cast<const void*>(a + i + 64));
            __m512i vw1 = _mm512_loadu_si512(reinterpret_cast<const void*>(w + i + 64));
            vacc1 = _mm512_dpbusd_epi32(vacc1, va1, vw1);
            __m512i va2 = _mm512_loadu_si512(reinterpret_cast<const void*>(a + i + 128));
            __m512i vw2 = _mm512_loadu_si512(reinterpret_cast<const void*>(w + i + 128));
            vacc2 = _mm512_dpbusd_epi32(vacc2, va2, vw2);
            __m512i va3 = _mm512_loadu_si512(reinterpret_cast<const void*>(a + i + 192));
            __m512i vw3 = _mm512_loadu_si512(reinterpret_cast<const void*>(w + i + 192));
            vacc3 = _mm512_dpbusd_epi32(vacc3, va3, vw3);
        }
        // Tail: fewer than 256 elements remain (0 of them for H=512 since
        // 512 % 256 == 0, but handled generally for any n) -- fold any
        // remaining whole 64-lane blocks into a 5th single-chain accumulator.
        __m512i vacc4 = _mm512_setzero_si512();
        for (; i + 64 <= n; i += 64) {
            __m512i va = _mm512_loadu_si512(reinterpret_cast<const void*>(a + i));
            __m512i vw = _mm512_loadu_si512(reinterpret_cast<const void*>(w + i));
            vacc4 = _mm512_dpbusd_epi32(vacc4, va, vw);
        }
        int32_t acc = _mm512_reduce_add_epi32(vacc0) + _mm512_reduce_add_epi32(vacc1)
                    + _mm512_reduce_add_epi32(vacc2) + _mm512_reduce_add_epi32(vacc3)
                    + _mm512_reduce_add_epi32(vacc4);
        if (i < n)
            acc += dot_u8i8_scalar(a + i, w + i, n - i);
        return acc;
    }
    __m512i vacc = _mm512_setzero_si512();
    int i = 0;
    for (; i + 64 <= n; i += 64) {
        __m512i va = _mm512_loadu_si512(reinterpret_cast<const void*>(a + i));
        __m512i vw = _mm512_loadu_si512(reinterpret_cast<const void*>(w + i));
        vacc = _mm512_dpbusd_epi32(vacc, va, vw);
    }
    int32_t acc = _mm512_reduce_add_epi32(vacc);
    if (i < n)
        acc += dot_u8i8_scalar(a + i, w + i, n - i);
    return acc;
}
#elif defined(__ARM_FEATURE_DOTPROD)
#include <arm_neon.h>
// DOTSPLIT (NEON/DOTPROD): same fix as the AVX512VNNI branch above, sized for
// NEON's 16-lane `vdotq_s32` (32 iterations over H=512 at the baseline
// 16-wide step vs. AVX512's 8 iterations at 64-wide) -- 4-way split groups
// iterations into 64-element blocks (4x16), independent int32x4_t
// accumulators, combined via vaddvq_s32 only at the end. Bit-exactness
// argument is identical to the AVX512 branch's comment (int32 add is
// associative/non-overflowing on this data) -- see there for the proof.
static inline int32_t dot_u8i8(const uint8_t* a, const int8_t* w, int n) {
    // a[i] in [0,127] fits int8 without change of bit pattern or value, so
    // reinterpreting the u8 buffer as int8 and using the SIGNED dot (vdotq_s32,
    // s8 x s8 -> s32) computes the same products as the true u8 x i8 multiply.
    if (dotsplit_enabled()) {
        int32x4_t vacc0 = vdupq_n_s32(0);
        int32x4_t vacc1 = vdupq_n_s32(0);
        int32x4_t vacc2 = vdupq_n_s32(0);
        int32x4_t vacc3 = vdupq_n_s32(0);
        int i = 0;
        for (; i + 64 <= n; i += 64) {
            int8x16_t va0 = vreinterpretq_s8_u8(vld1q_u8(a + i));
            int8x16_t vw0 = vld1q_s8(w + i);
            vacc0 = vdotq_s32(vacc0, va0, vw0);
            int8x16_t va1 = vreinterpretq_s8_u8(vld1q_u8(a + i + 16));
            int8x16_t vw1 = vld1q_s8(w + i + 16);
            vacc1 = vdotq_s32(vacc1, va1, vw1);
            int8x16_t va2 = vreinterpretq_s8_u8(vld1q_u8(a + i + 32));
            int8x16_t vw2 = vld1q_s8(w + i + 32);
            vacc2 = vdotq_s32(vacc2, va2, vw2);
            int8x16_t va3 = vreinterpretq_s8_u8(vld1q_u8(a + i + 48));
            int8x16_t vw3 = vld1q_s8(w + i + 48);
            vacc3 = vdotq_s32(vacc3, va3, vw3);
        }
        // Tail: fewer than 64 elements remain (0 for H=512 since 512%64==0,
        // handled generally) -- fold remaining whole 16-lane blocks into a
        // 5th single-chain accumulator.
        int32x4_t vacc4 = vdupq_n_s32(0);
        for (; i + 16 <= n; i += 16) {
            int8x16_t va = vreinterpretq_s8_u8(vld1q_u8(a + i));
            int8x16_t vw = vld1q_s8(w + i);
            vacc4 = vdotq_s32(vacc4, va, vw);
        }
        int32_t acc = vaddvq_s32(vacc0) + vaddvq_s32(vacc1) + vaddvq_s32(vacc2)
                    + vaddvq_s32(vacc3) + vaddvq_s32(vacc4);
        if (i < n)
            acc += dot_u8i8_scalar(a + i, w + i, n - i);
        return acc;
    }
    int32x4_t vacc = vdupq_n_s32(0);
    int i = 0;
    for (; i + 16 <= n; i += 16) {
        int8x16_t va = vreinterpretq_s8_u8(vld1q_u8(a + i));
        int8x16_t vw = vld1q_s8(w + i);
        vacc = vdotq_s32(vacc, va, vw);
    }
    int32_t acc = vaddvq_s32(vacc);
    if (i < n)
        acc += dot_u8i8_scalar(a + i, w + i, n - i);
    return acc;
}
#else
static inline int32_t dot_u8i8(const uint8_t* a, const int8_t* w, int n) {
    return dot_u8i8_scalar(a, w, n);
}
#endif

// gemvF32Scalar (kernels.go:135-146): output-stationary GEMV over INPUT-MAJOR
// weights. out[o] = Σ_i in[i] · w[i*stride + off + o]. The input-outer loop is
// load-bearing for float bit-exactness: each out[o] accumulates its terms in
// i-ASCENDING order (i=0,1,2,...), matching Go's non-associative float32 add order.
static inline void gemv_f32(float* out, int outN,
                            const float* in, int inN,
                            const float* w, int stride, int off) {
    for (int o = 0; o < outN; ++o) out[o] = 0.0f;
    for (int i = 0; i < inN; ++i) {
        const float x = in[i];
        const float* row = w + static_cast<std::size_t>(i) * stride + off;
        for (int o = 0; o < outN; ++o)
            out[o] += x * row[o];  // FP_CONTRACT OFF -> no FMA fusion
    }
}

// buildAccHalf (enriched.go:483-489): seed one perspective's accumulator with the
// FT bias, then add every active feature's int16 column. In the prod net BOTH base
// and threat columns are int16 (nnue_net.h has no int8 threat table), so the add is
// uniform. int16 wraparound add is associative/commutative, so the base-then-threat
// order is irrelevant to the result (it matches Go's sum regardless).
static void build_acc_half(int16_t* acc, const Features& f) {
    const int16_t* B0 = g_net.B0i.data();
    for (int i = 0; i < H; ++i) acc[i] = B0[i];

    const int16_t* W0 = g_net.W0i.data();
    for (int feat : f.base) {
        const int16_t* col = W0 + static_cast<std::size_t>(feat) * H;
        for (int i = 0; i < H; ++i) acc[i] += col[i];  // int16 wraparound
    }
    for (int feat : f.threat) {
        const int16_t* col = W0 + static_cast<std::size_t>(feat) * H;
        for (int i = 0; i < H; ++i) acc[i] += col[i];  // int16 wraparound
    }
}

} // namespace

// eval_from_halves: the multilayer forward pass over two prebuilt FT accumulator
// halves (accW = White-perspective, accB = Black-perspective), oriented to the side to
// move. Shared by the from-scratch evaluate() below and the incremental AccStack (see
// nnue_internal.h) — since it is a pure function of (accW, accB, pos), incremental
// bit-exactness reduces to "incremental halves == from-scratch halves" (int16). Ports
// enriched.go `Eval` (orientation + bucket) + enriched_int8.go `evalFromHalvesInt8`
// (pairwise-u8 -> int8 L1 -> float L2 -> float output).
int eval_from_halves(const int16_t* accW, const int16_t* accB, const Position& pos) {
    // stm/opp orientation (enriched.go:525-528): stm is the side-to-move half.
    const int16_t* stm = accW;
    const int16_t* opp = accB;
    if (pos.side_to_move() == BLACK) {
        stm = accB;
        opp = accW;
    }

    const int bk = material_bucket(pos);

    // (1) pairwise-u8 activation -> aq[H] = [ stm_pair(256) | opp_pair(256) ].
    constexpr int half = H / 2;  // 256
    uint8_t aq[H];
    for (int i = 0; i < half; ++i) {
        aq[i]        = pairwise_u8(stm[i], stm[i + half]);
        aq[half + i] = pairwise_u8(opp[i], opp[i + half]);
    }

    // (2) L1 int8: u8·i8 saturating dot -> descale (constant L1Inv=1/8128) -> +bias
    //     -> SCReLU. L1W8 row for (bucket bk, output o) is L1W8[(bk*D2+o)*H : +H].
    const int8_t* L1W = g_net.L1W8.data() + static_cast<std::size_t>(bk) * D2 * H;
    const float*  L1B = g_net.L1B.data()  + static_cast<std::size_t>(bk) * D2;
    float l1[D2];
    for (int o = 0; o < D2; ++o) {
        int32_t d = dot_u8i8(aq, L1W + static_cast<std::size_t>(o) * H, H);
        l1[o] = screlu(static_cast<float>(d) * L1Inv + L1B[o]);
    }

    // (3) L2 float GEMV (input-major, D2 -> D3) -> +bias -> SCReLU.
    float l2[D3];
    gemv_f32(l2, D3, l1, D2, g_net.L2W.data(), NB * D3, bk * D3);
    const float* L2B = g_net.L2B.data() + static_cast<std::size_t>(bk) * D3;
    for (int o = 0; o < D3; ++o)
        l2[o] = screlu(l2[o] + L2B[o]);

    // (4) output GEMV (D3 -> 1) -> +bias -> scale -> round-half-away-from-zero.
    float y1[1];
    gemv_f32(y1, 1, l2, D3, g_net.OW.data(), NB, bk);
    float y = g_net.OB[bk] + y1[0];
    float scaled = y * CpScale;  // float32 multiply, then widen for the round

    // ROUNDFAST: std::round(double) lowers to a libm `roundf32`/`round` call
    // (measured ~1.4% of node self-time -- a real cost for "round to nearest
    // int" on a value whose fractional part we don't otherwise care about).
    // The ROUNDFAST=1 path replaces it with the classic branchless
    // round-half-away-from-zero trick: add +-0.5 then truncate-toward-zero
    // via the int cast. Truncating (scaled + 0.5) toward zero is exactly
    // round-half-away-from-zero for scaled>=0 (and symmetrically for <0 with
    // -0.5), which is std::round's own rounding mode -- so the two agree on
    // every value EXCEPT the rare float-boundary case where `scaled + 0.5f`
    // itself rounds (in float32) to the next integer's boundary before the
    // truncation happens (a floating-point representation artifact of the
    // add, not a difference in rounding *rule*). That rate was measured
    // empirically (see the batch-spec deliverable) and is negligible; kept
    // default OFF regardless since the win is small (~1.4%) and a search
    // that wants strict libm-`round` parity (e.g. cross-checking against a
    // reference build) should leave it off.
    if (roundfast_enabled())
        return static_cast<int>(scaled + (scaled >= 0.0f ? 0.5f : -0.5f));
    return static_cast<int>(std::round(static_cast<double>(scaled)));
}

// evaluate: the from-scratch static eval (side-to-move-relative centipawns). Builds
// both absolute-color halves from the current board and runs the shared forward. This
// is the golden-tested path (test/golden_check.sh) and the assert oracle for the
// incremental accumulator. Used for every eval OUTSIDE search; inside search the
// AccStack maintains the halves incrementally and calls eval_from_halves directly.
int evaluate(const Position& pos) {
    if (!g_net.ok) return 0;

    Features fw, fb;
    active_features(pos, WHITE, fw);
    active_features(pos, BLACK, fb);

    int16_t accW[H];
    int16_t accB[H];
    build_acc_half(accW, fw);
    build_acc_half(accB, fb);

    return eval_from_halves(accW, accB, pos);
}

} // namespace NNUE
