// Wave 8 first step: measure how sparse fc_0's input (forward_pass's ft[HalfDimensions]
// uint8 activation vector) actually is on this net, over the same 560-FEN corpus every
// other sfnet gate uses. This is the number that decides whether SF's
// AffineTransformSparseInput (find_nnz + scrambled weight layout) can pay for itself
// here — see docs/sfnet-wave7.md §3 (the wave that named this as the required first
// step before touching fc_0) and docs/sfnet-wave8.md.
//
// Read-only: calls the real evaluate_raw() -> forward_pass() path (same code every
// other gate exercises), just also reads SFNet::g_sfnet_last_zero_count after each
// call. Does not modify ft[] or any returned value — see sfnet_eval.cpp's probe block.
//
//   make sfnet_sparsity_probe && ./test/sfnet_sparsity_probe <net.nnue> <fens.epd>

#include "sfnet.h"
#include "sfnet_internal.h"
#include "position.h"
#include "bitboard.h"
#include "zobrist.h"

#include <algorithm>
#include <cstdio>
#include <fstream>
#include <string>
#include <vector>

namespace {

std::vector<std::string> read_fens(const std::string& path) {
    std::vector<std::string> fens;
    std::ifstream f(path);
    std::string line;
    while (std::getline(f, line)) {
        while (!line.empty() && (line.back() == '\r' || line.back() == '\n' || line.back() == ' '))
            line.pop_back();
        if (!line.empty()) fens.push_back(line);
    }
    return fens;
}

}  // namespace

int main(int argc, char** argv) {
    BB::init();
    Zobrist::init();

    if (argc < 3) {
        std::fprintf(stderr, "usage: %s <net.nnue> <fens.epd>\n", argv[0]);
        return 2;
    }
    const std::string netPath = argv[1];
    const std::string fenPath = argv[2];

    if (!SFNet::load(netPath.c_str())) {
        std::fprintf(stderr, "sfnet_sparsity_probe: failed to load net %s\n", netPath.c_str());
        return 1;
    }

    const std::vector<std::string> fens = read_fens(fenPath);
    if (fens.empty()) {
        std::fprintf(stderr, "sfnet_sparsity_probe: no FENs read from %s\n", fenPath.c_str());
        return 1;
    }

    SFNet::g_sfnet_probe_sparsity = true;

    constexpr int HalfDimensions = SFNet::HalfDimensions;
    constexpr int NumChunks4 = HalfDimensions / 4;
    std::vector<int> zeroCounts;
    std::vector<int> nonzeroChunks;
    zeroCounts.reserve(fens.size());
    nonzeroChunks.reserve(fens.size());

    int skipped = 0;
    for (const std::string& fen : fens) {
        Position p;
        p.set(fen);
        if (p.in_check()) { ++skipped; continue; }  // evaluate_raw's precondition
        SFNet::g_sfnet_last_zero_count = -1;
        SFNet::g_sfnet_last_nonzero_chunks4 = -1;
        (void)SFNet::evaluate_raw(p);
        if (SFNet::g_sfnet_last_zero_count < 0) {
            std::fprintf(stderr, "sfnet_sparsity_probe: probe did not fire for %s\n", fen.c_str());
            return 1;
        }
        zeroCounts.push_back(SFNet::g_sfnet_last_zero_count);
        nonzeroChunks.push_back(SFNet::g_sfnet_last_nonzero_chunks4);
    }

    if (zeroCounts.empty()) {
        std::fprintf(stderr, "sfnet_sparsity_probe: no positions evaluated\n");
        return 1;
    }

    std::vector<int> sorted = zeroCounts;
    std::sort(sorted.begin(), sorted.end());
    const std::size_t n = sorted.size();

    double sum = 0.0;
    for (int z : zeroCounts) sum += z;
    const double meanZero = sum / double(n);
    const double meanFrac = meanZero / double(HalfDimensions);

    auto pct = [&](double p) -> int {
        std::size_t idx = std::size_t(p * double(n - 1));
        return sorted[idx];
    };
    const int p0 = sorted.front();
    const int p25 = pct(0.25);
    const int p50 = pct(0.50);
    const int p75 = pct(0.75);
    const int p100 = sorted.back();

    // Coarse histogram over zero-fraction deciles, so the distribution shape (not just
    // the mean) is visible — a bimodal split (some positions near-dense, others
    // near-fully-sparse) would matter differently than a tight cluster around the mean.
    int hist[10] = {0};
    for (int z : zeroCounts) {
        double frac = double(z) / double(HalfDimensions);
        int bucket = int(frac * 10.0);
        if (bucket > 9) bucket = 9;
        if (bucket < 0) bucket = 0;
        ++hist[bucket];
    }

    std::printf("sfnet_sparsity_probe: %zu positions evaluated (%d skipped, in-check), HalfDimensions=%d\n",
                n, skipped, HalfDimensions);
    std::printf("zero-count per position (of %d): min=%d  p25=%d  median=%d  p75=%d  max=%d\n",
                HalfDimensions, p0, p25, p50, p75, p100);
    std::printf("zero-FRACTION per position: min=%.3f  p25=%.3f  median=%.3f  p75=%.3f  max=%.3f  mean=%.4f\n",
                double(p0) / HalfDimensions, double(p25) / HalfDimensions, double(p50) / HalfDimensions,
                double(p75) / HalfDimensions, double(p100) / HalfDimensions, meanFrac);
    std::printf("histogram (zero-fraction deciles, count of positions):\n");
    for (int b = 0; b < 10; ++b) {
        std::printf("  [%.1f,%.1f): %d\n", b / 10.0, (b + 1) / 10.0, hist[b]);
    }
    std::printf("MEAN_ZERO_FRACTION=%.4f\n", meanFrac);

    // Chunk-level (SF's ChunkSize=4): what find_nnz actually skips. A chunk of 4 bytes
    // counts as nonzero if ANY byte in it is nonzero, so this is a materially different
    // (higher) fraction than the raw per-byte zero count above.
    std::vector<int> sortedChunks = nonzeroChunks;
    std::sort(sortedChunks.begin(), sortedChunks.end());
    double sumChunks = 0.0;
    for (int c : nonzeroChunks) sumChunks += c;
    const double meanNonzeroChunks = sumChunks / double(n);
    const double meanNonzeroChunkFrac = meanNonzeroChunks / double(NumChunks4);
    auto pctc = [&](double p) -> int {
        std::size_t idx = std::size_t(p * double(n - 1));
        return sortedChunks[idx];
    };
    std::printf("\n-- chunk-level (ChunkSize=4, %d chunks/position; SF's find_nnz granularity) --\n",
                NumChunks4);
    std::printf("nonzero-chunk count per position: min=%d  p25=%d  median=%d  p75=%d  max=%d\n",
                sortedChunks.front(), pctc(0.25), pctc(0.50), pctc(0.75), sortedChunks.back());
    std::printf("nonzero-chunk FRACTION per position: mean=%.4f  (i.e. find_nnz visits this "
                "share of the %d chunks; dense fc_0 visits 1.0)\n",
                meanNonzeroChunkFrac, NumChunks4);
    std::printf("MEAN_NONZERO_CHUNK_FRACTION=%.4f\n", meanNonzeroChunkFrac);
    std::printf("projected fc_0 speedup from skipping zero chunks (1/mean_nonzero_chunk_frac): %.2fx\n",
                1.0 / meanNonzeroChunkFrac);
    return 0;
}
