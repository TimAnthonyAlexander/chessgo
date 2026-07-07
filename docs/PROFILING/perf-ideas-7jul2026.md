# Profiling-driven optimization ideas — 7 Jul 2026

Four ideas surfaced by the 7 Jul 2026 profiling (`docs/PROFILING/amd/7Jul2026.md`
and `docs/PROFILING/arm/7Jul2026.md`), cross-referenced against everything already
tried in this repo and against SF 18 / Stormphrax source.

**Status of byte-identical claim:** only ideas 1 and 3 are byte-identical (pure
speed). Ideas 2 and 4 are search-behavior changes — they reorder operations that
touch global mutable history tables, changing the search tree. Both need SPRT
gating, not just NPS verification.

---

## 1. ARM-only `batchApply` enablement — BYTE-IDENTICAL

**Targets:** `Int16x8.Store` (9.95%) + `LoadInt16x8` (3.90%) + `LoadInt8x16` (6.00%)
= **19.85% combined** ARM load/store overhead.

**What:** The batchApply kernel already exists in `kernels_simd_arm64.go` and is
wired in `init()`. It loads the accumulator once, applies all columns for a tile,
stores once. Won +50% in isolated ARM benchmarks. Lost on amd64 (uop-throughput-bound
at near-peak IPC, ENGINE_STRENGTH.md §30.3) so was set aside. But ARM has no such
ceiling — the narrow 128-bit NEON vectors make per-column load/store the bottleneck,
which batchApply directly attacks.

**How:** Flip the default apply path to use the batch kernel on ARM only, behind the
existing `//go:build arm64` split. Bit-exact and node-identical — pure speed, zero
risk to amd64 prod. Re-measure whole-engine on the 7 Jul mirror-KB baseline first.

**Status:** Deferred (prod is AVX-512; ARM is dev-only).

---

## 2. Try TT move before scoring — NOT BYTE-IDENTICAL (shipped as scaffolding)

**Attempted and failed as a pure NPS win.** Implemented behind `TTMoveFirst` flag
(default-off, `internal/search/params.go`). Showed +6–8% NPS in a midgame benchmark
but failed movetime SPRT (all draws at 100/300/500ms).

**Root cause:** Searching the TT move before `scoreMoves` mutates history tables
that `scoreMoves` reads for the remaining moves → different move-order scores →
different tree. The tree inflates ~3× (125k vs 43k nodes at depth 11 from startpos),
outweighing the NPS gain. Same obstacle as staged movegen (ENGINE_STRENGTH.md §30.2):
global mutable history tables prevent reordering search vs scoring.

**Kept as scaffolding** for deferred quiet scoring (#4). The implementation is
correct and `dbgTTMFFires` confirms the path fires. It needs deferred scoring to
be byte-identical — searching the TT move before scoring only works if scoring
doesn't read mutable state, which requires the #4 restructure.

---

## 3. Pre-packed uint64 scores — BYTE-IDENTICAL

**Targets:** `selectMove` (8.1%).

**What:** Have `scoreMoves` emit packed `(score, index)` uint64 values directly
instead of a `[256]int` array. `selectMove` then becomes a trivial max-scan over
uint64s with no per-element packing in its hot loop. Reduces instruction count on
a branch-miss-bound function.

**How:** Change `scoreMoves` signature to emit `[256]uint64`, pack at score time
(one shift + or per move, amortized). `selectMove` reads the packed values directly.
Same scores, same move order, same tree — pure instruction-count reduction.

**Gating:** Fixed-nodes + movetime SPRT. `PackScores` flag, default-off initially.

---

## 4. Deferred quiet scoring — NOT BYTE-IDENTICAL (search-behavior change)

**Targets:** `scoreMoves` (3.5%) on nodes where a capture cuts before quiets are
reached.

**What:** SF 18 / Stormphrax pattern. Generate and score captures/promotions first,
try them. Only generate and score quiets if no capture causes a cutoff. The history
tables mutate during sibling subtree searches, so deferred scoring reads different
history values than upfront scoring — this is a search-behavior change that needs
an SPRT. This is the enabler that would make #2 byte-identical.

**Gating:** Fixed-nodes + movetime SPRT. `DeferredQuiets` flag, default-off.

---

## Process

Ideas 1 and 3: gate via fixed-nodes SPRT (byte-identical → should read 0) +
movetime SPRT (real-world speed win).

Ideas 2 and 4: gate via fixed-nodes + movetime SPRT as search-behavior changes.
#2 is implemented behind a flag; #4 needs implementation.
