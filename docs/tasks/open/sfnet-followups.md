# SF-net backend — what is still open

The campaign and its results: [`../done/sf-net-experiment-results.md`](../done/sf-net-experiment-results.md).
Read the negative-results section there BEFORE proposing anything here — five ideas were
already killed by measurement, including the two most obvious ones.

Ranked by expected value.

## 1. The refresh cache — the last untried piece of the 2.08x

We run SF's net at 354,750 nps against SF's own 737,142 on the identical net. Wave 9
showed the cost is accumulator traffic, not kernel width, and closed 10% of it by
deferring materialization. The piece we have NOT ported is SF's
`update_accumulator_refresh_cache` (`~/sf18-arm/src/nnue/nnue_accumulator.cpp`): when a
king move forces a full base rebuild, SF diffs against a cached accumulator for that king
bucket instead of re-enumerating the position from scratch.

Check first, because it may already be answered: our own net has the equivalent (`Finny`,
`src/nnue_accumulator.cpp`) and it is **arch-gated default-ON for arm64 / OFF for amd64**.
Understand why it lost on amd64 for our net before assuming it wins for the SF backend —
that reason may transfer, in which case this is a short investigation rather than a port.

Worth ~40-70 Elo if the full 2x closes, on the movetime number specifically.

## 2. Sweep `SFNETK`

Never done. Ships at 48 (= 100/208). The bucket-fixed material ladder says 0.444, corpus
medians say ~0.68 — a 40% spread that has never been arbitrated by games. It is a runtime
env knob, so a sweep needs no rebuild: `SFNETK=48` vs `SFNETK=68` on `zugzwang_sfnet`,
both arms the same binary.

Cheap, and it could move the +39.64 movetime result in either direction.

## 3. Tests 3 and 4 at SPRT rigour

`−214.85 ± 18.38` (our net) and `−203.83 ± 18.71` (SF's net) against `stockfish` are
800-game point estimates, not SPRTs. They carry the campaign's headline claim (~88% of the
gap is not the net), so if that number is going to be load-bearing anywhere it should be
measured properly. Note the difference between them (11.0) and the direct head-to-head
(+39.64) disagree by more than either error bar — trust the direct measurement, and treat
that disagreement as a reminder that transitive Elo chains across engines do not hold.

## 4. Confounds that would make test 3 a fair search-vs-search comparison

Currently `zugzwang_sfnet` is handicapped in ways that are not search quality:

- **We collapse SF's `(psqt, positional)` pair into one scalar.** SF's own search consumes
  the pair plus `nnueComplexity` natively. Restoring it through `corrected_eval` is a
  prerequisite for calling test 3 a clean search comparison — and `EVALCOMPLEXITY` exists
  on our side precisely as a proxy for the pair we did not have.
- **We are big-net-only.** SF switches to its small net above `|simple_eval| > 962` and
  re-evaluates with the big one when the small returns `|nnue| < 277`. That is a strength
  difference, not only a speed one. The small net's shape is already parsed and confirmed
  (`tools/sfnet_parse.py --small`).

## 5. The retrain case

Independent of everything above, and the reason the experiment was worth running: our net
has no linear channel that survives a decided position. SF has two — the 8-bucket int32
psqt head and the `fc_0` neuron-15 bypass — and the measurement in
`zugzwang/docs/sfnet-rail-comparison.md` shows the psqt head carrying the eval exactly
where ours goes constant.

Note this is NOT settled by the washed-ledger negative. That result says eval blindness is
not what condemned those particular levers; it says nothing about whether a net that stays
sighted is worth Elo in its own right.
