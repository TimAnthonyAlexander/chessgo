# Aggression / dynamism — status + the NNUE plan (deferred)

> **TL;DR.** An eval-bolt-on "aggression" knob was built and SPRT'd (2026-07-02). It is a
> **style lever, not a strength patch**: it wins at shallow depth and loses at real depth
> (its value decays with depth — `ENGINE_STRENGTH.md §24`). The strength-neutral version
> has to live **inside the NNUE**, not on top of it. This doc records that plan. **Not
> being built yet — written down for later.**

## What exists today (shipped as inert scaffolding, default-OFF)
A `0..100` aggression knob, **default 50 = neutral = byte-identical to the shipped engine**
(the term is never evaluated at 50). At >50 it biases toward attacking the enemy king; at
<50, toward solid play.

- Engine: `search.Params.Aggr`; `eval.AggressionTerm(pos)` (`internal/eval/aggression.go`),
  added onto the static eval in `Searcher.rawEvaluate` scaled by `(Aggr-50)/50`; `SetAggr`
  (`internal/search/aggr.go`); bench key `aggr=`.
- Frontend: an "aggression" slider on the admin **Engine vs Engine** page (localStorage),
  wired end-to-end and **gomachine-side only** (absent → 50 at every layer). Full path in
  `ENGINE_STRENGTH.md §24.1`.

**Keep it default-50.** It's safe (zero cost, zero behavior change at rest) and useful as a
*style* control at bot-level depths (sharper, slightly weaker — the correct trade for a
"play aggressively" slider). **Never ship it default-on and never call it stronger.**

## Why the eval bolt-on can't be strength-neutral (the finding)
Same term, three rulers (full numbers in `ENGINE_STRENGTH.md §24.2`):

| Ruler | `aggr=100` vs `50` |
|---|---:|
| fixed depth 8 | **+43.7** |
| fixed depth 12 | **≈ −30** |
| movetime 100ms | **≈ −44** |

The value **decays with depth**. Mechanism: at shallow depth the attack bias substitutes
for tactics the search can't see yet, so it "helps"; at real depth the search already sees
them, so the bias only pushes the eval toward sacrifices deeper search has correctly
rejected. Cheapening the term does **not** fix this — a diagnostic at fixed depth 12
(depth removes the NPS variable) was still negative, and a near-free tropism variant was
*worse* (−65 @ d8). The bias itself is the problem, not its compute cost.

**Corollary lesson:** gate eval changes across ≥2 depths (or at movetime), never a single
fixed depth — a one-depth "win" can be a shallow-search crutch.

## The plan: bake dynamism into the net (the only route that survives depth)
The reason NNUE aggression survives depth is that the net learns *positional* king-attack
value from real game outcomes, not a hand-forced cp bonus that fights the search. Two ways,
smallest-effort first:

### Option A — WDL/sharpness-weighted training target (preferred first try)
Retrain the current arch (single-layer v6, or whatever is current) with the **loss
re-weighted toward decisive, sharp positions** instead of a symmetric MSE/WDL target:
- Up-weight positions/games that ended decisively; down-weight dead draws.
- Optionally add a small term that rewards agreement with the *attacking* continuation in
  won games (king-attack motifs in the winning side's moves).
- This nudges the net toward *dynamism it can actually realize*, because the signal is
  "this sharp position converted to a win," not "add 40cp for pieces near the king."

Ship criterion: **beats the current net at MOVETIME** (or is a movetime wash **and**
measurably sharper — lower draw rate — which is the point of the feature). Same SPRT
discipline as every other net (`ENGINE_ROADMAP.md`). This does **not** give a user-facing
0–100 slider; it shifts the *default* style. A slider would need option B.

### Option B — a dynamism input / conditioning bucket (bigger, later)
To keep a *tunable* aggression dial with net-quality behavior, condition the net on a
dynamism scalar:
- Simplest: **two nets** (neutral + sharp) trained with different target weightings; the
  slider blends or selects. Cheap to reason about, doubles net memory.
- Cleaner: a **style input feature / output bucket** (like the material-count buckets) that
  the net reads, trained across a range of style weightings so one net covers the dial.
  This is the "real" version but is a training + format change; do it only after A proves
  the feature is worth a slider.

## Ordering vs the main roadmap
This is **secondary** to the threats/NPS ladder in `ENGINE_ROADMAP.md` (the path to passing
Stormphrax). Do it when the main net work is between rungs, or if a product need for a
"play style" control becomes concrete. It is **not** on the critical path to strength.

## Cross-refs
- `ENGINE_STRENGTH.md §24` — the full experiment, numbers, hypotheses, diagnostic.
- `ENGINE_STRENGTH.md §14.4` — the fixed-nodes-inflates-eval rule this extends.
- `ENGINE_ROADMAP.md` — the main NNUE ladder this defers to.
