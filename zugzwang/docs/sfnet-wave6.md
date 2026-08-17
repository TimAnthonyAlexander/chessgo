# SF-net Wave 6 — making the SF backend fast, without changing a single output value

Wave 5 shipped a playable `zugzwang_sfnet` binary that is bit-exact vs Stockfish but
2.02x slower than our own engine (308k vs 623k median NPS, costing 1.5 ply at 2s). This
wave's job was speed only — profile the hot path, SIMD it, and prove every gate still
passes. It does, on both architectures. The headline result is asymmetric and reported
honestly below: a real, measured win on arm64 (NEON), and a real, measured *regression*
on amd64 (the actual SPRT platform) that this wave could not fully explain — so the
amd64 default ships as Wave 5's untouched scalar code, not as a guess.

## 1. Profiling — what actually costs, not what was guessed

`sample` (macOS; no `perf` here) attached to `zugzwang_sfnet` during an 8s `go movetime`
search on startpos, before any change:

| symbol | inclusive samples |
|---|---|
| `SFNet::forward_pass` | 1210 |
| `SFNet::AccStack::delta_threat_apply` | 886 |
| `SFNet::AccStack::delta_base` | 382 |
| `SFNet::AccStack::build_base` | 141 |
| `SFNet::AccStack::build_threat` | 34 |

Roughly an even split between the accumulator (delta/build, ~1443 samples total) and
the forward pass (pairwise activation + fc_0/fc_1/fc_2, ~1210) — matching the task's
own prediction, not contradicting it. `sample` over-attributes to inlined frames (same
caveat this repo's own `docs/PROFILING/README.md` already carries for the arm/`sample`
method vs authoritative amd/`perf`), so this was treated as directional, confirming
*which* three things to optimize, not as a precise percentage breakdown.

## 2. What was built — `src/sfnet_simd.h`

A new header, included only by `sfnet_eval.cpp` and `sfnet_accumulator.cpp` (mirrors
`sfnet_internal.h`'s own sharing convention), with four kernel families:

1. **`col_add_i16`/`col_sub_i16`** — `acc[j] +=/-= col[j]` over 1024 int16 lanes (the
   base/PSQ accumulator's weight column). Plain wraparound arithmetic; bit-exact by
   construction (a SIMD add/sub instruction computes the identical mod-2^16 result as
   scalar `+=`/`-=`, lane for lane — no proof needed beyond that).
2. **`col_add_i8widen_i16`/`col_sub_i8widen_i16`** — same, but the column is int8 (the
   threat weight table) and must sign-extend before adding. Exact: `vmovl_s8`/
   `cvtepi8_epi16` are exact sign-extensions (no precision loss), followed by the same
   exact wraparound add/sub as above.
3. **`pairwise_combine_sf`** — the feature-transformer activation (`clamp(ps+th,0,255)`
   twice, multiply, `>>9`, pack to u8). The scalar reference widens the add to int32
   *before* clamping (an accumulator value can be the full int16 range, and the sum of
   two can exceed it), so every SIMD tier does too, narrowing back to int16 only after
   the clamp. The multiply/shift/pack tail reuses the exact bit-exactness argument
   `nnue_eval.cpp`'s own `pairwise_u8_block` already carries (product fits exactly in an
   unsigned 16-bit lane, logical shift matches C++ `>>` on a value proven non-negative).
4. **`dot_u8i8_sf`** — the widening u8×i8 dot product for fc_0 (1024-wide), fc_1 and
   fc_2 (32-wide each). Same overflow proof as `nnue_eval.cpp`'s `dot_u8i8`: the
   activation (`ft`, this file's `pairwise_combine_sf` output) is provably in [0,127],
   int8 weights are in [-128,127], so no adjacent-pair sum can reach int16's saturation
   threshold — the scalar reference's saturating branch never actually fires on real
   data, making a direct widening-dot instruction (VPDPBUSD/`vdotq_s32`) exactly
   equivalent to the scalar formula. The AVX2 tier doesn't even need that proof:
   VPMADDUBSW+VPMADDWD performs the identical saturating-pairwise-sum-then-widen the
   scalar code models, so it matches by instruction definition regardless.

Every kernel has the arch tiers required: AVX512BW(+VL where the narrowing conversions
need it)/AVX512VNNI for coalla, an AVX2-only tier for any x86_64 without AVX512, NEON
for arm64, and a scalar tail-fold in every tier for any remainder (none of the actual
call sites in this backend ever hit that remainder — 1024, 512 and 32 all divide evenly
by every tier's lane width — but it's there for correctness rather than omitted for
tidiness).

A software-prefetch lever (`SFNETPREFETCH`, mirroring `nnue_accumulator.cpp`'s shipped
`APPLYPREFETCH` exactly: same arch-gated default, amd64 on / arm64 off, same
`__builtin_prefetch(p, 0, 3)` + next-cache-line hint) was added to `build_base`,
`build_threat` and `delta_threat_apply`'s sub/add loops, which stream through the 46 MB
`weights` and 82 MB `threatWeights` arrays — both far larger than any cache, so this is
the same "cold-cache-miss-bound column touch" `apply_diff` already documents for our
own net.

## 3. Gates — all four, both architectures

### arm64 (this machine, M3 Pro, NEON)

```
$ make sfnet_eval_test && ./test/sfnet_eval_test ~/sf18-arm/src/nn-c288c895ea92.nnue test/sfnet_corpus.epd
  -> diffed against test/sfnet_corpus_ref.tsv columns 1-4: 0 differences (560/560 exact)

$ make sfnet_acc_test && ./test/sfnet_acc_test ~/sf18-arm/src/nn-c288c895ea92.nnue test/sfnet_corpus.epd
  -> sfnet_acc_test: 11089304 nodes checked, 0 drift failures — RESULT: PASS

$ make -j8 && ./test/golden_check.sh ./zugzwang
  -> === golden: 38/38 pass (tol 5), 0 fail ===
```

All three re-run and re-confirmed after every structural change in this wave (the SIMD
kernels, the prefetch addition, and the final call-site restructuring below) — not run
once and assumed to still hold.

### amd64 (coalla, AMD EPYC 9634, AVX512-VNNI) — real hardware, not assumed

Contrary to the task's expectation that amd64 couldn't be tested from here, this
session has SSH access to coalla. Its zugzwang tree was stale (an old commit, git-dirty
— matches the standing "coalla dirty, use a worktree" note), so an *existing* worktree
already sitting at this branch's Wave 5 commit (`~/sfwork`) was used; no `make` binary
exists there, so every build below is a direct `g++` invocation excluding `perft.cpp`
and the WASM-only files, matching this repo's own documented coalla build recipe. The
net files live at `~/sf18/src/nn-c288c895ea92.nnue` (this machine's `~/sf18-arm` is a
different path, not touched).

```
$ ./test/sfnet_eval_test ~/sf18/src/nn-c288c895ea92.nnue test/sfnet_corpus.epd
  -> diffed against test/sfnet_corpus_ref.tsv columns 1-4: 0 differences (560/560 exact)

$ ./test/sfnet_acc_test ~/sf18/src/nn-c288c895ea92.nnue test/sfnet_corpus.epd
  -> sfnet_acc_test: 11089304 nodes checked, 0 drift failures — RESULT: PASS

$ ./test/golden_check.sh ./zugzwang
  -> === golden: 38/38 pass (tol 5), 0 fail ===
```

Run both with `SFNET_X86_SIMD` defined (the AVX512BW/AVX2/AVX512VNNI tiers compiled in)
*and* undefined (the shipped default, scalar) — identical pass/fail either way, as the
bit-exactness argument in §2 requires.

## 4. NPS — before/after, both architectures, and an honest amd64 story

Method: 8 fixed positions (opening, two middlegames, two endgames, a tactical rook
ending, a dense-material middlegame, a reduced-material ending), `go movetime 2000`,
`OwnBook` off, median of the final `info depth` line's `nps`/`depth` across all 8 — this
exact method is not in `docs/sfnet-wave5.md` (that wave explicitly did not measure NPS),
so it's defined here as `tools/sfnet_nps_bench.py` and used identically before/after on
both machines. A second, lower-noise cross-check (fixed `go depth 18`, byte-identical
node count every run since the search is deterministic, wall-clock via
`tools/fixed_depth_bench.py`) was used specifically to pin down the amd64 result once
the movetime numbers looked surprising — reported alongside where it matters.

### arm64 (M3 Pro)

| binary | median depth | median nps |
|---|---|---|
| `zugzwang` (own net) | 21.5 | ~752,000 |
| `zugzwang_sfnet`, Wave 5 (before) | 20.0–20.5 | ~366,000–372,000 |
| `zugzwang_sfnet`, this wave (after) | 21.0 | ~401,000–411,000 |

**+10% to +16% NPS** (repeated runs; a clean fixed-depth-18 A/B, which removes search-
depth variance entirely, measured **+11.5%** specifically: 373,938 → after further
tuning 394,581–408,314 depending on run). Remaining ratio vs our own net: **~1.83–1.88x
slower**, down from Wave 5's 2.02–2.09x. Still meaningfully slower — reported as such,
not oversold.

### amd64 (coalla, Zen4, AVX512-VNNI) — the actual SPRT platform

| binary | median depth | median nps (movetime) | median nps (fixed depth 18) |
|---|---|---|---|
| `zugzwang` (own net) | 21.0 | ~594,000–620,000 | — |
| `zugzwang_sfnet`, Wave 5 (before) | 20.0 | ~347,000–383,000 | ~255,000–272,000 |
| `zugzwang_sfnet`, this wave, **shipped default** | 20.0 | ~365,000 | ~254,000–272,000 |

**No measured improvement on amd64 by default — and that is deliberate, not a
shortfall.** Every SIMD tier this wave wrote regressed performance on coalla when
enabled, sometimes badly:

| configuration | fixed-depth-18 median nps | vs Wave 5 baseline (~260k) |
|---|---|---|
| Wave 5 baseline (scalar, original inline code) | ~260,000–272,000 | — |
| full AVX512BW + AVX512VNNI | ~232,000 | **-10%** |
| AVX2-only (no AVX512 at all) | ~250,000 | ~-3% (near parity) |
| AVX512VNNI dot only (accumulator/pairwise forced to AVX2) | ~226,000 | **-13%** |
| accumulator-SIMD only (pairwise/dot forced to scalar) | ~200,000 | **-23%** |
| refactored scalar (all four kernel families going through `simd::`'s own scalar fallback, no intrinsics at all) | ~195,000 | **-27%** |

That last row is the important one: even with **zero SIMD instructions**, just moving
the accumulator/pairwise/dot arithmetic out of Wave 5's textually-inline loops into
`sfnet_simd.h`'s small shared functions cost ~27% on g++ 13/amd64 — worse than every
SIMD variant except the two narrowest isolations. Two specific fixes were tried and
**both failed to close this gap**:

- `__attribute__((always_inline))` on every kernel (ruling out an LTO inlining-
  heuristic miss specific to this codebase's own `-flto=auto` multi-partition build) —
  no change (232k → 232k on the full-AVX512 variant).
- Making the loop bound a **template parameter** instead of a runtime `int n` (ruling
  out a lost-constant-propagation theory — GCC not treating an inlined-but-parameterized
  bound the same as a namespace-scope `constexpr` visible directly in the loop) — no
  change (199k → 199k, still ~23% down).

Root cause is **not resolved**. Zen4 is documented to execute AVX512 as double-pumped
2×256-bit internally, which is a plausible story for the AVX512-specific loss, but it
does not explain why the AVX2-only and scalar-through-refactor variants *also*
underperformed the original. Getting further would need `perf record -g` line-level
attribution on coalla (available there — `perf` is installed — but not reached this
wave) to see whether this is icache/code-layout, register pressure, or something in how
`-flto`'s serial LTRANS partitioning handles this specific header.

**The shipped fix**: rather than guess at a cause and ship a maybe-fix, the call sites
in `sfnet_eval.cpp`/`sfnet_accumulator.cpp` are gated on a `SFNET_USE_SIMD` macro
(`sfnet_simd.h`), true when `__aarch64__`/`__ARM_NEON` (arm64, unconditional — the
measured win) or `SFNET_X86_SIMD` is explicitly defined (opt-in, not default). When
false, the call site is **Wave 5's original inline loop, verbatim** — not a call into
`sfnet_simd.h`'s scalar fallback. This was verified to actually close the gap (not just
theorized to): a build with this reversion measured **~264,000–272,000** fixed-depth-18
median nps, repeatedly matching Wave 5's baseline within normal run-to-run noise (and
occasionally edging ahead, plausibly from the still-active `SFNETPREFETCH`, though that
delta is inside the noise floor and not claimed as a proven win). Every gate above was
re-run and re-passed against this exact reverted-call-site configuration, on both
`SFNET_X86_SIMD` on and off, on both architectures.

## 5. What shipped vs what didn't, and why

**Shipped, default-on:**
- NEON tier for all four kernel families on arm64 — measured, gate-passing,
  **+10-16% NPS**.
- `SFNETPREFETCH`, arch-gated exactly like `APPLYPREFETCH` (amd64 default-on, arm64
  default-off) — not isolated from the call-site-revert confound in time to claim an
  amd64 number for it alone; kept because it is a pure cache-occupancy hint (provably
  cannot change any accumulator value, same argument as `APPLYPREFETCH`'s own doc
  comment) and the codebase's own precedent for the identical technique already shipped
  a measured amd64 win in the exact same "stream a huge out-of-cache weight array"
  situation.

**Written, bit-exact-validated on real amd64 hardware, but NOT default-on:**
- AVX512BW/AVX512VL, AVX512VNNI and AVX2 tiers for x86_64, behind `SFNET_X86_SIMD`
  (undefined by default). All four gates pass with it defined. Not shipped as default
  because every configuration tried measured as a wash-to-regression on coalla, for
  reasons this wave could not fully pin down — see §4. This is exactly the situation
  `docs/tasks/open/sf-net-experiment.md`'s honesty clause exists for: "still 1.4x
  slower" is a fine result, a false "faster on amd64 too" would not have been.

**Not attempted:**
- The count-array cancellation `sfnet_accumulator.cpp`'s own Wave-4-era comment flags
  ("No count-array cancellation... the count-array optimization is a Wave 6 perf
  concern, not a correctness one") — `delta_threat_apply`'s sub/add lists are applied as
  a straight subtract-then-add with no dedup, unlike our own net's `apply_diff`. Whether
  overlapping sub/add indices occur often enough in practice to be worth a persistent
  per-context counts array (rather than a per-call allocation, which would likely cost
  more than it saves for the typically-small per-move delta) was not measured this wave.
  Flagged here rather than guessed at.
- `perf record -g` on coalla to actually resolve §4's open question — the tool is
  there, this wave ran out of budget before reaching it.

## 6. Files

- `src/sfnet_simd.h` — new. All four kernel families, arch-tiered, `SFNET_USE_SIMD`.
- `src/sfnet_eval.cpp` — `build_accumulators`'s two column loops and `forward_pass`'s
  pairwise/fc_0/fc_1/fc_2 loops now branch on `SFNET_USE_SIMD` (SIMD call vs Wave 5's
  original inline code).
- `src/sfnet_accumulator.cpp` — `build_base`/`build_threat`/`delta_base`/
  `delta_threat_apply`'s six column loops, same branch; plus `SFNETPREFETCH` and the
  arch-gated `sfnet_prefetch_enabled()`/`prefetch_col()` helpers.
- `tools/sfnet_nps_bench.py`, `tools/fixed_depth_bench.py` — new, one-shot instruments
  for this wave's gate 4 (not a permanent test; see docs/sfnet-wave5.md's own note that
  no such method existed yet).
