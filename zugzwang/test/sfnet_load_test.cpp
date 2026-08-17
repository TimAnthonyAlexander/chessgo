// Wave 1 gate for the SF-net backend: the C++ loader must agree, array for array, with
// tools/sfnet_parse.py — the independent Python parser that walks the same bytes.
//
//   make sfnet_load_test && ./test/sfnet_load_test ~/sf18-arm/src/nn-c288c895ea92.nnue
//
// Asserts the recomputed hashes, every array's length, and the measured value ranges the
// Python oracle prints. Also asserts the two negative cases that matter: the small net
// (wrong architecture) and a truncated file must both be REFUSED, not half-read.

#include "sfnet.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <string>
#include <vector>

namespace {

int g_fails = 0;

void expect(bool cond, const char* what) {
    std::printf("  %s %s\n", cond ? "ok  " : "FAIL", what);
    if (!cond) ++g_fails;
}

template<typename T>
void expect_eq(long long got, long long want, const char* what) {
    const bool ok = got == want;
    if (ok) std::printf("  ok   %-34s %lld\n", what, got);
    else {
        std::printf("  FAIL %-34s %lld (want %lld)\n", what, got, want);
        ++g_fails;
    }
}

void expect_hash(std::uint32_t got, std::uint32_t want, const char* what) {
    const bool ok = got == want;
    if (ok) std::printf("  ok   %-34s 0x%08x\n", what, got);
    else {
        std::printf("  FAIL %-34s 0x%08x (want 0x%08x)\n", what, got, want);
        ++g_fails;
    }
}

template<typename T>
void expect_range(const std::vector<T>& v, long long lo, long long hi, const char* what) {
    long long mn = 0, mx = 0;
    if (!v.empty()) {
        mn = mx = v[0];
        for (const T x : v) {
            if (x < mn) mn = x;
            if (x > mx) mx = x;
        }
    }
    const bool ok = mn == lo && mx == hi;
    if (ok) std::printf("  ok   %-34s [%lld, %lld]\n", what, mn, mx);
    else {
        std::printf("  FAIL %-34s [%lld, %lld] (want [%lld, %lld])\n", what, mn, mx, lo, hi);
        ++g_fails;
    }
}

// Copies the first `bytes` of `src` to a temp file, for the truncation case.
std::string truncated_copy(const char* src, std::size_t bytes) {
    const std::string dst = std::string(std::getenv("TMPDIR") ? std::getenv("TMPDIR") : "/tmp")
                          + "/sfnet_truncated.nnue";
    std::ifstream in(src, std::ios::binary);
    std::ofstream out(dst, std::ios::binary);
    std::vector<char> buf(bytes);
    in.read(buf.data(), std::streamsize(bytes));
    out.write(buf.data(), in.gcount());
    return dst;
}

}  // namespace

int main(int argc, char** argv) {
    const char* big = argc > 1 ? argv[1] : "/Users/tim.alexander/sf18-arm/src/nn-c288c895ea92.nnue";
    const char* small = argc > 2 ? argv[2] : nullptr;

    std::printf("SF net loader gate\n  %s\n\n", big);

    std::printf("hashes recomputed from the architecture (nothing read from the file):\n");
    expect_hash(SFNet::feature_transformer_hash(), 0x8F2344B8u, "feature-transformer hash");
    expect_hash(SFNet::architecture_hash(), 0x63336A4Au, "layer-stack (arch) hash");
    expect_hash(SFNet::network_hash(), 0xEC102EF2u, "top-level network hash");

    std::printf("\nload:\n");
    if (!SFNet::load(big)) {
        std::printf("  FAIL load returned false\n");
        return 1;
    }
    const SFNet::Net& n = SFNet::net();
    expect(SFNet::loaded(), "loaded()");
    expect(n.description.rfind("Network trained with", 0) == 0, "description");

    std::printf("\nshapes:\n");
    expect_eq<int>((long long) n.biases.size(), 1024, "biases");
    expect_eq<int>((long long) n.threatWeights.size(), 81772544LL, "threatWeights");
    expect_eq<int>((long long) n.weights.size(), 23068672LL, "weights");
    expect_eq<int>((long long) n.threatPsqt.size(), 638848LL, "threatPsqtWeights");
    expect_eq<int>((long long) n.psqt.size(), 180224LL, "psqtWeights");
    expect_eq<int>((long long) n.stacks.size(), 8, "layer stacks");

    // The values tools/sfnet_parse.py measures. A shape misread that still consumed the
    // file exactly would show up here as a shifted range.
    std::printf("\nvalue ranges (must match tools/sfnet_parse.py):\n");
    expect_range(n.biases, -207, 162, "biases");
    expect_range(n.threatWeights, -128, 127, "threatWeights");
    expect_range(n.weights, -719, 900, "weights");
    expect_range(n.threatPsqt, -4575, 4749, "threatPsqtWeights");
    expect_range(n.psqt, -45382, 43060, "psqtWeights");

    std::printf("\nrejections:\n");
    if (small) {
        expect(!SFNet::load(small), "small net refused (wrong architecture)");
        expect(!SFNet::loaded(), "loaded() false after refusal");
    } else {
        std::printf("  --   small-net rejection skipped (pass it as argv[2])\n");
    }
    {
        const std::string t = truncated_copy(big, 50u * 1024 * 1024);
        expect(!SFNet::load(t.c_str()), "truncated file refused");
        std::remove(t.c_str());
    }

    std::printf("\n%s\n", g_fails == 0 ? "RESULT: PASS" : "RESULT: FAIL");
    return g_fails == 0 ? 0 : 1;
}
