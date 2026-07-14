# Measure zugzwang NPS: coalla vs lairner (is prod's speed a build issue?)

**Status:** open · **Area:** engine / perf · **Related:** [nps-infra-batch.md](nps-infra-batch.md)

## Observation (2026-07-14, deploy of `44b4728`)
Same source, same net, same build flags (g++ `-march=native -ffp-contract=off`),
single `/bestmove` on the start position:

| Box | CPU | NPS @ 1s | Depth @ 1s |
|---|---|---|---|
| **coalla** | AVX-512, 12 cores | ~286k | 16 |
| **lairner (prod)** | AVX-512, fewer cores + less RAM (same instance family) | ~113k | 15 |

Both are AVX-512 boxes — lairner is a smaller instance of the *same* type. A ~2.5× **single-search**
gap is more than fewer cores explains: a single search is single-threaded per pool `Context`, so
core count shouldn't move per-search NPS much. So either lairner's cores/memory are genuinely
slower, or **the lairner build isn't actually using AVX-512** (or an int8/vector path silently fell
back to scalar).

## What to check
1. **Is AVX-512 really in the lairner binary?**
   - `g++ -march=native -dM -E - </dev/null | grep -i avx512` on lairner — does `-march=native`
     even detect it? (VPS CPUID masking can hide it.)
   - `objdump -d /var/www/chessgo/zugzwang/zugzwang | grep -cE 'zmm|vpdpbusd|vpmaddubsw'` vs the
     same on coalla — are wide-vector / int8-dot instructions emitted at all?
2. **Apples-to-apples at FIXED nodes** (not movetime) on both boxes — same binary, same net — for a
   timing-noise-free NPS number (a `bench`-style fixed-node run).
3. **Memory-bound?** The NNUE eval is latency-bound; `perf stat -e cache-misses,instructions` on
   both. A small instance with fewer RAM channels could show a real bandwidth-limited gap.
4. **Contention:** lairner hosts many vhosts + gomachine engine/hub — measure quiet vs under load.

## Outcome
- If the lairner build is missing AVX-512 (CPUID masking → `-march=native` picks a lower ISA, or a
  flag differs): pin the ISA explicitly (e.g. `-mavx512f -mavx512bw …` or `GOAMD64=v4`-equivalent)
  → **free prod speedup**.
- If it's a genuinely weaker/contended box: document the expected prod NPS and fold the speed win
  into [nps-infra-batch.md](nps-infra-batch.md) (hand-written SIMD kernels — zugzwang currently
  relies on compiler auto-vec, unlike gomachine's AVX-512 kernels, which is the bigger lever).

Note: strength is NOT the concern here — the +24.6 vs gomachine was measured at equal *movetime* at
zugzwang's real (lower) NPS, so it out-searches per node. This is purely about making prod analysis
reach a given depth faster.
