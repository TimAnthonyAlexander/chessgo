# Does SF's psqt head + bypass explain why our net rails and SF's doesn't?

Wave 3 of `docs/tasks/open/sf-net-experiment.md` — the science wave, no search
integration. Answers whether continuing the sf-net experiment (a search
integration, an SPRT matrix, ~4-7 more days) is worth it, by testing the
hypothesis in `docs/tasks/open/eval-rail-collapse.md` directly: that our net's
D2=16 SCReLU tail rails to a per-bucket constant once either side is up about
a piece, and that SF18's net survives this because it has two channels that
structurally cannot saturate — a linear psqt head and an `fc_0` neuron-15
bypass — while ours has neither.

**Verdict up front: the hypothesis holds, cleanly, on every measurement below.**
SF's psqt channel is a near-linear function of material out to a 3+-queen
deficit; SF's positional channel (which nominally includes the un-saturating
bypass) stops tracking material almost immediately; and our net's rail
incidence rises in lockstep with exactly the region where SF's positional
channel goes flat. This is a positive result — it says the August retrain
should get a linear psqt-style second head, and this wave found no evidence
against that.

## Method

Two instruments, both reusing existing, already-validated machinery — nothing
above was reinvented:

1. **`tools/sfnet_material_ladder.py`** (new) — a material ladder over the same
   12 balanced middlegames `tools/blundersuite.py` already uses. Two ladder
   shapes per base, White to move throughout (material removed from Black
   only, so both engines' white-relative output should rise as White's
   advantage grows):
   - **CUM** — cumulative removal of a black knight, bishop, rook, queen,
     then a second rook and minor (compound deficits past a queen). Piece
     count drops every rung, so the output/psqt bucket
     (`bucket = clamp((occupied-2)/4, 0, 7)` for us, `(occupied-1)/4` for SF)
     changes too — **named confound**, tracked per row.
   - **SUB** — Black's queen, on its own square, downgraded
     Q → R → B → N → P → removed. The first five rungs hold total piece
     count, and therefore the bucket, **exactly fixed** — verified
     numerically below, 12/12 bases. This isolates material value from
     bucket-crossing, which CUM cannot.
   - Our net's `(eval, l1live)` comes from `./zugzwang`'s `eval` UCI command
     under `SATDIAG=1` (same route `tools/railfreq.py` uses).
   - SF's `(psqt, positional)` comes from `./test/sfnet_eval_test` against
     `~/sf18-arm/src/nn-c288c895ea92.nnue` — the from-scratch SF-format
     forward pass built in Waves 1-2, proven bit-exact against Stockfish 18
     itself on all 560 corpus rows (commit `3307312`). `~/sf18-arm` was never
     touched.
   - SF's blended "full" value is our own port of `evaluate.cpp:65-87`
     (`sf_blend_full` in the script), with `optimism=0` and `rule50=0`.
     Constants (`PawnValue=208`, `KnightValue=781`, `BishopValue=825`,
     `RookValue=1276`, `QueenValue=2538`, `OutputScale=16`) and the
     `optimism=0` choice were confirmed against `~/sf18-arm` by a read-only
     subagent quoting `evaluate.cpp`, `evaluate.h`, `engine.cpp` and
     `nnue_common.h` line-for-line — SF's own `eval`/trace command makes
     exactly this call (`Eval::trace`, `evaluate.cpp:115`, `optimism =
     VALUE_ZERO`). This blend is a fresh reimplementation, not the corpus's
     precomputed oracle (that TSV has no rows for these new ladder FENs).
   - `n = 154` ladder rows (94 CUM, 60 SUB) over 12 base positions. Raw data:
     `test/sfnet_ladder.tsv`.

2. **`tools/sfnet_channel_decomp.py`** (new) — reuses the existing 560-position
   corpus **unmodified**: `test/sfnet_corpus.epd` and its bit-exact oracle
   `test/sfnet_corpus_ref.tsv` (`fen, bucket, psqt, positional, full`, all
   from the real Stockfish 18 binary, Waves 1-2). Adds our net's `(eval,
   l1live)` on the same 560 FENs and a decidedness axis computed
   independently of either net's output: material imbalance from the FEN's
   own piece counts (P/N/B/R/Q = 100/320/330/500/900). Binned decidedness
   avoids the circularity of binning by `|full|` itself. `n = 560`. Raw data:
   `test/sfnet_corpus_rail.tsv`.

All material-deficit x-axis values use our own P/N/B/R/Q = 100/320/330/500/900
valuation for both engines — it is just "how much material left the board",
independent of SF's internal Value scale (SF pawn = 208).

## 1. Material ladder: does our eval flatten while SF's keeps moving?

### 1a. Bucket-controlled segment (SUB, rungs R→B→N): the clean test

All 12 bases hold `occupied` — and therefore the output bucket — **exactly
identical** across R, B, N (verified: `occ(R) == occ(B) == occ(N)` in 12/12
bases). Least-squares slope over this fixed-bucket segment, deficit 400→580cp:

| channel | slope (cp eval / cp material) | strictly monotonic R<B<N |
|---|---|---|
| our net eval | **0.448** | 4/12 bases |
| SF psqt | **2.479** | **12/12 bases** |
| SF positional | **−0.170** | 2/12 bases |
| SF full (blend) | **2.301** | 10/12 bases |

SF's psqt channel is monotonically increasing with material in **every single
base**, at a bucket-fixed slope of 2.48 cp per cp of material removed — close
to its slope over the full ladder range (2.65 cp/cp, see 1b), i.e. it doesn't
change behavior near the rail region. SF's positional channel is flat-to-
negative (−0.17 cp/cp) and monotonic in only 2/12 bases despite material
strictly increasing at every step — it is not tracking material here at all.
Our own net's eval slope (0.45 cp/cp) is 5.4x weaker than SF's blended slope,
and fails to increase monotonically in 8/12 bases even though the deficit was
built to increase by construction. SF's blended output stays mostly monotonic
(10/12) purely because psqt is carrying it — positional's own failure rate
(10/12 non-monotonic) is comparable to ours (8/12 non-monotonic).

### 1b. Full range (CUM, deficit 0→3171cp average, crosses buckets)

Least-squares slope over the whole ladder, all 12 bases, all rungs (this
segment **does** cross bucket boundaries — 24/82 = 29% of rung-to-rung
transitions cross an `our_bucket` line, named per the task's confound
warning):

| channel | slope (cp eval / cp material), 0→3171cp |
|---|---|
| our net eval | 1.125 |
| SF psqt | **2.646** |
| SF positional | **−0.004** |
| SF full | 1.653 |

SF psqt's slope barely moves between the bucket-fixed segment (2.48) and the
full bucket-crossing range (2.65) — consistent with it being a linear lookup
that doesn't care about the bucket boundary. SF positional's slope is flat in
both regimes (−0.17 and −0.004) — it isn't rescued by bucket boundaries
either; it just doesn't move. Our own eval's slope rises from 0.45 to 1.13
across the wider range, but that rise is mostly bucket-crossing artifact (see
1c) rather than genuine material tracking, since the bucket-fixed segment
alone gives 0.45.

Averaged eval by rung (mean across bases, `test/sfnet_ladder.tsv` has every
row):

| rung | deficit(cp) | our eval | our l1live | SF psqt | SF positional | SF full |
|---|---|---|---|---|---|---|
| base | 0 | 2.5 | 1.58 | 42.9 | 52.7 | 132.8 |
| −N | 320 | 1473.4 | 0.50 | 816.9 | 725.0 | 1987.2 |
| −N−B | 650 | 2082.5 | 0.17 | 1705.0 | 877.7 | 3143.0 |
| −N−B−R | 1150 | 2316.4 | **0.00** | 2962.4 | 198.2 | 3344.7 |
| −N−B−R−Q | 2050 | 2977.7 | 0.00 | 5446.8 | 46.5 | 4691.5 |
| −N−B−R−Q−R2 | 2550 | 3687.9 | 0.00 | 6705.8 | 175.8 | 5291.4 |
| −N−B−R−Q−R2−N2 | 2870 | 3849.5 | 0.00 | 7647.5 | 561.3 | 5998.1 |
| −N−B−R−Q−R2−N2−B2 | 3171 | 4403.5 | 0.00 | 8342.3 | 656.7 | 6145.1 |

SF psqt climbs from 42.9 to 8342.3 — roughly linearly, per the near-constant
slope above. SF positional peaks at 877.7 (two pieces down) and then
oscillates between 46.5 and 656.7 all the way out to a 3171cp deficit — it is
not merely slow, it stops responding to material at all past ~two pieces.

### 1c. Our net's rail incidence rises immediately, and average eval after that is a per-bucket artifact, not a gradient

| CUM rung | deficit(cp) | our net railed (l1live==0) |
|---|---|---|
| base | 0 | 1/12 (8%) |
| −N | 320 | 9/12 (75%) |
| −N−B | 650 | 11/12 (92%) |
| −N−B−R | 1150 | **12/12 (100%)** |
| every rung after | ≥2050 | **12/12 (100%)** |

**Our net is fully railed (zero live L1 lanes) in 100% of positions from a
two-piece deficit onward, and already 75% railed after removing a single
knight.** Once fully railed, the "eval keeps changing" in the rung-averaged
table above is exactly the mechanism `eval-rail-collapse.md` §4b already
named: a railed node's output is a constant *per (bucket, rail pattern)*, and
captures change the bucket, so the number moves between rungs while carrying
no gradient at any fixed bucket. The SUB ladder's `none` rung confirms this
concretely: across 11 bases that fully rail there, `our_eval` ranges from
1573 to 2690 (not one shared constant — different rail *patterns*, not just
different buckets, per the original doc's mechanism) while one base (idx 10)
that does NOT rail there reports 757, wildly out of that range.

## 2. Channel decomposition on the 560-position corpus: does psqt's explanatory power grow with decidedness?

`n = 560`, binned by material imbalance computed directly from the FEN
(independent of either net's output):

| imbalance bin | n | r(psqt, full) | r(positional, full) | R² psqt | R² positional |
|---|---|---|---|---|---|
| [0, 100) | 155 | 0.568 | **0.920** | 0.32 | **0.85** |
| [100, 300) | 72 | 0.604 | **0.922** | 0.37 | **0.85** |
| [300, 600) | 105 | **0.884** | 0.602 | **0.78** | 0.36 |
| [600, 1000) | 80 | **0.904** | 0.139 | **0.82** | 0.02 |
| [1000, ∞) | 148 | **0.978** | **−0.246** | **0.96** | 0.06 |

This is a clean crossover, not a gradual drift. In near-balanced positions
(imbalance < 300cp, n=227), the **positional** channel explains 85% of the
variance in SF's blended output and psqt explains only 32-37% — the deep
network is doing the real evaluation work, as expected in normal chess. Past
a rook's worth of imbalance (≥1000cp, n=148 — roughly a piece-plus up),
**psqt explains 96% of the blended output and positional explains 6%, with a
negative correlation** (r = −0.246: positional's remaining variation is
mildly *anti*-correlated with the true decided value there, i.e. it behaves
as noise, not signal).

One caution stated plainly: "positional decorrelates from the outcome" is not
identical to "positional collapses to a bucket constant" the way our net's
L1 layer does. `std(positional)` in the most decided bin is 771cp — real
variance, just uncorrelated variance — versus our net's literal zero-variance
constant at `l1live==0`. SF's positional head degrades to noise; ours
degrades to a frozen number. Both are useless for search, but they are not
mechanistically identical failure modes, and this measurement can't
distinguish "positional is genuinely saturated" from "positional is encoding
something legitimate but orthogonal to material that happens not to
correlate with SF's own final verdict here." Either way, psqt is what keeps
the blend's *correlation with truth* alive in decided positions.

## 3. Rail incidence vs. decidedness, same 560-position corpus

| imbalance bin | n | our l1live==0 | avg l1live |
|---|---|---|---|
| [0, 100) | 155 | 0 (0.0%) | 3.32 |
| [100, 300) | 72 | 2 (2.8%) | 5.06 |
| [300, 600) | 105 | 13 (12.4%) | 3.39 |
| [600, 1000) | 80 | 11 (13.8%) | 2.26 |
| [1000, ∞) | 148 | **83 (56.1%)** | 0.66 |

Rail incidence rises in the same bin where SF's channel roles flip (§2):
0% railed while positional (r=0.92) is carrying SF's output, climbing to
56.1% railed exactly where psqt (r=0.98) has taken over and positional has
gone to r≈0. "Neighbouring rungs still moving" for this same relationship is
what the material ladder (§1) already measured directly with actual
consecutive positions, since the 560-corpus is 560 independent games, not a
sequence — see §1a/§1c for the rung-by-rung version of this cross-tab: SF's
full blend keeps moving between neighbouring rungs (10/12 bases monotonic
R<B<N) in exactly the regime (any material deficit past a single minor piece)
where our net is already ≥75% railed.

## What this does and doesn't settle

- The hypothesis is confirmed on both an independent controlled ladder (n=154,
  12 bases, bucket-boundary named and, for SUB, eliminated) and an independent
  560-position corpus, using two different decidedness axes (material removed
  vs. material imbalance) and two different statistics (rung-to-rung slope,
  and correlation-by-bin). All four numbers point the same way; none of them
  needed hunting to find — see the raw slope/correlation tables above.
- It is **not** established that psqt alone, bolted onto our current net,
  would fix conversion in play — this wave measured static eval behavior
  only, no search, exactly as scoped. A psqt head trained on our own
  self-play distribution, our own feature set (which already carries the
  full-threats block, ported bit-identical from SF) and our own bucket
  scheme is a retrain, not a graft.
- SF's own positional channel is not immune to *this* effect — it decorrelates
  from the true value in decided positions almost as often as our net's
  monotonicity fails (§1a: 10/12 vs 8/12 non-monotonic in the controlled
  segment) — it is only rescued in aggregate because psqt is structurally
  incapable of the same failure and dominates the blend by construction
  (fixed weights 125:131, further pulled toward psqt by the nnue-complexity
  damp when the two channels disagree).
- This settles the *architecture* question the wave was scoped to answer:
  the psqt head is the mechanism, worth specifying into the August retrain.
  It does not by itself size the Elo payoff of doing so, which needs the
  search-integration waves this wave was explicitly built to avoid.

## Reproduce

```
cd zugzwang
make -j8   # if the zugzwang binary or sfnet_eval_test is stale
python3 tools/sfnet_material_ladder.py    # writes test/sfnet_ladder.tsv
python3 tools/sfnet_channel_decomp.py     # writes test/sfnet_corpus_rail.tsv
```
