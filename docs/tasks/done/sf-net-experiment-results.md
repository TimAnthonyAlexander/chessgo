# Running Stockfish's net in our search — what it measured

Campaign record, 2026-08-15/17. The design lives in
[`sf-net-experiment.md`](sf-net-experiment.md) (moved here alongside this file); the
per-wave engineering detail is in `zugzwang/docs/sfnet-wave{2,4,5,6,7,8,9}.md` and
`zugzwang/docs/sfnet-rail-comparison.md`. This file is the answer, not the method.

**No Stockfish code is linked, copied or vendored.** The backend is an independent
implementation of the published file format and forward pass, written against
`~/sf18-arm` as a specification. The `.nnue` weights are GPLv3 data from the Stockfish
project, loaded locally for measurement; whether anything ships is a separate decision.

## The question

Our engine is behind Stockfish. How much of that is the net and how much is the search?
Nobody could answer it, because the two had never been separated — so "it's the net/data"
and "it's the search" were both unfalsifiable.

Building a second NNUE backend that runs SF18's own net inside OUR search separates them.

## What it measured

All on coalla (amd64), 1 thread, 100ms unless stated, `book.epd` openings, fastchess
pentanomial.

| match | result | n |
|---|---|---|
| our search, SF's net vs our net — **fixed depth 8** | **+129.58 ± 22.41** (SPRT accepted) | 516 |
| our search, SF's net vs our net — **movetime** | **+39.64 ± 11.32** (SPRT accepted) | 1074 |
| our engine, our net vs `stockfish` | **−214.85 ± 18.38** | 800 |
| our engine, SF's net vs `stockfish` | **−203.83 ± 18.71** | 800 |

**The headline: ~88% of our gap to Stockfish survives handing our engine Stockfish's
exact eval.** Swapping the net closes ~11 Elo of ~215 measured against a common opponent,
~40 measured head-to-head. The gap is search and implementation, not the network.

The +130-at-fixed-depth vs +40-at-movetime split is not a contradiction — it is the same
fact twice. SF's net is a far better evaluator, and most of that advantage is spent
paying for it: our backend runs it at 2.08x fewer nps than SF's own implementation does.

Both numbers moved during the campaign and the earlier ones are stale: movetime was
+26.11 ± 9.52 before Wave 9's accumulator work, so **quote +39.64, not +26**.

## Why our net is worse — measured, not inferred

`zugzwang/docs/sfnet-rail-comparison.md`. The SF backend returns `psqt` and `positional`
as separate channels, so the mechanism is observable rather than theorised.

With the output bucket held **exactly fixed** across 12 bases (a rung that removes a piece
also changes the psqt column *and* the layer stack — this control is load-bearing):

| | monotonic in material |
|---|---|
| SF `psqt` (linear head) | **12/12 bases** |
| SF `positional` (deep path) | 2/12 |
| our eval | 2/12 |

Our rail incidence — `l1live == 0`, meaning the tail output IS a per-bucket constant —
runs 8% balanced → 75% down a knight → 92% down N+B → **100% from N+B+R on**.

On the independent 560-position corpus, which channel carries SF's blended output flips
with decidedness: `r(psqt, full)` 0.63 → 0.83 → 0.90 → **0.98** as `|material imbalance|`
grows, while `r(positional, full)` 0.94 → 0.65 → 0.14 → **−0.25**.

So past about a piece, SF's deep path stops tracking and its **linear psqt head carries the
eval**. Ours has no such channel. That is an architecture argument for the retrain, with a
number attached.

One caveat kept rather than buried: SF's positional channel *decorrelates* but does not
freeze — `sd(positional)` stays ~770cp in the most decided bin, where ours collapses to a
literal constant. Both are useless to a search; they are different failure modes.

## What was built

`make sfnet` → `zugzwang_sfnet`. Compile-time `-DSFNET_BACKEND` switches
`EngineAccStack` between `NNUE::AccStack` and `SFNet::AccStack`, so the production engine
pays nothing — no branch, no indirect call, and its search output is **byte-identical to
main** (depth/score/nodes/hashfull/pv/bestmove across 24 positions at depth 11).

Gates, all re-run independently rather than taken on report:

- **560/560 bit-exact** against Stockfish's own `(psqt, positional)` ints, all 8 buckets,
  all four king-mirror combinations, on arm64 and amd64
- **11,089,304 interior nodes, 0 accumulator drift** vs the from-scratch oracle
- loader refuses the small net and a truncated file; every hash **recomputed** from the
  architecture rather than read from the file and compared to itself
- `golden_check` 38/38 throughout

That bit-exactness settled something the design doc could only assert from reading source:
**our threat block really is bit-identical to SF's `FullThreats`**, since the SF backend
drives our `active_features()` threat half unchanged and one wrong index among 79,856
would move `positional`.

`tools/sfnet_parse.py` is a stdlib-only reference parser and the loader's oracle.

## Speed: four attempts, one worked

Our backend vs SF's own implementation on the identical net: **737,142 vs 354,750 nps**.

| wave | lever | amd64 |
|---|---|---|
| 6 | hand-written AVX-512/AVX2 kernels | +0% |
| 7 | load-time weight permutation (SF's `PackusEpi16Order`) | +4.1% |
| 8 | block-sparse `fc_0` | −3.8% |
| **9** | **deferred materialization** | **+10.0%** |

The pattern is the lesson. Waves 6-8 bet on instruction selection and the forward pass;
Wave 9 did strictly less work. `fc_0` runs once per **eval**; the accumulator runs once per
**move** over ~8KB of working set, and that is the term that scales with the tree.

Wave 6's failure has a specific cause worth remembering: **GCC already auto-vectorizes
these loops to AVX-512** (2,694 zmm/VNNI instructions in our binary), so hand intrinsics
compete with the autovectorizer rather than replacing scalar code.

Wave 8 is the cleanest example of a measurement beating an estimate: 82.2% of the 1024 FT
activations are exactly zero, `find_nnz` would visit 44% of chunks against a dense 100%,
projecting **2.28x on that layer** — and it measured **−3.8%** overall, because `fc_0` is
1024→16, about 256 vector ops, and scanning for the non-zeros costs the same order.

## Negative results — the more useful half

Five ideas were killed by measurement. Recording them so they are not re-proposed.

1. **The washed ledger does not come back with a sighted eval.** The hypothesis: levers
   gating on `eval` were condemned on a net that rails on 100% of decided positions, so a
   sighted eval should exonerate the good ones. Re-tested under SF's net, 1000 games each:
   `CORRMARGIN` −2.1, `RFPDEEP` −5.2, `RAZORQUAD` −9.7, `NMPSF` −0.00, `CAPFUT` +2.1.
   **None flipped positive.** `NMPSF` is the sharpest refutation — −27 with our net, and
   with a sighted eval it lands on exactly 0.00 rather than turning good. See
   [`washed-ledger-retest.md`](washed-ledger-retest.md).
2. **`margins2` joint SPSA: rejected**, −3.47 ± 8.93 over 1600 confirmation games after
   4000 iterations — including the two margins (`FutBase`, `CaptSeeCoeff`) that a stale
   UCI-min note had pinned out of every previous joint tune.
3. **Narrowing RFP toward SF's value loses**, −5.89 ± 9.54 over 1238 games.
4. **SF's weight permutation does not apply to our own net.** Structural, verified at the
   instruction level on the shipped amd64 binary: `vpackuswb` 0, `vpshufb` 0, `vpermw` 0
   against `vpmovwb` 16. SF permutes to undo `packus`'s lane-crossing; we narrow with a
   truncating single-source convert and have nothing to undo.
5. **A single cp scale factor `k` does not hold.** `k = 0.481` (= 100/208) is defensible
   and is what ships (`SFNETK=48`), corroborated by a bucket-fixed material ladder at
   0.444 — but per-position corpus medians say ~0.68. The lesson is a category error worth
   avoiding: `k` was fitted on eval **levels**, and a pruning margin's correct size depends
   on the eval's **spread** where it bites. Converting one with the other's factor produces
   a confident-looking number that means nothing — it is what produced the discarded
   "our RFP is 2.3x wider than SF's" claim.

## Where the ~189 Elo is not

It is not the net. It is not the already-written, already-rejected levers. It is not the
forward pass. Follow-ups that remain live are in
[`../open/sfnet-followups.md`](../open/sfnet-followups.md).
