# SPSA margin re-tune (post SF-selectivity stack)

> **LMR-CLUSTER JOINT SPSA — DONE 2026-07-17 → WASH, reverted (`60e3a4f` reverts `7bbe90e`).**
> Exposed 6 LMR/ext constants (RootDeltaCoeff, CorrMarginDiv, AllNodeDiv, DblExtMargin,
> LmrBase, LmrDiv) + a combined `LMRCLUSTER` flag enabling the 3 co-dependent fine-terms
> (rootDeltaLmr+allNodeLmr+corrMargin) together. Key finding: the **bundle at default constants
> beat base +3.9 @1600g** where each term washes SOLO — co-tuning is real. 3000-iter joint SPSA
> drifted meaningfully off SF defaults (DblExtMargin 64→25, RootDeltaCoeff 608→480, LmrBase
> +20%) — a "deepen the critical move, cut everything else harder" profile. BUT the tuned theta
> **did not confirm as a win vs base:** final-theta vs base +8.0 ±8.7 @1600 (LB −0.66, under bar);
> iter-2950 theta vs base −11.5 @574; final-vs-iter2950 head-to-head +2.8 ±9 (wash → the two
> near-identical points are equal strength, so the +8/−11.5 straddle is pure noise on one quantity
> ≈ 0). Verdict: **SPSA found a basin, not an edge.** Reverted. The 6 constants stay UCI-settable +
> the `LMRCLUSTER` flag stays (default-off) for any future re-tune with larger batch/more games —
> the per-iter noise (batch 8) likely too high to resolve a true ~+3 effect. Do NOT re-ship on a
> single vs-base SPRT; require an A/B stability cross-check.


**What.** Re-tune the search margins now that the SF-selectivity campaign landed
five waves on top of the old tree: `RfpMargin`, `RazorMargin`, `FutBase`,
`FutSlope`, `SeeQuietCoeff`, `CaptSeeCoeff`, `NmpEvalDiv`, `SingularMargin`
(`zugzwang/src/search.cpp`, `Tune` struct; UCI `setoption`), **plus** the new
extension/reduction levers the campaign added: the double-extension margin (fixed
`64` in the singular block), `lmrBase`/`lmrDiv`, and the singular depth/margin
interaction. Expose the ones not yet UCI-tunable.

**Why — sharpened target.** The stack (ttPv + double singular extension +
hindsight + cutoffCnt, branch `feat/sf-selectivity`, tip after d788f19) measures
**+16.8 Elo @ movetime (LB +3.9) but +20.0 @ fixed-nodes (LB +11.1) vs
pre-campaign main** (settled SPRTs 2026-07-14). The ~+3 Elo gap is NOT bad-roads
over-pruning (fixed-nodes *rose*, so selectivity is genuinely smart) and NOT raw
NPS (~1-4% only) — it's **tree cost**: the extensions inflate the tree so movetime
realises slightly less depth (d17 vs d19 at 3s, equal NPS). Same shape as
[[conthist-fn-to-mt]] (+19.6 FN / +8 MT) but smaller. So the retune's job is
**keep the per-node quality while shrinking the tree the extensions build**,
converting the trapped ~+3 (and any margin slack) into movetime Elo. The old
cp-margins were also bulk-transplanted from gomachine and never re-tuned for
zug's (now further-changed) tree.

**Where.** `zugzwang/spsa/` harness; movetime SPRT the winner on coalla
(`zugzwang/sprt.sh`) before baking into `Tune` defaults. Gate: the retuned build
must hold/improve the movetime SPRT vs the stack AND not regress the fixed-nodes
number (`zugzwang/sprt_fn.sh`, `nodes=50000`) — don't buy movetime depth back by
throwing away per-node quality.

**Also parked here:** revisit Wave 6 **triple extension** (`TRIPLEEXT=1`, default
off, commit 724f0c3) in the extension-margin sweep — its fixed `-200` margin
over-fires in endgames and wants tuning, not a constant.
