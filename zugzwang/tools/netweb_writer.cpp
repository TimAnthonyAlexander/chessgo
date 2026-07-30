// netweb_writer: converts the prod float32 bullet export (net.nnue / kb-mirror.bin,
// ~180 MB) into the pre-quantized "web format" (src/nnue_web_format.h, ~90 MB) so
// browsers (WASM) and the iOS app can download the already-quantized net instead of
// requantizing 180 MB of float32 client-side.
//
// It reuses the PRODUCTION loader (NNUE::load_net, src/nnue_net.cpp) to parse and
// quantize the float32 input — so the writer can never drift from what the engine
// itself would compute — then serializes the resulting NNUE::g_net via the shared
// WebFormat::write_net() helper (also used by test/nnue_web_format_test.cpp, so the
// writer and the test always agree on the exact byte layout).
//
// Build (standalone, does not touch the main `make` build):
//   cd zugzwang && make netweb
// or directly:
//   c++ -std=c++17 -O3 -DNDEBUG -ffp-contract=off -Isrc \
//       tools/netweb_writer.cpp src/nnue_net.cpp -o tools/netweb_writer
//
// Usage:
//   tools/netweb_writer <input-float32-net> <output-prequantized-net>
//   tools/netweb_writer net.nnue net.web.nnue

#include "nnue_net.h"
#include "nnue_web_format.h"

#include <cstdio>

using namespace NNUE;
using namespace NNUE::WebFormat;

int main(int argc, char** argv) {
    if (argc != 3) {
        std::fprintf(stderr, "usage: %s <input-float32-net> <output-prequantized-net>\n", argv[0]);
        return 2;
    }
    const char* inPath  = argv[1];
    const char* outPath = argv[2];

    std::fprintf(stderr, "loading + quantizing %s ...\n", inPath);
    if (!load_net(inPath) || !g_net.ok) {
        std::fprintf(stderr, "error: load_net(%s) failed (not a valid float32 net?)\n", inPath);
        return 1;
    }

    if (!write_net(g_net, outPath)) {
        std::fprintf(stderr, "error: write_net(%s) failed (size mismatch or write error)\n", outPath);
        return 1;
    }

    const SectionCounts counts = section_counts();
    const size_t payloadSize = payload_bytes(counts);
    std::fprintf(stderr, "wrote %s: %zu bytes (header %zu + payload %zu)\n",
                 outPath, kHeaderSize + payloadSize, kHeaderSize, payloadSize);
    return 0;
}
