# NNUE architecture direction — the frontier sweep verdict

> **Dated 2026-07-03.** A four-engine teardown (Stockfish, Reckless, Stormphrax, +
> a dedicated NPS/implementation teardown) done to answer one question before
> committing months of code: **are we capping ourselves by copying Stormphrax, or
> is "rich features vs big-and-simple" just a tradeoff we get to pick?**
> Companion docs: `ENGINE_ROADMAP.md` (current phase), `ENRICHED_MULTILAYER.md`
> (the threats-net plan/state), `NEXT_ARCH.md` (the earlier gap analysis),
> `ENGINE_STRENGTH.md §16–28` (measured numbers). All strength/arch figures below
> are as researched on **2026-07-03** from primary sources (engine source trees +
> release notes); re-verify before quoting as current — the frontier moves weekly.

---

## 0. TL;DR (the decision)

- **Threats are the 2026 frontier consensus, not a ~3700 ceiling.** Stockfish (#1),
  Reckless (#2, 3767), and Stormphrax (3722) **all** use explicit threat inputs.
  SF *added* them in SF18/SFNNv10 (2026-01) for **+33–46 Elo** and *narrowed* its FT
  3072→1024 to pay for them. Chasing the threats school does not cap us at
  Stormphrax — its top member is the world #1.
- **Reckless is our blueprint:** #2 CCRL (3767) on a **768-wide FT** with a tiny
  tail, self-play data, no external distillation — i.e. our width class, our
  trainer (bullet), no SF-scale data. Threats were its biggest single jump (+265 CCRL).
- **Our 3.7× NPS deficit on the threats net is implementation debt, not physics.**
  A well-built threats net runs within ~1.3–1.7× of a plain net (Stormphrax runs a
  *bigger* net at 2.4× *SF*). Our debt: a **scalar, int16, dense** tail where the
  frontier runs **SIMD, int8, sparse**.
- **Direction:** threats + king buckets + a **small** multilayer tail + 8 output
  buckets, all richness in the **sparse incremental** layer, tail kept small and
  cheap (SIMD+int8+sparse). Keep FT hidden ~512 for now (defer width). QAT always.

---

## 1. The frontier, as measured (2026-07-03)

| | Strength | FT hidden | Inputs | Tail | Quant | Data |
|---|---|---|---|---|---|---|
| **Stockfish** (SFNNv14, master) | #1 (~3900+) | **1024** | HalfKAv2_hm (32 king buckets, hm) + **FullThreats** ~60,720 | 32→32→1 ×8 | int16 acc / int8 wt (127/64) | Leela+SF mix, ~10¹¹ positions, iterated |
| **Reckless** (v0.9/v46) | #2, **3767** Blitz | **768** | 768 + **10 king buckets** (hm) + **threats** 66,864 | 768→16→32→1 ×8 | int16 piece / **int8 threat** / float tail | **100% self-play from zero**, iterated |
| **Stormphrax** (v8 `undertown`) | **3722** Blitz | **640** | 704 (merged-king) + **16 king buckets** (hm) + **threats** 59,808 + pawn-pawn 4560 | 32→64→64→1 ×8, dual act + skip | **int8 FT + int8 L1** (VPDPBUSD) | **100% self-play**, 24k-node datagen, DFRC |
| **gomachine v6** (shipped) | floor >3400 | 512 | 768 plain, no buckets, no threats | single SCReLU dot | int16 | SF distillation |
| **gomachine enriched** (built, unshipped) | +170 @ d8 eval; 9µs/node | 512 | 768 + threats 9216 | multilayer, **scalar float** | partial int8 | SF distillation |

**Sources (2026-07-03):** SF `src/nnue/nnue_architecture.h`, `features/full_threats.h`,
`features/half_ka_v2_hm.h`, SF18 blog (SFNNv10 threat inputs, +33–46 Elo), PR #5149
(SFNNv9 L1=3072 peak). Reckless `src/nnue.rs`, `RecklessNetworks/CHANGELOG.md`, v0.9.0
release notes. Stormphrax `~/stormphrax/src/eval/arch.h`, `nnue/arch/multilayer.h`,
`nnue/features/{threats,psq}.*`, `src/datagen/datagen.cpp`, v8.0.0 release.

---

## 2. The two design questions, answered

### 2a. Rich features vs big-and-simple — is one a higher ceiling?

**No — they are two points on one capacity/speed/data tradeoff, and the axes are
substitutes.** SF literally traded FT width (3072→1024) for threat features and came
out ahead. The decisive empirical fact: **explicit threats gained SF ~40 Elo at
1024–3072 width on 100B+ positions** — so even the widest, most data-saturated net
does not perfectly recover attack/defend relations from bare piece placement. For an
engine that cannot generate/curate SF-scale data, engineered sparse inputs give **more
Elo per parameter and per training position** than brute width. Reckless is the proof:
#2 in the world on a 768 FT + threats + self-play, no giant net, no external data.

**"Boring big net" is not a superior architecture in the abstract** — it is the shape
that pays off *when you own SF-scale data + compute*, dictated by incremental-update
economics (a huge sparse first layer updates in a few adds/subs per move; capacity
there is nearly free). Without SF's data, the same wide plain net underperforms a
smaller feature-rich one.

### 2b. Where does the capacity go — tail or sparse inputs?

The frontier splits, but the split is smaller than it looks: **every one of these
tails is small** (16–64 wide). Nobody runs a fat tail. The shared law (SF states it):
*the sparse input layer is incremental (near-free per move); anything dense after the
accumulator runs in full on every node — so keep it small.* SF keeps it trivial
(32→32→1); Reckless/Stormphrax use a small multilayer (16–64). All three put the real
capacity in **sparse, incrementally-updatable inputs** (threats + king buckets).

**Our error was never "multilayer" — it's that our small tail is implemented scalar +
int16 + dense**, costing ~2.4µs where it should cost ~0.4–0.6µs. Reckless runs the same
16→32→1 shape at #2. We don't need SF's trivial tail; we need our small tail to be as
cheap as theirs.

---

## 3. Why SF ≫ Stormphrax ≫ us in NPS — the culprits (2026-07-03 teardown)

**The threat tax is universal now** — SF pays it too (via `DirtyThreats` incremental
deltas). It is an implementation cost, not an NPS ceiling. Corrected ratios: SF ÷
Stormphrax ≈ **2.4×** (the "3.3×" was high); Stormphrax ÷ our-threats-net ≈ **3.7×**,
and Stormphrax's is the *bigger* net. Our threats eval is ~5–7× Stormphrax's eval —
all recoverable.

**Ranked culprits (NPS recovery ÷ effort):**

| # | Culprit | Fix | ~Win | Effort | Retrain? |
|---|---|---|---|---|---|
| **1** | **Scalar float tail** — the enriched multilayer tail bypasses the SIMD seam the lean nets already use (`enriched.go` `pairwiseHalf`, `multilayer.go` `screluF`, `gemvF32Scalar`). | Route the multilayer tail through the existing `screluDotSIMD`/`gemvF32SIMD` kernels. | **+25–30%** | **Low** | **No — code only** |
| 2 | int16 tail, not int8 (VNNI `dotU8I8VNNI` built 2026-07-03, opt-in, unused by threats net). | Flip `int8L1` on → VPDPBUSD (u8 act × i8 wt). | +20–40% on L1 | Med | Calibrate / QAT |
| 3 | Dense L1 (processes zero activations). | Port Stormphrax `SparseContext` (nonzero-mask + popcount LUT); needs #2 (u8 acts). | **+2–4× on L1** | Med-high | After #2 |
| 4 | Threat push not fully edge-incremental (`changedEdges` default helps ~14%; not at Stormphrax's focus-square/discovered-slider completeness). | Finish O(changed-edges) delta incl. discovered sliders. | +10–15% | Med | No |
| 5 | 10MB threat-weight table memory-bound (lairner weak memory). | int8-FT threat cols (→~5MB) + prefetch. | +10–20% (lairner) | Med | QAT |
| 6 | No lazy accumulator (threats acc updated on pruned nodes). | Defer materialization to eval (SF `AccumulatorStack`). | +3–8% | Med | No |

**Don't chase SF's absolute NPS** — its last ~1.5× is C++/AVX-512-ICL/two-decade
tuning Go can't match. Correct goal: **make the threats eval cheap enough that its
already-won eval edge (+170 @ d8) nets positive at movetime.** Target: threats eval
within ~1.5–2× of the plain lean-768 net → flips the movetime SPRT.

---

## 4. The build plan (each rung movetime-gated, never fixed-nodes)

**Target arch (Reckless-convergent, NPS-disciplined):** FT hidden ~512 (defer width) +
**threats** (sparse, int8, incremental) + **king buckets** (needs the accumulator
refresh path we don't yet have) + **small multilayer tail 16→32→1** (SIMD + int8 +
sparse) + **8 output buckets**, QAT-trained.

**Order:**
1. **SIMD the scalar tail** — culprit #1. ✅ **DONE 2026-07-03.** The real target
   was `pairwiseU8` (the int8 multilayer path's pairwise FT activation), not the
   float `pairwiseHalf` — archsimd has **no int→float**, so the float tail can't
   vectorize; the fast tail is integer/int8. Recast `pairwiseU8` to the pure-integer
   `(clamp(lo)·clamp(hi)+ftRound)>>ftShift` form (65025>>9=127, same trick as
   `quantU8I16`), put it behind the kernel seam, SIMD on AVX-512 + NEON (AVX2 stays
   scalar — archsimd has no non-AVX-512 int32→u8 narrow, matching `quantU8I16`).
   Bit-exact gate `TestPairwiseU8MatchScalar` green on scalar + NEON, and **✅ validated
   on real AVX-512 (coalla, 2026-07-03)**. Measured (coalla, enriched-64 net): tail-only
   int8 **1234→371 ns (3.3×)**, full node **2678→1756 ns (−922 ns/node)**. Now the int8
   multilayer tail is all-SIMD on the prod (AVX-512) build.

   > **★ Finding that reprioritizes (2026-07-03 coalla measurement):** with the tail now
   > cheap (371 ns, ~21% of node), the **threat PUSH dominates (~1385 ns, ~79%)** — and
   > this multilayer net ran the SLOW push (`ImportBulletEnrichedNet` doesn't set
   > `moveAware`; the lean import does). Fair node ≈ **3.5× v6** with moveAware on, not the
   > 5.56× measured. Two consequences: (1) the next lever is the **push** (culprit #4/#5),
   > not the tail; (2) the **multilayer tail is a questionable trade at FT width 512** — it
   > costs ~0.6× v6/node over the lean single-layer tail for only ~+10 fixed-depth eval
   > (soft, cross-run). The lean net (2.89× v6, +25 movetime winner) may be the better base;
   > multilayer tails pay off at WIDER FTs (Reckless 768, SF/SP wider). **Open fork: lean +
   > threats + king buckets + width + data, vs multilayer tail. Re-measure with moveAware on
   > before committing a multilayer retrain.**
2. **Finish the edge-incremental threat push** — culprit #4, code-only.
3. **int8 L1 (VNNI) + sparse L1** — the Stormphrax pairing (#2→#3); the QAT-int8
   retrain lands here.
4. **Re-measure the threats net at movetime** — should now clear v6 comfortably.
5. **King buckets** (refresh path) + **output buckets**. Width→1024 stays deferred
   until the above make it cheap.

**Data strategy:** keep SF distillation now (we're hundreds of Elo below the teacher —
no ceiling pressure yet); **mix in Leela** cheaply (SF's own best sets are SF+Leela
interleaves); build **self-play datagen** as the long pole (Stormphrax recipe: ~24k
soft nodes, DFRC openings, ±500cp verification filter). Reckless/Stormphrax prove
self-play-only reaches 3722–3767 — it is the eventual ceiling-breaker, not the next
lever. Blend targets λ≈0.7–0.8 (score-dominant + WDL) for self-labeled data; keep
`LinearWDL 1.0→0.75` for distillation.

---

## 5. Hard-won framings to keep

- **QAT rides on every net** (free, and the only thing that stops int8's ~150-Elo PTQ
  cliff). Bake it into every training run.
- **There is no int8 *tail* for a single-layer SCReLU→scalar net** (SCReLU squares →
  int16-bound). int8 in the tail is a *multilayer* lever. The lean net's int8 lever is
  the FT columns (threat cols already int8; base cols int16).
- **Gate eval at movetime or fixed depth, never fixed-nodes** (fixed-nodes inflates
  eval changes — the v8-buckets +90→≈0 scar).
- **Every SIMD/int8 kernel needs a bit-exact scalar gate** (`TestKernelsMatchScalar` /
  `NNUE_ASSERT`).

---

## 6. EMPIRICAL VERDICT — enriched-512 measured, ABANDONED (2026-07-04)

Trained the enriched multilayer net (H=512, D2=16, D3=32, NB=8, threats 768+9216)
to 320 sb with full QAT on ~40GB SF test80 data, then SPRT'd on coalla (AVX-512)
vs the **lean-v9** champion (`data/nnue/lean.bin`). Clean net, sb 320 (md5
`c00a621d…`; a corrupt-data first run that lost 100% was discarded — flaky
`curl|zstd -dc >>` streaming silently truncated the binpack; **always
download-to-disk + `zstd -t` first**).

**Node cost (coalla, EPYC 9634, SIMD v4):** V6 ~325 ns · **lean-v9 ~882 ns** ·
**enriched int8(full, incl int8-FT) ~1750 ns (~2× lean)** · enriched float ~3790 ns.
The 2× tax is the **multilayer TAIL** (D2/D3), not threats — lean-v9 already carries
the same 9216 threat features at 882 ns.

**Strength ladder (fixed-depth eval vs lean-v9, and movetime):**

| Config | fixed-depth Elo | movetime Elo |
|---|---|---|
| Float FT + float tail | **+32 ± 20** (firm, 193 pr) | — (too slow) |
| int16-FT + int8-L1 | +10 ± 18 (200 pr) | −68 (slow FT) |
| **int8-FT + int8-L1 (shipping)** | **−19 ± 22** (150 pr) | **~−17** (40 pr) |

**Why it fails:** (1) the float eval ceiling is only **+32** — SF/Stormphrax make
threats pay via *bigger* nets with larger eval gains, not +32 at width 512; (2) a
~**51 Elo int8 leak** (float +32 → int8-FT −19). At ~2× node cost even a perfect
int8 net lands ~break-even at movetime. Well-measured marginal loss → **abandoned**;
lean-v9 stays champion; pivot to **lean width→512→1024** (higher eval ceiling, better
Elo/node, less complexity — the NEXT_STEPS ladder).

> **UPDATE 2026-07-11:** the "pivot to lean width→512→1024 / NEXT_STEPS ladder" recommendation
> above is **SUPERSEDED**. The engine instead added **full threats + 16 king-buckets** (prod =
> the SF full-threats net), and the forward plan is now `docs/NNUE/SF_PARITY_ROADMAP.md` (data →
> 32 king-buckets → dual net → threat-PSQT skip → 1024, with 1024 **last and not cheap**). The
> ">3400 floor" strength row (§1) still stands.

### The FT-weight-QAT gap (bank this for a future BIGGER threat net)

The int8-FT leak is diagnosed and *fixable*, just not worth it here. Root cause:
`chessgo_enriched.rs` (and `chessgo_lean_threats.rs`) fake-quantise the FT
**activation** (`faux_quantise(QA=255)`), the pairwise activation (`QACT=127`), and
the L1 **weights** (`QW=64`) — but **never the FT *weights* (`l0.weights`)**. Go's
`QuantizeFTInt8` quantises the threat columns to int8 at the fixed `ftQA=255` grid,
clamping ±127. Measured weights: base & threat both span **±505** (= AdamW ±1.98 ×
255); threat has 3,261 weights >127, base 4,502. So int8-FT loses the ±127→±505 tail
(4× range) → the leak.

**The fix (unbuilt):** fake-quantise *only* the threat **columns** (input 768:) of
`l0.weights` to the (255-scale, ±127-clamp) grid during training, constraining threat
weights to |W|≤0.5. Needs bullet graph surgery — `ModelNode` exposes `slice_rows`
but the threat columns are the *input/col* dim of the `(H, INPUT_SIZE)` weight, so it
needs a `slice_cols`/col-`concat` patch (or an affine split + save-format + Go-import
change). **Base must stay int16** (4,502 weights >127 would clamp). Payoff is
uncertain even then: constraining threats to a 4× smaller range may cost
expressiveness, so recovery is partial (est. int8-FT eval −19→~+5, movetime
−17→~break-even). Only worth it once a *wider/bigger* threat net raises the float
ceiling well past +32 so the recovered int8 net is clearly movetime-positive.
