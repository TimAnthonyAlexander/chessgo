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
#include "nnue_web_format.h" // pre-quantized ("web format") file format shared with tools/netweb_writer

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>
#if defined(__linux__)
#include <sys/mman.h>
#endif

namespace NNUE {

// Definition of the process-wide net (declared extern in nnue_net.h).
Net g_net;

namespace {

// Back a large read-only region with transparent huge pages — DEFAULT OFF, opt-in via
// env NETHP=1 (byte-identical eval either way: only the page size backing the same bytes
// changes). W0i (~90 MB feature transformer) is read at scattered 512-wide columns on
// every feature change during search; 4 KB pages thrash the dTLB. MADV_HUGEPAGE marks the
// region; MADV_COLLAPSE (Linux 6.1+) collapses the already-faulted small pages to 2 MB
// pages synchronously. Kept dormant (movetime SPRT could not resolve its ~4-5% NPS above
// the noise floor — real but sub-threshold; would likely help the single-shared-net prod
// serve, unprovable via self-play). Best-effort: all failures ignored. See
// docs/tasks/done/tt-hugepages.md.
inline bool net_hugepages_enabled() {
    const char* e = std::getenv("NETHP");
    return e && e[0] == '1';
}

inline void advise_hugepages(const void* p, std::size_t bytes) {
#if defined(__linux__)
    const std::uintptr_t HP = 2u * 1024u * 1024u;
    if (!p || bytes < HP) return;
    std::uintptr_t a = reinterpret_cast<std::uintptr_t>(p);
    std::uintptr_t start = (a + HP - 1) & ~(HP - 1);   // round up to 2 MB
    std::uintptr_t end   = (a + bytes) & ~(HP - 1);    // round down to 2 MB
    if (end <= start) return;
    void* baseptr = reinterpret_cast<void*>(start);
    std::size_t len = static_cast<std::size_t>(end - start);
    madvise(baseptr, len, MADV_HUGEPAGE);
#ifdef MADV_COLLAPSE
    madvise(baseptr, len, MADV_COLLAPSE);   // synchronous collapse of the populated region
#endif
#else
    (void)p; (void)bytes;
#endif
}

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

// Reads the bullet float32 export at `path`, quantizes into g_net, sets g_net.ok.
// Returns false on any read/size mismatch (leaving g_net.ok == false). Renamed from
// the historical `load_net` (now the public dispatcher below) when the pre-quantized
// web-format fast path was added; body is UNCHANGED — see the file-header comment for
// why this arithmetic must never be perturbed.
bool load_net_float32(const char* path) {
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

    // Opt-in (NETHP=1): back the ~90 MB feature transformer with huge pages. Default off
    // = no madvise = original 4 KB-page behavior (byte-identical eval).
    if (net_hugepages_enabled())
        advise_hugepages(g_net.W0i.data(), g_net.W0i.size() * sizeof(std::int16_t));

    g_net.ok = true;
    return true;
}

// Reads a pre-quantized "web format" file (nnue_web_format.h) straight into g_net —
// no quantization arithmetic, just validated byte copies. Returns false (leaving
// g_net.ok == false) on any size/magic/version/arch/checksum mismatch: a bad file
// must fail loudly rather than silently produce a wrong eval.
bool load_net_prequant(const char* path) {
    using namespace WebFormat;
    g_net = Net{};

    std::FILE* fp = std::fopen(path, "rb");
    if (!fp) return false;
    std::fseek(fp, 0, SEEK_END);
    const long fsize = std::ftell(fp);
    std::fseek(fp, 0, SEEK_SET);
    if (fsize < static_cast<long>(kHeaderSize)) { std::fclose(fp); return false; }

    std::vector<unsigned char> raw(static_cast<std::size_t>(fsize));
    const std::size_t got = std::fread(raw.data(), 1, static_cast<std::size_t>(fsize), fp);
    std::fclose(fp);
    if (got != static_cast<std::size_t>(fsize)) return false;

    const unsigned char* p = raw.data();

    // --- header: magic + version + arch/quant constants + payload size + checksum ---
    if (std::memcmp(p, kMagic, sizeof(kMagic)) != 0) return false;
    const std::uint32_t formatVersion = wf_rd_u32(p + 8);
    const std::uint32_t inputTotal    = wf_rd_u32(p + 12);
    const std::uint32_t hdrH          = wf_rd_u32(p + 16);
    const std::uint32_t hdrD2         = wf_rd_u32(p + 20);
    const std::uint32_t hdrD3         = wf_rd_u32(p + 24);
    const std::uint32_t hdrNB         = wf_rd_u32(p + 28);
    const std::uint32_t hdrFtQA       = wf_rd_u32(p + 32);
    const std::uint32_t hdrInt8QA     = wf_rd_u32(p + 36);
    const std::uint32_t hdrL1QB       = wf_rd_u32(p + 40);
    const std::uint32_t hdrFtShift    = wf_rd_u32(p + 44);
    const std::uint64_t payloadSize   = wf_rd_u64(p + 48);
    const std::uint64_t headerCsum    = wf_rd_u64(p + 56);

    if (formatVersion != kFormatVersion) return false;

    // Validate every arch/quant constant against the compiled-in net this binary
    // expects (nnue_arch.h). A mismatch means the file targets a different net
    // architecture — refuse rather than reinterpret its bytes under the wrong shape.
    if (inputTotal != static_cast<std::uint32_t>(InputTotal) ||
        hdrH       != static_cast<std::uint32_t>(H)          ||
        hdrD2      != static_cast<std::uint32_t>(D2)         ||
        hdrD3      != static_cast<std::uint32_t>(D3)         ||
        hdrNB      != static_cast<std::uint32_t>(NB)         ||
        hdrFtQA    != static_cast<std::uint32_t>(ftQA)       ||
        hdrInt8QA  != static_cast<std::uint32_t>(int8QA)     ||
        hdrL1QB    != static_cast<std::uint32_t>(L1QB)       ||
        hdrFtShift != static_cast<std::uint32_t>(ftShift))
        return false;

    // Truncated-download check: cheap, before touching the checksum.
    if (static_cast<std::uint64_t>(fsize) < static_cast<std::uint64_t>(kHeaderSize) + payloadSize)
        return false;

    const unsigned char* payload = p + kHeaderSize;
    const SectionCounts counts = section_counts();
    if (payloadSize != payload_bytes(counts)) return false; // arch matched but size didn't — corrupt/foreign file

    // Corruption check: FNV-1a over the payload must match the header's checksum.
    // Catches a truncated OR bit-flipped download that happens to pass the size checks.
    if (fnv1a64(payload, static_cast<std::size_t>(payloadSize)) != headerCsum) return false;

    // --- payload: explicit little-endian decode straight into Net's vectors ---
    const unsigned char* cur = payload;

    g_net.W0i.resize(counts.nW0i);
    for (std::size_t i = 0; i < counts.nW0i; ++i)
        g_net.W0i[i] = wf_rd_i16(cur + i * 2);
    cur += counts.nW0i * 2;

    g_net.B0i.resize(counts.nB0i);
    for (std::size_t i = 0; i < counts.nB0i; ++i)
        g_net.B0i[i] = wf_rd_i16(cur + i * 2);
    cur += counts.nB0i * 2;

    // int8: single bytes, no endianness — a direct copy is unambiguous.
    g_net.L1W8.resize(counts.nL1W8);
    std::memcpy(g_net.L1W8.data(), cur, counts.nL1W8);
    cur += counts.nL1W8;

    g_net.L1B.resize(counts.nL1B);
    for (std::size_t i = 0; i < counts.nL1B; ++i)
        g_net.L1B[i] = wf_rd_f32(cur + i * 4);
    cur += counts.nL1B * 4;

    g_net.L2W.resize(counts.nL2W);
    for (std::size_t i = 0; i < counts.nL2W; ++i)
        g_net.L2W[i] = wf_rd_f32(cur + i * 4);
    cur += counts.nL2W * 4;

    g_net.L2B.resize(counts.nL2B);
    for (std::size_t i = 0; i < counts.nL2B; ++i)
        g_net.L2B[i] = wf_rd_f32(cur + i * 4);
    cur += counts.nL2B * 4;

    g_net.OW.resize(counts.nOW);
    for (std::size_t i = 0; i < counts.nOW; ++i)
        g_net.OW[i] = wf_rd_f32(cur + i * 4);
    cur += counts.nOW * 4;

    g_net.OB.resize(counts.nOB);
    for (std::size_t i = 0; i < counts.nOB; ++i)
        g_net.OB[i] = wf_rd_f32(cur + i * 4);
    cur += counts.nOB * 4;

    // Same opt-in huge-pages behavior as the float32 path (byte-identical eval either way).
    if (net_hugepages_enabled())
        advise_hugepages(g_net.W0i.data(), g_net.W0i.size() * sizeof(std::int16_t));

    g_net.ok = true;
    return true;
}

} // namespace

// Public loader: sniffs the first bytes for the pre-quantized "web format" magic
// (nnue_web_format.h) and dispatches accordingly. The float32 path's arithmetic
// (load_net_float32, above) is completely untouched by this — it is called exactly
// as it always was when the magic doesn't match.
bool load_net(const char* path) {
    std::FILE* fp = std::fopen(path, "rb");
    if (!fp) return false;
    unsigned char magic[sizeof(WebFormat::kMagic)];
    const std::size_t got = std::fread(magic, 1, sizeof(magic), fp);
    std::fclose(fp);
    const bool isPrequant = got == sizeof(magic) &&
                             std::memcmp(magic, WebFormat::kMagic, sizeof(magic)) == 0;
    return isPrequant ? load_net_prequant(path) : load_net_float32(path);
}

// --- Public NNUE::load / loaded (nnue.h). evaluate() is a separate file. ---

namespace { bool s_loaded = false; }

bool load(const char* path) {
    s_loaded = load_net(path);
    return s_loaded;
}

bool loaded() { return s_loaded; }

} // namespace NNUE
