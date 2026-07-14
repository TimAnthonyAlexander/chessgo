# SPSA margin re-tune (post SF-selectivity stack)

**What.** Re-tune the search margins now that the SF-selectivity campaign landed
five waves on top of the old tree: `RfpMargin`, `RazorMargin`, `FutBase`,
`FutSlope`, `SeeQuietCoeff`, `CaptSeeCoeff`, `NmpEvalDiv`, `SingularMargin`
(`zugzwang/src/search.cpp`, `Tune` struct; UCI `setoption`), **plus** the new
extension/reduction levers the campaign added: the double-extension margin (fixed
`64` in the singular block), `lmrBase`/`lmrDiv`, and the singular depth/margin
interaction. Expose the ones not yet UCI-tunable.

**Why — sharpened target.** The stack (ttPv + double singular extension +
hindsight + cutoffCnt, branch `feat/sf-selectivity`, tip after d788f19) measures
**+16.8 Elo @ movetime but +25 @ fixed-nodes vs pre-campaign main** (SPRTs
2026-07-14). The ~+8 Elo gap is NOT bad-roads over-pruning (fixed-nodes *rose*,
so selectivity is genuinely smart) and NOT raw NPS (~1-4% only) — it's **tree
cost**: the extensions inflate the tree so movetime realises less depth (d17 vs
d19 at 3s, equal NPS). Same shape as [[conthist-fn-to-mt]] (+19.6 FN / +8 MT).
So the retune's job is **keep the +25 per-node quality while shrinking the tree
the extensions build**, converting the trapped ~+8 into movetime Elo. The old
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
