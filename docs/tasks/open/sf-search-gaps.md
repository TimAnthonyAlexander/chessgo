# SF18 search gaps — untried levers backlog (search is NOT dry)

Every SF18 search/ordering technique zug still lacks or has a weaker version of, from a
full code diff of `~/sf18-arm/src` vs `zugzwang/src` (2026-07-15). **Search has a LOT of
Elo left** — "the net is the gap" is cope; this engine has pulled hundreds of Elo out of
"dry" wells. Net retrain is an August thing and won't close half the gap. Work these.

**Before touching any of these, check the WASHED ledger** (`gomachine/engine/docs/OPTIMIZATIONS.md`
REJECTED table + `docs/tasks/done/smp-search-wave-2026-07-15.md`) so you don't re-run a loser.
Already washed on zug, NOT here: NMP cutNode-gate alone (−27), full capture-loop ProbCut (+4.1),
rule50+material eval scaling (−7.6), HistPrune, lmrDepth-futility, D.5 SEE-quiet-linear, D.7 check-ext.

Each item: SF file:line, what zug has, value band (rough), effort. Gate = movetime SPRT on coalla
(env-flag A/B, same-binary wrapper trick). A "washed SF technique" usually means OUR port is
incomplete, not that the technique is bad — port the whole mechanism, not a fragment.

## A. Build-ons (leverage tables/machinery already shipped — lowest risk, do first)

1. **Capture history in PRUNING + REDUCTION** — SF feeds `captHist` into the capture-SEE margin
   (`search.cpp:1077` `max(166*depth + captHist/29, 0)`) and the LMR statScore (`search.cpp:1216`).
   Zug shipped the ordering read only (`docs/tasks/done/capture-history.md`). Scale SF's constants to
   zug's `PieceVal`/history magnitudes. **~+3–8, low risk, build-on.**
2. **ContHist more plies (2 → 3/4/6)** — SF reads plies 1,2,3,4,6 + updates 1–6, split by
   `[inCheck][capture]` (`search.cpp:992`, `history.h:150`); zug has only 1-ply+2-ply
   (`contHist1/2`). **~+10–20 ceiling BUT real read-cost headwind** (see the FN→MT / warm-read
   findings — cold plane first-touch is the cost; more planes = more cold touches). Read SF's
   *selective* ply subset. Medium-high effort, temper the movetime expectation.

## B. Null-move — the FULL rewrite (the gate alone lost; the whole thing is untried)

3. **SF NMP rewrite** — zug null-moves at ALL non-PV nodes with `eval>=beta` (over-prunes, hides
   zugzwangs). SF: **cutNode-only gate** + relaxed margin (`beta-18*depth+350`) + **depth-only R**
   (no `(eval-beta)` term) + **verification search at depth≥16** (`nmpMinPly`, `search.cpp:906-919`).
   The gate *alone* washed −27 — because it needs the rest. Porting the whole mechanism is untried.
   **Medium-high value, medium risk.** `SF_MARGINS.md` §Null-move R has the full spec.

## C. Correction history — expand + wire into margins

4. **Corrhist variants** — SF has 5 (pawn/minor/nonpawn/pieceTo/continuation); zug has 2 (pawn,
   nonpawn). Add **minor / pieceTo / continuation** (`history.h:160-166`). **low-single each.**
5. **Fold |correctionValue| into futility + LMR** — SF uses it as an uncertainty discount:
   `futility += |corrValue|/174665`, `lmr r -= |corrValue|/30370`. Zug reads `correction()` only to
   adjust staticEval, never as its own pruning/reduction signal. **~+3–6, cheap (values already computed).**

## D. Pruning / extension refinements

6. **RFP softened return + gate** — SF returns `(2*beta+eval)/3` (not raw eval), gated
   `depth<14 && !ttPv && (!ttMove||ttCapture)` (`search.cpp:876-889`). Zug returns raw eval, no gate.
7. **Razoring curve** — zug linear (`eval+200*depth<=alpha`); SF quadratic (`eval < alpha-485-281*d*d`).
8. **Negative extension magnitude** — zug `-2/-1`; SF `-3/-2` (larger). Cheap SPRT.
9. **Multi-cut returns `s` not `singularBeta`** — `SF_MARGINS.md` C.7; zug returns the fixed margin.
10. **ttMoveHistory** → feeds the double/triple-extension margin (SF `history.h:216`); zug uses flat
    constants. Bundle with triple-ext (parked in `spsa-margin-polish.md`).
11. **Capture-SEE stalemate-sac guard** (`search.cpp:1077`, `non_pawn_material != PieceValue[moved]`)
    + **qsearch stalemate-avoidance** (`search.cpp:1708-1721`) — SF has both; zug neither. Correctness
    + tiny Elo, but real edge cases.

## E. New ordering history tables

12. **Low-ply history** (`LowPlyHistory`, `search.cpp:179`, `8*val/(1+ply)`) — root-adjacent. small.
13. **Pawn-structure history** for ordering (`PawnHistory`, `history.h:153`) — SF bumps it with the
    eval-diff term. small-medium.

## F. Aspiration / eval post-processing (partly washed — narrow angles remain)

14. **Adaptive aspiration delta** — SF `5 + |meanSquaredScore|/9000` (volatility-scaled), widen `/3`;
    zug fixed `25`, widen `/2`. Interacts with time-mgmt — isolate. small.
15. **SF LMR terms** — aspiration-window-relative (`delta*608/rootDelta`) + `allNode` self-scaling
    (`r += r/(depth+1)`); zug has neither. small each.
16. **Optimism from root-avg score / rule50-damping ALONE** — the rule50+material COMBO washed −7.6,
    but rule50-damping alone and optimism alone are untested (`smp-search-wave` note). low priority.

---
**Ranking (value × freshness × ease):** A1 (capthist→pruning) > B3 (NMP rewrite) > C5 (corrhist→margins)
> A2 (conthist plies) > C4 (corrhist variants) > D6-11 (refinements, bundle for SPSA) > E/F (small).
Start at A1: it's a build-on the just-shipped table, low-risk, and SF proves the technique.
