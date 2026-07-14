#include "book.h"
#include "bitboard.h"
#include <array>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <iostream>

namespace Book {

// ---- gomachine-compatible Zobrist tables -----------------------------------
// Ported byte-for-byte from gomachine/internal/chess/zobrist.go. Deliberately
// SEPARATE from zugzwang's own Zobrist::psq/castling/enpassant/side (different
// RNG, different table layout) — this exists ONLY so book_key() reproduces the
// keys the book was compiled with. Never mix the two schemes.
namespace {

uint64_t gmPieces[12][64];
uint64_t gmCastling[16];
uint64_t gmEP[8];
uint64_t gmSide;
bool gmTablesInit = false;

void init_gm_tables() {
    if (gmTablesInit) return;
    uint64_t r = 0x9E3779B97F4A7C15ULL;
    auto next = [&]() -> uint64_t {
        r ^= r << 13;
        r ^= r >> 7;
        r ^= r << 17;
        return r;
    };
    for (int p = 0; p < 12; ++p)
        for (int s = 0; s < 64; ++s)
            gmPieces[p][s] = next();
    for (int i = 0; i < 16; ++i)
        gmCastling[i] = next();
    for (int f = 0; f < 8; ++f)
        gmEP[f] = next();
    gmSide = next();
    gmTablesInit = true;
}

} // namespace

uint64_t book_key(const Position& pos) {
    init_gm_tables();
    uint64_t k = 0;
    for (int s = 0; s < 64; ++s) {
        Piece pc = pos.piece_on(Square(s));
        if (pc == NO_PIECE) continue;
        int p = int(color_of(pc)) * 6 + (int(type_of(pc)) - 1);
        k ^= gmPieces[p][s];
    }
    k ^= gmCastling[pos.castling_rights()];
    if (pos.side_to_move() == BLACK) k ^= gmSide;

    Square ep = pos.ep_square();
    if (ep != SQ_NONE) {
        Color us = pos.side_to_move();
        if (BB::pawn_attacks(~us, ep) & pos.pieces(us, PAWN))
            k ^= gmEP[file_of(ep)];
    }
    return k;
}

// ---- GMBK file format -------------------------------------------------------
// Mirrors gomachine/internal/book/book.go: header (24B) + count * 112B records.
namespace {

constexpr char kMagic[4] = {'G', 'M', 'B', 'K'};
constexpr uint32_t kFormatVer = 2;
constexpr uint32_t kEngineVer = 1;
constexpr size_t kHeaderSize = 24;
constexpr size_t kPvFieldSz = 96;
constexpr size_t kRecordSize = 8 + 4 + 2 + 2 + kPvFieldSz;

uint32_t read_u32(const uint8_t* p) {
    return uint32_t(p[0]) | (uint32_t(p[1]) << 8) | (uint32_t(p[2]) << 16) | (uint32_t(p[3]) << 24);
}
uint64_t read_u64(const uint8_t* p) {
    uint64_t lo = read_u32(p);
    uint64_t hi = read_u32(p + 4);
    return lo | (hi << 32);
}
int32_t read_i32(const uint8_t* p) { return int32_t(read_u32(p)); }
int16_t read_i16(const uint8_t* p) { return int16_t(uint16_t(p[0]) | (uint16_t(p[1]) << 8)); }

// Standard CRC-32 (IEEE 802.3), reflected polynomial 0xEDB88320 — identical to
// Go's hash/crc32.ChecksumIEEE, which is what the book was written with.
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

std::vector<std::string> decode_pv(const uint8_t* field, size_t sz) {
    size_t n = 0;
    while (n < sz && field[n] != 0) ++n;
    std::vector<std::string> moves;
    if (n == 0) return moves;
    std::string s(reinterpret_cast<const char*>(field), n);
    size_t pos = 0;
    while (pos < s.size()) {
        size_t sp = s.find(' ', pos);
        if (sp == std::string::npos) {
            moves.push_back(s.substr(pos));
            break;
        }
        if (sp > pos) moves.push_back(s.substr(pos, sp - pos));
        pos = sp + 1;
    }
    return moves;
}

} // namespace

bool Book::load(const std::string& path) {
    std::ifstream f(path, std::ios::binary);
    if (!f) return false; // missing file: not an error, just no book

    std::vector<uint8_t> raw((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
    if (raw.size() < kHeaderSize || std::memcmp(raw.data(), kMagic, 4) != 0) {
        std::cerr << "Book: " << path << " bad magic/too short — ignoring\n";
        return false;
    }

    uint32_t formatVer = read_u32(&raw[4]);
    uint32_t engineVer = read_u32(&raw[8]);
    if (formatVer != kFormatVer || engineVer != kEngineVer) {
        // Unknown/stale format — ignore gracefully, exactly like gomachine's parse().
        return false;
    }

    uint32_t count = read_u32(&raw[12]);
    uint32_t storedCrc = read_u32(&raw[16]);

    const uint8_t* body = raw.data() + kHeaderSize;
    size_t bodyLen = raw.size() - kHeaderSize;
    if (bodyLen != size_t(count) * kRecordSize) {
        std::cerr << "Book: " << path << " size mismatch (have " << bodyLen
                  << ", want " << (size_t(count) * kRecordSize) << ") — refusing to load\n";
        return false;
    }
    uint32_t actualCrc = crc32_ieee(body, bodyLen);
    if (actualCrc != storedCrc) {
        std::cerr << "Book: " << path << " crc mismatch (corrupt) — refusing to load\n";
        return false;
    }

    std::vector<BookEntry> entries(count);
    std::vector<uint64_t> keys(count);
    for (uint32_t i = 0; i < count; ++i) {
        const uint8_t* off = body + size_t(i) * kRecordSize;
        keys[i] = read_u64(off);
        entries[i].score = read_i32(off + 8);
        entries[i].mate = read_i16(off + 12);
        entries[i].depth = read_i16(off + 14);
        entries[i].pv = decode_pv(off + 16, kPvFieldSz);
    }

    // Records are already sorted ascending by key on disk (book.go's Write
    // guarantees it), but store keys alongside entries for lookup's binary
    // search rather than trusting on-disk order blindly.
    keys_ = std::move(keys);
    entries_ = std::move(entries);
    loaded_ = true;
    return true;
}

const BookEntry* Book::lookup(uint64_t key) const {
    if (!loaded_) return nullptr;
    size_t lo = 0, hi = keys_.size();
    while (lo < hi) {
        size_t mid = lo + (hi - lo) / 2;
        if (keys_[mid] < key) lo = mid + 1;
        else hi = mid;
    }
    if (lo < keys_.size() && keys_[lo] == key) return &entries_[lo];
    return nullptr;
}

} // namespace Book
