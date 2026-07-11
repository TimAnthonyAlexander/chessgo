# SPSA margin tuning — HIGH PRIORITY (stale defaults = free Elo)

**Status:** DONE / no further gain on the current net. The historical **+38.7 ± 5.5 Elo movetime**
margin re-tune (v6-tuned margins applied to the pre-full-threats v12 net; 640 pairs, lb +33.2) is
**real and shipped** — keep it. **CORRECTED 2026-07-11:** the forward claim "a proper native SPSA
almost certainly finds MORE" **did not hold** — SPSA on the current SF full-threats net
(`chessgo_threats_sf_640`) found **NO gain** (the margins are already optimal for this net). SPSA is
no longer a live lever here; forward plan is `docs/NNUE/SF_PARITY_ROADMAP.md`.
**Owner:** engine
**Created:** 2026-07-05

## Why this is now HIGH priority (the stale-defaults finding)

The "flat surface / scraps" read was a misdiagnosis. The margins landed mid-range not because the
surface is flat but because the **defaults were stale** — `nullr=4` (an earlier SPSA optimum) and
`seequietmargin=150` (an earlier sweep peak) were tuned *before* v9→v12 and the full search stack;
the engine grew past its own hand-tuned constants and the optimum drifted. Even a **v6**-imperfect
re-tune recovered **+38.7 movetime on v12**. So:
- **Shipped now:** `singulardepth 8→6, seequietmargin 150→103, captseemaxdepth 6→4, nullr 4→3`
  (DefaultParams flipped; SPRT above).
- **Next:** ~~a proper v12-native SPSA over these + an expanded registry, expecting further gains.~~
  **Done (2026-07-11): the native SPSA on the current full-threats net found NO further gain** —
  margins are optimal for this net. (History preserved; this bullet no longer describes open work.)
- Caveat that still holds: we're also ~280 Elo EVAL-bound (`data-retrain-640sb.md` is the bigger
  lever). But search is NOT dry — stale defaults left real Elo on the table, and SPSA reclaims it cheaply.

## The 2026-07-05 run was a THROWAWAY (v6-clobber bug — since fixed)

The run completed 1200 iterations but **tuned against v6, not v12**: `player.play` (`match.go`) called
`nnue.SetEnriched(p.enrichedNet)` every move, and the SPSA built players with a nil `enrichedNet`, so
the startup `loadEnrichedDefault()` (v12) was cleared to v6 on the first move. SEE/singular/null-move
margins scale with eval magnitude/noise, which differ between nets, so the output is **not prod-valid**.

**Fixed in `df51c9d`** ("make v12 the default eval everywhere; fix v6-clobber in SPRT/SPSA/Calibrate"):
a `defaultEnriched` field is now threaded into the SPSA/SPRT/Calibrate players. SPRT was always fine
(it threads `--new-lean`/`--old-lean` into `enrichedNet`); only SPSA/Calibrate were affected. The
earlier gauntlet **anchor is valid** (gauntlet reads the process-global once, never clobbers).

### v6-tuned result (throwaway — do NOT ship these)
| param | tuned (v6) | range | default |
|---|---|---|---|
| singularmargin | 2 | 1–4 | 2 |
| singularmindepth | 6 | 5–9 | 8 |
| seequietmargin | 103 | 60–250 | 150 |
| seequietmaxdepth | 6 | 4–8 | 6 |
| captseemargin | 25 | 10–60 | 25 |
| captseemaxdepth | 4 | 4–8 | 6 |
| nullmover | 3 | 3–6 | 4 |

## If revisited (correct procedure, v12)

- Binary must include `df51c9d` (threads v12 into SPSA players). Verify at startup and by sanity —
  a valid v12 run should NOT reproduce the v6 margins above.
- `LEAN_NET_PATH=data/nnue/v12.bin ./bin/gomachine bench spsa --params "singularmargin:1:4,singularmindepth:5:9,seequietmargin:60:250,seequietmaxdepth:4:8,captseemargin:10:60,captseemaxdepth:4:8,nullmover:3:6" --iterations 1200 --pairs 16 --nodes 25000 --concurrency 12`
- **Bigger win = expand the tunable registry first** (`internal/bench/spsa_fields.go`): promote the
  LMR base/divisor + history bonus/malus + RFP/futility consts to Params fields and register them.
  The 8 current fields are already-swept margins (flat surface); the untapped leverage is LMR/history.
- Final θ **must clear a movetime SPRT** vs defaults (lower bound *stably* >0) before shipping.

## Related
- `docs/open_tasks/data-retrain-640sb.md` (the real lever — eval).
- `df51c9d` (the net-threading fix).
