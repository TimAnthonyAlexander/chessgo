# NNUE data-pipeline recipe — SF SFNNv10–v13 findings & our mapping (2026-07-06)

> Source: user pulled `threats.yaml` behind the Stockfish SFNNv10–v13 nets (Nov 2025–Feb
> 2026) + the nnue-pytorch wiki + linrock's notes. Authoritative reference for how the
> frontier builds training data. **Pipeline quality pays off harder than more data on a
> weak pipeline.** (Distinct from the historical v2 doc `DATA_PIPELINE.md`.)

## Confirmed (how SF's data works)

- **Blend, not replacement.** S1 mixes SF gensfen (`nodes5000pv2_UHO`, `wrongIsRight`,
  `multinet`, `dfrc_n5000`) with early Leela (Farseer T60/T70/T74-76).
- **Staged: SF-synthetic first, THEN Leela retrain.** Training solely on Lc0-derived data
  is worse; train on SF depth9/nodes5000 first, then retrain on Lc0 data.
- **Old runs are a weak teacher; breadth has sharp diminishing returns.** T80 oct+nov alone
  ≈ bigger Leela mixes; adding more didn't help much.

## Corrections to earlier understanding

- **Rescore = syzygy 7-piece tablebase rescoring** (16TB, lc0 rescorer during conversion)
  **+ a separate depth6-multipv2 filter** (drops positions where either top-2 move is a
  capture). NOT an "SF-search relabel." Value target = Leela game-WDL blended with eval via
  lambda.
- SF **does** reach back to T60/T77/T78/T79 — but every old run is **`v6-dd`** (v6 filter +
  dedup) **and syzygy-rescored**. Raw old runs are never used (they regress).

## The levers (what a raw-T80 setup is missing)

1. **`early-fen-skipping=28`** — skip ply ≤ 28. Openings are noise for eval. **BIGGEST
   single lever.** Raw T80 without this burns capacity on the opening.
2. `random-fen-skipping=10`.
3. **Lambda anneal: 1.0 (S1) → ~0.85 → ~0.75.** SF `lambda` = weight on **eval**, so this
   lowers eval-weight from 1.0 → 0.75, i.e. shifts the target from pure eval **toward WDL
   (game-result)** across training (start pure-eval, end 75% eval / 25% WDL). NOTE bullet's
   `wdl` value is the **inverse** (weight on game-result), so the faithful bullet translation is
   `LinearWDL{start:0.0, end:0.25}` — anneal result-weight **up**, NOT `0.75→0.5`.
4. Best-move export > played-move on Elo, but breaks binpack compression (tradeoff).
5. Hyperparams: `max_epochs=800`, `repetitions=3`/stage, `batch=16384`, `lr≈1.08e-3`,
   `gamma≈0.9944`. SPSA-tuned scaling (`pow-exp`, `qp-asymmetry`, `in/out-scaling/offset`)
   is architecture-specific, NOT portable.

## Architecture (current SF state, reference)

- **SFNNv10** (Nov 2025): `Full_Threats` inputs → **+33 Elo**. (We have threats since v9.)
- **SFNNv13** (Feb 2026): doubled **L2 16 → 32** (threats shrank accumulator/L1) → **+8–13
  Elo**. (Applies only to a MULTILAYER tail — our lean net is single-layer.)

## Our pipeline vs the recipe (`chessgo_lean_threats.rs` loader `filter`)

Current filter: `ply >= 16 && !is_checked && score.abs() <= 10000 && mv.mtype==Normal &&
piece_at(mv.to)==None`. WDL: `ConstantWDL{0.6}`. Single-stage, raw T80 (SF-rescored Leela),
no syzygy re-rescore.

| Lever | SF recipe | Us | Action |
|---|---|---|---|
| early-fen-skip | ply ≤ 28 | **`ply >= 16`** | **bump 16 → 28 (one line, #1 cheap win)** |
| capture/quiet filter | d6pv2 | played-move-quiet | close in spirit; keep |
| lambda / WDL | anneal 1.0→0.85→0.75 | **`ConstantWDL 0.6`** | **switch to WDL schedule (map bullet WDL-value vs SF-lambda conventions carefully first)** |
| random-fen-skip | 10 | none | add if bullet supports |
| syzygy rescore | 7-piece always | none | infra-heavy — defer |
| staged SF→Leela | yes | no | needs SF gensfen — defer |

## Roadmap order (cheaper wins first)

1. **Fix the pipeline on our CURRENT T80** — `early-fen-skipping=28` + lambda anneal +
   filtering — retrain → **SPRT vs v12**. Cheapest, biggest EV, helps ANY arch.
2. Add **contemporaneous T80 months** → SPRT.
3. **T78/T79** (v6-dd + syzygy-rescored ONLY) → SPRT.
4. **T60/T77 last** — marginal.

Hard condition on old data: syzygy-rescore + v6-filter + dedup, or it regresses.

## Update 2026-07-10 — deltas + the STRATEGY lives in ENGINE_STRENGTH §34

> The strategic synthesis (scale gap, two-track program, phased roadmap, honest ceiling) is
> **ENGINE_STRENGTH.md §34**. This section adds the recipe-level deltas found since 2026-07-06.

- **Multi-STAGE curriculum (4 stages), not single-pass.** SF from-scratch ≈ pretraining(broad,
  low-quality mix) → pretraining(high-quality, mostly test-series) → fine-tune(low-quality +
  relabeled) → [filter], with **different epoch counts + hyperparameters per stage** (~400 / 800 /
  800 / 800 / 960+ epoch-equiv, est ⇒ ~3,800–4,800 total). We do ONE stage. The curriculum + data
  ORDERING is itself a lever (wiki: broad/SF-gen first, Leela second; **solely-Lc0 is worse**).
- **Full source list (SFNNv10+):** Leela test60, test77, test78, test79, test80-2022, -2023, and
  **test80-2024 Jan–June** (not just Apr); PLUS non-Leela `dfrc_n5000` (SF self-play @5000 nodes,
  DFRC openings), `tb5dtm.binpack` (TB distance-to-mate), UHO book (`UHOx2`, `nodes5000pv2_UHO`).
- **BT4 relabeling:** much OLD data is re-labeled with **BT4** (a later, stronger Leela net) rather
  than kept at its original Q — files tagged `relabel-BT4-tf13tune`. This is the teacher-quality
  upgrade that lets SF run **eval-heavy** lambda.
- **⚠ lambda ↔ relabel are COUPLED (refines lever #3):** SF's eval-heavy anneal (1.0→0.7) rides on
  BT4-relabeled targets. Our `ConstantWDL 0.6` was calibrated to RAW test80-Q (§32 two-AI debate).
  **Do NOT blind-copy 0.7 onto raw labels** — relabel/deeper-teacher FIRST, or run the anneal as a
  true single-variable SPRT. See ENGINE_STRENGTH §34.3.
- **Scale/compute:** we're at ~15% of SF's training volume on ~10% of its diversity; SF-scale volume
  is only ~72–90 GPU-hours on the 4090 (~$25–32). Constraint = pipeline engineering, not compute.

## Implication for the in-flight king-bucket work

The 640-sb KB run (2026-07-06) uses the **weak pipeline** (`ply>=16`, `ConstantWDL 0.6`, no
lambda anneal). So its result is a **current-pipeline baseline**; the marginal KB gain may be
partly pipeline-limited. **The pipeline fixes (step 1) are likely higher-EV than more KB/arch
tuning** — they lift every future net. Do them next, after the 640 finishes.
