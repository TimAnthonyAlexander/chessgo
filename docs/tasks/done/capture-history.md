# Capture history (SF CapturePieceToHistory) — SHIPPED

**Done 2026-07-15, default-on, on main.** A learned capture-ordering table, ported from
Stockfish 18's `CapturePieceToHistory`. Zug previously ordered captures by static
MVV-LVA + a binary SEE good/bad split only — no learned signal — so this had room.

## What shipped

- **Table** (`search.cpp`, `Context::captHist`): `int16_t[CONT_PIECE_NB][SQUARE_NB][PIECE_TYPE_NB]`,
  keyed `[movedPieceDense][to][capturedType]`. ~10 KB. House-style int16 gravity
  (`update_cont_entry`), cleared in `reset_tables`.
- **Read** (capture branch of `score_moves_impl`): `mvvlva += captHist[...] * captHistWeight / 256`,
  real captures only (`cap`, not non-capture promotions). Default `captHistWeight = 128`
  (= half weight) keeps it under a queen's MVV term so MVV stays primary for big captures
  and history breaks ties / reorders similar-value captures (SF's balance).
- **Update** (beta-cutoff block): bonus (`depth*depth`) to the cutoff capture; malus to every
  searched-but-not-best capture (a new `capturesSearched[]` collection, mirrors `quietsSearched[]`).
  Malus runs on ANY cutoff (quiet or capture). qsearch reads but never updates (SF parity).
- **Gating**: `Tune::captHist` default **true** (deploy-active). `CAPTHIST=0` kill-switch =
  byte-identical to pre-capthist. `CaptHistWeight` is a SPSA-tunable UCI option (clamp 16..512).

## Result

- **Movetime SPRT** (coalla, `CAPTHIST=1` vs 0, 100 ms): **modest win, ~+10 Elo** — settled from
  +23 (178g) → +14 (460g) → +9.8 (1062g), LLR climbing steadily (never negative), CI just above 0.
  Called as a modest win at ~1062g rather than grinding the slow `[0,5]` test to formal accept
  (a ~+10 effect sits near the elo1=5 boundary → resolves slowly by design).
- **SPSA on `CaptHistWeight`** (focused, 37 iters): objective **FLAT around 128** — the weight
  orbited 115–144 with no directional pull. 128 stands; no tuning gain. (The `score` column in
  the SPSA log is a paired ±1–2-game noise probe between near-identical engines, NOT a fitness
  curve — it oscillates around 0 by construction; watch `theta`, not `score`.)

## ⚠️ Notable: won in zug, WASHED in gomachine

gomachine's docs list capture history among "the cheap long tail (conthist/IIR/**capthist**/
probcut/razor) — all SPRT'd flat/negative on our already-heavily-pruned baseline"
(`gomachine/CLAUDE.md`). It won here (+10) because **zug's capture ordering was pure MVV-LVA+SEE
with no learned table** — different baseline, real headroom. This was a **direct zug-side SPRT**,
not inherited. Lesson: a technique washed on one engine can win on another with a weaker version
of that subsystem — measure on the actual target.

## Follow-on still OPEN (fresh)

SF uses capture history in **more than ordering** — it feeds the **capture-SEE pruning margin**
(`search.cpp:1077`, `max(166*depth + captHist/29, 0)`) and the **LMR statScore**
(`search.cpp:1216`, `868*PieceValue/128 + captHist[...]`). Zug only wired the **ordering** read.
Extending the table we now maintain into pruning/reduction is a genuine fresh sub-lever
(build-on, not a re-do). Scale SF's constants to zug's `PieceVal`/history magnitudes, gate + SPRT.
