// NNUE net loader for the PROD multilayer full-threats net
// (gomachine data/nnue/kb-mirror.bin, ~180 MB: H=512 D2=16 D3=32 NB=8).
//
// BIT-EXACT PORT of the gomachine (Go) reference — every arithmetic step mirrors
// it exactly:
//   * bullet float32 export layout + save order:
//       gomachine/internal/nnue/enriched.go:729-787 (ImportBulletEnrichedNet)
//       order: l0w l0b l1w l1b l2w l2b l3w l3b  (little-endian f32, tail NO transpose)
//   * FT int16 quantization:  enriched.go:301-309 (quantizeFT)
//       W0i = round_half_away(l0w * 255),  B0i = round_half_away(l0b * 255)   (int16, no clamp)
//   * int8 L1 quantization:   enriched_int8.go (QuantizeForInt8)
//       L1W8[(bk*D2+o)*H + i] = clamp(round_half_away(l1w[i*(NB*D2)+bk*D2+o] * 64), -127, 127)
//   * L1 descale: RESOLVED as a SINGLE CONSTANT 1/(127*64)=1/8128, NOT per-row —
//       enriched_int8.go:55  `n.L1Inv[bk*d2+o] = 1 / (int8QA * sw)`  with
//       sw = float32(enrichedL1QB) = 64 (:39) and int8QA = 127; the RHS carries no
//       per-row/per-weight term, so every entry is identically 1/8128. Already exposed
//       as NNUE::L1Inv in nnue_arch.h — no per-row vector, no Net/header change.
//   * tail copied straight (input-major, no transpose): l2w->L2W l2b->L2B l3w->OW l3b->OB.
//   * threat FT stays int16 here (int8FT / W0t8 is LEAN-only — ignored).
//
// The Go multiplies happen in float32 (untyped const 255 / float32(64) promote to
// float32) then widen to float64 for math.Round (round half away from zero). We
// reproduce that precisely: a float32 product, widened to double, then std::round
// (which — like Go's math.Round — rounds halfway cases away from zero). Do NOT build
// this TU with -ffast-math: it would perturb the float32 rounding and break bit-exactness.

#include "nnue.h"      // NNUE::load / loaded / evaluate declarations (evaluate lives elsewhere)
#include "nnue_net.h"  // NNUE::Net, g_net, load_net  (+ nnue_arch.h dims/quant constants)

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <vector>

namespace NNUE {

// Definition of the process-wide net (declared extern in nnue_net.h).
Net g_net;

namespace {

// Little-endian float32 decode, mirroring Go's binary.LittleEndian.Uint32 +
// math.Float32frombits. Explicit byte assembly keeps it correct on any host endianness.
inline float le_f32(const unsigned char* p) {
    const std::uint32_t u = static_cast<std::uint32_t>(p[0]) |
                            (static_cast<std::uint32_t>(p[1]) << 8) |
                            (static_cast<std::uint32_t>(p[2]) << 16) |
                            (static_cast<std::uint32_t>(p[3]) << 24);
    float f;
    std::memcpy(&f, &u, sizeof(f));
    return f;
}

// Quantize one FT weight to int16 exactly like quantizeFT: float32 product w*255,
// widened to double, rounded half-away-from-zero, cast to int16 (no clamp — matches Go).
inline std::int16_t quant_ft(float w) {
    const float prod = w * static_cast<float>(ftQA);          // float32 multiply (ftQA = 255)
    return static_cast<std::int16_t>(std::round(static_cast<double>(prod)));
}

// Quantize one L1 weight to int8 exactly like QuantizeForInt8: float32 product w*64,
// widened to double, rounded half-away-from-zero, clamped to [-127,127], cast to int8.
inline std::int8_t quant_l1(float w) {
    const float prod = w * static_cast<float>(L1QB);          // float32 multiply (L1QB = 64)
    double q = std::round(static_cast<double>(prod));
    if (q > 127.0) q = 127.0;
    else if (q < -127.0) q = -127.0;
    return static_cast<std::int8_t>(q);
}

} // namespace

// Reads the bullet float32 export at `path`, quantizes into g_net, sets g_net.ok.
// Returns false on any read/size mismatch (leaving g_net.ok == false).
bool load_net(const char* path) {
    g_net = Net{}; // reset: fresh, ok == false until fully populated

    // Section sizes (float32 counts), identical to ImportBulletEnrichedNet.
    const long h  = H;   // 512
    const long d2 = D2;  // 16
    const long d3 = D3;  // 32
    const long nb = NB;  // 8
    const long in = static_cast<long>(InputTotal); // 92144 = PsqSize + ThreatBlock

    const long nL0w = in * h;              // 47,177,728  FT weights (feature-major)
    const long nL0b = h;                   // 512         FT bias
    const long nL1w = h * (nb * d2);       // 65,536      L1 weights (input-major)
    const long nL1b = nb * d2;             // 128         L1 bias
    const long nL2w = d2 * (nb * d3);      // 4,096       L2 weights (input-major)
    const long nL2b = nb * d3;             // 256         L2 bias
    const long nL3w = d3 * nb;             // 256         output weights (input-major)
    const long nL3b = nb;                  // 8           output bias
    const long want = nL0w + nL0b + nL1w + nL1b + nL2w + nL2b + nL3w + nL3b;

    // Read the whole file (mirrors Go os.ReadFile). A small zero trailer past `want`
    // is tolerated (read-past), so require >= want*4, not == .
    std::FILE* fp = std::fopen(path, "rb");
    if (!fp) return false;
    std::fseek(fp, 0, SEEK_END);
    const long fsize = std::ftell(fp);
    std::fseek(fp, 0, SEEK_SET);
    if (fsize < want * 4) { std::fclose(fp); return false; }

    std::vector<unsigned char> raw(static_cast<std::size_t>(fsize));
    const std::size_t got = std::fread(raw.data(), 1, static_cast<std::size_t>(fsize), fp);
    std::fclose(fp);
    if (static_cast<long>(got) < want * 4) return false;

    // Float-indexed cursor over `raw`, mirroring Go's off/take slicing.
    long off = 0;
    const unsigned char* base = raw.data();
    auto fptr = [&](long i) -> const unsigned char* {
        return base + static_cast<std::size_t>(off + i) * 4;
    };

    // --- l0w -> W0i (int16 FT weights, feature-major W0i[f*H + i]) ---
    g_net.W0i.resize(static_cast<std::size_t>(nL0w));
    for (long i = 0; i < nL0w; ++i)
        g_net.W0i[static_cast<std::size_t>(i)] = quant_ft(le_f32(fptr(i)));
    off += nL0w;

    // --- l0b -> B0i (int16 FT bias) ---
    g_net.B0i.resize(static_cast<std::size_t>(nL0b));
    for (long i = 0; i < nL0b; ++i)
        g_net.B0i[static_cast<std::size_t>(i)] = quant_ft(le_f32(fptr(i)));
    off += nL0b;

    // --- l1w -> L1W8 (int8, per-output-row [(bk*D2+o)*H + i]) ---
    // l1w is INPUT-major [H x (NB*D2)]: l1w[i*(NB*D2) + bk*D2 + o]. Gather output o's
    // scattered column into the contiguous per-output int8 row the dot wants.
    g_net.L1W8.resize(static_cast<std::size_t>(nb * d2 * h));
    {
        const long nbd2 = nb * d2; // 128
        for (long bk = 0; bk < nb; ++bk) {
            for (long o = 0; o < d2; ++o) {
                std::int8_t* dst = &g_net.L1W8[static_cast<std::size_t>((bk * d2 + o) * h)];
                for (long i = 0; i < h; ++i)
                    dst[i] = quant_l1(le_f32(fptr(i * nbd2 + bk * d2 + o)));
            }
        }
    }
    off += nL1w;

    // --- l1b -> L1B (float, straight copy — bucket-major [bk*D2 + o]) ---
    g_net.L1B.resize(static_cast<std::size_t>(nL1b));
    for (long i = 0; i < nL1b; ++i)
        g_net.L1B[static_cast<std::size_t>(i)] = le_f32(fptr(i));
    off += nL1b;

    // --- l2w -> L2W (float, straight copy — input-major [i*(NB*D3) + bk*D3 + o]) ---
    g_net.L2W.resize(static_cast<std::size_t>(nL2w));
    for (long i = 0; i < nL2w; ++i)
        g_net.L2W[static_cast<std::size_t>(i)] = le_f32(fptr(i));
    off += nL2w;

    // --- l2b -> L2B (float, straight copy) ---
    g_net.L2B.resize(static_cast<std::size_t>(nL2b));
    for (long i = 0; i < nL2b; ++i)
        g_net.L2B[static_cast<std::size_t>(i)] = le_f32(fptr(i));
    off += nL2b;

    // --- l3w -> OW (float, straight copy — input-major [i*NB + bk]) ---
    g_net.OW.resize(static_cast<std::size_t>(nL3w));
    for (long i = 0; i < nL3w; ++i)
        g_net.OW[static_cast<std::size_t>(i)] = le_f32(fptr(i));
    off += nL3w;

    // --- l3b -> OB (float, straight copy) ---
    g_net.OB.resize(static_cast<std::size_t>(nL3b));
    for (long i = 0; i < nL3b; ++i)
        g_net.OB[static_cast<std::size_t>(i)] = le_f32(fptr(i));
    off += nL3b;

    g_net.ok = true;
    return true;
}

// --- Public NNUE::load / loaded (nnue.h). evaluate() is a separate file. ---

namespace { bool s_loaded = false; }

bool load(const char* path) {
    s_loaded = load_net(path);
    return s_loaded;
}

bool loaded() { return s_loaded; }

} // namespace NNUE
