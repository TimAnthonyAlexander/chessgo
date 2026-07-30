#pragma once
#include <cstdint>
#include <cstddef>
#include <cstdio>
#include <cstring>
#include <vector>
#include "nnue_arch.h"
#include "nnue_net.h" // NNUE::Net, for the shared write_net() helper below

// Pre-quantized NNUE net file format ("web format") — ships the ALREADY-QUANTIZED
// in-memory Net (W0i/B0i/L1W8/L1B/L2W/L2B/OW/OB) so WASM/iOS clients don't have to
// download the 180 MB float32 bullet export and requantize it client-side. The
// quantized payload is ~half the size (~90 MB) and needs zero arithmetic on load —
// just byte copies straight into the Net vectors.
//
// This header is the single source of truth for the format: both the writer tool
// (tools/netweb_writer.cpp) and the loader (src/nnue_net.cpp) include it. Layouts
// below MUST exactly match NNUE::Net (src/nnue_net.h) — this file ships the same
// bytes load_net() would have computed from the float32 export, so the two loaders
// must produce a byte-identical Net.
//
// === On-disk layout ===
//
//   [Header, 64 bytes, all multi-byte fields little-endian]
//     offset  0   char[8]   magic            "ZUGWNNQ1"
//     offset  8   uint32    format_version   1
//     offset 12   uint32    input_total      NNUE::InputTotal (92144)
//     offset 16   uint32    h                NNUE::H  (512)
//     offset 20   uint32    d2               NNUE::D2 (16)
//     offset 24   uint32    d3               NNUE::D3 (32)
//     offset 28   uint32    nb               NNUE::NB (8)
//     offset 32   uint32    ft_qa            NNUE::ftQA   (255)
//     offset 36   uint32    int8_qa          NNUE::int8QA (127)
//     offset 40   uint32    l1_qb            NNUE::L1QB   (64)
//     offset 44   uint32    ft_shift         NNUE::ftShift (9)
//     offset 48   uint64    payload_size     byte length of the payload that follows
//     offset 56   uint64    checksum         FNV-1a 64 over the payload bytes (below)
//   [Payload, payload_size bytes]
//     W0i   : InputTotal * H   int16  LE   (feature-major, W0i[f*H + i])
//     B0i   : H                 int16  LE
//     L1W8  : NB * D2 * H       int8         (per-output-row)
//     L1B   : NB * D2           float32 LE
//     L2W   : D2 * (NB*D3)      float32 LE
//     L2B   : NB * D3           float32 LE
//     OW    : D3 * NB           float32 LE
//     OB    : NB                float32 LE
//
// The loader:
//   1. Reads the 64-byte header, checks the magic — if it doesn't match, the file
//      is NOT this format (the loader falls back to the float32 path unchanged).
//   2. Checks format_version, then validates every arch/quant constant against the
//      compiled-in NNUE:: constants (nnue_arch.h). A mismatch means the file was
//      built for a different net architecture than this binary expects — refuse to
//      load rather than silently producing a wrong eval.
//   3. Checks the actual file size against the header's payload_size (catches a
//      truncated download cheaply, before touching the checksum).
//   4. Computes FNV-1a 64 over the payload bytes and compares to the header's
//      checksum. Mismatch -> refuse to load (a flipped byte anywhere in a 90 MB
//      download must fail loudly, not produce a garbage eval — same intent as
//      Stockfish's BAD_NNUE detection).
//   5. Only then does it byte-copy the payload straight into Net's vectors.
//
// Endianness: every multi-byte field is assembled/disassembled explicitly (see
// wf_rd_u16/u32/u64/f32 / wf_wr_* below), never via memcpy of a raw struct or a
// native integer type — the format is defined to be little-endian regardless of
// host byte order, mirroring the existing le_f32 helper in nnue_net.cpp.

namespace NNUE::WebFormat {

constexpr char     kMagic[8]      = {'Z','U','G','W','N','N','Q','1'};
constexpr uint32_t kFormatVersion = 1;
constexpr size_t   kHeaderSize    = 64;

struct Header {
    char     magic[8];
    uint32_t formatVersion;
    uint32_t inputTotal;
    uint32_t h;
    uint32_t d2;
    uint32_t d3;
    uint32_t nb;
    uint32_t ftQA;
    uint32_t int8QA;
    uint32_t l1QB;
    uint32_t ftShift;
    uint64_t payloadSize;
    uint64_t checksum;
};

static_assert(sizeof(Header) >= kHeaderSize, "Header must fit in kHeaderSize bytes");

// --- explicit little-endian byte assembly (host-endianness independent) ---

inline void wf_wr_u16(unsigned char* p, uint16_t v) {
    p[0] = static_cast<unsigned char>(v & 0xFF);
    p[1] = static_cast<unsigned char>((v >> 8) & 0xFF);
}
inline void wf_wr_u32(unsigned char* p, uint32_t v) {
    p[0] = static_cast<unsigned char>(v & 0xFF);
    p[1] = static_cast<unsigned char>((v >> 8) & 0xFF);
    p[2] = static_cast<unsigned char>((v >> 16) & 0xFF);
    p[3] = static_cast<unsigned char>((v >> 24) & 0xFF);
}
inline void wf_wr_u64(unsigned char* p, uint64_t v) {
    for (int i = 0; i < 8; ++i) p[i] = static_cast<unsigned char>((v >> (8 * i)) & 0xFF);
}
inline void wf_wr_i16(unsigned char* p, int16_t v) { wf_wr_u16(p, static_cast<uint16_t>(v)); }
inline void wf_wr_f32(unsigned char* p, float f) {
    uint32_t u;
    std::memcpy(&u, &f, sizeof(u));
    wf_wr_u32(p, u);
}

inline uint16_t wf_rd_u16(const unsigned char* p) {
    return static_cast<uint16_t>(p[0]) | (static_cast<uint16_t>(p[1]) << 8);
}
inline uint32_t wf_rd_u32(const unsigned char* p) {
    return static_cast<uint32_t>(p[0]) | (static_cast<uint32_t>(p[1]) << 8) |
           (static_cast<uint32_t>(p[2]) << 16) | (static_cast<uint32_t>(p[3]) << 24);
}
inline uint64_t wf_rd_u64(const unsigned char* p) {
    uint64_t v = 0;
    for (int i = 0; i < 8; ++i) v |= static_cast<uint64_t>(p[i]) << (8 * i);
    return v;
}
inline int16_t wf_rd_i16(const unsigned char* p) { return static_cast<int16_t>(wf_rd_u16(p)); }
inline float wf_rd_f32(const unsigned char* p) {
    uint32_t u = wf_rd_u32(p);
    float f;
    std::memcpy(&f, &u, sizeof(f));
    return f;
}

// FNV-1a 64-bit over a byte buffer. Not cryptographic — this is a corruption
// detector (truncated/bit-flipped download), not a security checksum.
inline uint64_t fnv1a64(const unsigned char* data, size_t len) {
    uint64_t h = 0xcbf29ce484222325ULL; // offset basis
    constexpr uint64_t prime = 0x100000001b3ULL;
    for (size_t i = 0; i < len; ++i) {
        h ^= static_cast<uint64_t>(data[i]);
        h *= prime;
    }
    return h;
}

// Element counts for the payload sections, derived from the compiled-in arch
// constants — shared by the writer (to size its output buffer) and the loader
// (to size Net's vectors and know how many bytes each section occupies).
struct SectionCounts {
    size_t nW0i, nB0i, nL1W8, nL1B, nL2W, nL2B, nOW, nOB;
};

inline SectionCounts section_counts() {
    SectionCounts c;
    c.nW0i  = static_cast<size_t>(NNUE::InputTotal) * NNUE::H;
    c.nB0i  = static_cast<size_t>(NNUE::H);
    c.nL1W8 = static_cast<size_t>(NNUE::NB) * NNUE::D2 * NNUE::H;
    c.nL1B  = static_cast<size_t>(NNUE::NB) * NNUE::D2;
    c.nL2W  = static_cast<size_t>(NNUE::D2) * (NNUE::NB * NNUE::D3);
    c.nL2B  = static_cast<size_t>(NNUE::NB) * NNUE::D3;
    c.nOW   = static_cast<size_t>(NNUE::D3) * NNUE::NB;
    c.nOB   = static_cast<size_t>(NNUE::NB);
    return c;
}

inline size_t payload_bytes(const SectionCounts& c) {
    return c.nW0i * sizeof(int16_t) + c.nB0i * sizeof(int16_t) +
           c.nL1W8 * sizeof(int8_t) + c.nL1B * sizeof(float) +
           c.nL2W * sizeof(float) + c.nL2B * sizeof(float) +
           c.nOW * sizeof(float) + c.nOB * sizeof(float);
}

// Serializes `net` to the pre-quantized web-format file at `path`, per the on-disk
// layout documented above. Returns false if `net`'s section sizes don't match the
// compiled-in arch constants, or on any write failure. Shared by the writer tool
// (tools/netweb_writer.cpp) and the byte-identity test (test/nnue_web_format_test.cpp)
// so both serialize with the exact same code.
inline bool write_net(const NNUE::Net& net, const char* path) {
    const SectionCounts counts = section_counts();
    if (net.W0i.size() != counts.nW0i || net.B0i.size() != counts.nB0i ||
        net.L1W8.size() != counts.nL1W8 || net.L1B.size() != counts.nL1B ||
        net.L2W.size() != counts.nL2W || net.L2B.size() != counts.nL2B ||
        net.OW.size() != counts.nOW || net.OB.size() != counts.nOB)
        return false;

    const size_t payloadSize = payload_bytes(counts);
    std::vector<unsigned char> payload(payloadSize);
    unsigned char* cur = payload.data();
    for (size_t i = 0; i < counts.nW0i; ++i, cur += 2) wf_wr_i16(cur, net.W0i[i]);
    for (size_t i = 0; i < counts.nB0i; ++i, cur += 2) wf_wr_i16(cur, net.B0i[i]);
    // int8: single bytes, no endianness — a direct copy is unambiguous.
    std::memcpy(cur, net.L1W8.data(), counts.nL1W8);
    cur += counts.nL1W8;
    for (size_t i = 0; i < counts.nL1B; ++i, cur += 4) wf_wr_f32(cur, net.L1B[i]);
    for (size_t i = 0; i < counts.nL2W; ++i, cur += 4) wf_wr_f32(cur, net.L2W[i]);
    for (size_t i = 0; i < counts.nL2B; ++i, cur += 4) wf_wr_f32(cur, net.L2B[i]);
    for (size_t i = 0; i < counts.nOW;  ++i, cur += 4) wf_wr_f32(cur, net.OW[i]);
    for (size_t i = 0; i < counts.nOB;  ++i, cur += 4) wf_wr_f32(cur, net.OB[i]);
    if (static_cast<size_t>(cur - payload.data()) != payloadSize) return false;

    const uint64_t checksum = fnv1a64(payload.data(), payload.size());
    unsigned char header[kHeaderSize];
    std::memset(header, 0, sizeof(header));
    std::memcpy(header, kMagic, sizeof(kMagic));
    wf_wr_u32(header + 8,  kFormatVersion);
    wf_wr_u32(header + 12, static_cast<uint32_t>(NNUE::InputTotal));
    wf_wr_u32(header + 16, static_cast<uint32_t>(NNUE::H));
    wf_wr_u32(header + 20, static_cast<uint32_t>(NNUE::D2));
    wf_wr_u32(header + 24, static_cast<uint32_t>(NNUE::D3));
    wf_wr_u32(header + 28, static_cast<uint32_t>(NNUE::NB));
    wf_wr_u32(header + 32, static_cast<uint32_t>(NNUE::ftQA));
    wf_wr_u32(header + 36, static_cast<uint32_t>(NNUE::int8QA));
    wf_wr_u32(header + 40, static_cast<uint32_t>(NNUE::L1QB));
    wf_wr_u32(header + 44, static_cast<uint32_t>(NNUE::ftShift));
    wf_wr_u64(header + 48, static_cast<uint64_t>(payloadSize));
    wf_wr_u64(header + 56, checksum);

    std::FILE* fp = std::fopen(path, "wb");
    if (!fp) return false;
    size_t wrote = std::fwrite(header, 1, sizeof(header), fp);
    wrote += std::fwrite(payload.data(), 1, payload.size(), fp);
    std::fclose(fp);
    return wrote == sizeof(header) + payload.size();
}

} // namespace NNUE::WebFormat
