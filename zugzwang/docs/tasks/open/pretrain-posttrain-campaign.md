# Elo Campaign — Pre-Train / Post-Train Master Doc

> **Hard constraint this doc is built around:** the NNUE retrain is **not until August**
> (>1 week out) and the training slot is scarce. Until then we do **only** work that gains
> Elo **on the current net**. Everything that needs a new net is documented here in full and
> then **sits untouched** — no trainer-side code, no inference prep for features that have no
> net to validate against.
>
> **Two sections:** **Pre-Train** = actionable now, no new net. **Post-Train** = gated on the
> August retrain.
>
> **Claim tags:** every causal/factual claim is marked **`[OBS]`** (observed — read directly
> in source, file:line given) or **`[INF]`** (inferred — deduced, not directly read). "SF
> stores X in Y" is `[OBS]` if read; "therefore we should do Z" is `[INF]`.
>
> **Source trees:** SF = `/Users/tim.alexander/sf18-arm/src` (tag `sf_18`, commit `cb3d4ee9`,
> **SFNNv10 era**). zug = `/Users/tim.alexander/chessgo/zugzwang/src`. Finny + sparse-affine
> are both in the tagged tree (fully sourceable locally). **SFNNv14/15/16 and PP_3Wide are NOT
> in this tree** — anything about them is upstream report, labeled `[UPSTREAM]`, not our source.

---

## Net architecture (reference — used throughout) `[OBS]`

From `zug/nnue_arch.h:8-32`:

| Const | Value | Meaning |
|---|---|---|
| `InputDim` | 768 | 2×6×64 one king-bucket |
| `NumKingBuckets` | 16 | |
| `PsqSize` | 12288 | `16×768`, also the threat-feature offset |
| `ThreatBlock` | 79856 | SF full-threats index space |
| `InputTotal` | 92144 | FT input width (`PsqSize+ThreatBlock`) |
| `H` | **512** | FT hidden width per perspective (256/perspective ×2) |
| `D2` | 16 | tail L1 width |
| `D3` | 32 | tail L2 width |
| `NB` | 8 | output buckets |
| `int8QA` | 127 | u8 activation ceiling |
| `L1QB` | 64 | int8 L1 weight scale |

Threat FT is **int16** (`W0i`, same table as base features, `nnue_net.h:11-12`). SF's big net
is L1=**1024** for comparison (`SF/nnue_architecture.h:43`). **Our L1 is half SF's width** — a
recurring gate for the sparse-affine item.

---
---

# PRE-TRAIN — actionable now, current net

---

## P1. Finny tables (AccumulatorCaches)

**What it is (1 line):** A per-(king-square, perspective) cache of the FT accumulator + the
board snapshot it was built from, so an own-king move refreshes by diffing against the cached
snapshot instead of rebuilding the accumulator from scratch.

### Mechanism `[OBS]` (SF `nnue_accumulator.h:61-106`, `nnue_accumulator.cpp:670-822`)

- **Data structure:** `Cache<Size>::Entry { std::array<BiasType,Size> accumulation;
  std::array<PSQTWeightType,PSQTBuckets> psqtAccumulation; std::array<Piece,SQUARE_NB> pieces;
  Bitboard pieceBB; }`. Entries indexed `[SQUARE_NB][COLOR_NB]` = **64×2 = 128 entries** per
  net, keyed by the **exact king square** (not an abstract bucket) and perspective. Two caches
  per struct: `big` (Size=1024) and `small` (Size=128). One `AccumulatorCaches` **per search
  thread** (`SF/search.h:363`), persists across the whole game, re-cleared only at construction
  and `ucinewgame` (`SF/search.cpp:609`).
- **What is stored:** the cached FT activation sums (`accumulation`, int16), the PSQT head
  (`psqtAccumulation`, 8×int32), a **64-slot mailbox** of the board as of last refresh
  (`pieces`), and a **single combined occupancy** bitboard (`pieceBB`). **NOT** per-piece-type
  or per-color bitboards — one flat mailbox + one occupancy.
- **Diff/refresh** (`update_accumulator_refresh_cache`): (1) look up `cache[ksq][perspective]`;
  (2) `changedBB = get_changed_pieces(entry.pieces, pos.piece_array())` — a **byte-wise SIMD
  compare of the whole 64-square mailbox** (old snapshot vs current), returning every square
  whose occupant differs; (3) `removedBB = changedBB & entry.pieceBB`, `addedBB = changedBB &
  pos.pieces()` (a capture square appears in both → remove-old + add-new pair); (4) build
  feature index lists via `make_index(perspective, sq, piece, ksq)` using **old** pieces for
  removed, **new** for added, same current `ksq`; (5) overwrite `entry.pieces/pieceBB` to
  current; (6) apply paired ±weight column updates (`fused<Add,Sub>`) to `entry.accumulation`,
  store into **both** the entry (persist) and the live accumulator.
- **Trigger** (`SF/half_ka_v2_hm.cpp:65-67`): `requires_refresh` fires on **any own-king move**
  (`diff.pc == make_piece(perspective, KING)`) — NOT only bucket crossings. The per-square
  keying means "did the bucket change" is never asked; every king move re-indexes
  `cache[newKsq]`, which may already be warm from an earlier visit (the whole point:
  memoize per-king-square work across repeated tree visits).

### PRE-CHECK #2 (measured, definitive) `[OBS]`: **Finny covers ONLY the PSQ half, NOT threats.**

The cache and `update_accumulator_refresh_cache` are hard-typed to `PSQFeatureSet`
(`SF/nnue_accumulator.cpp:671-675`). The threat half is handled by a **cache-free**
`update_threats_accumulator_full` (`SF/nnue_accumulator.cpp:824-922`) — takes no cache arg,
does an `O(#active threat features)` from-scratch recompute every time, triggered by a
mirror-side flip (`FullThreats::requires_refresh`, `SF/full_threats.cpp:331-333`:
`(int8_t(diff.ksq) & 0b100) != (int8_t(diff.prevKsq) & 0b100)`). SF's own reference **does not
extend Finny to threat features.**

**Consequence `[INF]` (corrected cost model):** Finny caches only the base (PSQ) half; threats
stay a full recompute exactly as SF does. But "threat-dominated" by **index-space** (79856 vs
12288) is the **wrong model** — refresh cost is `#active_features × H`, and active threats
(~128–256) vs active PSQ (~piece count, ~32) is ~4–8× **per event**; the dimension ratio agreeing
at ~6.5× is coincidence. Crucially the two halves fire at **different frequencies, cutting the
opposite way from per-event cost**: the half Finny **can** cache (PSQ) refreshes on **any own-king
move**, while the half it **can't** (threats) refreshes only on a **mirror-flip** (a subset of
king moves). So the cacheable event is the *more frequent* one — Finny is **less** capped than
"threat-dominated" implies. → **Respecified follow-up:** don't estimate "share of cost" — **count
refresh events by type (PSQ vs threat) and time each** on coalla; the product (PSQ-event frequency
× per-event base cost) is Finny's actual ceiling, and it gates whether P1 is worth the code.

### zug current state `[OBS]`: **LACK.**
From-scratch rebuild on bucket/mirror crossing — `zug/nnue_accumulator.cpp:416-464`
(`push_delta`: `if (refreshW) { enumerate_flat(...); build_half(...); }`), `build_half` at
`:156-160` (bias + full feature re-sum, no cached reuse). Only "Finny" mention is a comment
contrasting with SF (`zug/nnue_accumulator.cpp:88-90`). LAZYACC/LAZYACC2/ACCFUSE are separate
(deferred-apply/fusion, not caching) and are **default-ON** despite stale "default OFF" header
comments (`zug/nnue_accumulator.cpp:24,42-53`).

- **Retrain dependency:** **NONE** — pure inference restructuring, byte-identical eval output.
- **Validation cost:** **bench-only** (NPS on coalla/amd64 + arm64) **after** a correctness
  gate; **no games** to decide keep/drop a byte-identical speedup. But see risks.
- **Risks / failure modes:**
  1. **"Output-identical" is intent, not property** — a cache bug produces silently-wrong
     evals, not a crash. SF's own threat-update code "has twice been the source of wrong
     benches." **Mandatory correctness gate:** assert-equal vs the full-refresh path across a
     large FEN set **dense in king-bucket crossings + castling** (where stale cached bitboards
     break). We already have the harness shape (`NNUE_ASSERT` drift check,
     `zug/nnue_accumulator.cpp:612-618`) — extend it, don't invent it.
  2. **Bench mix under-measures Finny** — the whole benefit is king-move frequency; a standard
     bench has few king moves/position. Build a **king-active** bench set or the NPS delta reads
     near-zero even if the win is real.
  3. **Partial-fix ceiling** (pre-check #2) — threats uncached, so upside is the PSQ-refresh
     share = (own-king-move frequency × per-event base cost). Measure it (the respecified
     follow-up); do **not** assume it's small — the cacheable PSQ event is the *more frequent* one.

---

## P2. Sparse-affine L1 / nnz

**What it is (1 line):** Skip all-zero 4-wide input blocks of the clipped-ReLU FT output when
computing the first dense layer, turning an `O(inputs×outputs)` matmul into
`O(nnz_blocks×outputs)`.

### Mechanism `[OBS]` (SF `nnue/layers/affine_transform_sparse_input.h`)

- Applies to `fc_0` only (`SF/nnue_architecture.h:66`), input = FT clipped `u8` output
  (mostly zero after ReLU). Input `u8[]` is reinterpreted as `int32[]` — each int32 packs **4
  consecutive u8 inputs** = the sparsity unit ("block sparse").
- **`find_nnz`** (`:80-169`): for each chunk of 8 blocks, `vec_nnz(chunk)` builds a bitmask of
  nonzero lanes (ISA-specific: AVX512 `cmpgt..._mask`, AVX2/SSE `movemask`, NEON manual
  masked-sum). The 8-bit `nnz` mask indexes a **compile-time `constexpr` lookup table**
  `Lookup.offset_indices[256][8]` (4 KB, `:51-70`) that maps each mask → the list of set-bit
  positions, front-packed. `base` (running +8 offset) is vector-added to get global indices,
  stored to `out[]`, `count += popcount(nnz)`. AVX512(ICL) instead uses hardware
  `maskz_compress_epi8/16` (`:107,129`); the lookup table is the **fallback for ISAs without a
  compress instruction**.
- **Sparse dot** (`:339-347`): `while (start<end) { i=*start++; in=vec_set_32(input32[i]);
  col=&weights[i*OutputDimensions*ChunkSize]; for k: vec_add_dpbusd_32(acc[k], in, col[k]); }`
  — weights stored **pre-transposed** so one input block's whole output column is contiguous;
  `vec_add_dpbusd_32` = `vpdpbusd` under VNNI, else `maddubs+madd+add`. Accumulators seeded from
  `biases`; zero blocks contribute nothing (correctness holds). A 3-way-unrolled VNNI variant
  (`:311-338`) breaks the dpbusd dependency chain.

### PRE-CHECK: is it AVX512-gated? **No** `[OBS]`.
Whole mechanism guarded by `#if (USE_SSSE3 | (USE_NEON >= 8))`
(`SF/affine_transform_sparse_input.h:39,193,253`). Works on plain SSSE3 / AVX2 / any ARMv8
NEON; AVX512 is only a faster `find_nnz`/wider accumulator. **Pays on our prod amd64 (no AVX512
needed) and arm64.** My earlier "needs AVX512" was wrong — that was PP_3Wide's intrinsic.

### PRE-CHECK #1 (the gate) — zero fraction of our fc_0 input: **MEASUREMENT PENDING** ⚠️

Sparse only pays if the input array is mostly zero **and** the zeros cluster into 4-wide blocks,
**and** the index-gather overhead amortizes over enough elements. Three reasons this is a hard
gate for us specifically:

1. **Our width is half SF's** (H=512 vs 1024). The `find_nnz` + gather bookkeeping is fixed
   overhead amortized over fewer elements → the sparse crossover is **less favorable** at 512
   than at 1024. `[INF]`
2. **SF engineers block-sparsity via weight permutation** — the origin commit (`38e61663`,
   2023) ships "a net with reordered weights, to increase the likelihood of block sparse
   inputs." `[OBS from git log]` So block-sparsity is **partly trained-in, not purely emergent
   from ReLU** — our net was **never** permuted for it, so even a high *scalar* zero fraction may
   not yield a high *4-wide-block* all-zero fraction. `[INF]`
3. Therefore the metric that gates the port is the **4-wide-block all-zero fraction of `aq[]`
   at H=512 on our current net**, not the scalar zero fraction.

**Measurement status: DONE (2026-07-24)** `[OBS, measured]` — throwaway instrument at the `aq[]`
fill, 1.58M eval calls over a depth-16 in-search mix (net confirmed loaded, tree reverted clean):
- **4-wide-block all-zero: 49.9%** — only ~half the L1 dot blocks are skippable as-is.
- **scalar-zero: 83.9%** — nonzeros are spread across blocks, not clustered.

So a naive sparse port skips ~50% of L1 blocks at H=512 (not the 84% scalar would imply) —
**marginal**, and the gather overhead amortizes over half SF's width. **But the gap between 50%
block-zero and 84% scalar-zero is the permutation headroom:** clustering the ~16% live lanes
4-per-block could push block-zero toward ~96%. So P2's real form is **permute-then-sparse**, not
naive-sparse. Whether *either* pays is now gated only on the fresh profile's L1-dot share.

**Exact measurement procedure (specified, not run):** `aq[]` is a stack-local `uint8_t[H]` in
`eval_from_halves` (`zug/nnue_eval.cpp:413,424-438`), filled fresh per call, consumed by
`dot_u8i8` at `:446`. Add `thread_local uint64_t g_blkZero=0, g_blkTot=0;`, and immediately after
the `aq[]` fill (`:438`, both `pairsimd_enabled()` branches converge there) loop over the 128
4-wide blocks (`for b in 0..H/4: if (*(uint32_t*)(aq+4*b))==0) ++g_blkZero; g_blkTot += H/4;`).
Also count scalar zeros for reference. Drive it via the `eval` UCI command over a FEN set
(`position fen … / eval` per line) for a from-scratch distribution, **and** via `bench`'s depth-12
loop for the in-search (incremental-path) distribution — the in-search mix is what matters. Report
both block-zero and scalar-zero fractions. **Decision rule `[INF]`:** if the block-zero fraction
is comfortably above the dense/sparse crossover at H=512, port directly. If it is weak, that does
**not** kill P2 and does **not** push it Post-Train — it spawns a **retrain-free pre-train task:
compute our own permutation** (collect per-neuron nonzero-frequency stats, cluster
frequently-live units into shared 4-wide blocks, permute FT units + `fc_0` rows
pair-consistently, verify byte-identical eval), then re-measure the block-zero fraction on the
permuted net.

### zug current state `[OBS]`: **LACK (dense).**
`zug/nnue_eval.cpp:440-448` — `dot_u8i8(aq, L1W+o*H, H)` over full width for every output, no
zero-skip/gather. DOTSPLIT/PAIRSIMD are dense throughput opts (`:42-46,59-66`).

- **Retrain dependency:** **NONE.** Porting the kernel is retrain-free — **and so is
  manufacturing the sparsity.** A permutation of the FT hidden units with the matching
  permutation of `fc_0`'s input weight rows is **output-identical** (integer dot = reordered
  summation, exact) — an offline transform on the *current* net, no retraining. **Constraint
  `[INF]`:** the pairwise activation pairs unit `i` with `i+H/2` (PAIRSIMD, `nnue_eval.cpp:424-438`),
  so the permutation must map pairs→pairs or it is not identity-preserving.
- **Validation cost:** **bench-only** (NPS) once pre-check #1 clears; correctness is structural
  (bias-seeded, zeros contribute 0) but still assert-equal vs dense over a FEN set.
- **Risks:** (1) pre-check #1 fails at H=512 → port is net-negative (gather overhead > skipped
  work); (2) weight layout — the sparse path needs weights pre-transposed to our block layout,
  a nontrivial one-time repack of `L1W8`; (3) our int8 L1 (`L1QB=64`) vs SF's — confirm the
  dpbusd descale (`L1Inv=1/8128`) survives the reorder.

---

## P3. Output-layer SPSA on the current net

**What it is (1 line):** SPSA-tune the small output-side layers' weights/biases of the *existing*
`.nnue` directly (no GPU, no retrain), ship the perturbed net if it passes.

### Mechanism `[OBS] + [INF]`
- SF architecture (`SF/nnue_architecture.h:43-71`, `network.h:105`): `LayerStacks=8` buckets,
  each with `fc_0` (FT→L2=15+1), `fc_1` (L2*2→L3=32), `fc_2` (L3→1). Parameter surface for the
  648-param tune `[INF from OBS dims]`: `fc_2` = 32 weights + 1 bias per bucket → **256 output
  weights + 8 output biases**; `fc_1` biases = 32×8 = **256**; `fc_0` biases = 16×8 = **128**.
  Total **648** — matches SFNNv9's reported surface (output weights + all three bias layers).
- **No in-source hook** `[OBS]`: `grep` for `TUNE`/`SPSA`/`set_parameter`/net-weight overrides
  across SF finds nothing wired to `NetworkArchitecture`. `tune.h` is the generic *search-const*
  tuner only. The only net control is whole-file `EvalFile` selection (`SF/engine.cpp:139-300`),
  which deserializes an opaque blob via `AffineTransform::read_parameters`
  (`SF/affine_transform.h:167-173`).
- **Therefore the workflow is external tooling** `[INF]`: a script opens the `.nnue` binary,
  seeks to the `fc_2`/`fc_1`/`fc_0` weight/bias byte regions (reimplementing the
  `read_parameters`/`get_weight_index` layout), perturbs them on an SPSA schedule, writes a new
  `.nnue`, and points a normal SPRT harness at `EvalFile=<perturbed>`. **Snapshot mid-run** — SF
  shipped #5459/#5632 at **12k and 38k** of a 120k budget, not at convergence.

### zug current state `[OBS]`: **LACK (never done).**
Entire tune surface is search constants (`zug/search.cpp` `Tune` struct; `spsa/tune.py` sets
`CAPTHIST_PARAMS`/`MARGIN_PARAMS`/`LMRCLUSTER_PARAMS`/`HISTMARGIN_PARAMS`/`NEWPARAMS` — all
search). No mechanism exposes net weights. Our net loader treats `.nnue`/`kb-mirror.bin` as an
opaque blob.

- **Retrain dependency:** **NONE** — operates on the current net's bytes. This is the **only
  retrain-free net-improvement lever.**
- **Validation cost:** **SPSA is its own harness** (not a single SPRT) — thousands of
  self-play games across SPSA iterations; snapshot candidates then confirmed with one SPRT under
  wide bounds. Budget like SF: O(10k–100k) SPSA games, but ship at a **mid-run snapshot**.
- **Risks:** (1) we must reimplement **our** `.nnue` layout offsets exactly (int8 L1 `L1W8`,
  float `L1B`, the D2/D3/NB tail) — a wrong offset silently corrupts the net; write a
  round-trip test (parse→re-emit→byte-identical) first; (2) our tail is int8-L1 + float-tail,
  different quantization than SF's — perturbing int8 weights needs care (clamp to ±127, respect
  `L1QB` scale); (3) overfitting to the tune book → confirm on a disjoint SPRT book.

---

## P4. SPRT uncapping + bounds selection

**What it is (1 line):** Stop running fixed-N capped batches; run sequential SPRT to an LLR
decision with bounds **sized to our below-frontier regime**, not SF's frontier bounds.

### Mechanism / rationale `[OBS our side] + [INF]`
- **Current policy `[OBS]`:** cap-800 / cap-1600 "trend-accept" batches (per the July campaign
  log and `coalla-sprt-workflow`). A capped SPRT that hits the cap without an LLR decision **is a
  fixed-N test** — Defect A ("N too small to resolve ±3 at any TC").
- **Bounds are the real lever, not just uncapping `[INF]`:** SF uses `<0.00,2.00>` STC /
  `<0.50,2.50>` LTC **because SF is at the frontier** (+1.5 is a good day) — those bounds are
  *why* SF needs 300k–500k-game tests (corrplexity-futility #5748: **545,504** STC; contcorrhist:
  **310,144**). **Copying SF's bounds is the same category error as copying its search
  constants.** But wider bounds are a **filter, not a universal speedup**: `<0,5>` tests H0:0 vs
  H1:5, so a **true +2 patch fails more often than it passes** — wide bounds resolve *large*
  effects fast and deliberately **discard real medium gains** to buy that resolution. That is
  exactly why P5 exists: **bundle small correlated gains into one large one** that wide bounds can
  see. Pick bounds from a **target effect size**; do not widen blindly.
- **TC is a *separate, narrow* axis `[INF]`:** long TC is justified **only** for changes with a
  measured **NPS cost** (SFNNv13/v16 failed STC and shipped on LTC *because* they trade speed for
  accuracy — v16 −3.5% NPS, v13 doubled L2). NPS-neutral changes (corrhist margins, extension
  terms) do **not** need long TC; SF passes them at STC on huge N. At fixed compute, moving
  100ms→LTC costs vastly more games/test, so doing it **without** fixing N/bounds makes
  resolution **worse**.

### Strategic note (the deepest point) `[INF]`
If the entire candidate pool is ±1–3 Elo, we are **mining SF's marginal frontier, not our own
deficit** — 40 washed flags in one campaign is what that looks like from the inside. The
**right model is deficit-mining**, and we have a precedent in our own history: **HCEBLEND** was a
>±3 win found by identifying *our* specific pathology (net hangs pieces when losing), not by
porting an SF margin. Method: differential-test vs a stronger engine, categorize where **we
specifically** lose, fix that class. The dormant-flag bundle (P5) is the near-term stopgap; this
is the actual direction.

- **Retrain dependency:** **NONE** — harness policy change.
- **Validation cost:** meta — this *is* the validation policy. No games to "test" it; it changes
  how every other item is tested.
- **Risks:** (1) wide bounds **reject true medium gains** (a real +2 fails under `<0,5>`) — that
  is the price of resolution; size bounds to the target effect and use P5 bundling to lift small
  correlated gains above the lower bound; (2) uncapping a genuinely sub-±1 effect random-walks
  near LLR 0 for tens of thousands of games — there is no free lunch, which is exactly why P5
  (bundle to a resolvable aggregate) exists.

---

## P5. Dormant SF-exact bundle (CORRVARIANTS + CORRMARGIN + triple-ext corr term)

**What it is (1 line):** Three already-implemented, SF-weight-exact, default-off correction terms
tested **as a correlated bundle** so a +4–6 aggregate is resolvable where six +1s are not.

### Components — all present in zug, dormant `[OBS]`

**(a) CORRVARIANTS** — minor-piece + continuation corrhist. `zug/search.cpp:58-72` (weights),
`:1018-1019` (tables `corrHistMinor[COLOR_NB][CORR_SIZE]`, `corrHistCont[CONT_PIECE_NB][SQUARE_NB]`),
`:1315-1323` (cont term: ss-2 tap num 127, ss-4 tap num 59, fallback 8), `:1329-1341` (blend, gated
`if (C.tune.corrVariants)`), `:1430-1451` (update). Gate `:101` `bool corrVariants=false`. Weights
`CORR_W_MINOR=8821`, `CORR_W_CONT=7841` — **exact SF match** (`SF/search.cpp:80-94`:
`10347*pcv + 8821*micv + 11665*(wnp+bnp) + 7841*cntcv`).

**(b) CORRMARGIN** — corrplexity in RFP + LMR. `zug/search.cpp:2273-2286` (RFP:
`|correction_raw|/174665` widens the margin), `:2750-2758` (LMR: `r -= |correction_raw|/30370`).
Gate `:247` `bool corrMargin=false`, `corrMarginDiv=30370` `:767`. Divisors **exact SF match** —
SF futility_margin uses `/174665` (`SF/search.cpp:884`), SF LMR uses `/30370` (`SF/search.cpp:1197`).

**(c) triple-ext corr term** — see P6; SF's `tripleMargin` includes `-corrValAdj`
(`|correctionValue|/230673`) which zug's bare-constant triple margin lacks.

### zug current state: **DORMANT** (a,b), **absent term** (c). Already written for (a,b).

- **Retrain dependency:** **NONE** — all search-side arithmetic.
- **Validation cost:** **games.** Bundle under **`<0,5>` bounds** (per P4): a +4–6 aggregate
  → few thousand games; the six-singletons approach is unresolvable (each ±1 < noise floor).
- **The bundling loop must be *complete* `[INF]`:** (1) test the bundle for aggregate signal;
  (2) if it passes, **strip components back out one at a time** under non-regression bounds
  (`<-1.75,0.25>`, SF's simplification-test bounds) to recover per-component sign — otherwise a
  passing bundle is dead code with an unknown-sign interior; (3) **never strip two correlated
  components in the same test** — that is exactly the #5978/#5992/#6002 mistake (two individually-
  neutral correlated simplifications stacked into a real loss, then #6002 re-added ply-5 as a
  588k-game LTC gainer) run in reverse.
- **Risks:** (1) the three terms are all "trust the corrected eval more" — they may be
  **redundant** (diminishing) rather than additive; the strip-back phase is what tells us; (2)
  these are default-off likely because each washed *solo* at 100ms/cap-800 — the bundle+bounds
  reframe is the bet, not a guarantee; (3) minor/cont corrhist add tables (memory + a
  correction_value hot-path cost) — confirm no NPS regression that would itself need LTC.

---

## P6. TRIPLEEXT — SF's full 5-term margin

**What it is (1 line):** Replace zug's bare-constant triple-extension threshold with SF's
5-term `tripleMargin` so the third extension ply is gated on node type / TT-capture / ttPv /
corrplexity / depth-vs-ply, not a flat `200`.

### Mechanism `[OBS]` (SF `search.cpp:1129-1187`)
- Gate (`:1129-1131`): non-root, `move==ttData.move`, `depth >= 6 + ss->ttPv`, TT value
  valid/non-decisive lower-bound, `ttData.depth >= depth-3`, not shuffling.
- Verification search at `singularBeta = ttData.value - (53 + 75*(ttPv&&!PvNode))*depth/60`,
  `singularDepth = newDepth/2` (`:1133-1138`).
- Margins (`:1140-1152`): `corrValAdj = |correctionValue|/230673`;
  `tripleMargin = 73 + 302*PvNode - 248*!ttCapture + 90*ss->ttPv - corrValAdj -
  (ss->ply*2 > rootDepth*3)*50`;
  `extension = 1 + (value < singularBeta - doubleMargin) + (value < singularBeta - tripleMargin)`;
  `depth++`. `extension` is added to `newDepth` after the move (`:1183-1187`). (Note the *double*
  margin also folds `ttMoveHistory`; the *triple* does not.)

### zug current state `[OBS]`: **DORMANT, bare constant.**
`zug/search.cpp:2625-2630`: `if (dblExt && !PvNode && s < singularBeta - dblMargin){ extension=2;
if (tripleExt && s < singularBeta - 200) extension=3; }`. Flag `:215` `bool tripleExt=false`,
self-labeled "UNTESTED (mixed gate: +1 depth some pos, -2 endgame)". Missing **all 5 SF terms**
(PvNode, !ttCapture, ttPv, corrValAdj, ply-vs-rootDepth) — just `< singularBeta - 200`.

- **Retrain dependency:** **NONE.**
- **Validation cost:** **games.** Small effect; test **inside the P5 bundle** (its corr term is
  P5c) or solo under `<0,5>`; expect small.
- **Risks:** (1) triple extensions can explode the tree in endgames (zug's own comment) — the
  ply-vs-rootDepth shrink term (`-(ss->ply*2>rootDepth*3)*50`) is precisely SF's guard against
  that, so port the **whole** margin, not a subset; (2) our `singularBeta`/`dblMargin` scale must
  match for the constants to transfer (they do at the corr scale — `singCorrDiv=230673` already
  matches).

---

## P7. Continuation-history plies — CONTHISTPLIES (primary), ss-5 (secondary)

**What it is (1 line):** Enable the ss-3/ss-4/ss-6 continuation-history planes zug currently
leaves off by default — the **largest structural gap in Pre-Train** — then separately consider
the ss-5 slot zug omits entirely.

> **This is NOT a marginal tweak and NOT a P5-bundle footnote `[INF]`.** Day-to-day zug runs
> **2 of 6** continuation-history plies (ss-1, ss-2). SF's bonus weights are
> `{1:1133, 2:683, 3:312, 4:582, 5:149, 6:474}` — the plies we skip (3/4/6) carry **312, 582,
> 474**, comparable to ss-2's own 683. Missing them is a **size-class gap**, so this gets its own
> item and its own SPRT, tested **first** among the game-validated items.

### CONTHISTPLIES (ss-3/4/6) — the primary lever

**zug current state `[OBS]`:** `zug/search.cpp:1496-1551` (`cont_hist_planes`): always-on
ss-1/ss-2 (`:1507-1522`); ss-3/ss-4/ss-6 gated behind `if (!C.tune.contHistPlies) return;`
(`:1523`, `:1527-1550`). Flag `CONTHISTPLIES` default **false** (`:184`) → day-to-day only
ss-1/ss-2 live. SF orders on ss-1,2,3,4,6 (`SF/movepick.cpp:163-167`) — our ss-3/4/6 set matches
SF's ordering read exactly; it's just off.

- **Retrain dependency:** **NONE.**
- **Validation cost:** **games.** Test **first**, under bounds sized to a real effect (this is
  plausibly the biggest pre-train item, not a ±1). A deep-ordering effect → may lean LTC.
- **Risks:** (1) three extra tables = memory + update-path cost; confirm no NPS regression that
  itself needs LTC to see through; (2) it was default-off historically — likely washed at
  cap-800/100ms, which the bounds fix (P4) is meant to resolve.

### ss-5 slot — secondary, only interesting after CONTHISTPLIES `[OBS]`

- **Reconciled SF truth:** ss-5 is **updated in the tables** (`SF/search.cpp:1876-1889`,
  `conthist_bonuses` includes `{5,149}`, only in-check `i>2` break) but **excluded from the
  ordering read** (`SF/movepick.cpp:163-167` sums indices `0,1,2,3,5` = plies 1,2,3,4,6). The
  #6002 "re-adding the 5th continuation history" (588k-game LTC gainer) re-added the *maintenance*;
  ordering still skips it. The stale header comment omitting "-5" is the source of the confusion.
- **zug state:** ss-5 **absent entirely** — no `ch5`/`contHist5` table; `cont_hist_planes` jumps
  ply≥4 → ply≥6. So even the maintenance SF keeps, we lack.
- **Validation:** games, small, only after CONTHISTPLIES clears; low priority.

---

## P8. Cuckoo (upcoming-repetition detection)

**What it is (1 line):** Detect that a legal reversible move would repeat a prior position and
return a draw score before searching it — cheap fortress/repetition handling.

### Mechanism `[OBS]` (SF `position.cpp:104-161`, `:1430-1474`; call sites `search.cpp:629,1504`)
- **Cuckoo tables** (`position.cpp:104-161`): `std::array<Key,8192> cuckoo; std::array<Move,8192>
  cuckooMove;` built at init by enumerating every non-pawn reversible move (`s1<s2`,
  `attacks_bb(type,s1,0)&s2`), hashed `psq[pc][s1]^psq[pc][s2]^side`, inserted by cuckoo-hashing
  with H1/H2 (`h&0x1fff`, `(h>>16)&0x1fff`) and evict-to-other-slot. `assert(count==3668)`.
- **`upcoming_repetition(ply)`** (`position.cpp:1430-1474`): `end=min(rule50,pliesFromNull)`;
  walk back **two StateInfo links per iteration** (same side to move), incrementally XOR
  `other ^= stp->key ^ stp->previous->key ^ side`; when `other==0`, `moveKey=originalKey^stp->key`,
  probe cuckoo via H1 then H2; on hit pull `cuckooMove[j]`, verify the path is unobstructed in
  the current position (`!((between_bb(s1,s2)^s2) & pieces())`), then `if (ply>i) return true`
  (repetition inside the tree) else `if (stp->repetition) return true` (pre-root).
- **Call sites:** main search non-root (`SF/search.cpp:629-635`) + qsearch (`:1504-1510`), both
  `if (alpha<VALUE_DRAW && upcoming_repetition(ss->ply)){ alpha=value_draw(nodes); if(alpha>=beta)
  return alpha; }`.

### zug current state `[OBS]`: **DORMANT — fully implemented, verified, NEVER SPRT'd.**
Tables `zug/zobrist.h:22-23`, `zobrist.cpp:13-14`, `assert(count==3668)` sentinel
(`zobrist.cpp:78-87`). `Position::upcoming_repetition()` `zug/position.cpp:807-836`. Both call
sites present (qsearch `zug/search.cpp:1888-1894`, negamax `:2166-2173`), gated
`Zobrist::cuckoo_enabled()` (env `CUCKOO=1`, default off, `zobrist.cpp:16-19`). Byte-identical
default-off, unit-verified (6/6 repetition test, one-move-early fire), commit `40db482`. **No Elo
verdict exists** — the port is complete, only the SPRT is missing.

- **Retrain dependency:** **NONE.**
- **Validation cost:** **games.** This is the cleanest ready-to-test item — just needs its SPRT
  under `<0,5>`. Effect likely small at movetime (repetition/fortress positions are rare in
  self-play) but it's a finished feature awaiting a number.
- **Risks:** (1) low base rate → may wash at movetime even if correct; test under wide bounds and
  don't over-interpret a wash as "broken"; (2) already verified byte-identical, so downside is
  bounded.

---

## P9. Corrplexity applied to futility "specifically"

**What it is (1 line):** The requested item — add a corrplexity term to *forward quiet-futility*
pruning, since CORRMARGIN currently only touches RFP + LMR.

### Finding — the item **largely dissolves** `[OBS]`
- SF's "corrplexity for futility" (PR #5748) lives in `futility_margin` at the **Step-8
  reverse-futility (RFP)** site: `SF/search.cpp:879-889`,
  `... + abs(correctionValue)/174665`, consumed by `eval - futility_margin(depth) >= beta`
  returning `(2*beta+eval)/3`. That is **RFP** — the exact site zug's **CORRMARGIN already
  mirrors at the same `/174665`** (`zug/search.cpp:2273-2286`).
- SF applies corrplexity at **exactly three** sites (RFP `/174665`, singular `/230673`, LMR
  `/30370`) and **nowhere on forward quiet-futility** — `grep correctionValue` over SF
  `search.cpp` = {714,727,737,884,1142,1197,1563,1574,1585}; the forward-futility/razoring paths
  have **no** corr term (razoring uses corrected eval baseline only, `SF/search.cpp:873`).
- zug's forward quiet-futility (`zug/search.cpp:2525-2529`, `futBase+futSlope*depth+futSfAdj`)
  has no corr term — **matching SF**, which also has none there.

**Conclusion `[INF]`:** there is **no SF-source basis** for corr-on-forward-quiet-futility.
"Apply corrplexity to futility" = either (i) already done, if "futility" means RFP (it's our
CORRMARGIN, ships inside P5b), or (ii) a **novel, unproven** term with no reference impl if it
means forward quiet-futility. **Recommendation:** do **not** invent (ii); fold (i) into the P5
bundle. If we ever want (ii), label it clearly as a zug-original experiment, not an SF port.

- **Retrain dependency:** NONE. **Validation cost:** subsumed by P5. **Risk:** inventing an
  unmotivated term that adds noise; the SF evidence says the forward-futility site is
  deliberately corr-free.

---

## P10. Node-effort time management

**What it is (1 line):** Shorten the move's time budget when the best move already consumed almost
all search nodes (position is "obvious"), plus best-move-instability / falling-eval scaling — a
set of TIMEMAN multipliers zug lacks entirely.

### Mechanism `[OBS]` (SF `search.cpp:487-508`, per-move accrual `:1308`)
Per-root-move node accounting: `rm.effort += nodes - nodeCount` each iteration (`:1308`). The
budget is then scaled by a product of factors (`:487-508`):
`nodesEffort = rootMoves[0].effort*100000/nodes`; `highBestMoveEffort = (nodesEffort >= 93340) ?
0.76 : 1.0`; `fallingEval = clamp(11.85 + 2.24*(prevAvg - bestValue) + …, 0.57, 1.70)`;
`bestMoveInstability = 1.02 + 2.14*totBestMoveChanges/threads`; final
`totalTime = optimum * fallingEval * reduction * bestMoveInstability * highBestMoveEffort`. The
node-effort term cuts the budget to 0.76× once the PV move has eaten ≥93.34% of nodes; instability
and falling-eval *raise* it when the PV is unstable or the score is dropping.

### zug current state `[OBS]`: **LACK.**
`grep effort` in `zug/search.cpp` finds no `nodesEffort`/`rm.effort`/`highBestMoveEffort`/
`bestMoveInstability`/`fallingEval` — only unrelated hits (`:2033` instability comment, `:3334`
bestMove weighting). zug's TIMEMAN has base time scaling but none of these multipliers.

- **Retrain dependency:** **NONE.**
- **Validation cost:** **games — real-clock TC-SPRT** (like TIMEMAN's +28), not movetime.
- **⚠️ Scope caveat `[OBS/INF]`:** **clock-mode only.** The website bot calls rating-only
  `/bestmove` with no clocks/ponder, so this helps the **CCRL/UCI track only**, not website play
  — same class as the rest of TIMEMAN ([zug-clock-features-uci-path]).
- **⚠️ Constants drifted `[OBS]`:** the commonly-quoted `nodesEffort>=97`, `*0.654`,
  `completedDepth>=10` do **not** match `sf_18` (which shows `>= 93340 ? 0.76`). Read the tagged
  tree for the exact terms before porting — the mechanism is stable, the numbers are version-specific.
- **Risks:** (1) a mis-tuned node-effort cutoff moves too fast in sharp positions — port SF's
  **full** factor set (instability + falling-eval raise the budget), not just the cut; (2)
  real-clock SPRT only, invisible to the movetime harness.

---

## Sequencing / dependencies `[INF]`

- **Bench-only, P4-independent — start immediately, in parallel:** **P1** (Finny) and **P2**
  (sparse-affine). Both decided by NPS on coalla/amd64 + arm64 behind a correctness gate; neither
  waits on the harness. P1 gated by its event-count follow-up; P2 by pre-check #1 (then, if weak,
  the retrain-free permutation task).
- **P4 lands first among the game-validated items — it gates P5, P6, P7, P8, P10.** All are
  unresolvable under the current cap-800 policy; do not run them until bounds/uncapping are fixed.
- **Among the game items, order by expected size:** **P7 (CONTHISTPLIES ss-3/4/6) first** — the
  largest structural gap — then the P5 corr bundle, then P8 (cuckoo — finished, just needs its
  SPRT), then P6 / ss-5 (small). P10 is a separate real-clock track.
- **P3 (output-layer SPSA) needs a wall-clock feasibility check before scheduling.** SF spent
  120k games at 120+1.2; measure games/hour on coalla at the chosen TC first. If a usable run
  exceeds the pre-August window, P3 becomes **tooling-now, run-in-August** (the mechanism is a
  standard post-training step regardless) — build the `.nnue`-offset perturber + round-trip test
  now, run the SPSA later.
- **Bench hygiene:** keep the **canonical bench position set unchanged** (cross-commit NPS
  comparability is our cheapest regression signal); add a **separate king-active NPS set** for P1
  and the sparse/king-move-sensitive measurements.

---
---

# POST-TRAIN — gated on the August retrain (document, then do not touch)

> None of the below is started now. No trainer code, no inference prep. `[UPSTREAM]` = from
> commit reports / other engines, **not** in our `sf_18` tree.

## T1. PP_3Wide pawn-pair features `[UPSTREAM]`

- **What:** SFNNv16 (~4 days ago upstream, net `nn-89cb98a217f7`). A **second sparse FT feature
  set**: pairs of pawns on the same or adjacent file, ranks 2–7. `pawn_id = 48*color + sq -
  SQ_A2` (96 IDs); `index = hi*(hi-1)/2 + lo + IndexBase` → **4560 features**.
- **Mechanism (reported):** pawn-pusher inputs from SFNNv14 **removed** (pawn pairs subsume
  them); FullThreats **60720→59808**, pawn `numValidTargets` **6→4**. Cost ~10% slowdown
  **optimized to ~3.5%** via hand-written AVX512ICL (`_mm512_maskz_compress_epi8` +
  `_mm256_cvtepu8_epi16`); `IndexList` widened `ValueList<IndexType,128>`→`ValueList<u16,256>`.
  Invented by J. Hallström for Pawnocchio.
- **zug state:** LACK. **Rides our existing sparse-FT threat plumbing** conceptually (threats
  are already an FT feature set), but the features must be **trained into the net**.
- **Retrain dependency:** **HARD** — new feature set = new net.
- **Validation cost:** games; **LTC-gated** (SFNNv16 failed STC LLR −2.94, passed LTC/VLTC/VVLTC).
- **Risks:** (1) must remove the subsumed pawn-threat pairs or it double-counts; (2) 3.5% is
  *post* expert AVX512ICL hand-optimization — a naive port is the original ~10%, plausibly
  **net-negative at our NPS**; (3) real cost = trainer change + inference + a training run for an
  **LTC-only** gain. Not cheap despite the "rides existing plumbing" framing.

## T2. int8 threat FT with QAT `[UPSTREAM / to verify]`

- **What:** quantize the threat FT weights to **int8** (calc stays int16), à la the reported SF
  threat quantization, to cut threat-FT memory/bandwidth.
- **Mechanism:** our threat FT is currently **int16** (`zug/nnue_net.h:11-12`, `W0i` includes
  the 79856 threat columns). int8 threat weights need **QAT** (quantization-aware training) or
  eval regresses.
- **⚠️ Claim to verify before committing the slot:** the explicit "i8-weights / i16-math threat
  quantization" is documented in **Monty #116 / PlentyChess #411**, **NOT** in SF's SFNNv10
  commit (which says only "minor quantization changes"). **Read our local SF18 FT quantization
  and the Monty/PC refs before designing this** — do not port a claim. `[INF]`
- **Retrain dependency:** **HARD** — QAT is a training-time change.
- **Validation cost:** games (net compare at fixed nodes first, then SPRT).
- **Risks:** QAT instability; the memory/bandwidth win may not convert to Elo if we're not
  bandwidth-bound at H=512.

## T3. FullThreats dimension change `[UPSTREAM]`

- **What:** the v11→v16 threat-dimension trims (v11 drop piece→king −13MB; v13/v16
  reshaping; PP_3Wide 60720→59808).
- **Mechanism/state:** our `ThreatBlock=79856` is the SFNNv10 full-threats space. The trims are
  net-architecture changes.
- **Retrain dependency:** **HARD.** **Validation:** games/net-compare. **Risk:** coupled to
  whatever else the retrain changes — do not bundle (see isolation statement).

## T4. L1 / L2 width changes `[UPSTREAM + INF]`

- **What:** SF went L1 **3072→1024** *when threats arrived*, then spent the savings on L2
  (**15→31**, SFNNv13). Question: is our H=512 the deficit?
- **Finding `[INF]`:** width is **no longer the obvious deficit** — threats change the width
  economics (SF is "fine" at 1024 *with* threats). But "SF fine at 1024" does **not** license
  "we're fine at 512": SF's 1024 comes with 8 layer stacks, L2/L3 31/32, and 100B+ training
  positions. **Do not flip to "the net is fine" either.** The unmeasured variable is data/recipe
  (T5/T6), not width.
- **Retrain dependency:** **HARD.** **Validation:** net-compare at fixed nodes. **Risk:**
  changing width alone tells us little without holding data constant.

## T5. Data-volume scaling `[INF]`

- **What:** train the same arch on 5–10× data vs our current single-stage bullet run
  (~tens of GB test80-style vs SF nettest 100B+ positions).
- **Mechanism / metric `[INF]`:** measure with **local Elo at fixed nodes vs the current net**
  (SF ranks candidate nets at 25k nodes/move), **not** a game SPRT — sidesteps the movetime
  harness entirely, same logic as P1/P2 being bench-decidable.
- **Retrain dependency:** **HARD.** **Validation:** fixed-node net-compare. **Risk:** volume is
  only one of two variables (see T6).

## T6. Training staging `[INF, nnue-pytorch finding]`

- **What:** chained/staged training — high-quality data as a **retrain over a net first trained
  on lower-quality data**, which nnue-pytorch finds beats training on the good data **from
  zero**.
- **Mechanism:** SF's recipe is **chained stages**, not single-stage. Our pipeline is
  single-stage bullet. Staging may be the **larger half** of the net gap vs raw volume.
- **Retrain dependency:** **HARD.** **Validation:** fixed-node net-compare (from-scratch vs
  staged, data held constant). **Risk:** more pipeline infra to build; but potentially the
  biggest net lever.

---

## THE AUGUST RUN — sequence and design `[INF]`

**Volume first (T5), then staging (T6) — and measurement is not one-variable-bound.**

**Ordering — why volume precedes staging:** the measured gap is **tens of GB vs 100B+
positions**. Staging (T6) is a technique for *consuming* large heterogeneous data — with little
data it has little to work with — and it needs **new chaining infra** that a "one slot for
staging" framing silently hides. Volume (T5) needs no new pipeline infra (caveat: sourcing and
ingesting 100B+ positions is its own throughput problem, since we're on test80/79-scale today).
So volume is the first lever.

**Design — a factorial, not a single confounded run:** the one-variable-per-run rule applies to
**shipping** decisions, not **measurement**. Because the metric is **fixed-node net-compare
against a fixed anchor** (the current net, at 25k nodes/move), each candidate net attributes
independently. If GPU time allows, run three and compare all to the same anchor:
1. baseline (current arch, current data, from-scratch),
2. current arch, **more data**, single-stage,
3. current arch, **more data**, staged (weak-net → good-data finetune).

(2)−(1) isolates **volume**; (3)−(2) isolates **staging**. That is a clean factorial, not a
confound. The one-variable rule bites only when *shipping* a net (don't change arch + data +
quantization together) — and do **not** fold PP_3Wide / width / int8-QAT into these measurement
runs; those are separate slots.

**Meta — do not over-attribute to the net `[INF]`:** the search/net split of our gap to SF is
**unmeasured**. CONTHISTPLIES (P7) is the standing reminder that structural *search* Elo is still
on the table pre-train; the August runs measure the *net* half — they do not prove it is the
whole gap.

---

## Open measurements folded into this doc (not guesses)

| # | Measurement | Status | Gates |
|---|---|---|---|
| PRE-CHECK #2 | Does SF Finny cover FullThreats? | **DONE — NO** `[OBS]` (§P1) | reprices P1 to base-half-only |
| PRE-CHECK #1 | 4-wide-block all-zero fraction of `aq[]` at H=512, in-search mix | **DONE (2026-07-24):** block-zero **49.9%**, scalar-zero **83.9%** (1.58M eval calls, depth-16 mix, net loaded) | ~50% of L1 blocks skippable as-is → marginal at H=512; permutation could lift toward ~96% |
| PROFILE freshness | re-profile at current main (20Jul profile is stale: built at `93e4f56`, **pre-LAZYACC2**) | **IN PROGRESS** — fresh amd64 profile on coalla | decides P1 (`build_half` share) + P2 (`eval_from_halves`/L1 share) |
| P1-followup | count refresh events by type (PSQ/threat) + time each on coalla | **PENDING** | (PSQ-event freq × per-event cost) = Finny's ceiling |
| P2-fallback | if pre-check #1 weak: compute our own block-sparsity permutation (retrain-free) | **CONDITIONAL** | makes P2 pay without a retrain |
