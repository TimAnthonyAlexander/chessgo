# NNUE pipeline experiments (ready-to-run A/Bs)

Each experiment changes **one variable**, trains on the GPU box, and A/Bs the final annealed
net **directly vs the current prod net** at movetime on coalla (`[[sprt-direct-vs-prod-and-fn-mt]]`),
then an Abitur anchor. Ship only on a clear positive movetime lower bound
(`[[nnue-ship-annealed-final]]`).

---

## Experiment 1 — WDL anneal (single variable) **[NEXT]**

**Hypothesis.** Annealing the WDL target weight (eval-heavy early → result-heavy late — standard
NNUE/nnue-pytorch practice, and what mature SF nets do) beats our flat `ConstantWDL 0.6`, on the
existing test80-2024 Jan–Apr data. We currently anneal **nothing**; SF does.

**Convention (get this right).** bullet's WDL value = weight on the **game RESULT** (WDL), with the
remainder on the **eval** (score). So:
- `ConstantWDL 0.6` = 60% game-result / 40% eval, *throughout* (our shipped baseline).
- `LinearWDL {0.5 → 0.7}` = result-weight **rises** 50%→70% over training ⇒ **eval-leaning early,
  result-leaning late**. Dense/graded eval gradient helps early convergence; the true objective
  (game result) fine-tunes late with less overfitting to the teacher's eval quirks.

**Why these endpoints — `LinearWDL {start: 0.5, end: 0.7}`.**
- **Mean-matched to the baseline.** `(0.5+0.7)/2 = 0.6` = the constant's average result-weight, so
  the **only** variable is the anneal *shape*, not the average. A win = "shaping helps," cleanly.
- **Stays in our raw-label regime.** `DATA_RECIPE_SF_2026 §34.3`: our 0.6 was calibrated to **raw**
  test80-Q (noisier eval than SF's BT4-relabeled data), so we correctly lean result-heavy. Do **not**
  blind-copy SF's eval-heavy `0.0→0.25` onto raw labels — the recipe's own prescription is to run the
  anneal as a **single-variable SPRT**, which this is. Endpoints straddle 0.6 rather than jumping to
  SF's regime.
- **Direction = SF/standard** (result-weight up over the run), magnitude ≈ SF's Δ (~+0.2).

**Design (cheap — reuse prod as baseline).** The prod net `chessgo_threats_sf_640` **is** the baseline
(ConstantWDL 0.6, concat, Jan–Apr, 640sb). Train **one** new net identical in every way except the WDL
schedule, then SPRT it vs prod. `INTERLEAVE=0` (concat) to match how prod trained — interleave is a
**no-op on homogeneous test80 months** (single-source shuffle windows ≈ month-mixed windows; the
16.7M-position shuffle buffer already decorrelates within-source), so it must not be a confound here.
Interleave earns its keep only across **heterogeneous** sources — see Experiment 2.

**Run (GPU box).**
```sh
# data: test80-2024 Jan-Apr (the prod-baseline set)
MONTHS="01-jan 02-feb 03-mar 04-apr" bash docs/NNUE/pipeline/fetch-data.sh
# train the annealed net (everything else = prod defaults; concat; 640 sb)
FETCH=1 NET_ID=chessgo_wdl0507_640 SB=640 INTERLEAVE=0 \
  WDL_ANNEAL=1 WDL_START=0.5 WDL_END=0.7 FEATURES=cuda \
  bash docs/NNUE/pipeline/train.sh
```

**Measure.** Copy `checkpoints/chessgo_wdl0507_640-640/quantised.bin` to coalla; SPRT vs prod at
movetime:
```sh
KB_NET_PATH=data/nnue/ft_final.bin ./bin/gomachine_simd bench sprt \
  --new-enriched "<path>/quantised.bin,512,16,32,8" --old "" --movetime 100 --maxpairs 3000
```
(`--new-enriched` forces concurrency 1; fine for a net-vs-prod read.) Gate on the movetime lower
bound; then an Abitur anchor. The anneal **only manifests over the full 640sb** — it is NOT
smoke-testable at 4sb.

**If it wins / is promising — endpoint follow-ups (one variable each):** SF-Δ shifted up
`{0.5→0.75}` (tests mean too), or wider shape `{0.4→0.8}`. If it washes, 0.6 is near-optimal for raw
labels and the WDL lever is spent until we relabel with a deeper teacher (BT4-style).

---

## Experiment 2 — heterogeneous interleave **[after source prep]**

Interleave's real payoff: keep Jan–Apr test80 as the proven block and **add genuinely different
sources** (test79 / T78 — v6-dd + syzygy-rescored, per `DATA_RECIPE_SF_2026:73`; later dfrc_n5000 /
UHO), mixed **per batch** via `INTERLEAVE=1` so the optimizer never swings toward whichever source
it's currently draining (the catastrophic-forgetting oscillation that concat causes across
*different* distributions). Blocked on the source prep (confirm HF paths + rescore infra) — do NOT
feed raw old runs. `BINPACKS=<all sources> INTERLEAVE=1`; the homogeneous Jan–Apr mutual mixing is a
harmless no-op, the cross-type mixing is the win.
