#include "openings.h"
#include <algorithm>
#include <array>
#include <cstring>
#include <fstream>
#include <iostream>

namespace Openings {

namespace {

// ---- GMOP file format --------------------------------------------------
// header (16B): magic "GMOP"(4) + formatVer u32(4) + count u32(4) + crc32(4)
// then `count` records, each variable-length:
//   key u64(8) + ecoLen u8(1) + eco[ecoLen] + nameLen u16 LE(2) + name[nameLen]
// Records are sorted ascending by key (produced by
// zugzwang/tools/gen_openings_bin.py from gomachine's compiled opening
// table). crc32 is the standard CRC-32 (IEEE 802.3), matching Go's
// hash/crc32.ChecksumIEEE — computed over the body (everything after the
// 16-byte header), same convention as book.cpp's GMBK format.
constexpr char kMagic[4] = {'G', 'M', 'O', 'P'};
constexpr uint32_t kFormatVer = 1;
constexpr size_t kHeaderSize = 16;

uint32_t read_u32(const uint8_t* p) {
    return uint32_t(p[0]) | (uint32_t(p[1]) << 8) | (uint32_t(p[2]) << 16) | (uint32_t(p[3]) << 24);
}
uint64_t read_u64(const uint8_t* p) {
    uint64_t lo = read_u32(p);
    uint64_t hi = read_u32(p + 4);
    return lo | (hi << 32);
}
uint16_t read_u16(const uint8_t* p) { return uint16_t(p[0]) | (uint16_t(p[1]) << 8); }

uint32_t crc32_ieee(const uint8_t* data, size_t len) {
    static std::array<uint32_t, 256> table = [] {
        std::array<uint32_t, 256> t{};
        for (uint32_t i = 0; i < 256; ++i) {
            uint32_t c = i;
            for (int k = 0; k < 8; ++k)
                c = (c & 1) ? (0xEDB88320U ^ (c >> 1)) : (c >> 1);
            t[i] = c;
        }
        return t;
    }();
    uint32_t crc = 0xFFFFFFFFU;
    for (size_t i = 0; i < len; ++i)
        crc = table[(crc ^ data[i]) & 0xFF] ^ (crc >> 8);
    return crc ^ 0xFFFFFFFFU;
}

std::vector<uint64_t> g_keys;      // sorted ascending, parallel to g_entries
std::vector<Opening> g_entries;
bool g_loaded = false;

} // namespace

bool load(const std::string& path) {
    std::ifstream f(path, std::ios::binary);
    if (!f) return false; // missing file: not an error, just no classifier

    std::vector<uint8_t> raw((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
    if (raw.size() < kHeaderSize || std::memcmp(raw.data(), kMagic, 4) != 0) {
        std::cerr << "Openings: " << path << " bad magic/too short — ignoring\n";
        return false;
    }

    uint32_t formatVer = read_u32(&raw[4]);
    if (formatVer != kFormatVer) {
        // Unknown/stale format — ignore gracefully, like Book::load.
        return false;
    }
    uint32_t count = read_u32(&raw[8]);
    uint32_t storedCrc = read_u32(&raw[12]);

    const uint8_t* body = raw.data() + kHeaderSize;
    size_t bodyLen = raw.size() - kHeaderSize;
    uint32_t actualCrc = crc32_ieee(body, bodyLen);
    if (actualCrc != storedCrc) {
        std::cerr << "Openings: " << path << " crc mismatch (corrupt) — refusing to load\n";
        return false;
    }

    std::vector<uint64_t> keys;
    std::vector<Opening> entries;
    keys.reserve(count);
    entries.reserve(count);

    size_t off = 0;
    for (uint32_t i = 0; i < count; ++i) {
        if (off + 8 + 1 > bodyLen) {
            std::cerr << "Openings: " << path << " truncated record " << i << " — refusing to load\n";
            return false;
        }
        uint64_t key = read_u64(body + off);
        off += 8;
        uint8_t ecoLen = body[off];
        off += 1;
        if (off + ecoLen + 2 > bodyLen) {
            std::cerr << "Openings: " << path << " truncated eco field " << i << " — refusing to load\n";
            return false;
        }
        std::string eco(reinterpret_cast<const char*>(body + off), ecoLen);
        off += ecoLen;
        uint16_t nameLen = read_u16(body + off);
        off += 2;
        if (off + nameLen > bodyLen) {
            std::cerr << "Openings: " << path << " truncated name field " << i << " — refusing to load\n";
            return false;
        }
        std::string name(reinterpret_cast<const char*>(body + off), nameLen);
        off += nameLen;

        keys.push_back(key);
        entries.push_back(Opening{std::move(eco), std::move(name)});
    }

    g_keys = std::move(keys);
    g_entries = std::move(entries);
    g_loaded = true;
    return true;
}

bool loaded() { return g_loaded; }

bool lookup(uint64_t key, Opening& out) {
    if (!g_loaded) return false;
    size_t lo = 0, hi = g_keys.size();
    while (lo < hi) {
        size_t mid = lo + (hi - lo) / 2;
        if (g_keys[mid] < key) lo = mid + 1;
        else hi = mid;
    }
    if (lo < g_keys.size() && g_keys[lo] == key) {
        out = g_entries[lo];
        return true;
    }
    return false;
}

bool classify(const std::vector<uint64_t>& keys, Opening& out) {
    bool found = false;
    for (uint64_t k : keys) {
        Opening o;
        if (lookup(k, o)) {
            out = std::move(o);
            found = true;
        }
    }
    return found;
}

} // namespace Openings
