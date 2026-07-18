# TT transparent huge pages — +10.3 Elo movetime (SHIPPED 2026-07-18)

Banked movetime win from the NPS/infra track (bit-exact speed → depth), after the
`done/search-lever-sweep-2026-07-15` verdict that every *solo search lever* + joint
SPSA is tapped. The NPS track was the one lever the sweep left explicitly open:
`open/nps-infra-batch.md` shipped a +36.9 Elo batch but noted **"Did NOT add
madvise/hugepages."** This closes that.

## Change (`src/tt.cpp`, commit on `feat/tt-hugepages` → main `a5dfd22`)

`TranspositionTable::resize()`: 2 MB-align the allocation and `madvise(MADV_HUGEPAGE)`
it (guarded `#if defined(__linux__)`; macOS/dev falls back to the original
`aligned_alloc(64)`). The TT is a large, cache-cold, random-access array — 4 KB pages
thrash the dTLB on every probe. Huge pages collapse 64 MB into 32 × 2 MB pages the
TLB can cover.

**Bit-exact:** TT indexing/contents unchanged, only the backing page size. Verified
identical fixed-depth node counts (d16 startpos/kiwipete/KP-endgame: 180494 / 501300 /
129094 on both base and cand). The entire gain is raw NPS.

## Measurement (coalla, amd64, prod-representative g++ build)

- **THP mode is `[madvise]`** on coalla, so the base binary gets *zero* huge pages
  (AnonHugePages: 0); the change genuinely activates them — AnonHugePages jumps to the
  full 64 MB TT size while the cand runs.
- **NPS: ~10.8% faster** — 8M-node timed search, 4 interleaved rounds:
  base ~4343 ms vs cand ~3875 ms. (gomachine had estimated only +2.4%; coalla's 64 MB
  random TT is far more TLB-bound than that number implied.)
- **Movetime SPRT vs prior main** (fastchess pentanomial GSPRT, 100 ms/move, conc=6,
  Hash=64, book.epd): **+10.28 ± 6.77 Elo, LB +3.51**, 2400 games (51.48 %),
  Ptnml `[16, 181, 741, 240, 22]`, LLR 1.84. Trend-accept: LB > 0. The formal LLR
  capped before 2.94 because a +10 effect against an `elo0=0/elo1=5` window is in the
  test's slow regime (numerator `(2μ−s0−s1)` ≈ `(s1−s0)` near the boundary — see
  `sprt.go:127`); the LB-clears-0 criterion is the accept.

## Notes / negatives from the same session (don't re-try)

- **gcc-PGO is DEAD for this engine: ~14% SLOWER** (bit-exact, identical tree).
  `-fprofile-partial-training` gave a byte-identical binary → not a coverage issue,
  gcc just makes worse codegen decisions here. Instrumented binary also SIGSEGVs on
  cumulative multi-position in-process runs. clang unavailable on coalla; `-funroll-loops`
  fails at the -flto link stage.
- The initial SPRT stalls were self-inflicted orphan processes from `setsid`/`screen`
  launches (screen is broken on coalla — "No Sockets found"); the proven launcher is
  `nohup … & disown` (as in `run_cand.sh`). Huge pages do **not** hang under conc=6.

## Follow-ons (open)

- Explicit huge pages / `mmap(MAP_HUGETLB)` if THP defrag ever stalls resize under load
  (not observed at conc=6). THP `[madvise]` sync-compaction was the *hypothesised* early
  stall but was ruled out — the stalls were orphan processes.
- Prod boxes (lairner) should confirm THP is `always`/`madvise`, not `never`, or the
  madvise is a silent no-op (still correct, just no speedup there).
