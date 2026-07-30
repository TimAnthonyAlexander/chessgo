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

// PAIRSIMD — SIMD the pairwise_u8 FT activation loop in eval_from_halves
// (~10.9% of node self-time; the dot itself is only ~1.5%, so pairwise + tail
// dominate eval). Default OFF; PAIRSIMD=1 to enable. See pairwise_u8_block
// below for the bit-exactness argument (the whole computation fits exactly
// in unsigned 16-bit lanes, so the vector path is provably byte-identical
// to the scalar path -- not an approximation).
static inline bool pairsimd_enabled() {
    static const bool on = [] { const char* e = getenv("PAIRSIMD"); return e && e[0] == '1'; }();
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

// ---- SATLEAK: leaky SCReLU (default eps = 0, i.e. exactly screlu) -------------
// The tail's D2=16 L1 layer rails completely once either side is up ~a piece, and the
// output then collapses to a per-(bucket, rail-pattern) constant. But the CLAMP is what
// destroys the gradient, not the layer: the pre-activations keep varying with the
// position. Measured on a fixed frame, black down Q+B+R vs down Q+B+2R evaluate to the
// same -1062 while the largest pre-activation overshoot moves 2.95 -> 3.65. The extra
// rook is visible to the net and screlu throws it away.
//
// So instead of substituting a weaker hand-crafted eval (every SATFIX mode cost Elo,
// -3.7 to -20.8), continue the activation linearly past each rail. Identical to screlu
// on [0,1] and continuous at both knees, so positions where nothing rails are untouched
// and only the collapsed regime changes — and it changes using the net's OWN weights.
//
// eps = 0 makes this bit-for-bit screlu (x<0 -> 0*x = 0, x>1 -> 1 + 0 = 1), so the
// default build needs no branch and is byte-identical by construction.
static inline float screlu_leak(float x, float eps) {
    if (x < 0.0f) return eps * x;                  // linear, negative, small slope
    if (x > 1.0f) return 1.0f + eps * (x - 1.0f);  // linear continuation above the rail
    return x * x;
}

// L1 leak slope, from SATLEAK in per-mille (SATLEAK=50 -> 0.05). 0/absent = off.
static inline float sat_leak_eps() {
    static const float e = [] {
        const char* s = getenv("SATLEAK");
        return s ? static_cast<float>(atoi(s)) / 1000.0f : 0.0f;
    }();
    return e;
}
// SATSOFT (per-mille): leak slope applied ONLY at fully-collapsed nodes. 1000 = the
// activation continues linearly past both rails (no clamp at all). This is the shipping
// form of the idea; SATLEAK/SATLEAK2 are the ungated versions kept for attribution.
//
// DEFAULT ON (1000) since 2026-07-30. Normal-play SPRT -0.58 +/- 6.31 over 3000 games
// (costs nothing), while over the 6.6% of positions where the eval is blind it halves
// the centipawn loss judged by SF18 (45 -> 22 cp overall, 62 -> 27 on the winning side)
// and cuts material given away from ~4200 to 825 cp. SATSOFT=0 is the kill-switch.
static inline float satsoft_eps() {
    static const float e = [] {
        const char* s = getenv("SATSOFT");
        return s ? static_cast<float>(atoi(s)) / 1000.0f : 1.0f;
    }();
    return e;
}
// Fraction of the soft-vs-clamped difference that is kept (SATSOFTK, per-mille).
// The raw soft output is monotone but ~7x out of scale, so it is used for DIRECTION
// only, with the clamped constant remaining the anchor. SPSA candidate.
static inline float satsoft_k() {
    static const float k = [] {
        const char* s = getenv("SATSOFTK");
        return s ? static_cast<float>(atoi(s)) / 1000.0f : 0.12f;
    }();
    return k;
}
// Max number of still-live L1 lanes for which the soft pass still applies. 0 = only
// total collapse (the strictly-constant case). Raising it trades byte-identity in more
// positions for coverage of the near-blind ones.
static inline int satsoft_live() {
    static const int n = [] { const char* s = getenv("SATSOFTLIVE"); return s ? atoi(s) : 0; }();
    return n;
}
// L2 leak slope (SATLEAK2, per-mille). L1 variation is useless if L2 clamps it away
// again, so the two normally move together; kept separate to attribute the effect.
static inline float sat_leak2_eps() {
    static const float e = [] {
        const char* s = getenv("SATLEAK2");
        return s ? static_cast<float>(atoi(s)) / 1000.0f : 0.0f;
    }();
    return e;
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

// pairwise_u8_block: SIMD dispatch that is PROVABLY bit-exact with pairwise_u8
// above -- not "close enough", exact -- because the entire computation fits in
// unsigned 16-bit lanes with no overflow at any step:
//
//   * a,b are clamped to [0,255] (ftQA=255), so a,b in [0,255].
//   * a*b in [0, 255*255] = [0, 65025], which is < 2^16 = 65536, so the
//     product fits EXACTLY in a 16-bit lane -- unsigned multiply low-half
//     (vpmullw / vmulq_*16) never loses a bit here, regardless of whether the
//     lane type used to hold it is signed or unsigned.
//   * a*b + 256 (ftRound) is in [256, 65281], STILL < 2^16, so the add cannot
//     overflow the 16-bit lane either.
//   * (a*b + 256) >> 9 (ftShift) is a shift of a value that is provably
//     non-negative, so a LOGICAL right shift (treating the lane as unsigned)
//     gives the identical result C++'s `>>` gives when operating on the `int`
//     values in pairwise_u8 above (which are also non-negative there).
//   * The final result is in [0, (65025+256)>>9] = [0,127], which fits u8 --
//     matching pairwise_u8's return type exactly.
//
// So "clamp -> unsigned 16-bit multiply -> +256 -> logical >>9 -> narrow to
// u8" is not an approximation of pairwise_u8, it IS pairwise_u8, lane for
// lane, with no rounding or saturation difference at any intermediate step.
// half = H/2 = 256 is a compile-time constant divisible by every SIMD step
// width used below (32 for AVX512, 8 for NEON), so there is no tail to handle.
#if defined(__AVX512VNNI__)
#include <immintrin.h>
// AVX512 (32 lanes/step, matching dot_u8i8's __AVX512VNNI__ gate above -- VNNI
// implies the BW subset _mm512_cvtepi16_epi8 needs on the targets that define
// it, e.g. coalla).
static inline void pairwise_u8_block(const int16_t* src, uint8_t* dst) {
    constexpr int half = H / 2;  // 256
    static_assert(half % 32 == 0, "AVX512 pairwise step must divide half");
    const __m512i zero = _mm512_setzero_si512();
    const __m512i c255 = _mm512_set1_epi16(255);
    const __m512i r256 = _mm512_set1_epi16(256);
    for (int i = 0; i < half; i += 32) {
        __m512i lo = _mm512_loadu_si512(reinterpret_cast<const void*>(src + i));
        __m512i hi = _mm512_loadu_si512(reinterpret_cast<const void*>(src + i + half));
        lo = _mm512_min_epi16(_mm512_max_epi16(lo, zero), c255);   // clamp [0,255]
        hi = _mm512_min_epi16(_mm512_max_epi16(hi, zero), c255);
        __m512i prod = _mm512_mullo_epi16(lo, hi);                 // exact: product < 2^16
        prod = _mm512_add_epi16(prod, r256);                       // exact: still < 2^16
        prod = _mm512_srli_epi16(prod, 9);                         // logical >>9 -> [0,127]
        __m256i packed = _mm512_cvtepi16_epi8(prod);               // narrow 32x u16 -> 32x u8
        _mm256_storeu_si256(reinterpret_cast<__m256i*>(dst + i), packed);
    }
}
#elif defined(__ARM_NEON) || defined(__aarch64__)
#include <arm_neon.h>
// NEON (8 lanes/step). The product must be treated as UNSIGNED for the +256
// and >>9: vmulq_s16's low-16 result bit pattern is identical to the true
// unsigned product (proved above to be < 2^16, so it never sets the sign bit
// in the first place), and vreinterpretq_u16_s16 relabels that bit pattern as
// unsigned with zero cost and zero value change, after which vaddq_u16 /
// vshrq_n_u16 are exact unsigned add / logical shift.
static inline void pairwise_u8_block(const int16_t* src, uint8_t* dst) {
    constexpr int half = H / 2;  // 256
    static_assert(half % 8 == 0, "NEON pairwise step must divide half");
    const int16x8_t z = vdupq_n_s16(0);
    const int16x8_t c = vdupq_n_s16(255);
    const uint16x8_t r = vdupq_n_u16(256);
    for (int i = 0; i < half; i += 8) {
        int16x8_t lo = vminq_s16(vmaxq_s16(vld1q_s16(src + i), z), c);         // clamp [0,255]
        int16x8_t hi = vminq_s16(vmaxq_s16(vld1q_s16(src + i + half), z), c);
        int16x8_t prod = vmulq_s16(lo, hi);                                    // exact low16
        uint16x8_t p = vaddq_u16(vreinterpretq_u16_s16(prod), r);              // exact unsigned add
        p = vshrq_n_u16(p, 9);                                                 // logical >>9 -> [0,127]
        uint8x8_t packed = vmovn_u16(p);                                       // narrow to u8
        vst1_u8(dst + i, packed);
    }
}
#elif defined(__wasm_simd128__)
#include <wasm_simd128.h>
// WASM SIMD128 (16 lanes/step -- two i16x8 vectors narrowed together into one
// v128 of u8 lanes per wasm_u8x16_narrow_i16x8, since WASM has no single-vector
// narrow-to-half-width op like NEON's vmovn_u16). Same bit-exactness argument as
// the NEON block above: the product/round/shift stays within an UNSIGNED 16-bit
// lane at every step, and wasm_i16x8_mul/wasm_i16x8_add are plain mod-2^16
// operations (bit-identical regardless of the signed/unsigned tag used to read
// them), so the only place signedness matters is the shift -- wasm_u16x8_shr is
// the LOGICAL (zero-fill) right shift, matching >>9 on the always-non-negative
// true value, exactly as vshrq_n_u16 does for NEON. wasm_u8x16_narrow_i16x8
// applies unsigned saturation on the way to u8, but every lane here is already
// in [0,127] (proved above), so the saturation branch never fires -- narrow is
// therefore an exact truncation here, not an approximation.
static inline void pairwise_u8_block(const int16_t* src, uint8_t* dst) {
    constexpr int half = H / 2;  // 256
    static_assert(half % 16 == 0, "wasm pairwise step must divide half");
    const v128_t z = wasm_i16x8_splat(0);
    const v128_t c = wasm_i16x8_splat(255);
    const v128_t r = wasm_i16x8_splat(256);
    for (int i = 0; i < half; i += 16) {
        v128_t lo0 = wasm_v128_load(src + i);
        v128_t hi0 = wasm_v128_load(src + i + half);
        v128_t lo1 = wasm_v128_load(src + i + 8);
        v128_t hi1 = wasm_v128_load(src + i + half + 8);
        lo0 = wasm_i16x8_min(wasm_i16x8_max(lo0, z), c);   // clamp [0,255]
        hi0 = wasm_i16x8_min(wasm_i16x8_max(hi0, z), c);
        lo1 = wasm_i16x8_min(wasm_i16x8_max(lo1, z), c);
        hi1 = wasm_i16x8_min(wasm_i16x8_max(hi1, z), c);
        v128_t p0 = wasm_i16x8_mul(lo0, hi0);               // exact: product < 2^16
        v128_t p1 = wasm_i16x8_mul(lo1, hi1);
        p0 = wasm_i16x8_add(p0, r);                         // exact: still < 2^16
        p1 = wasm_i16x8_add(p1, r);
        p0 = wasm_u16x8_shr(p0, 9);                         // logical >>9 -> [0,127]
        p1 = wasm_u16x8_shr(p1, 9);
        v128_t packed = wasm_u8x16_narrow_i16x8(p0, p1);    // [p0 lanes | p1 lanes] -> 16x u8
        wasm_v128_store(dst + i, packed);
    }
}
#else
// No SIMD target recognized: fall back to the scalar formula, element by
// element. Still correct and still used only when PAIRSIMD=1 is requested.
static inline void pairwise_u8_block(const int16_t* src, uint8_t* dst) {
    constexpr int half = H / 2;  // 256
    for (int i = 0; i < half; ++i)
        dst[i] = pairwise_u8(src[i], src[i + half]);
}
#endif

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
#elif defined(__wasm_simd128__)
#include <wasm_simd128.h>
// WASM dot_u8i8. Two sub-variants, selected at compile time by which Makefile.wasm
// target is building (simd128 vs relaxed -- see Makefile.wasm's -mrelaxed-simd flag,
// which is the only thing that defines __wasm_relaxed_simd__):
//
//   * __wasm_relaxed_simd__ (relaxed build): i32x4.relaxed_dot_i8x16_i7x16_add is the
//     direct WASM analogue of VPDPBUSD/vdotq_s32 -- a single widening
//     multiply-add-accumulate instruction. Its second operand is documented as
//     "i7x16": only the low 7 bits of each lane are specified, the top bit's
//     contribution is implementation-defined. That is EXACTLY the int8QA=127
//     constraint this file already leans on for AVX512/NEON (see this file's
//     block comment above dot_u8i8_scalar) -- a[] never sets bit 7, so every
//     implementation's choice for that bit is moot and the instruction is
//     deterministic on our data regardless of which WASM engine runs it. Put the
//     unconstrained weight column in the i8x16 slot and the u8-range activation
//     lane in the i7x16 slot.
//   * plain __wasm_simd128__ (baseline build, no relaxed-simd): no native i8 dot
//     instruction exists, so build the same widening dot from two steps that DO
//     exist in the MVP SIMD128 spec: wasm_i16x8_extmul_{low,high}_i8x16 widens
//     the elementwise product into i16 lanes (exact -- max magnitude 127*127 =
//     16129 fits i16 with room to spare), then wasm_i32x4_extadd_pairwise_i16x8
//     widens-and-sums adjacent pairs into i32 (also exact -- the widen happens
//     BEFORE the add, so there is no intermediate 16-bit accumulation to
//     overflow even though a pair sum can reach ~32258). Either sub-variant
//     reduces, term for term, to the same Sigma a[i]*w[i] proven above to equal
//     dot_u8i8_scalar's saturating formula on real (non-adversarial) data.
static inline int32_t dot_u8i8(const uint8_t* a, const int8_t* w, int n) {
    v128_t vacc = wasm_i32x4_splat(0);
    int i = 0;
#ifdef __wasm_relaxed_simd__
    for (; i + 16 <= n; i += 16) {
        v128_t vw = wasm_v128_load(w + i);
        v128_t va = wasm_v128_load(a + i);
        vacc = wasm_i32x4_relaxed_dot_i8x16_i7x16_add(vw, va, vacc);
    }
#else
    for (; i + 16 <= n; i += 16) {
        v128_t vw = wasm_v128_load(w + i);
        v128_t va = wasm_v128_load(a + i);
        v128_t plo = wasm_i16x8_extmul_low_i8x16(vw, va);
        v128_t phi = wasm_i16x8_extmul_high_i8x16(vw, va);
        v128_t slo = wasm_i32x4_extadd_pairwise_i16x8(plo);
        v128_t shi = wasm_i32x4_extadd_pairwise_i16x8(phi);
        vacc = wasm_i32x4_add(vacc, wasm_i32x4_add(slo, shi));
    }
#endif
    alignas(16) int32_t lanes[4];
    wasm_v128_store(lanes, vacc);
    int32_t acc = lanes[0] + lanes[1] + lanes[2] + lanes[3];
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

// ---- SATDIAG: SCReLU rail-saturation diagnostics (default OFF) ----------------
// The single-output net loses ALL resolution in decisive positions: past roughly a
// queen the tail's SCReLU pre-activations all land on the rails (<=0 or >=1), so the
// activation vector becomes a fixed 0/1 pattern and the output collapses to a
// per-(bucket, sign) CONSTANT — five structurally unrelated down-a-queen positions
// all evaluate to exactly -887. These counters measure where that collapse happens
// (L1: D2=16 lanes, L2: D3=32 lanes) so a blend gate can be driven by the actual
// information loss instead of by |eval|, which is itself constant once collapsed.
// Purely observational; gated so the hot path is untouched unless SATDIAG=1.
thread_local SatDiag g_satdiag{};
bool satdiag_enabled() {
    static const bool on = [] { const char* e = getenv("SATDIAG"); return e && e[0] == '1'; }();
    return on;
}
// Maintain the rail tally only if something consumes it — SATFIX (the eval fix) or
// SATDIAG (reporting). Off by default, so the shipped build is byte-identical AND
// pays nothing.
bool sattrack_enabled() {
    static const bool on = [] {
        const char* f = getenv("SATFIX");
        return satdiag_enabled() || (f && f[0] != '0' && f[0] != '\0');
    }();
    return on;
}

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
    // PAIRSIMD=1 replaces this scalar loop with pairwise_u8_block (see its
    // definition above for the full bit-exactness proof); both paths compute
    // the IDENTICAL u8 lane for lane, so the branch below changes only speed.
    constexpr int half = H / 2;  // 256
    uint8_t aq[H];
    if (pairsimd_enabled()) {
        pairwise_u8_block(stm, aq);
        pairwise_u8_block(opp, aq + half);
    } else {
        for (int i = 0; i < half; ++i) {
            aq[i]        = pairwise_u8(stm[i], stm[i + half]);
            aq[half + i] = pairwise_u8(opp[i], opp[i + half]);
        }
    }

    // (2) L1 int8: u8·i8 saturating dot -> descale (constant L1Inv=1/8128) -> +bias
    //     -> SCReLU. L1W8 row for (bucket bk, output o) is L1W8[(bk*D2+o)*H : +H].
    const int8_t* L1W = g_net.L1W8.data() + static_cast<std::size_t>(bk) * D2 * H;
    const float*  L1B = g_net.L1B.data()  + static_cast<std::size_t>(bk) * D2;
    float l1[D2];
    float leakEps = sat_leak_eps();   // 0 by default -> screlu_leak == screlu
    for (int o = 0; o < D2; ++o) {
        int32_t d = dot_u8i8(aq, L1W + static_cast<std::size_t>(o) * H, H);
        l1[o] = screlu_leak(static_cast<float>(d) * L1Inv + L1B[o], leakEps);
    }

    // SATSOFT: the leak CANNOT be applied globally — 14 of 16 lanes sit on a rail even
    // in the starting position (that sparsity is how SCReLU works), so unclamping
    // everywhere rewrites the eval in every position and fails the golden gate 0/38.
    // Gate it on total collapse instead: only when ALL D2 lanes are railed is the
    // output a constant, and only then is the soft extrapolation strictly more
    // informative than what it replaces. Every other position stays byte-identical.
    //
    // The raw soft output is monotone but wildly out of scale — up one bishop reads
    // +7549 where the clamped constant reads +1086 and the truth is about +330. Feeding
    // 7000-13000 cp into the search would disturb every eval margin, aspiration window
    // and time-management rule, and would show nonsense on the eval bar. So the soft
    // pass supplies only a DIRECTION: the constant stays the anchor and a scaled
    // fraction of the soft deviation is added back (SATSOFTK, per-mille). That keeps
    // the eval on the scale everything else was tuned against while restoring ordering.
    bool softNode = false;
    if (satsoft_eps() > 0.0f) {
        int railed = 0;
        for (int o = 0; o < D2; ++o) railed += (l1[o] == 0.0f) | (l1[o] == 1.0f);
        // SATSOFTLIVE (default 0) widens the gate past total collapse: a node with one
        // surviving lane is nearly as blind as one with none (another ~5% of positions).
        softNode = (railed >= D2 - satsoft_live());
    }

    // SATFIX/SATDIAG rail tally. Read off l1[] rather than instrumenting the loop
    // above, so the hot path stays untouched: screlu maps (0,1) strictly into (0,1),
    // so l1[o] == 0.0f exactly when the pre-activation was <= 0 and l1[o] == 1.0f
    // exactly when it was >= 1 — the rail state is recoverable losslessly, and the
    // whole tally is skipped when neither feature is on.
    const bool track = sattrack_enabled();
    const bool diag  = satdiag_enabled();
    if (track) {
        int l1lo = 0, l1hi = 0;
        for (int o = 0; o < D2; ++o) { l1lo += (l1[o] == 0.0f); l1hi += (l1[o] == 1.0f); }
        g_satdiag.l1lo   = l1lo;
        g_satdiag.l1hi   = l1hi;
        g_satdiag.l1live = D2 - l1lo - l1hi;
        if (diag) {
            g_satdiag.l2lo = g_satdiag.l2hi = 0;
            // Recompute the pre-activations to report how far past the rails they sit.
            // Diagnostic path only — never on the hot path.
            float lo = 0.0f, hi = 0.0f;
            for (int o = 0; o < D2; ++o) {
                int32_t d = dot_u8i8(aq, L1W + static_cast<std::size_t>(o) * H, H);
                const float x = static_cast<float>(d) * L1Inv + L1B[o];
                if (x < 0.0f && -x > lo)      lo = -x;
                if (x > 1.0f && x - 1.0f > hi) hi = x - 1.0f;
            }
            g_satdiag.ovLo = lo;
            g_satdiag.ovHi = hi;
        }
    }

    // (3) L2 float GEMV (input-major, D2 -> D3) -> +bias -> SCReLU.
    float l2[D3];
    gemv_f32(l2, D3, l1, D2, g_net.L2W.data(), NB * D3, bk * D3);
    const float* L2B = g_net.L2B.data() + static_cast<std::size_t>(bk) * D3;
    // In the SATSOFT path leakEps has been raised, so L2 softens too — L1 variation is
    // pointless if L2 clamps it straight back off (measured: leaking L2 alone changes
    // nothing at all, since its inputs were the constant).
    const float leak2Eps = sat_leak2_eps() > 0.0f ? sat_leak2_eps() : leakEps;
    for (int o = 0; o < D3; ++o) {
        const float x = l2[o] + L2B[o];
        l2[o] = screlu_leak(x, leak2Eps);
        if (diag) { if (x <= 0.0f) ++g_satdiag.l2lo; else if (x >= 1.0f) ++g_satdiag.l2hi; }
    }

    // (4) output GEMV (D3 -> 1) -> +bias -> scale -> round-half-away-from-zero.
    float y1[1];
    gemv_f32(y1, 1, l2, D3, g_net.OW.data(), NB, bk);
    float y = g_net.OB[bk] + y1[0];

    // SATSOFT second pass: `y` above is the collapsed CONSTANT. Re-run L1/L2/output with
    // the leaky activation to get a value that still varies with the position, then keep
    // only a scaled fraction of the difference so the result stays on the net's own
    // scale. Costs a second tail only at the ~6.6% of nodes that are fully collapsed.
    if (softNode) {
        const float eps = satsoft_eps();
        float s1[D2];
        for (int o = 0; o < D2; ++o) {
            int32_t d = dot_u8i8(aq, L1W + static_cast<std::size_t>(o) * H, H);
            s1[o] = screlu_leak(static_cast<float>(d) * L1Inv + L1B[o], eps);
        }
        float s2[D3];
        gemv_f32(s2, D3, s1, D2, g_net.L2W.data(), NB * D3, bk * D3);
        for (int o = 0; o < D3; ++o) s2[o] = screlu_leak(s2[o] + L2B[o], eps);
        float sy1[1];
        gemv_f32(sy1, 1, s2, D3, g_net.OW.data(), NB, bk);
        const float softY = g_net.OB[bk] + sy1[0];
        y += (softY - y) * satsoft_k();
    }

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
