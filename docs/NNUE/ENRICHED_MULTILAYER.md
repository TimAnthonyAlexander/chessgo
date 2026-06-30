# Enriched multilayer NNUE — context, status, learnings, and the task

> **Orientation doc for the next phase: getting an *enriched* multilayer NNUE working
> well at movetime.** Reads top-to-bottom; deeper detail lives in `INT8_HANDOFF.md §8`
> (the int8/QAT speed work), `NEXT_ARCH.md` (the architecture plan), `INT8_PORT_SPEC.md`
> (the clean-room int8 forward), and `ENGINE_STRENGTH.md §14–15` (gating + the CCRL anchor).
> Last updated 2026-06-30.

---

> ## ★ OUTCOME UPDATE (2026-06-30 19:30) — RUNG 2 DONE: threats net is now MOVETIME-VIABLE (−330 → v6 parity). All numbers on **prod AVX512 `GOAMD64=v4` (coalla)**.
>
> Took the lean single-layer + threats net (64-sb) from **movetime −330 vs v6 → −8 ± 11 (statistical parity, CI straddles 0)**, eval **+115 fixed depth** (preserved). Two wins, then a wall:
> - **Tail fusion (the big one, ~1.87× NPS + free +40 eval):** the lean tail ran the scalar `screluActivateI16` + a *degenerate* `gemvF32` (nOut=1 → scalar strided gather) = **44% of the node**. Replaced with v6's fused integer `screluDot` over a bucket-contiguous int16 tail (`TWi`, `quantizeLeanTail`, QB=1024). Fixed depth went **+75 → +115** (the integer rounding beats the old float tail — a free eval gain).
> - **int8-FT (`QuantizeFTInt8`, bit-exact, 0 clamps):** halves threat-column memory traffic; the QAT trained the threat weights fully inside int8 range so it's lossless. Wired via `--lean-int8ft`.
> - **REJECTED, measured (do NOT re-try on this baseline):** register-tiling the accumulator apply *regressed −15% NPS* (the 1 KB accumulator is L1-resident, so the "redundant" reloads were free and the per-chunk overhead dominated); enumeration-dedup (compute attacks once, both perspectives) was *NPS-neutral* (the profiler was right: attack-gen is not the bottleneck); in-place make/unmake is *worse* (re-diffing on Pop costs more than the 2 KB copy); **lazy/deferred accumulator** — **measured the wasted-push rate (pushes whose whole subtree never evals) = ~5% midgame / ~14% endgame**, so the ceiling is ~3.5% NPS even on the heavy threats net, eaten by bookkeeping. That's why v6 lazy was −70/−30: **not a bug — the search evals ~95% of nodes it makes.** (`NNUE_LAZY=1 bestmove` prints the rate; counters `nnue.LazyPush/LazyWasted`.)
> - **The floor:** the per-move threat delta is ~22 accumulator columns (vs v6's ~4) and is *intrinsic to the threat encoding* — so pure speed is maxed for 64-sb/512-width. **The lever for a clear win is EVAL, not speed.**
> - **NEXT (running):** a **320-sb retrain** of the *same 512-width* lean+threats net (same NPS, stronger eval; 64-vs-320 → 320-vs-320). Expectation: clearly beats v6 at movetime. Width-1024 is deferred (doubles per-node eval cost; no point while a same-width run is training).
> - **BUILD GOTCHA (cost us time — pinned in CLAUDE.md):** the **arm64** local SIMD build needs **`go1.27rc1`** (`GOEXPERIMENT=simd ~/go/bin/go1.27rc1`). go1.26.4's arm64 `archsimd` is incomplete (missing `BroadcastFloat32x4`/`LoadFloat32x4` etc.); **amd64/prod stays on go1.26.4 `GOAMD64=v4`**. No Go assembly needed — `archsimd` covers the NEON/AVX kernels.

---

> ## ★ OUTCOME UPDATE (2026-06-30 17:00) — read `ENGINE_ROADMAP.md` top block + `ENGINE_STRENGTH.md §16` for the FULL plan/state; this is the short version.
>
> **We built the enriched threats net (multilayer) and learned the decisive thing:
> the EVAL is great, the INFERENCE is the wall.**
> - Threats net: **+149 Elo vs v6 at fixed depth 8** (weight-QAT int8) but **−160 at
>   movetime** — a better eval on a ~13× slower engine. So it's genuinely ~3100 now.
> - **Anchor (lairner): Stormphrax ~410k NPS / 2,440 ns/node (56 MB net) vs our enriched
>   ~110k / 9 µs.** A real 3700 threat-net is only ~3.7× slower than lean (not 13×) and
>   ~3.7× faster than ours ⇒ **our inference is ~3.7× inefficient, fixable.**
> - **The two fixes** (what Stormphrax does, we don't): **(1) real int8 dot via Go
>   assembly** — VPDPBUSD (named, x86) + SDOT (`WORD`-encoded, ARM64); CONFIRMED feasible
>   ~2–3 days, prior art `camdencheek/simd_blog`; `archsimd` lacks int8-dot. **(2)
>   move-aware threat push** (only changed edges, not re-enumerate).
> - **The line to pass is Stormphrax (~3700), not Stockfish** (not a CCRL peer).
> - **One ladder** (v6 = rung 0): threats+single-layer (rung 1, **training now**) →
>   int8-asm + move-aware push (beat v6 at movetime) → width 1024 → king buckets →
>   multilayer tail (+30–50, last, behind int8) → **self-gen data** (ceiling breaker;
>   we currently distill Stockfish = a ceiling). Multilayer was added prematurely; it's
>   the LAST rung, not the first. Single-layer + threats is a legitimate frontier base.
> - **What's training:** `chessgo_lean_threats` (lean single-layer + threats, 64-sb, QAT);
>   gate auto-runs lean-vs-v6 fixed-depth + movetime when `-64` lands.
> - **Process scars:** gate int8 STRENGTH not cp-closeness (5.8cp hid a 150-Elo cliff);
>   weight-QAT (faux_quantise L1 weights, QB=64) recovered +21→+149; the GEMV-tail
>   "reduction overhead" theory was WRONG (real tail cost = the SCALAR pairwise ~2.4µs);
>   the threat push is memory-bound (already incremental). §5 below is now superseded by
>   the ROADMAP ladder.

---

## 1. Why we're doing this

gomachine plays at **≈3260 "dirty" CCRL Blitz**. The open-source NNUE frontier
(Stormphrax, Viridithas ~3700) is **~400 Elo up**, and that gap is **net architecture**,
not Go-vs-C++ (~40 Elo). The shipped eval is **v6**: a single-layer `(768→512)×2→1`
SCReLU net, int16 + SIMD, default-on. It has hit the ceiling of what a single hidden
layer can express — the way forward is a **multilayer** net that the real enrichments
(king buckets, threats, output buckets, width) bolt onto. We built that scaffold; this
doc is about making the *enriched* version of it strong **and** fast enough to ship.

The whole effort is governed by one discipline: **a change ships only if it wins an
SPRT at movetime or fixed depth** (never fixed-nodes — that inflates eval changes;
`ENGINE_STRENGTH.md §14.4`). Eval quality is measured speed-independently (fixed
depth); the real verdict is **movetime on the prod arch (lairner, AVX-512)**.

---

## 2. What we've done — the Elo journey of the bare multilayer

We built **MultiNet** — `768 → 512 → 16 → 32 → 1`, dual-perspective, SCReLU on the
feature transformer, CReLU on the tail — width-matched to v6 so a fixed-depth A/B
isolates the *tail*, not width. Trained ~1 h (64 superbatches) in **bullet** on the M3
Pro. Then the long fight to make it movetime-viable:

| Milestone | Regime | Result | Note |
|---|---|---|---|
| Bare MultiNet PoC (float) | fixed depth 8 | **+102 vs v6** | the eval is genuinely much better |
| same, float scalar tail | movetime 100 ms | **−284** | ~16× v6's per-node eval cost — out-searched |
| + float-tail SIMD | movetime | −214…−255 | **no help** (see §4 finding #1) |
| + int8 L1, int16 accumulator, no-alloc, SIMD activation | movetime | **≈ −90** | eval cost 9.4× → **2.9× v6** |

So after the speed work, the bare multilayer is **fast enough but eval-quality-bound**:
int8 PTQ at fixed depth is only **≈ +15 to +50** (vs the float net's +102) — quantizing
a float-trained net costs ~50–90 Elo. The remaining −90 at movetime is that quality
gap, **not speed**. Two levers close it: **QAT** (train int8-aware — recovers most of
the loss) and **more data / a richer arch** (raises the ceiling). The speed path is
considered solved for now (the per-node eval is ~2–3× v6 and shrinking the gap further
is in the log-regime — diminishing depth returns).

**Where this leaves us:** the bare arch can probably be pushed to ~movetime-positive
with QAT+data, but its ceiling is low. **The Elo lives in the enrichments.** That is
this phase.

---

## 3. The speed toolkit we already have (reuse it)

These are built, bit-exact-gated (scalar / NEON / AVX2 / AVX-512), and carry over to
*any* multilayer variant — enrichment rides on top of them:

- **int16 feature-transformer accumulator** — per-move Push is the same fast int16
  SIMD `addCol`/`subCol` as v6 (the float accumulator's 4 KB copy + scalar delta was
  the single biggest per-node cost; int16 cut it ~12×). Incremental == from-scratch is
  now exact.
- **int8 L1 matmul** — `maddubs` (`VPMADDUBSW` + `VPMADDWD`); activation quantized to
  u8 ∈ [0,127] (so the maddubs pair never saturates → exact). The L1 dot is cheap.
- **SIMD activation** — the SCReLU→u8 quantize, AVX-512 `VPMOVUSDB` (no lane-crossing),
  ~16× over scalar; was the dominant cost before.
- **No per-eval allocation** — reused scratch on the per-searcher stack.
- The **kernel seam** (`kernels.go`) makes adding SIMD backends mechanical: scalar
  reference + build-tagged NEON/AVX2/AVX-512, each gated byte-exact vs scalar.

The Go eval (`internal/nnue/multilayer*.go`) already supports **output buckets**
(`NB>1`: `materialBucket` + per-bucket tail weights) — the importer is the only NB-aware
gap.

---

## 4. Learnings worth not re-deriving

**From the speed work (our own):**
1. **Float-tail SIMD is movetime-neutral vs a same-precision opponent.** SIMD sped our
   tail, but v6's int dot sped up equally, so the eval-cost *ratio* (and thus Elo, which
   is ratio-invariant to absolute speed) didn't move. **int8 is the only lever that
   changes the ratio** (4× the MAC density of fp32; v6's int16 can't densify). General
   rule: to make a heavier-but-better eval out-search a lighter one, lower its
   *precision*, don't just vectorize it.
2. **Most of the empirical movetime recovery came from the accumulator + activation +
   allocation work, not the int8 L1 dot itself** (the dot was never the bottleneck).
   Profile the *whole* per-node path, not the layer you assume is hot.
3. **Quantization scale matters more than it looks:** activation u8 at 127 (not 255)
   makes the `maddubs` pair-sum non-saturating → exact; the pure-int `(c²+round)>>9`
   activation matches `round(SCReLU·127)` and SIMD-narrows cleanly.

**From bullet (the trainer):**
- It has **native QAT** (`faux_quantise` = `round(scale·x)/scale`, straight-through) —
  but it was **broken**: the op lowered to a raw `round()` whose backward was
  `unimplemented!()`, so QAT *panicked*. **We patched the local clone** (STE backward for
  `Round`/`Truncate`). The clone is modified — don't `git reset` it.
- Adding QAT to a config is **two lines** (`faux_quantise` the FT accumulator and the
  activation) and the Go inference needs **no change** — it still reads the float
  `raw.bin` and PTQs it; QAT just makes that PTQ near-lossless. QAT is cheap and should
  ride on **every** future net.
- Conventions: **QA=255** (FT int16), **QB=64** (hidden-layer weights). AdamW's **default
  weight clip ±1.98** is the safety net that keeps per-row PTQ robust — don't widen it.
- **Never early-stop the cosine anneal** — the final anneal is worth ~+220 Elo; the
  lowest-loss mid-run checkpoint is *not* the strongest (loss ≠ strength). Intermediate
  checkpoints are unreliable for strength gating; the **int8-vs-float closeness** check
  *is* anneal-independent and gives an early "is QAT improving quantizability" read.
- Data is `pool.binpack`, `Chess768` inputs, `dual_perspective`; a full run on the M3
  is ~6 h (~1.5 M pos/s, QAT included). `SB` env var drives superbatch count so a smoke
  and the full run share one compile.

**From Stormphrax (the reference — GPLv3; learn the technique, copy no code):**
- Its production net is **enriched**: roughly `((704×16 + threats) hm → 640) ×2 →
  (32×2 → 64 → 1) ×8` — i.e. **king buckets** (per-king-square input transformer),
  **threats** features, **output buckets** (`MaterialCount<8>`), and a richer tail with
  **pairwise** multiplication on the FT, **dual activation** (CReLU‖SCReLU concatenated)
  on the L1 output, and a **skip connection**. That architecture richness is where its
  eval strength — and most of the 400-Elo gap — lives. None of it is an int8 obstacle;
  all of it is a retrain + kernel change.
- int8: **VNNI `VPDPBUSD`** with a `maddubs`+`madd` fallback; activation u8 ∈ [0,255]
  (`kFtQBits=8`). With VNNI the dot accumulates straight to int32 (no pair saturation),
  which is why they can run 255; our portable fallback uses 127. Quant constants for
  reference: `kFtQBits=8, kL1QBits=7, kFtScaleBits=7, kQ=64, scale=400`.
- **Sparsity**: it only dots the *non-zero* FT activation chunks (input-major layout) —
  a ~1.5–2× L1 speedup, relevant only once L1 is wide.

---

## 5. The task (directional — not a spec)

**Goal: a strong, movetime-positive *enriched* multilayer net** — enough to start
genuinely eating into the ~400-Elo frontier gap, shipped default-on like v6.

The shape of the work, not the steps:

- **Enrichment is a ladder, climbed one rung per retrain + gate.** The cheap, certain
  rungs first (output buckets, the Go side is ready), then the big-Elo-but-bigger-build
  rungs (king buckets, threats), then the tail-richness Stormphrax leans on (pairwise /
  dual / skip), with width (→1024, cheap behind int8) and sparsity/VNNI as throughput
  unlocks when L1 grows. Each rung is its **own** train + fixed-depth gate + movetime
  gate; don't stack unvalidated changes.
- **QAT and the speed toolkit ride on every rung** — they're free now. Train int8-aware
  from the start so no rung gives back its eval gain to quantization.
- **Keep the per-node eval near ~2–3× v6.** Enrichment buys eval ceiling at some
  throughput cost; if a rung pushes the eval too heavy, the int8/SIMD toolkit (and, at
  width, sparsity/VNNI) is how you pay it back. Movetime is the only arbiter.
- **Validate cheaply before committing the expensive run:** a ~1 h training + fixed-depth
  A/B says whether a rung is worth a full ~6 h anneal; the closeness check says whether
  the quantization is clean — both before burning the GPU block.
- **The method discipline is non-negotiable:** gate at movetime/fixed-depth (never
  fixed-nodes), measure on the real AVX-512 box, full anneal every time, bit-exact every
  SIMD kernel.

The immediate next move is the first rung — **output buckets + QAT**, trained short and
A/B'd against the bare baseline (the +102 PoC) — then commit the long run to the winner.
Where it goes after that (king buckets vs threats vs tail-richness first) is a strength
question to answer with SPRTs, not to pre-commit here.

---

## 6. Pointers
- Code: `gomachine/internal/nnue/multilayer*.go`, `kernels*.go` (the eval + kernels);
  `cmd/gomachine/bench.go` (`--new-multi … --multi-int8`, the SPRT harness).
- Trainer: `~/nnue-training/bullet/examples/chessgo_ml_*.rs` (PoC, smoke, QAT — the QAT
  config is the template; copy it and add the enrichment). Local bullet clone is patched
  (the QAT STE fix).
- Prod-arch testing: lairner (AVX-512, `~/sdk/go1.26.4`, `GOEXPERIMENT=simd GOAMD64=v4`);
  rsync to a `~/chessgo-simd/` scratch, don't disturb `/var/www/chessgo`.
- Deeper context: `INT8_HANDOFF.md §8` (full speed-work writeup + the bullet bug),
  `NEXT_ARCH.md`, `INT8_PORT_SPEC.md`, `ENGINE_STRENGTH.md §14–15`.
