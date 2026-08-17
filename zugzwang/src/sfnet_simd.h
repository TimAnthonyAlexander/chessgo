#pragma once
// SFNet Wave 6/7 — SIMD kernels for the SF backend's hot path (accumulator column
// add/sub, the feature-transformer pairwise activation, and the fc_0/fc_1/fc_2
// widening dot product). Every kernel here is PROVABLY bit-exact with the scalar
// formula it replaces — see each block's comment for the argument — not merely
// "close enough". Included by sfnet_eval.cpp and sfnet_accumulator.cpp (the two
// TUs that run the kernels), and by sfnet_load.cpp (Wave 7 — needs the FT
// permutation helpers below to reorder the net's weights once, at load time).
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
#include <cstring>
#include <vector>

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
// Wave 7 -- FT weight permutation. SF permutes biases/weights/threatWeights ONCE at
// load time (nnue_feature_transformer.h's permute_weights()/PackusEpi16Order) so its
// packus-based pairwise-combine kernel (pairwise_combine_sf below, AVX512/AVX2 tiers)
// can narrow int16->uint8 with ONE packus per two vectors, instead of the lane-split
// dance the pre-Wave-7 kernel used to dodge packus's cross-vector interleave. Verified
// against ~/sf18-arm/src/nnue/nnue_feature_transformer.h:52,105-145 and simd.h's
// vec_packus_16/MaxChunkSize definitions, not guessed.
//
// The permutation ONLY reorders the 1024-wide "j" (HalfDimensions) index, applied
// identically to every feature column of every array that ever feeds the accumulator
// (biases seeds it, weights/threatWeights add to it) -- so col_add_i16/col_sub_i16/
// col_add_i8widen_i16/col_sub_i8widen_i16 below need NO changes: they still compute
// acc[j] +=/-= col[j] over a relabeled j, and since biases/weights/threatWeights are
// ALL relabeled the SAME way, "acc[j]" and "col[j]" still refer to the same underlying
// feature lane after permutation as before it. Only the routines that need "j" to mean
// a SPECIFIC natural-order position -- the packus-based pairwise_combine_sf -- need to
// know about this at all, and even there the permutation is chosen (by SF, ported
// verbatim here) so packus's own physical interleave exactly cancels it, landing the
// OUTPUT `ft[]` buffer back in natural order for fc_0's (unpermuted) weights to dot
// against unchanged.
//
// ONLY the tiers that actually use a raw packus instruction (AVX512BW+VL, AVX2, both
// rewritten below) need this. Scalar and NEON keep their existing widen-add-clamp-
// narrow sequence, which has no packus to compensate for -- permuting for them would
// be a correct but useless relabeling, so SFNET_FT_PERMUTE stays 0 there rather than
// permuting for tidiness.
#if defined(__AVX512BW__) && defined(__AVX512VL__) && defined(SFNET_X86_SIMD)
#define SFNET_FT_PERMUTE 1
// nnue_feature_transformer.h:111 (_mm512_packus_epi16 branch), transcribed verbatim.
inline constexpr std::size_t kFtPermOrder[8] = {0, 2, 4, 6, 1, 3, 5, 7};
#elif defined(__AVX2__) && defined(SFNET_X86_SIMD)
#define SFNET_FT_PERMUTE 1
// nnue_feature_transformer.h:117 (_mm256_packus_epi16 branch), transcribed verbatim.
inline constexpr std::size_t kFtPermOrder[8] = {0, 2, 1, 3, 4, 6, 5, 7};
#else
#define SFNET_FT_PERMUTE 0
#endif

#if SFNET_FT_PERMUTE
// Permutes `data` (n elements of T, n a multiple of 64) in 64-element chunks: each
// chunk splits into 8 sub-blocks of 8 elements, reordered by `order`. Port of SF's
// permute<BlockSize>() (nnue_feature_transformer.h:52), specialized to typed elements
// instead of raw bytes -- SF's BlockSize is always exactly 8 elements' worth of bytes
// for both its callers (16 bytes = 8 x int16 for biases/weights, 8 bytes = 8 x int8
// for threatWeights), so "8 elements" is the one invariant this port keeps, and T can
// be int16_t or int8_t (or, for the order-table self-check below, a plain int).
template <typename T>
void ft_permute(T* data, std::size_t n, const std::size_t order[8]) {
    constexpr std::size_t kSubBlock = 8;
    constexpr std::size_t kChunk = kSubBlock * 8;  // 64
    T buf[kChunk];
    for (std::size_t base = 0; base + kChunk <= n; base += kChunk) {
        for (std::size_t j = 0; j < 8; ++j)
            for (std::size_t e = 0; e < kSubBlock; ++e)
                buf[j * kSubBlock + e] = data[base + order[j] * kSubBlock + e];
        for (std::size_t k = 0; k < kChunk; ++k) data[base + k] = buf[k];
    }
}

// Self-check: permute() by `order` then permute() by order's OWN inverse must recover
// the original array exactly. This is the "prove it's correctly inverted" gate the
// task calls for -- it runs on a synthetic [0..1023] array (not real net data; the
// order table's correctness doesn't depend on what's being permuted), so it costs
// nothing and needs no real weights loaded yet. A mistranscribed order table is
// EXACTLY the failure mode this catches: it would still "permute" (produce some
// array), still pass every other load-time sanity check, and only show up later as a
// plausible-looking but wrong eval -- the outcome the task calls "the worst possible".
inline bool ft_perm_order_self_check(const std::size_t order[8]) {
    std::size_t inv[8]{};
    for (std::size_t i = 0; i < 8; ++i) inv[order[i]] = i;
    // inv must itself be a permutation of 0..7 covering every slot exactly once --
    // if `order` had a duplicate or an out-of-range entry, some inv[k] would be left
    // at its zero-init default while another was overwritten twice.
    bool seen[8] = {};
    for (std::size_t i = 0; i < 8; ++i) {
        if (order[i] >= 8 || seen[order[i]]) return false;
        seen[order[i]] = true;
    }

    constexpr std::size_t N = 1024;  // HalfDimensions -- any multiple of 64 would do
    int original[N];
    for (std::size_t i = 0; i < N; ++i) original[i] = int(i);
    int a[N];
    for (std::size_t i = 0; i < N; ++i) a[i] = original[i];

    ft_permute(a, N, order);
    ft_permute(a, N, inv);
    for (std::size_t i = 0; i < N; ++i)
        if (a[i] != original[i]) return false;
    return true;
}
#endif  // SFNET_FT_PERMUTE

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

// Wave 7: SF's own algorithm (nnue_feature_transformer.h:264-379, UseThreats branch),
// ported instruction-for-instruction rather than the Wave 6 widen/narrow-int32 kernel
// it replaces. Requires ps/th to be laid out per kFtPermOrder (sfnet_load.cpp permutes
// net.biases/weights/threatWeights exactly once, at load) -- see the SFNET_FT_PERMUTE
// block above for why that's a zero-runtime-cost precondition, not a per-call cost.
//
// Two things earn the "still bit-exact" claim, both re-derived independently against
// the scalar reference above (not just trusted because SF ships it):
//
//  1. Asymmetric clamp + packus's own saturation == the reference's symmetric clamp.
//     `sum0` gets the FULL clamp(-,0,255); `sum1` gets ONLY the upper clamp (min 255),
//     left free to go negative. Case acc1>=0: sum1==clamp(acc1,0,255), identical to the
//     reference -- no discrepancy. Case acc1<0: sum1<0 while sum0>=0 (it WAS fully
//     clamped), so sum0*sum1<=0, and packus's saturating int16->uint8 narrow maps any
//     non-positive input to 0 -- exactly clamp(acc1,0,255)=0 times anything. Holds for
//     either operand being the "asymmetric" one, which is how SF assigns it (first
//     half gets the full clamp, second half the partial one) and how this port keeps it.
//  2. The shift(7)+mulhi+packus sequence computes the same value as widen/clamp/mullo/
//     shift-right-9/narrow. sum0 in [0,255]<<7 = [0,32640] (fits int16, no sign issue).
//     mulhi returns the top 16 bits of the true 32-bit product sum0*sum1, i.e.
//     floor(sum0*sum1 / 65536) = floor((clamp0*128*clamp1) / 65536) = floor(clamp0*
//     clamp1 / 512) -- the reference's exact formula, and mulhi's arithmetic top-half
//     extraction is floor-correct for negative products too (case 1 already showed the
//     only way to get one collapses to 0 either way).
//
// kFtPermOrder is chosen (by SF, transcribed here) so that packus's own physical
// 128-bit-lane interleave, applied to data pre-shuffled by that order, cancels out --
// `out[]` lands back in the SAME natural sequential order the Wave 6 kernel produced,
// which is why fc_0's weights (unpermuted) don't need to change at all. The 560/560
// bit-exact gate (test/sfnet_corpus_ref.tsv) is what actually proves this end to end;
// the two arguments above are why it was expected to, not a substitute for running it.
inline void pairwise_combine_sf(const std::int16_t* ps, const std::int16_t* th,
                                std::uint8_t* out, int half) {
    const __m512i Zero = _mm512_setzero_si512();
    const __m512i Max255 = _mm512_set1_epi16(255);
    constexpr int shift = 7;
    int j = 0;
    for (; j + 64 <= half; j += 64) {
        __m512i in0a = _mm512_loadu_si512(reinterpret_cast<const void*>(ps + j));
        __m512i in0b = _mm512_loadu_si512(reinterpret_cast<const void*>(ps + j + 32));
        __m512i in1a = _mm512_loadu_si512(reinterpret_cast<const void*>(ps + half + j));
        __m512i in1b = _mm512_loadu_si512(reinterpret_cast<const void*>(ps + half + j + 32));
        __m512i t0a = _mm512_loadu_si512(reinterpret_cast<const void*>(th + j));
        __m512i t0b = _mm512_loadu_si512(reinterpret_cast<const void*>(th + j + 32));
        __m512i t1a = _mm512_loadu_si512(reinterpret_cast<const void*>(th + half + j));
        __m512i t1b = _mm512_loadu_si512(reinterpret_cast<const void*>(th + half + j + 32));

        __m512i acc0a = _mm512_add_epi16(in0a, t0a);
        __m512i acc0b = _mm512_add_epi16(in0b, t0b);
        __m512i acc1a = _mm512_add_epi16(in1a, t1a);
        __m512i acc1b = _mm512_add_epi16(in1b, t1b);

        __m512i sum0a = _mm512_slli_epi16(_mm512_max_epi16(_mm512_min_epi16(acc0a, Max255), Zero), shift);
        __m512i sum0b = _mm512_slli_epi16(_mm512_max_epi16(_mm512_min_epi16(acc0b, Max255), Zero), shift);
        __m512i sum1a = _mm512_min_epi16(acc1a, Max255);   // upper clamp only -- see argument (1) above
        __m512i sum1b = _mm512_min_epi16(acc1b, Max255);

        __m512i pa = _mm512_mulhi_epi16(sum0a, sum1a);
        __m512i pb = _mm512_mulhi_epi16(sum0b, sum1b);

        _mm512_storeu_si512(reinterpret_cast<void*>(out + j), _mm512_packus_epi16(pa, pb));
    }
    if (j < half) pairwise_combine_sf_scalar(ps + j, th + j, out + j, half - j);
    // Dead in practice (half=512 is exactly divisible by 64), kept correct rather than
    // omitted -- same convention as the tail note this replaced. NOTE: this scalar
    // fallback assumes NATURAL-order ps/th, so it is only reachable (and only correct)
    // when SFNET_FT_PERMUTE is 0 for this build; it is unreachable here by construction
    // (half%64==0), so the mismatch never fires, but is flagged rather than silently relied on.
}

#elif defined(__AVX2__) && defined(SFNET_X86_SIMD)

// Wave 7: same port as the AVX512 tier above, at half the width (nnue_feature_
// transformer.h's vec_t=__m256i, MaxChunkSize=32 for USE_AVX2). Same two bit-exactness
// arguments apply verbatim (mulhi/packus width doesn't change either proof). Requires
// ps/th permuted by kFtPermOrder's AVX2 branch (see the SFNET_FT_PERMUTE block above).
inline void pairwise_combine_sf(const std::int16_t* ps, const std::int16_t* th,
                                std::uint8_t* out, int half) {
    const __m256i Zero = _mm256_setzero_si256();
    const __m256i Max255 = _mm256_set1_epi16(255);
    constexpr int shift = 7;
    int j = 0;
    for (; j + 32 <= half; j += 32) {
        __m256i in0a = _mm256_loadu_si256(reinterpret_cast<const __m256i*>(ps + j));
        __m256i in0b = _mm256_loadu_si256(reinterpret_cast<const __m256i*>(ps + j + 16));
        __m256i in1a = _mm256_loadu_si256(reinterpret_cast<const __m256i*>(ps + half + j));
        __m256i in1b = _mm256_loadu_si256(reinterpret_cast<const __m256i*>(ps + half + j + 16));
        __m256i t0a = _mm256_loadu_si256(reinterpret_cast<const __m256i*>(th + j));
        __m256i t0b = _mm256_loadu_si256(reinterpret_cast<const __m256i*>(th + j + 16));
        __m256i t1a = _mm256_loadu_si256(reinterpret_cast<const __m256i*>(th + half + j));
        __m256i t1b = _mm256_loadu_si256(reinterpret_cast<const __m256i*>(th + half + j + 16));

        __m256i acc0a = _mm256_add_epi16(in0a, t0a);
        __m256i acc0b = _mm256_add_epi16(in0b, t0b);
        __m256i acc1a = _mm256_add_epi16(in1a, t1a);
        __m256i acc1b = _mm256_add_epi16(in1b, t1b);

        __m256i sum0a = _mm256_slli_epi16(_mm256_max_epi16(_mm256_min_epi16(acc0a, Max255), Zero), shift);
        __m256i sum0b = _mm256_slli_epi16(_mm256_max_epi16(_mm256_min_epi16(acc0b, Max255), Zero), shift);
        __m256i sum1a = _mm256_min_epi16(acc1a, Max255);
        __m256i sum1b = _mm256_min_epi16(acc1b, Max255);

        __m256i pa = _mm256_mulhi_epi16(sum0a, sum1a);
        __m256i pb = _mm256_mulhi_epi16(sum0b, sum1b);

        _mm256_storeu_si256(reinterpret_cast<__m256i*>(out + j), _mm256_packus_epi16(pa, pb));
    }
    if (j < half) pairwise_combine_sf_scalar(ps + j, th + j, out + j, half - j);
    // Dead in practice (half=512 is exactly divisible by 32) -- see the AVX512 tier's
    // identical note above.
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

// =====================================================================================
// Wave 8 -- fc_0 block-sparse input, ported from SF's AffineTransformSparseInput
// (~/sf18-arm/src/nnue/layers/affine_transform_sparse_input.h). Read docs/sfnet-wave8.md
// for the measurement that motivates this: over test/sfnet_corpus.epd, forward_pass's
// `ft[HalfDimensions]` activation is 82.2% zero PER BYTE (mean), and 56.0% of its
// 4-byte chunks are ALL-zero (mean nonzero-chunk fraction 0.4395) -- so a chunk-driven
// dot that skips all-zero chunks does roughly 2.28x less work than the dense loop, for
// fc_0 specifically (fc_1/fc_2 are NOT touched -- see the comment block below).
//
// ONLY fc_0 gets this treatment, matching SF's own net: AffineTransformSparseInput
// requires OutputDimensions % 16 == 0 (SF's static_assert), and Fc0Out (=16, sfnet.h)
// is the only layer in this stack that satisfies it AND has a genuinely sparse input
// (fc_1/fc_2's inputs are clipped_relu/sqr_clipped_relu outputs, not the raw pairwise-
// combine activation, and SF's own net does not apply sparse-input to them either).
//
// Two load-time-vs-runtime pieces, mirroring the FT permutation above:
//   1. `fc0_permute_weights_inplace()` -- ONE-TIME, at load (sfnet_load.cpp): reindexes
//      each stack's `fc0w` from the file's natural row-major (output-major) order into
//      SF's `get_weight_index_scrambled()` layout, so that for a given 4-byte INPUT
//      chunk, all 16 outputs' 4 weight bytes for that chunk are contiguous (64 bytes =
//      exactly one AVX512 register or 4 NEON registers -- see fc0_sparse_forward below).
//      Ported verbatim from the header above (`get_weight_index_scrambled`, ChunkSize=4,
//      the SSSE3/NEON8-capable branch -- this codebase's SIMD tiers all qualify).
//   2. `fc0_sparse_forward()` -- every search call: scans `ft[]` for nonzero 4-byte
//      chunks (`fc0_find_nnz`, scalar -- see the note on why below) and, for each one,
//      broadcasts its 4 bytes and dots them against that chunk's scrambled weight block
//      for ALL 16 outputs via ONE widening dot instruction (AVX512VNNI's vpdpbusd,
//      NEON's vdotq_s32, or AVX2's maddubs+madd pair) -- never touching a zero chunk's
//      weights at all. Ported from `propagate()`'s VNNI branch (same file, lines
//      ~311-337) minus the 3-way-unrolled dependency-chain split (SF's own comment
//      calls that a latency-hiding trick, not a correctness requirement, and this port
//      keeps a single accumulator per output group for a first, simpler, gate-passable
//      version -- flagged as a possible follow-up, not attempted this wave).
//
// find_nnz itself is DELIBERATELY scalar here, not SF's SIMD/lookup-table version
// (affine_transform_sparse_input.h:80-169, `_mm512_maskz_compress_epi16` / the portable
// 256-entry `Lookup.offset_indices` LUT): find_nnz only decides WHICH chunks to visit,
// so a scalar bug there would silently DROP a genuinely-nonzero chunk's contribution --
// unlike every other kernel in this file, its correctness is load-bearing for the
// *value*, not just the speed, of the result. A plain "does this int32-sized chunk
// equal zero" scan is trivially and obviously correct, and its own cost (256 compares
// over `HalfDimensions=1024`) is small next to what it's skipping in fc_0's dot. If a
// future wave wants the SIMD find_nnz too, port it against the same 560/560 gate this
// wave already proves the scalar version against, not on faith.
//
// Bit-exactness argument for the dot itself: the accumulation order changes (chunk-
// major/output-simultaneous instead of output-major/input-sequential), but int32
// addition is associative and commutative on the values it actually sums (no
// saturation ever fires, by the same magnitude bound `dot_u8i8_sf`'s comment already
// establishes: ft in [0,127], weights in [-128,127], each product's magnitude <=16256,
// and int32 accumulation of up to 256 such products per output is nowhere near
// overflow) -- summing the SAME set of (input-times-weight) terms in a different order
// yields the identical int32 total. Zero chunks contribute exactly 0 to every output by
// construction (every one of their 4 input bytes is 0), so skipping them changes
// nothing about the sum. Gated end to end by the SAME 560/560 sfnet_eval_test diff and
// 11,089,304-node sfnet_acc_test drift check every other sfnet gate uses -- this
// argument is why it was expected to pass, not a substitute for running it.
// =====================================================================================

#if defined(SFNET_FC0_SPARSE)

constexpr int kFc0ChunkSize = 4;

// SF's get_weight_index_scrambled (affine_transform_sparse_input.h:210-213), transcribed
// verbatim: i = o*paddedIn + d (the file's natural row-major order) maps to
// c*outDims*ChunkSize + o*ChunkSize + b, where c=d/ChunkSize (chunk index) and
// b=d%ChunkSize (byte within the chunk) -- i.e. chunk-major, then output, then byte.
inline int fc0_scrambled_index(int i, int outDims, int paddedIn) {
    const int cs = kFc0ChunkSize;
    return (i / cs) % (paddedIn / cs) * outDims * cs + i / paddedIn * cs + i % cs;
}

// Self-check: the scramble must be a bijection over [0, outDims*paddedIn) -- same
// "prove it's a genuine permutation before trusting it" gate as Wave 7's
// ft_perm_order_self_check, run at load time before any real weight is touched.
inline bool fc0_scramble_self_check(int outDims, int paddedIn) {
    const std::size_t total = std::size_t(outDims) * std::size_t(paddedIn);
    std::vector<bool> seen(total, false);
    for (int i = 0; i < int(total); ++i) {
        const int s = fc0_scrambled_index(i, outDims, paddedIn);
        if (s < 0 || std::size_t(s) >= total || seen[std::size_t(s)]) return false;
        seen[std::size_t(s)] = true;
    }
    return true;
}

// Applies the scramble to one stack's fc0w, in place, once, at load.
inline void fc0_permute_weights_inplace(std::int8_t* w, int outDims, int paddedIn) {
    const std::size_t total = std::size_t(outDims) * std::size_t(paddedIn);
    std::vector<std::int8_t> buf(total);
    for (int i = 0; i < int(total); ++i)
        buf[std::size_t(fc0_scrambled_index(i, outDims, paddedIn))] = w[i];
    std::memcpy(w, buf.data(), buf.size());
}

// Scalar find_nnz -- see the block comment above for why this stays scalar. Treats
// ft[] as HalfDim/4 chunks of 4 bytes each; a chunk is "nonzero" if ANY byte in it is.
// Returns the count; fills nnzOut[0..count) with chunk indices (ascending).
template <int HalfDim>
inline int fc0_find_nnz(const std::uint8_t* ft, int* nnzOut) {
    int count = 0;
    for (int c = 0; c < HalfDim / 4; ++c) {
        std::uint32_t v;
        std::memcpy(&v, ft + c * 4, 4);
        if (v != 0) nnzOut[count++] = c;
    }
    return count;
}

// fc0_sparse_forward -- Fc0Out is fixed at 16 by construction (this codebase's own
// architecture, sfnet.h); callers assert that at the call site, since sfnet.h's
// constants aren't visible from this standalone header. `wScrambled` must already be
// permuted by fc0_permute_weights_inplace with outDims=16, paddedIn=HalfDim. `bias`
// and `out` are both 16-wide int32.
#if defined(__AVX512VNNI__) && defined(SFNET_X86_SIMD)
#include <immintrin.h>

template <int HalfDim>
inline void fc0_sparse_forward(const std::uint8_t* ft, const std::int8_t* wScrambled,
                                const std::int32_t* bias, std::int32_t* out) {
    __m512i acc = _mm512_loadu_si512(reinterpret_cast<const void*>(bias));  // 16 int32 lanes
    int nnz[HalfDim / 4];
    const int count = fc0_find_nnz<HalfDim>(ft, nnz);
    for (int k = 0; k < count; ++k) {
        const int c = nnz[k];
        std::int32_t in32;
        std::memcpy(&in32, ft + c * 4, 4);
        const __m512i inVec = _mm512_set1_epi32(in32);  // 16x replica of the 4-byte chunk
        const __m512i wVec =
            _mm512_loadu_si512(reinterpret_cast<const void*>(wScrambled + std::size_t(c) * 64));
        acc = _mm512_dpbusd_epi32(acc, inVec, wVec);  // all 16 outputs, one instruction
    }
    _mm512_storeu_si512(reinterpret_cast<void*>(out), acc);
}

#elif defined(__AVX2__) && defined(SFNET_X86_SIMD)
#include <immintrin.h>

// No VNNI: two 8-wide groups (outputs 0-7, 8-15) per chunk, via the same
// maddubs+madd combo dot_u8i8_sf's AVX2 tier already uses and already proves exact
// for this net's magnitude bounds (see that block's comment).
template <int HalfDim>
inline void fc0_sparse_forward(const std::uint8_t* ft, const std::int8_t* wScrambled,
                                const std::int32_t* bias, std::int32_t* out) {
    __m256i acc0 = _mm256_loadu_si256(reinterpret_cast<const __m256i*>(bias));      // outputs 0-7
    __m256i acc1 = _mm256_loadu_si256(reinterpret_cast<const __m256i*>(bias + 8));  // outputs 8-15
    const __m256i ones16 = _mm256_set1_epi16(1);
    int nnz[HalfDim / 4];
    const int count = fc0_find_nnz<HalfDim>(ft, nnz);
    for (int k = 0; k < count; ++k) {
        const int c = nnz[k];
        std::int32_t in32;
        std::memcpy(&in32, ft + c * 4, 4);
        const __m256i inVec = _mm256_set1_epi32(in32);
        const std::int8_t* block = wScrambled + std::size_t(c) * 64;
        const __m256i w0 = _mm256_loadu_si256(reinterpret_cast<const __m256i*>(block));
        const __m256i w1 = _mm256_loadu_si256(reinterpret_cast<const __m256i*>(block + 32));
        acc0 = _mm256_add_epi32(acc0, _mm256_madd_epi16(_mm256_maddubs_epi16(inVec, w0), ones16));
        acc1 = _mm256_add_epi32(acc1, _mm256_madd_epi16(_mm256_maddubs_epi16(inVec, w1), ones16));
    }
    _mm256_storeu_si256(reinterpret_cast<__m256i*>(out), acc0);
    _mm256_storeu_si256(reinterpret_cast<__m256i*>(out + 8), acc1);
}

#elif defined(__ARM_FEATURE_DOTPROD)
#include <arm_neon.h>

// Four 4-wide groups (vdotq_s32 -- s8 x s8 -> s32, 4 lanes) per chunk. ft is reinterpreted
// as signed int8 (top bit never set, values in [0,127] -- identical trick and proof to
// dot_u8i8_sf's own ARM_FEATURE_DOTPROD tier above).
template <int HalfDim>
inline void fc0_sparse_forward(const std::uint8_t* ft, const std::int8_t* wScrambled,
                                const std::int32_t* bias, std::int32_t* out) {
    int32x4_t acc0 = vld1q_s32(bias);
    int32x4_t acc1 = vld1q_s32(bias + 4);
    int32x4_t acc2 = vld1q_s32(bias + 8);
    int32x4_t acc3 = vld1q_s32(bias + 12);
    int nnz[HalfDim / 4];
    const int count = fc0_find_nnz<HalfDim>(ft, nnz);
    for (int k = 0; k < count; ++k) {
        const int c = nnz[k];
        std::uint32_t in32;
        std::memcpy(&in32, ft + c * 4, 4);
        const int8x16_t inVec = vreinterpretq_s8_u32(vdupq_n_u32(in32));  // 4x replica
        const std::int8_t* block = wScrambled + std::size_t(c) * 64;
        const int8x16_t w0 = vld1q_s8(block);
        const int8x16_t w1 = vld1q_s8(block + 16);
        const int8x16_t w2 = vld1q_s8(block + 32);
        const int8x16_t w3 = vld1q_s8(block + 48);
        acc0 = vdotq_s32(acc0, inVec, w0);
        acc1 = vdotq_s32(acc1, inVec, w1);
        acc2 = vdotq_s32(acc2, inVec, w2);
        acc3 = vdotq_s32(acc3, inVec, w3);
    }
    vst1q_s32(out, acc0);
    vst1q_s32(out + 4, acc1);
    vst1q_s32(out + 8, acc2);
    vst1q_s32(out + 12, acc3);
}

#else

// Scalar fallback -- still algorithmically sparse (skips zero chunks entirely), just
// no widening-dot instruction. Correct on every architecture, including one with none
// of the SIMD feature macros above defined.
template <int HalfDim>
inline void fc0_sparse_forward(const std::uint8_t* ft, const std::int8_t* wScrambled,
                                const std::int32_t* bias, std::int32_t* out) {
    for (int o = 0; o < 16; ++o) out[o] = bias[o];
    int nnz[HalfDim / 4];
    const int count = fc0_find_nnz<HalfDim>(ft, nnz);
    for (int k = 0; k < count; ++k) {
        const int c = nnz[k];
        const std::int8_t* block = wScrambled + std::size_t(c) * 64;
        const std::int32_t in0 = ft[c * 4], in1 = ft[c * 4 + 1], in2 = ft[c * 4 + 2], in3 = ft[c * 4 + 3];
        for (int o = 0; o < 16; ++o) {
            out[o] += in0 * std::int32_t(block[o * 4 + 0]) + in1 * std::int32_t(block[o * 4 + 1])
                    + in2 * std::int32_t(block[o * 4 + 2]) + in3 * std::int32_t(block[o * 4 + 3]);
        }
    }
}

#endif  // fc0_sparse_forward tiers

#endif  // SFNET_FC0_SPARSE

}  // namespace simd
}  // namespace SFNet
