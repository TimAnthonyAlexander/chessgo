#pragma once
// Precomputed opening book: a compiled, read-only lookup of (gomachine-Zobrist
// key -> stockfish-quality eval / PV / depth) records, ported from gomachine's
// internal/book (gomachine/data/book.bin). The book stores KEYS ONLY (no FENs),
// so book_key() must reproduce gomachine's Zobrist scheme byte-for-byte — see
// book.cpp for the derivation (gomachine internal/chess/zobrist.go + the
// computeKey in position.go). This module is fully self-contained: it does NOT
// touch zugzwang's own Zobrist (src/zobrist.{h,cpp}) or TT.
#include "types.h"
#include "position.h"
#include <cstdint>
#include <string>
#include <vector>

namespace Book {

// gomachine-compatible Zobrist key for a position (NOT zugzwang's own key).
uint64_t book_key(const Position& pos);

struct BookEntry {
    int score;
    int mate;
    int depth;
    std::vector<std::string> pv; // UCI moves, pv[0] is the best move
};

class Book {
public:
    // Parses+validates a GMBK file at `path`. Returns true and stores entries
    // on success. A missing file, a bad/unknown format version, or a stale
    // engine version is NOT an error — returns false quietly (caller just
    // proceeds without a book). A corrupt (size/crc mismatch) file also
    // returns false, but logs to stderr so it's not silently ignored.
    bool load(const std::string& path);
    bool loaded() const { return loaded_; }

    // Exact-key binary search. nullptr on miss.
    const BookEntry* lookup(uint64_t key) const;

private:
    std::vector<uint64_t> keys_;     // sorted ascending, parallel to entries_
    std::vector<BookEntry> entries_;
    bool loaded_ = false;
};

// Process-wide singleton for `serve` mode: serve.cpp loads it once at startup
// (mirrors NNUE::load's pattern) and serve_handlers.cpp's search-backed
// handlers probe it before searching, from a different translation unit than
// the loader. uci.cpp keeps its OWN separate `Book::Book` instance rather than
// this one — the UCI `OwnBook` option is a live-game policy toggle (avoid
// repeating known theory move-for-move), which doesn't apply to serve's
// always-on full-strength analysis (gomachine's `bookHit`/handleBestMove
// consult the book unconditionally whenever no rating/level/worst weakening
// is requested — see server.go), so the two paths intentionally don't share
// state.
Book& shared();

} // namespace Book
