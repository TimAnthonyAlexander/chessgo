# SPSA margin tuning — DEFERRED (low priority)

**Status:** DEFERRED — not worth the compute right now. Revisit only after the eval gap closes.
**Owner:** engine
**Created:** 2026-07-05

## Why deferred (read before re-running)

Two independent reasons this is picking scraps:

1. **The tuning surface is flat.** A full 1200-iteration SPSA (2026-07-05) landed every margin
   **mid-range, nothing pinned to an extreme** — i.e. the current defaults are already near-optimal
   and the gradient is ~zero. Best case a few Elo, and the values likely transfer.
2. **We are ~280 Elo EVAL-bound** (the 2026-07-05 anchor). Tuning search margins optimizes the 3rd
   decimal while the 1st is eval. The lever is the **data retrain** (`data-retrain-640sb.md`), not this.

3.5h of coalla compute for a likely-few-Elo, likely-transfers result → not now.

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
