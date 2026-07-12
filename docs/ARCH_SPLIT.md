# Arch-split optimizations (gomachine is fast on ALL arches, not just prod)

gomachine is **open-source** — most people who build and run it are on **arm64 Macs**, not
our amd64 (AVX-512) prod box. Optimizing only for prod is the wrong lens. Some speedups are
**arch-specific**: a change that wins on arm can be flat or negative on amd64 and vice-versa
(the two have very different bottlenecks — narrow 128-bit NEON load/store vs. compute/
throughput-bound Zen4 AVX-512). So we **split** those: each arch gets the code that's fastest
*for it*, gated at compile time.

## The rule

- **Gate arch-specific optimizations with a build-tag const**, not a runtime flag. Pattern:
  a `const useX = true` in a `*_arm64.go` file (`//go:build arm64`) and `false` in a
  `*_generic.go`/`*_other.go` (`//go:build !arm64`). The call site branches on the const, so
  the other arch's path is compile-time dead code — **provably byte-identical to before** on
  that arch, zero regression risk.
- **Each optimization records its per-arch verdict** (measured, not assumed). A change is
  arch-split only when it's measured *win on one arch, flat/loss on the other*.
- These are **byte-identical / node-identical** (pure speed, same search tree) → the gate is
  an **NPS delta**, not a strength SPRT. Correctness is proven by the bit-exact tests
  (`TestEnrichedMoveAwareBitExact` etc.) which run on whichever arch compiles the path.

## Measurement discipline (learned the hard way)

- **arm** is measured on **this M3** with the **SIMD build**:
  `GOEXPERIMENT=simd ~/go/bin/go1.27rc1 build -o bin/x ./cmd/gomachine`, then
  `KB_NET_PATH=data/nnue/kb-mirror.bin ./bin/x bench nps-ft` (grep `int16` medianNPS).
- **amd64** is measured on **coalla** with `GOEXPERIMENT=simd GOAMD64=v4 ~/go/bin/go1.26.4`.
- Alternate BEFORE/AFTER, **one bench at a time** (competing benches skew the median), 3+ reps.
  Node counts MUST be identical (proves node-identity).
- **★ Measure arm on the SIMD build, NOT scalar.** The plain `go build` (no `GOEXPERIMENT`)
  produces a *scalar* binary whose bottlenecks differ from the real arm deployment (SIMD).
  A change measured **+1.5% on scalar-arm was FLAT on SIMD-arm** (see computeDelta below) —
  because with SIMD eval the accumulator dominates and a saved scalar op is noise. The real
  arm deployment is SIMD; measure that. (Companion lesson to [[arm64-vs-amd64-speed-divergence]]:
  there's a scalar-vs-SIMD divergence *within* arm, not just arm-vs-amd64.)

## Current splits & findings

| Optimization | arm64 SIMD | amd64 SIMD | Status |
|---|---|---|---|
| **NEON int8 tail dot** (`dotU8I8SIMD`, `kernels_simd_arm64.go`) — vectorize the int8 L1 matmul (`evalFromHalvesInt8`), reproducing AVX2 VPMADDUBSW+VPMADDWD maddubs saturation bit-for-bit via widen-multiply-pairsum (NEON has no VNNI/UDOT in archsimd). Was the ONLY hot kernel still scalar on NEON — `dotU8I8Scalar` was **51% of the arm profile**. | **+80% whole-engine NPS** (~227.5k→~410.7k medianNPS int16-threatFT, node-identical, 3 reps, byte-exact) | untouched — amd64 never compiles `//go:build arm64`; keeps its VNNI `VPDPBUSD` path | **SHIPPED arm64-only** (2026-07-12), gated `useNeonDotU8I8` — the single biggest arm win to date |
| **int16 batch-apply kernel** (`applyBatchI16`, `kernels_batch_i16_arm64.go`) — load acc tile once, apply all changed int16 threat columns, store once (vs per-column load/add/store) | **+2.9–3.0% NPS** (byte-exact, node-identical) | measured WORSE (compute-bound, ENGINE_STRENGTH §30.3) — keeps per-column | **SHIPPED arm64-only** (`bd31529`), gated `useI16Batch` |
| computeDelta child-board reuse (drop redundant per-eval DoMove) | **FLAT** on SIMD-arm (−0.1%) — the +1.5% was a **scalar** artifact | flat/−2% | **DROPPED** — not worth the complexity on either arch (scalar-vs-SIMD lesson above) |
| int8 batch-apply (`applyThreatBatchSIMD`, amd64) | (int8-FT only; prod net is int16-FT so inert) | measured WORSE on amd64 | amd64 kernel exists, gated off for prod |

## Existing arch-split infrastructure (predates this doc)

- `kernels_simd_amd64_v4.go` (AVX-512) vs `kernels_simd_arm64.go` (NEON) — the accumulator
  add/sub column kernels, split by arch.
- `dotu8i8_vnni_amd64.{go,s}` — VNNI int8 dot (amd64 only; NEON has no VNNI, uses a scalar/
  widen path — this is the 51%-on-arm `dotU8I8Scalar` in the arm profile, a known arm-dev
  artifact, not prod).
- `prefetch_amd64.go` / `prefetch_other.go` — PREFETCHT0 on amd64, no-op elsewhere.

## Adding a new arch-split optimization (checklist)

1. Implement behind a `const useX` build-tag split; the *other* arch keeps the existing path
   unchanged (dead code, byte-identical).
2. Gate: `go build ./...` (native) + `GOOS=linux GOARCH=amd64 go build ./...` both clean;
   `TestEnrichedMoveAwareBitExact` + relevant equiv tests GREEN (bit-exactness — mandatory for
   hand SIMD); perft green; Go↔Rust threat crosscheck green (if it touches the accumulator).
3. Measure NPS on the target arch's SIMD build (arm→M3 go1.27rc1, amd64→coalla go1.26.4),
   alternating one-at-a-time, node counts identical.
4. Ship only on a clear NPS win (>~1.5% over noise) for that arch; the other arch stays
   byte-identical. Flat → don't ship (like computeDelta). Record the verdict in the table above.
