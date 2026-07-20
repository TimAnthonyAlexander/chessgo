# zugzwang CPU profiling

Dated flat CPU profiles of the engine, per arch. Mirrors the layout of the retired
`gomachine/engine/docs/PROFILING/`.

- **`amd/`** — Linux `perf` on coalla (amd64, AVX512-VNNI). **Authoritative** — prod is amd64,
  and movetime/Elo decisions are made here.
- **`arm/`** — macOS `sample` on the M3 dev box (arm64, NEON). Coarse cross-check only; `sample`
  over-attributes to inlined recursive frames, so trust `amd/` for magnitudes.

Latest: **`amd/20Jul2026.md`** (post-LAZYACC). Headline: the NNUE accumulator
(`apply_diff` 26.9% + `changed_edges_delta` 13.2% + `eval_from_halves` 10.0%) dominates node
time; `apply_diff` is bandwidth-bound on int16 threat columns.

## How to regenerate (amd)

```sh
# on coalla, at the commit you want to profile:
cd ~/chessgo/zugzwang
SRCS=$(ls src/*.cpp | grep -v perft.cpp)
g++ -std=c++17 -O3 -flto -DNDEBUG -march=native -ffp-contract=off -fno-omit-frame-pointer \
    -pthread -o /tmp/zug_prof $SRCS
# batch of `position … / go depth 18` lines in /tmp/pc.txt, then:
perf record -q -g -o /tmp/zp.data -- /tmp/zug_prof < /tmp/pc.txt
perf report -i /tmp/zp.data --stdio --no-children -g none | grep -v '^#' | head -25
```

Toggle `LAZYACC=0/1` (or any other default-off flag) on the same binary to compare — the search
is byte-identical, so only the profiled cost distribution changes.
