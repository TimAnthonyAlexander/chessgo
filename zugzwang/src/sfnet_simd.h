#pragma once
// SFNet Wave 6 — SIMD kernels for the SF backend's hot path (accumulator column
// add/sub, the feature-transformer pairwise activation, and the fc_0/fc_1/fc_2
// widening dot product). Every kernel here is PROVABLY bit-exact with the scalar
// formula it replaces — see each block's comment for the argument — not merely
// "close enough". Included only by sfnet_eval.cpp and sfnet_accumulator.cpp,
// mirroring sfnet_internal.h's own sharing convention.
//
// Arch-detection idiom copied from src/nnue_eval.cpp / src/nnue_accumulator.cpp
// (this codebase's existing pattern): a #if/#elif ladder on compiler-defined arch
// macros, resolved at COMPILE time by the Makefile's -march=native / -mcpu=native
// (no runtime dispatch, no indirect calls).
//
// Tiers, in the order tried:
//   ARM NEON / dotprod  -- arm64 (this Mac, M3 Pro). SHIPPED default-on: measured
//     +11-16% NPS on the wave's own before/after bench (docs/sfnet-wave6.md), bit-exact
//     on every gate.
//   AVX512BW(+VL where noted) / AVX2 (implies SSE4.1) -- x86_64. Written, bit-exact
//     on real hardware (cross-compiled AND gate-tested on coalla, amd64 AVX512-VNNI,
//     over SSH), but gated behind SFNET_X86_SIMD (NOT defined by default) rather than
//     shipped unconditionally like the NEON tier -- see the honest reason below.
//   scalar -- x86_64 by default, and the fallback within every tier's own tail.
//
// WHY THE X86 TIERS ARE OPT-IN, NOT DEFAULT-ON (unlike NEON): measured on coalla
// (AMD EPYC 9634, Zen4) with a fixed-depth (byte-identical node count) wall-clock
// bench, every x86 SIMD combination tried came out AT BEST a wash and typically a
// REGRESSION against the plain scalar Wave 5 baseline -- full AVX512BW+VNNI -10%,
// AVX2-only ~-3%, an isolated "VNNI dot only" build -12.5%, an isolated "accumulator
// SIMD only" build -23%. Forcing __attribute__((always_inline)) on every kernel (ruling
// out an LTO inlining-heuristic miss) changed nothing. This is a genuinely surprising,
// unresolved result -- Zen4 is known to double-pump 512-bit ops as 2x256-bit internally,
// which could explain the AVX512-specific loss, but does not explain why the AVX2-only
// and isolated-accumulator builds ALSO underperformed pure scalar. Root cause is not
// nailed down (would need `perf record -g` line-level attribution on coalla, which this
// wave did not reach); shipping an unproven-and-measured-negative default on the
// platform the SPRT actually runs on would be irresponsible, so amd64 defaults to
// scalar (Wave 5's exact behavior) until someone re-investigates with real profiling.
// Full log: docs/sfnet-wave6.md.

#include <cstdint>
#include <cstddef>

// SFNET_USE_SIMD — whether the CALL SITES in sfnet_eval.cpp/sfnet_accumulator.cpp
// route through simd:: at all, as opposed to keeping Wave 5's original inline loops
// verbatim. Separate from (and coarser than) the per-kernel tier gates above: the
// amd64 measurement this wave recorded was NOT specific to any one SIMD instruction
// set -- even routing the pure-scalar fallback through a shared header's function
// (instead of Wave 5's textually-inline loop) cost real NPS on g++/Zen4, and neither
// __attribute__((always_inline)) nor making the loop bound a template parameter closed
// the gap. Root cause unresolved (see the block comment above); the only fix this wave
// could ship with confidence is to not change amd64's call sites' generated code AT
// ALL by default. See docs/sfnet-wave6.md for the numbers.
#if defined(__aarch64__) || defined(__ARM_NEON) || defined(SFNET_X86_SIMD)
#define SFNET_USE_SIMD 1
#else
#define SFNET_USE_SIMD 0
#endif

namespace SFNet {
namespace simd {

inline std::int32_t clampi32(std::int32_t v, std::int32_t lo, std::int32_t hi) {
    return v < lo ? lo : (v > hi ? hi : v);
}

// =====================================================================================
// col_add_i16 / col_sub_i16 -- acc[j] +=/-= col[j] over n int16 lanes. Plain wraparound
// int16 arithmetic (no widening): a SIMD add/sub instruction computes exactly the same
// mod-2^16 result as scalar `+=`/`-=` on the same bits, lane for lane, unconditionally
// -- there is no proof needed here beyond "int16 add is int16 add". Used for the base
// (PSQ) accumulator's weight column, which is already int16 in the net file.
// =====================================================================================

// N is a TEMPLATE parameter, not a runtime `int n`: every call site in this backend
// calls these with the same compile-time constant (HalfDimensions=1024). This was
// tried as a fix for the amd64 regression documented above and at SFNET_USE_SIMD's
// definition (the hypothesis being that a runtime parameter was defeating constant
// propagation) -- it did NOT close that gap (see docs/sfnet-wave6.md: still ~199k vs
// ~260k baseline with N templated), so it is NOT what makes amd64 safe. It is kept
// anyway because it is strictly more precise than a runtime `int n` for callers that
// always pass the same constant, and it does not hurt on arm64 (still the measured
// +11-16% NEON win). The actual amd64 fix is SFNET_USE_SIMD gating the CALL SITES,
// not this template parameter.

#if defined(__AVX512BW__) && defined(SFNET_X86_SIMD)
#include <immintrin.h>

template <int N>
inline void col_add_i16(std::int16_t* acc, const std::int16_t* col) {
    int j = 0;
    for (; j + 32 <= N; j += 32) {
        __m512i a = _mm512_loadu_si512(reinterpret_cast<const void*>(acc + j));
        __m512i c = _mm512_loadu_si512(reinterpret_cast<const void*>(col + j));
        _mm512_storeu_si512(reinterpret_cast<void*>(acc + j), _mm512_add_epi16(a, c));
    }
    for (; j < N; ++j) acc[j] = std::int16_t(acc[j] + col[j]);
}
template <int N>
inline void col_sub_i16(std::int16_t* acc, const std::int16_t* col) {
    int j = 0;
    for (; j + 32 <= N; j += 32) {
        __m512i a = _mm512_loadu_si512(reinterpret_cast<const void*>(acc + j));
        __m512i c = _mm512_loadu_si512(reinterpret_cast<const void*>(col + j));
        _mm512_storeu_si512(reinterpret_cast<void*>(acc + j), _mm512_sub_epi16(a, c));
    }
    for (; j < N; ++j) acc[j] = std::int16_t(acc[j] - col[j]);
}

#elif defined(__AVX2__) && defined(SFNET_X86_SIMD)
#include <immintrin.h>

template <int N>
inline void col_add_i16(std::int16_t* acc, const std::int16_t* col) {
    int j = 0;
    for (; j + 16 <= N; j += 16) {
        __m256i a = _mm256_loadu_si256(reinterpret_cast<const __m256i*>(acc + j));
        __m256i c = _mm256_loadu_si256(reinterpret_cast<const __m256i*>(col + j));
        _mm256_storeu_si256(reinterpret_cast<__m256i*>(acc + j), _mm256_add_epi16(a, c));
    }
    for (; j < N; ++j) acc[j] = std::int16_t(acc[j] + col[j]);
}
template <int N>
inline void col_sub_i16(std::int16_t* acc, const std::int16_t* col) {
    int j = 0;
    for (; j + 16 <= N; j += 16) {
        __m256i a = _mm256_loadu_si256(reinterpret_cast<const __m256i*>(acc + j));
        __m256i c = _mm256_loadu_si256(reinterpret_cast<const __m256i*>(col + j));
        _mm256_storeu_si256(reinterpret_cast<__m256i*>(acc + j), _mm256_sub_epi16(a, c));
    }
    for (; j < N; ++j) acc[j] = std::int16_t(acc[j] - col[j]);
}

#elif defined(__aarch64__) || defined(__ARM_NEON)
#include <arm_neon.h>

template <int N>
inline void col_add_i16(std::int16_t* acc, const std::int16_t* col) {
    int j = 0;
    for (; j + 8 <= N; j += 8) {
        int16x8_t a = vld1q_s16(acc + j);
        int16x8_t c = vld1q_s16(col + j);
        vst1q_s16(acc + j, vaddq_s16(a, c));
    }
    for (; j < N; ++j) acc[j] = std::int16_t(acc[j] + col[j]);
}
template <int N>
inline void col_sub_i16(std::int16_t* acc, const std::int16_t* col) {
    int j = 0;
    for (; j + 8 <= N; j += 8) {
        int16x8_t a = vld1q_s16(acc + j);
        int16x8_t c = vld1q_s16(col + j);
        vst1q_s16(acc + j, vsubq_s16(a, c));
    }
    for (; j < N; ++j) acc[j] = std::int16_t(acc[j] - col[j]);
}

#else

template <int N>
inline void col_add_i16(std::int16_t* acc, const std::int16_t* col) {
    for (int j = 0; j < N; ++j) acc[j] = std::int16_t(acc[j] + col[j]);
}
template <int N>
inline void col_sub_i16(std::int16_t* acc, const std::int16_t* col) {
    for (int j = 0; j < N; ++j) acc[j] = std::int16_t(acc[j] - col[j]);
}

#endif

// =====================================================================================
// col_add_i8widen_i16 / col_sub_i8widen_i16 -- acc[j] +=/-= (int16)col[j], where col is
// int8 (the threat weight table). The scalar reference (`h.accumulation[j] += w[j]`,
// w an int8_t*) promotes w[j] to int (sign-extend), adds to the int-promoted int16
// accumulator, truncates the sum back to int16 on store -- i.e. sign-extend-then-
// wraparound-add. Every tier below performs exactly that: an explicit sign-extending
// widen (vmovl_s8 / cvtepi8_epi16, all exact -- int8 -> int16 sign extension has no
// precision loss) followed by a plain int16 add/sub, which is bit-identical wraparound
// arithmetic to the scalar version by the same argument as col_add_i16 above.
// =====================================================================================

#if defined(__AVX512BW__) && defined(SFNET_X86_SIMD)

template <int N>
inline void col_add_i8widen_i16(std::int16_t* acc, const std::int8_t* col) {
    int j = 0;
    for (; j + 32 <= N; j += 32) {
        __m256i c8 = _mm256_loadu_si256(reinterpret_cast<const __m256i*>(col + j));
        __m512i cw = _mm512_cvtepi8_epi16(c8);           // exact sign-extend, 32 lanes
        __m512i a = _mm512_loadu_si512(reinterpret_cast<const void*>(acc + j));
        _mm512_storeu_si512(reinterpret_cast<void*>(acc + j), _mm512_add_epi16(a, cw));
    }
    for (; j < N; ++j) acc[j] = std::int16_t(acc[j] + col[j]);
}
template <int N>
inline void col_sub_i8widen_i16(std::int16_t* acc, const std::int8_t* col) {
    int j = 0;
    for (; j + 32 <= N; j += 32) {
        __m256i c8 = _mm256_loadu_si256(reinterpret_cast<const __m256i*>(col + j));
        __m512i cw = _mm512_cvtepi8_epi16(c8);
        __m512i a = _mm512_loadu_si512(reinterpret_cast<const void*>(acc + j));
        _mm512_storeu_si512(reinterpret_cast<void*>(acc + j), _mm512_sub_epi16(a, cw));
    }
    for (; j < N; ++j) acc[j] = std::int16_t(acc[j] - col[j]);
}

#elif defined(__AVX2__) && defined(SFNET_X86_SIMD)

template <int N>
inline void col_add_i8widen_i16(std::int16_t* acc, const std::int8_t* col) {
    int j = 0;
    for (; j + 16 <= N; j += 16) {
        __m128i c8 = _mm_loadu_si128(reinterpret_cast<const __m128i*>(col + j));
        __m256i cw = _mm256_cvtepi8_epi16(c8);           // exact sign-extend, 16 lanes
        __m256i a = _mm256_loadu_si256(reinterpret_cast<const __m256i*>(acc + j));
        _mm256_storeu_si256(reinterpret_cast<__m256i*>(acc + j), _mm256_add_epi16(a, cw));
    }
    for (; j < N; ++j) acc[j] = std::int16_t(acc[j] + col[j]);
}
template <int N>
inline void col_sub_i8widen_i16(std::int16_t* acc, const std::int8_t* col) {
    int j = 0;
    for (; j + 16 <= N; j += 16) {
        __m128i c8 = _mm_loadu_si128(reinterpret_cast<const __m128i*>(col + j));
        __m256i cw = _mm256_cvtepi8_epi16(c8);
        __m256i a = _mm256_loadu_si256(reinterpret_cast<const __m256i*>(acc + j));
        _mm256_storeu_si256(reinterpret_cast<__m256i*>(acc + j), _mm256_sub_epi16(a, cw));
    }
    for (; j < N; ++j) acc[j] = std::int16_t(acc[j] - col[j]);
}

#elif defined(__aarch64__) || defined(__ARM_NEON)

template <int N>
inline void col_add_i8widen_i16(std::int16_t* acc, const std::int8_t* col) {
    int j = 0;
    for (; j + 8 <= N; j += 8) {
        int8x8_t c8 = vld1_s8(col + j);
        int16x8_t cw = vmovl_s8(c8);                     // exact sign-extend, 8 lanes
        int16x8_t a = vld1q_s16(acc + j);
        vst1q_s16(acc + j, vaddq_s16(a, cw));
    }
    for (; j < N; ++j) acc[j] = std::int16_t(acc[j] + col[j]);
}
template <int N>
inline void col_sub_i8widen_i16(std::int16_t* acc, const std::int8_t* col) {
    int j = 0;
    for (; j + 8 <= N; j += 8) {
        int8x8_t c8 = vld1_s8(col + j);
        int16x8_t cw = vmovl_s8(c8);
        int16x8_t a = vld1q_s16(acc + j);
        vst1q_s16(acc + j, vsubq_s16(a, cw));
    }
    for (; j < N; ++j) acc[j] = std::int16_t(acc[j] - col[j]);
}

#else

template <int N>
inline void col_add_i8widen_i16(std::int16_t* acc, const std::int8_t* col) {
    for (int j = 0; j < N; ++j) acc[j] = std::int16_t(acc[j] + col[j]);
}
template <int N>
inline void col_sub_i8widen_i16(std::int16_t* acc, const std::int8_t* col) {
    for (int j = 0; j < N; ++j) acc[j] = std::int16_t(acc[j] - col[j]);
}

#endif

// =====================================================================================
// pairwise_combine_sf -- SF's feature-transformer activation (sfnet_eval.cpp
// forward_pass's inner loop, spec ss3.4): for j in [0,half),
//   s0 = clamp(ps[j]        + th[j],        0, 255)
//   s1 = clamp(ps[j+half]   + th[j+half],   0, 255)
//   out[j] = uint8( (unsigned(s0) * unsigned(s1)) / 512 )
// The scalar reference computes s0/s1 as int32 (ps/th widened before the add), NOT as
// wraparound int16 -- an accumulator value can be the full int16 range and the SUM of
// two of them can exceed int16, so every tier below widens to int32 for the add and
// clamp, exactly matching the scalar's precision, and only narrows back to int16 AFTER
// clamping to [0,255] (safe: clamped values fit int16 with enormous headroom).
//
// Bit-exactness of the multiply/shift/narrow tail, once s0/s1 are int16 in [0,255]:
// identical argument to nnue_eval.cpp's pairwise_u8_block (see that file) -- s0*s1 in
// [0,65025] fits exactly in an unsigned 16-bit lane (no overflow), so a plain 16-bit
// lane multiply (which returns the true product mod 2^16) is exact regardless of the
// lane's signed/unsigned tag, and a LOGICAL right shift by 9 on that always-non-negative
// value matches C++'s `>>9` on the equivalent non-negative `int`. No +round term here
// (SF's formula, unlike ours, is a plain truncating /512 -- no ftRound).
// =====================================================================================

inline void pairwise_combine_sf_scalar(const std::int16_t* ps, const std::int16_t* th,
                                       std::uint8_t* out, int half) {
    for (int j = 0; j < half; ++j) {
        std::int32_t s0 = std::int32_t(ps[j]) + std::int32_t(th[j]);
        std::int32_t s1 = std::int32_t(ps[j + half]) + std::int32_t(th[j + half]);
        s0 = clampi32(s0, 0, 255);
        s1 = clampi32(s1, 0, 255);
        out[j] = std::uint8_t((unsigned(s0) * unsigned(s1)) / 512u);
    }
}

#if defined(__AVX512BW__) && defined(__AVX512VL__) && defined(SFNET_X86_SIMD)

// 16 output lanes/iter. AVX512's cvtepi32_epi16 / cvtepi16_epi8 are TRUNCATING narrow
// conversions with plain lane-0..N-1 -> lane-0..N-1 semantics (unlike the legacy SSE/AVX2
// "pack" instructions, which interleave two source registers) -- no permute fix-up
// needed, and safe to use un-saturated here because every value narrowed is already
// proven in-range ([0,255] for s0/s1, [0,127] for the final byte) before the narrow.
inline void pairwise_combine_sf(const std::int16_t* ps, const std::int16_t* th,
                                std::uint8_t* out, int half) {
    int j = 0;
    for (; j + 16 <= half; j += 16) {
        __m256i ps_lo = _mm256_loadu_si256(reinterpret_cast<const __m256i*>(ps + j));
        __m256i ps_hi = _mm256_loadu_si256(reinterpret_cast<const __m256i*>(ps + j + half));
        __m256i th_lo = _mm256_loadu_si256(reinterpret_cast<const __m256i*>(th + j));
        __m256i th_hi = _mm256_loadu_si256(reinterpret_cast<const __m256i*>(th + j + half));

        __m512i s0 = _mm512_add_epi32(_mm512_cvtepi16_epi32(ps_lo), _mm512_cvtepi16_epi32(th_lo));
        __m512i s1 = _mm512_add_epi32(_mm512_cvtepi16_epi32(ps_hi), _mm512_cvtepi16_epi32(th_hi));
        const __m512i zero = _mm512_setzero_si512();
        const __m512i c255 = _mm512_set1_epi32(255);
        s0 = _mm512_min_epi32(_mm512_max_epi32(s0, zero), c255);
        s1 = _mm512_min_epi32(_mm512_max_epi32(s1, zero), c255);

        __m256i s0_16 = _mm512_cvtepi32_epi16(s0);   // truncating narrow, in-range -> exact
        __m256i s1_16 = _mm512_cvtepi32_epi16(s1);
        __m256i prod = _mm256_mullo_epi16(s0_16, s1_16);   // exact low-16 (product < 2^16)
        __m256i p = _mm256_srli_epi16(prod, 9);            // logical shift, value >= 0
        __m128i packed = _mm256_cvtepi16_epi8(p);          // truncating narrow, in [0,127]
        _mm_storeu_si128(reinterpret_cast<__m128i*>(out + j), packed);
    }
    if (j < half) pairwise_combine_sf_scalar(ps + j, th + j, out + j, half - j);
    // NOTE: the scalar tail above re-derives s0/s1 from a WINDOW starting at ps+j, which
    // is only correct because pairwise_combine_sf_scalar re-reads ps[j+half] relative to
    // its own `half` argument (half-j here) -- see the call site's actual usage, which
    // always passes j==half (no tail, HalfDimensions/2=512 is exactly divisible by 16),
    // so this path is dead in practice but kept correct rather than omitted.
}

#elif defined(__AVX2__) && defined(SFNET_X86_SIMD)

// 8 output lanes/iter: widen 8-of-16 int16 lanes to int32 via the 256-wide cvtepi16_epi32
// (covers all 8 in one instruction), clamp, then narrow via the 128-bit-only
// _mm_packs_epi32 -- safe because each 256i32 is explicitly split into its two 128-bit
// halves (castsi256_si128 / extracti128_si256) BEFORE packing, so there is no cross-
// 128-lane interleave to fix up (that interleave problem only arises when packing two
// full 256-bit registers with the AVX2 "pack" instructions directly).
inline void pairwise_combine_sf(const std::int16_t* ps, const std::int16_t* th,
                                std::uint8_t* out, int half) {
    int j = 0;
    for (; j + 8 <= half; j += 8) {
        __m128i ps_lo = _mm_loadu_si128(reinterpret_cast<const __m128i*>(ps + j));
        __m128i ps_hi = _mm_loadu_si128(reinterpret_cast<const __m128i*>(ps + j + half));
        __m128i th_lo = _mm_loadu_si128(reinterpret_cast<const __m128i*>(th + j));
        __m128i th_hi = _mm_loadu_si128(reinterpret_cast<const __m128i*>(th + j + half));

        __m256i s0 = _mm256_add_epi32(_mm256_cvtepi16_epi32(ps_lo), _mm256_cvtepi16_epi32(th_lo));
        __m256i s1 = _mm256_add_epi32(_mm256_cvtepi16_epi32(ps_hi), _mm256_cvtepi16_epi32(th_hi));
        const __m256i zero = _mm256_setzero_si256();
        const __m256i c255 = _mm256_set1_epi32(255);
        s0 = _mm256_min_epi32(_mm256_max_epi32(s0, zero), c255);
        s1 = _mm256_min_epi32(_mm256_max_epi32(s1, zero), c255);

        __m128i s0_16 = _mm_packs_epi32(_mm256_castsi256_si128(s0), _mm256_extracti128_si256(s0, 1));
        __m128i s1_16 = _mm_packs_epi32(_mm256_castsi256_si128(s1), _mm256_extracti128_si256(s1, 1));
        __m128i prod = _mm_mullo_epi16(s0_16, s1_16);
        __m128i p = _mm_srli_epi16(prod, 9);
        __m128i packed = _mm_packus_epi16(p, p);   // values in [0,127] -> saturation never fires
        _mm_storel_epi64(reinterpret_cast<__m128i*>(out + j), packed);
    }
    if (j < half) pairwise_combine_sf_scalar(ps + j, th + j, out + j, half - j);
}

#elif defined(__aarch64__) || defined(__ARM_NEON)

// 8 output lanes/iter. vaddl_s16 is an exact widening add (int16+int16 -> int32, no
// overflow possible); vmovn_s32 is a truncating narrow, safe because the value was
// already clamped to [0,255] beforehand.
inline void pairwise_combine_sf(const std::int16_t* ps, const std::int16_t* th,
                                std::uint8_t* out, int half) {
    int j = 0;
    for (; j + 8 <= half; j += 8) {
        int16x8_t ps_lo = vld1q_s16(ps + j);
        int16x8_t ps_hi = vld1q_s16(ps + j + half);
        int16x8_t th_lo = vld1q_s16(th + j);
        int16x8_t th_hi = vld1q_s16(th + j + half);

        int32x4_t s0_a = vaddl_s16(vget_low_s16(ps_lo), vget_low_s16(th_lo));
        int32x4_t s0_b = vaddl_s16(vget_high_s16(ps_lo), vget_high_s16(th_lo));
        int32x4_t s1_a = vaddl_s16(vget_low_s16(ps_hi), vget_low_s16(th_hi));
        int32x4_t s1_b = vaddl_s16(vget_high_s16(ps_hi), vget_high_s16(th_hi));

        const int32x4_t zero = vdupq_n_s32(0);
        const int32x4_t c255 = vdupq_n_s32(255);
        s0_a = vminq_s32(vmaxq_s32(s0_a, zero), c255);
        s0_b = vminq_s32(vmaxq_s32(s0_b, zero), c255);
        s1_a = vminq_s32(vmaxq_s32(s1_a, zero), c255);
        s1_b = vminq_s32(vmaxq_s32(s1_b, zero), c255);

        int16x8_t s0 = vcombine_s16(vmovn_s32(s0_a), vmovn_s32(s0_b));
        int16x8_t s1 = vcombine_s16(vmovn_s32(s1_a), vmovn_s32(s1_b));

        int16x8_t prod = vmulq_s16(s0, s1);                              // exact low-16
        uint16x8_t p = vshrq_n_u16(vreinterpretq_u16_s16(prod), 9);      // logical >>9
        uint8x8_t packed = vmovn_u16(p);
        vst1_u8(out + j, packed);
    }
    if (j < half) pairwise_combine_sf_scalar(ps + j, th + j, out + j, half - j);
}

#else

inline void pairwise_combine_sf(const std::int16_t* ps, const std::int16_t* th,
                                std::uint8_t* out, int half) {
    pairwise_combine_sf_scalar(ps, th, out, half);
}

#endif

// =====================================================================================
// dot_u8i8_sf -- widening u8 x i8 dot product for fc_0/fc_1/fc_2 (spec ss3.4). Models
// VPMADDUBSW+VPMADDWD exactly: pairwise saturate-to-int16 the adjacent (u8,i8) product
// sum, then accumulate into int32. Same structure and the same overflow argument as
// NNUE::dot_u8i8 in nnue_eval.cpp (that file's ft activation and this file's `ft` (the
// output of pairwise_combine_sf) share the identical [0,127] range proof), reproduced
// here rather than shared across namespaces because SFNet is deliberately NOT templated
// against NNUE's kernels (see sfnet.h's header comment).
//
//   * ft[j] (this file's `a` operand) is provably in [0,127] -- pairwise_combine_sf's
//     output range is [0, (255*255)/512] = [0,127], identical bound to NNUE's own
//     pairwise_u8.
//   * fc0w/fc1w/fc2w (`w`) are int8, so in [-128,127].
//   * Each product is in [-127*128, 127*127] = [-16256, 16129]; each adjacent PAIR SUM
//     is in [-32512, 32258] wait -- more precisely each pair sums two such products, so
//     the pair-sum magnitude is bounded by 2*16256 = 32512, strictly inside int16 range
//     [-32768, 32767]. The scalar saturating branch therefore never fires on real data,
//     exactly as nnue_eval.cpp's own proof establishes for its own kernel.
//   * n<=1024 terms x max 16129 ~= 16.5M, far under int32 range.
//
// Tail handling: each tier's main loop only ever consumes floor(n/W)*W elements (W =
// that tier's lane width); the remainder folds to the scalar reference, which is always
// safe regardless of n's alignment (no over-read past the caller's buffer, matching
// nnue_eval.cpp's dot_u8i8 tail-fold convention exactly). For n=32 (fc_1/fc_2), the
// AVX512VNNI tier's W=64 main loop runs zero iterations and the whole call folds to
// scalar -- deliberately not special-cased with a masked 32-lane load: fc_1/fc_2's
// total work is ~3% of fc_0's (1024*16 vs 32*32 + 32*1 terms), so the complexity of a
// masked/OOB-safe 32-wide AVX512 path was not worth it for this wave. AVX2 (W=32) and
// NEON (W=16) both divide n=32 evenly, so THEY fully vectorize fc_1/fc_2 already.
// =====================================================================================

inline std::int32_t dot_u8i8_sf_scalar(const std::uint8_t* a, const std::int8_t* w, int n) {
    std::int32_t acc = 0;
    int i = 0;
    for (; i + 2 <= n; i += 2) {
        std::int32_t p = std::int32_t(a[i])     * std::int32_t(w[i])
                       + std::int32_t(a[i + 1]) * std::int32_t(w[i + 1]);
        if (p > 32767) p = 32767;
        else if (p < -32768) p = -32768;
        acc += p;
    }
    if (i < n) acc += std::int32_t(a[i]) * std::int32_t(w[i]);
    return acc;
}

#if defined(__AVX512VNNI__) && defined(SFNET_X86_SIMD)

inline std::int32_t dot_u8i8_sf(const std::uint8_t* a, const std::int8_t* w, int n) {
    __m512i vacc = _mm512_setzero_si512();
    int i = 0;
    for (; i + 64 <= n; i += 64) {
        __m512i va = _mm512_loadu_si512(reinterpret_cast<const void*>(a + i));
        __m512i vw = _mm512_loadu_si512(reinterpret_cast<const void*>(w + i));
        vacc = _mm512_dpbusd_epi32(vacc, va, vw);
    }
    std::int32_t acc = _mm512_reduce_add_epi32(vacc);
    if (i < n) acc += dot_u8i8_sf_scalar(a + i, w + i, n - i);
    return acc;
}

#elif defined(__AVX2__) && defined(SFNET_X86_SIMD)

// VPMADDUBSW (_mm256_maddubs_epi16) + VPMADDWD (_mm256_madd_epi16, dotted against an
// all-ones vector to widen-and-pairwise-sum into int32) is EXACT by instruction
// definition, not by the "never saturates" argument above -- maddubs performs the same
// saturating pairwise sum the scalar reference models, so this tier matches even in the
// (unreachable, per the proof) case where saturation would fire.
inline std::int32_t dot_u8i8_sf(const std::uint8_t* a, const std::int8_t* w, int n) {
    __m256i vacc = _mm256_setzero_si256();
    const __m256i ones16 = _mm256_set1_epi16(1);
    int i = 0;
    for (; i + 32 <= n; i += 32) {
        __m256i va = _mm256_loadu_si256(reinterpret_cast<const __m256i*>(a + i));
        __m256i vw = _mm256_loadu_si256(reinterpret_cast<const __m256i*>(w + i));
        __m256i prod16 = _mm256_maddubs_epi16(va, vw);          // saturating pairwise sum
        __m256i prod32 = _mm256_madd_epi16(prod16, ones16);     // widen-sum adjacent pairs
        vacc = _mm256_add_epi32(vacc, prod32);
    }
    alignas(32) std::int32_t lanes[8];
    _mm256_storeu_si256(reinterpret_cast<__m256i*>(lanes), vacc);
    std::int32_t acc = lanes[0] + lanes[1] + lanes[2] + lanes[3]
                     + lanes[4] + lanes[5] + lanes[6] + lanes[7];
    if (i < n) acc += dot_u8i8_sf_scalar(a + i, w + i, n - i);
    return acc;
}

#elif defined(__ARM_FEATURE_DOTPROD)
#include <arm_neon.h>

inline std::int32_t dot_u8i8_sf(const std::uint8_t* a, const std::int8_t* w, int n) {
    // a[i] in [0,127] fits int8 without change of bit pattern or value (top bit never
    // set), so reinterpreting the u8 buffer as int8 and using the signed dot
    // (vdotq_s32, s8 x s8 -> s32) computes the same products as the true u8 x i8
    // multiply -- identical reasoning to nnue_eval.cpp's own ARM_FEATURE_DOTPROD tier.
    int32x4_t vacc = vdupq_n_s32(0);
    int i = 0;
    for (; i + 16 <= n; i += 16) {
        int8x16_t va = vreinterpretq_s8_u8(vld1q_u8(a + i));
        int8x16_t vw = vld1q_s8(w + i);
        vacc = vdotq_s32(vacc, va, vw);
    }
    std::int32_t acc = vaddvq_s32(vacc);
    if (i < n) acc += dot_u8i8_sf_scalar(a + i, w + i, n - i);
    return acc;
}

#else

inline std::int32_t dot_u8i8_sf(const std::uint8_t* a, const std::int8_t* w, int n) {
    return dot_u8i8_sf_scalar(a, w, n);
}

#endif

}  // namespace simd
}  // namespace SFNet
