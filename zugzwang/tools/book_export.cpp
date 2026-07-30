// book_export: recovers the FENs that zugzwang's precomputed opening book
// (book.bin, GMBK v2, keys-only — see src/book.{h,cpp}) was compiled with, so
// a downstream importer can bulk-load the book straight into `eval_cache`
// without the site ever having to see every position live first.
//
// The book stores gomachine-Zobrist KEYS only, no FENs (see book.h's header
// comment), so entries cannot be enumerated directly. Instead this does a
// breadth-first walk starting from the standard start position plus every
// FEN in gomachine's opening suites, probing Book::book_key()+Book::lookup()
// at each node:
//   - HIT  -> emit the record, enqueue all legal children (the book is a
//             connected opening tree, so a hit's children are worth exploring).
//   - MISS -> don't expand (would explode the search for nothing) — UNLESS
//             the node is one of the seed positions themselves, which get one
//             ply of expansion even on a miss so a seed adjacent to book
//             territory can still reach it.
// Visited positions are deduplicated by book_key(). The walk is bounded by a
// ply cap (--max-ply, default 40) and a visited-node cap (--max-nodes,
// default 2000000) so it cannot run away.
//
// Every emitted record's pv[0] is validated as a legal move via
// Rules::parse_uci_move (mirrors serve_handlers.cpp's analysis_lines/book
// guard against stale records) — this is not optional, a bad row silently
// poisons eval_cache.
//
// Build (standalone, does not touch the main `make` build):
//   cd zugzwang && make book_export
// or directly:
//   c++ -std=c++17 -O3 -DNDEBUG -ffp-contract=off -Isrc \
//       tools/book_export.cpp src/book.cpp src/position.cpp src/bitboard.cpp \
//       src/zobrist.cpp src/movegen.cpp src/rules.cpp src/weakening.cpp \
//       src/antichess.cpp src/nnue_net.cpp src/nnue_features.cpp \
//       src/nnue_eval.cpp src/nnue_accumulator.cpp -o tools/book_export
//
// Usage:
//   tools/book_export [--book=book.bin] [--max-ply=40] [--max-nodes=2000000]
//                      [-o out.tsv] [seed.epd ...]
//   (seed.epd files are optional additional seed lists beyond the built-in
//   start position; each line's first whitespace-separated field is a FEN,
//   any trailing EPD opcodes are ignored.)
//
// Output TSV (stdout, or -o file): fen<TAB>score<TAB>mate<TAB>depth<TAB>pv
// where pv is a space-separated UCI move list. fen is the FULL 6-field FEN.

#include "bitboard.h"
#include "book.h"
#include "movegen.h"
#include "position.h"
#include "rules.h"
#include "zobrist.h"

#include <cstdio>
#include <cstring>
#include <deque>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>
#include <unordered_set>
#include <vector>

namespace {

constexpr const char* START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

// First whitespace-separated field of a line == the FEN's piece-placement
// field is not enough on its own (a FEN is 6 space-separated fields); EPD
// lines in gomachine/data/*.epd are already full 6-field FENs with no extra
// opcodes appended (verified: `rnbqk... w KQkq - 0 1`-shaped, nothing after
// field 6), but parse defensively anyway — take exactly the first 6
// whitespace-separated fields and ignore anything past that.
std::string first_six_fields(const std::string& line) {
    std::istringstream iss(line);
    std::vector<std::string> fields;
    std::string tok;
    while (fields.size() < 6 && (iss >> tok)) fields.push_back(tok);
    if (fields.size() < 4) return ""; // not even a minimal FEN
    std::string out;
    for (size_t i = 0; i < fields.size(); ++i) {
        if (i) out += ' ';
        out += fields[i];
    }
    return out;
}

std::vector<std::string> load_seed_fens(const std::string& path) {
    std::vector<std::string> out;
    std::ifstream f(path);
    if (!f) {
        std::fprintf(stderr, "warning: cannot read seed file '%s' — skipping\n", path.c_str());
        return out;
    }
    std::string line;
    while (std::getline(f, line)) {
        if (line.empty() || line[0] == '#') continue;
        std::string fen = first_six_fields(line);
        if (!fen.empty()) out.push_back(fen);
    }
    return out;
}

struct QueueItem {
    std::string fen;
    int ply;
    bool isSeed; // seeds get one ply of expansion even on a book miss
};

// Coverage reporting needs the book's total entry count, but Book::Book
// doesn't expose one (keys_/entries_ are private, and book.h/.cpp are
// intentionally left untouched by this tool). Re-read just the 24-byte GMBK
// header directly — same layout book.cpp already documents (magic 4B,
// formatVer 4B, engineVer 4B, count 4B, crc 4B, reserved 4B) — to report the
// denominator for "found / total" without duplicating the parser or forking
// Book's internals.
long read_book_entry_count(const std::string& path) {
    std::ifstream f(path, std::ios::binary);
    if (!f) return -1;
    unsigned char hdr[24];
    f.read(reinterpret_cast<char*>(hdr), sizeof(hdr));
    if (!f || std::memcmp(hdr, "GMBK", 4) != 0) return -1;
    uint32_t count = uint32_t(hdr[12]) | (uint32_t(hdr[13]) << 8) |
                     (uint32_t(hdr[14]) << 16) | (uint32_t(hdr[15]) << 24);
    return long(count);
}

} // namespace

int main(int argc, char** argv) {
    // Magic-bitboard + Zobrist tables are lazily-nothing — every other
    // entrypoint (uci_main, perft_main) calls these before touching a
    // Position; skipping them leaves RookMagics/BishopMagics attack tables
    // null, so Position::set() (via set_check_info -> attackers_to ->
    // rook_attacks) segfaults on a null magic-table pointer dereference.
    BB::init();
    Zobrist::init();

    std::string bookPath = "book.bin";
    std::string outPath;
    int maxPly = 40;
    long maxNodes = 2000000;
    std::vector<std::string> seedFiles;

    for (int i = 1; i < argc; ++i) {
        std::string a = argv[i];
        auto val = [&](const std::string& prefix) -> std::string {
            return a.substr(prefix.size());
        };
        if (a.rfind("--book=", 0) == 0) bookPath = val("--book=");
        else if (a.rfind("--max-ply=", 0) == 0) maxPly = std::stoi(val("--max-ply="));
        else if (a.rfind("--max-nodes=", 0) == 0) maxNodes = std::stol(val("--max-nodes="));
        else if (a == "-o" && i + 1 < argc) outPath = argv[++i];
        else if (a.rfind("-o=", 0) == 0) outPath = val("-o=");
        else seedFiles.push_back(a);
    }

    Book::Book book;
    if (!book.load(bookPath)) {
        std::fprintf(stderr, "error: failed to load book at '%s'\n", bookPath.c_str());
        return 1;
    }
    long bookTotalEntries = read_book_entry_count(bookPath);
    std::fprintf(stderr, "book '%s' loaded: %ld total entries (header count)\n",
                 bookPath.c_str(), bookTotalEntries);

    std::ostream* out = &std::cout;
    std::ofstream outFile;
    if (!outPath.empty()) {
        outFile.open(outPath);
        if (!outFile) {
            std::fprintf(stderr, "error: cannot open output file '%s'\n", outPath.c_str());
            return 1;
        }
        out = &outFile;
    }

    // ---- seed set: start position + every seed file --------------------
    std::vector<std::string> seeds;
    seeds.push_back(START_FEN);
    for (const std::string& sf : seedFiles) {
        std::vector<std::string> fens = load_seed_fens(sf);
        std::fprintf(stderr, "seed file '%s': %zu FEN(s)\n", sf.c_str(), fens.size());
        for (auto& f : fens) seeds.push_back(std::move(f));
    }
    std::fprintf(stderr, "total seeds: %zu, max-ply=%d, max-nodes=%ld\n", seeds.size(), maxPly, maxNodes);

    std::unordered_set<uint64_t> visited;
    std::deque<QueueItem> queue;
    for (const std::string& s : seeds) queue.push_back({s, 0, true});

    long nodesVisited = 0;
    long hits = 0;
    long misses = 0;
    long parseFailures = 0;
    long pvValidationFailures = 0;
    long emitted = 0;

    while (!queue.empty() && nodesVisited < maxNodes) {
        QueueItem item = queue.front();
        queue.pop_front();

        if (!Rules::valid_fen_structure(item.fen)) {
            parseFailures++;
            continue;
        }
        Position pos;
        pos.set(item.fen);
        if (!Rules::position_legal(pos)) {
            parseFailures++;
            continue;
        }

        uint64_t key = Book::book_key(pos);
        if (visited.count(key)) continue;
        visited.insert(key);
        nodesVisited++;

        const Book::BookEntry* e = book.lookup(key);
        bool isHit = (e != nullptr && !e->pv.empty());

        if (isHit) {
            hits++;
            Move bm = Rules::parse_uci_move(pos, e->pv[0]);
            if (bm == MOVE_NONE) {
                pvValidationFailures++;
            } else {
                emitted++;
                *out << pos.fen() << '\t' << e->score << '\t' << e->mate << '\t' << e->depth << '\t';
                for (size_t i = 0; i < e->pv.size(); ++i) {
                    if (i) *out << ' ';
                    *out << e->pv[i];
                }
                *out << '\n';
            }
        } else {
            misses++;
        }

        // Expand: always on a hit; on a miss, only if this node is itself a
        // seed (one ply past a seed, even on a miss, so an off-book seed
        // adjacent to book territory can still reach it).
        if (item.ply >= maxPly) continue;
        if (!isHit && !item.isSeed) continue;

        MoveList list;
        generate<ALL>(pos, list);
        StateInfo st;
        for (const ExtMove& em : list) {
            if (!pos.legal(em.move)) continue;
            pos.do_move(em.move, st);
            queue.push_back({pos.fen(), item.ply + 1, false});
            pos.undo_move(em.move);
        }
    }

    bool truncatedByNodeCap = !queue.empty();

    std::fprintf(stderr,
                 "walk done: nodes_visited=%ld book_hits=%ld book_misses=%ld "
                 "parse_failures=%ld pv_validation_failures=%ld emitted=%ld "
                 "queue_remaining=%zu%s\n",
                 nodesVisited, hits, misses, parseFailures, pvValidationFailures, emitted,
                 queue.size(), truncatedByNodeCap ? " (TRUNCATED by --max-nodes)" : "");

    // hits == distinct book keys reached (each key is probed at most once —
    // visited dedupes by book_key before the lookup), so this IS the
    // "found / total" coverage number the caller must report, not a proxy.
    if (bookTotalEntries > 0) {
        double pct = 100.0 * double(hits) / double(bookTotalEntries);
        std::fprintf(stderr, "coverage: %ld / %ld book entries reached (%.2f%%)\n",
                     hits, bookTotalEntries, pct);
    } else {
        std::fprintf(stderr, "coverage: unknown (could not read book header count)\n");
    }

    return 0;
}
