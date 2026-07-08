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

## Implication for the in-flight king-bucket work

The 640-sb KB run (2026-07-06) uses the **weak pipeline** (`ply>=16`, `ConstantWDL 0.6`, no
lambda anneal). So its result is a **current-pipeline baseline**; the marginal KB gain may be
partly pipeline-limited. **The pipeline fixes (step 1) are likely higher-EV than more KB/arch
tuning** — they lift every future net. Do them next, after the 640 finishes.
