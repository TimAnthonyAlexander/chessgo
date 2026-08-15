// SFNet loader — parses a Stockfish 18 .nnue file. Independent implementation of the
// published format; no Stockfish code is linked, copied or vendored.
//
// The format is validated end to end by tools/sfnet_parse.py, which walks the same
// bytes in Python and recomputes the same hashes. That script is this file's oracle:
// if the two disagree about any array, one of them is wrong.

#include "sfnet.h"
#include "sfnet_simd.h"

#include <array>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iostream>

namespace SFNet {
namespace {

// nnue_common.h:58,67-68
constexpr std::uint32_t kVersion = 0x7AF32F20u;
constexpr char kLebMagic[] = "COMPRESSED_LEB128";
constexpr std::size_t kLebMagicSize = sizeof(kLebMagic) - 1;  // 17, no NUL

// features/full_threats.h:41, features/half_ka_v2_hm.h:70
constexpr std::uint32_t kFullThreatsHash = 0x8F234CB8u;

std::uint32_t affine_hash(std::uint32_t prev, int outDims) {
    std::uint32_t h = 0xCC03DAE4u + std::uint32_t(outDims);
    h ^= prev >> 1;
    h ^= prev << 31;
    return h;
}

std::uint32_t relu_hash(std::uint32_t prev) { return 0x538D24C7u + prev; }

// ---- little-endian scalar reads --------------------------------------------------
// The engine only ever runs on little-endian targets (arm64/amd64), so these are
// straight byte copies; a big-endian host would need a swap here and nowhere else.
template<typename T>
bool read_le(std::istream& s, T* out, std::size_t count) {
    s.read(reinterpret_cast<char*>(out), std::streamsize(sizeof(T) * count));
    return bool(s);
}

std::uint32_t read_u32(std::istream& s) {
    unsigned char b[4];
    s.read(reinterpret_cast<char*>(b), 4);
    return std::uint32_t(b[0]) | (std::uint32_t(b[1]) << 8) | (std::uint32_t(b[2]) << 16)
         | (std::uint32_t(b[3]) << 24);
}

// ---- signed LEB128 ---------------------------------------------------------------
// One frame ("call") is: 17 magic bytes, a u32 payload length, then that many bytes of
// signed-LEB128. A single frame can fill SEVERAL arrays back to back off one bitstream
// with no re-framing between them — the big net's threatPsqtWeights and psqtWeights are
// exactly that (nnue_common.h:210-225).
class LebFrame {
   public:
    explicit LebFrame(std::istream& s) : s_(s) {}

    bool begin() {
        char magic[kLebMagicSize];
        s_.read(magic, kLebMagicSize);
        if (!s_ || std::memcmp(magic, kLebMagic, kLebMagicSize) != 0) return false;
        bytesLeft_ = read_u32(s_);
        bufPos_ = fill_ = 0;
        return bool(s_);
    }

    // Decodes `count` values into `out`. Accumulation is done in int32 and narrowed on
    // store, which is what SF's `IntType result` does after integer promotion.
    template<typename T>
    bool read(T* out, std::size_t count) {
        std::int32_t result = 0;
        std::size_t shift = 0, i = 0;
        while (i < count) {
            if (bufPos_ >= fill_) {
                const std::size_t want = std::min<std::size_t>(bytesLeft_, buf_.size());
                if (want == 0) return false;  // the frame ran out before the arrays did
                s_.read(reinterpret_cast<char*>(buf_.data()), std::streamsize(want));
                if (!s_) return false;
                bufPos_ = 0;
                fill_ = std::uint32_t(want);
            }
            const std::uint8_t byte = buf_[bufPos_++];
            --bytesLeft_;
            result |= std::int32_t(std::uint32_t(byte & 0x7F) << (shift % 32));
            shift += 7;
            if ((byte & 0x80) == 0) {
                if (shift < 32 && (byte & 0x40))
                    result |= std::int32_t(~((std::uint32_t(1) << shift) - 1));
                out[i++] = static_cast<T>(result);
                result = 0;
                shift = 0;
            }
        }
        return true;
    }

    // A well-formed frame is consumed exactly: the declared payload length covers the
    // arrays and nothing else. Anything left over means we misread a shape.
    bool end() const { return bytesLeft_ == 0 && bufPos_ == fill_; }

   private:
    std::istream& s_;
    std::array<std::uint8_t, 8192> buf_{};
    std::uint32_t bytesLeft_ = 0;
    std::uint32_t bufPos_ = 0;
    std::uint32_t fill_ = 0;
};

Net g_net;

bool fail(const char* what) {
    std::cerr << "SFNet: " << what << "\n";
    g_net = Net{};
    return false;
}

}  // namespace

std::uint32_t feature_transformer_hash() {
    return kFullThreatsHash ^ std::uint32_t(HalfDimensions * 2);
}

std::uint32_t architecture_hash() {
    // ac_sqr_0 is in neither the read chain nor this hash chain, even though
    // propagate() runs it (nnue_architecture.h:74-86).
    std::uint32_t h = 0xEC42E90Du ^ std::uint32_t(HalfDimensions * 2);
    h = affine_hash(h, Fc0Out);  // fc_0
    h = relu_hash(h);            // ac_0
    h = affine_hash(h, L3);      // fc_1
    h = relu_hash(h);            // ac_1
    h = affine_hash(h, 1);       // fc_2
    return h;
}

std::uint32_t network_hash() { return feature_transformer_hash() ^ architecture_hash(); }

bool loaded() { return g_net.ok; }
const Net& net() { return g_net; }

bool load(const char* path) {
    g_net = Net{};

    std::ifstream f(path, std::ios::binary);
    if (!f) return fail("cannot open net file");

    // ---- header (96 bytes for the released nets: 12 + an 84-byte description) ----
    if (read_u32(f) != kVersion) return fail("not a Stockfish .nnue (bad version)");
    const std::uint32_t topHash = read_u32(f);
    if (topHash != network_hash())
        return fail("architecture mismatch — this loader is the 1024-wide threats net only");
    const std::uint32_t descLen = read_u32(f);
    if (!f || descLen > (1u << 20)) return fail("bad description length");
    g_net.description.resize(descLen);
    if (descLen && !f.read(&g_net.description[0], descLen)) return fail("truncated description");

    // ---- feature transformer ----
    if (read_u32(f) != feature_transformer_hash()) return fail("bad feature-transformer hash");

    g_net.biases.resize(HalfDimensions);
    {
        LebFrame frame(f);
        if (!frame.begin()) return fail("bad LEB frame (biases)");
        if (!frame.read(g_net.biases.data(), g_net.biases.size())) return fail("short biases");
        if (!frame.end()) return fail("biases frame not fully consumed");
    }

    // Uncompressed on purpose: at 82 MB, LEB128 would cost more to decode than it saves.
    g_net.threatWeights.resize(std::size_t(ThreatDims) * HalfDimensions);
    if (!read_le(f, g_net.threatWeights.data(), g_net.threatWeights.size()))
        return fail("short threatWeights");

    g_net.weights.resize(std::size_t(PsqDims) * HalfDimensions);
    {
        LebFrame frame(f);
        if (!frame.begin()) return fail("bad LEB frame (weights)");
        if (!frame.read(g_net.weights.data(), g_net.weights.size())) return fail("short weights");
        if (!frame.end()) return fail("weights frame not fully consumed");
    }

    // ONE frame, TWO arrays, threats first — not two frames (nnue_feature_transformer.h:161).
    g_net.threatPsqt.resize(std::size_t(ThreatDims) * PSQTBuckets);
    g_net.psqt.resize(std::size_t(PsqDims) * PSQTBuckets);
    {
        LebFrame frame(f);
        if (!frame.begin()) return fail("bad LEB frame (psqt)");
        if (!frame.read(g_net.threatPsqt.data(), g_net.threatPsqt.size()))
            return fail("short threatPsqtWeights");
        if (!frame.read(g_net.psqt.data(), g_net.psqt.size())) return fail("short psqtWeights");
        if (!frame.end()) return fail("psqt frame not fully consumed");
    }

    // ---- 8 layer stacks, raw little-endian, never LEB128 ----
    g_net.stacks.resize(LayerStacks);
    for (int i = 0; i < LayerStacks; ++i) {
        if (read_u32(f) != architecture_hash()) return fail("bad layer-stack hash");
        LayerStack& L = g_net.stacks[std::size_t(i)];
        if (!read_le(f, L.fc0b, Fc0Out)) return fail("short fc_0 biases");
        if (!read_le(f, L.fc0w, std::size_t(Fc0Out) * HalfDimensions)) return fail("short fc_0 weights");
        if (!read_le(f, L.fc1b, L3)) return fail("short fc_1 biases");
        if (!read_le(f, L.fc1w, std::size_t(L3) * Fc1InPadded)) return fail("short fc_1 weights");
        if (!read_le(f, L.fc2b, 1)) return fail("short fc_2 biases");
        if (!read_le(f, L.fc2w, Fc2In)) return fail("short fc_2 weights");
    }

    // Trailing bytes mean we misread a shape somewhere above and happened to land short.
    f.peek();
    if (!f.eof()) return fail("trailing bytes after the last layer stack");

    // ---- Wave 7: permute the FT arrays for the packus-based pairwise-combine tiers ----
    // Only the AVX512BW+VL/AVX2 kernels need this (see sfnet_simd.h's SFNET_FT_PERMUTE
    // block) -- SFNET_FT_PERMUTE is 0 for scalar/NEON builds, so this whole block
    // compiles out there and net.weights/biases/threatWeights stay in the natural
    // (file) order those tiers already expect.
    //
    // The self-check runs FIRST, before any real array is touched: if the order table
    // doesn't invert cleanly, permuting anyway would produce a load that succeeds and
    // an engine that plays with a silently wrong eval -- the exact failure mode this
    // wave was warned is worse than refusing to load at all.
#if SFNET_FT_PERMUTE
    if (!simd::ft_perm_order_self_check(simd::kFtPermOrder))
        return fail("FT permutation order failed its own involution self-check");
    simd::ft_permute(g_net.biases.data(), g_net.biases.size(), simd::kFtPermOrder);
    simd::ft_permute(g_net.weights.data(), g_net.weights.size(), simd::kFtPermOrder);
    simd::ft_permute(g_net.threatWeights.data(), g_net.threatWeights.size(), simd::kFtPermOrder);
#endif

    g_net.ok = true;
    return true;
}

}  // namespace SFNet
