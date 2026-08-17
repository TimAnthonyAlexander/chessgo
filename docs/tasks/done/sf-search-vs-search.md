# RESOLVED — see ../done/sf-net-experiment-results.md

Both halves of this task were answered, and the static half was answered NEGATIVELY.

**The games half ran.** `zugzwang_sfnet` vs `stockfish` (test 3): −203.83 ± 18.71 over 800
games. `zugzwang` vs `stockfish` (test 4): −214.85 ± 18.38. So holding the net constant
leaves ~88% of the gap standing. Live follow-ups moved to ../open/sfnet-followups.md.

**The static half was wrong, and the table below is retained only as a worked example of
the error.** Converting margins with `k = 0.481` produced "our RFP slope is 2.3x wider
than SF's" and "our singular margin 2-5x wider". A direct SPRT settled it: `RfpMargin`
84→60 measured **−5.89 ± 9.54 over 1238 games**, and a subsequent 4000-iteration joint
SPSA over the whole margin set was rejected at −3.47 ± 8.93. The category error: `k` was
fitted on eval LEVELS, while a pruning margin's correct size depends on the eval's SPREAD
in the regime where it fires. Those are different quantities and one does not convert the
other.

The one row that survives is structural rather than numeric: **SF18's null-move reduction
(`R = 7 + depth/3`) has no eval term at all**, while ours SPSA-tunes `nmpEvalDiv`. That is
a shape difference, not a tuning difference, and is still untested. (Note `NMPSF` — the SF
null-move rewrite — measured −0.00 under a sighted eval, so temper expectations.)

---

# SF18 vs zugzwang on the SAME net — how much of the gap is search

Tests 3 and 4 of `sf-net-experiment.md` §7, now unblocked: with `zugzwang_sfnet`
loading SF18's own net, a match against `stockfish` holds the EVAL CONSTANT and the
difference is search. Until Wave 2 landed, every search comparison was confounded by
the net, and every washed SF technique could be blamed on it. That excuse is gone.

Two halves, and the cheap half needs no games at all.

## 1. The static half — margins in common units (no games)

Wave 5 pinned the eval-scale conversion at **k = 100/208 = 0.481** (SF `Value` →
our cp). That makes our SPSA'd margins and SF's shipped constants directly
comparable for the first time.

**This conversion is not new to the codebase** — `search.cpp:3051-3055`'s `razorQuad`
already ships SF's razoring constants pre-scaled by exactly it (`485 → 233`,
`281 → 135`). Wave 5 arrived at 0.481 independently from the material ladder, so the
two agree. Anything below that contradicts `razorQuad`'s constants is an arithmetic
error, not a discovery.

> **DOUBT RAISED — do not act on the table below without settling this first.**
> Our `RfpTtHitCoeff` defaults to **23**, and SF's RFP is `futilityMult = 76 - 23*!ttHit`.
> That 23 is identical and UNSCALED, and our `rfpMargin = 84` sits next to SF's 76 — so
> our RFP margins look like they were ported at SF's RAW scale, never converted by
> 0.481. SPSA then moved rfpMargin 75→84, *away* from where a 0.48 rescale would put it
> (~37), which is what you would expect if 84 is already near-optimal for our eval.
> If that reading is right, the "we are 2.3x wider" and "2-5x wider" rows below are
> wrong, and the k=0.481 lens does not apply to margins at all — 0.481 was fitted on
> eval LEVELS, and a margin's correct scale depends on the eval's spread in the regime
> where it bites, which is not the same quantity.
> Being settled empirically instead of by more source-reading: an SPRT of
> `RfpMargin=60` vs `84` on our own engine, same binary both sides (the margins are
> UCI-settable, so no rebuild). If narrowing wins, the table is right; if it washes or
> loses, SPSA already found the optimum and the table is an artifact of a bad conversion.

First pass, **unverified beyond a read of both sources** — confirm each before acting:

| lever | ours | SF18 | in our cp | note |
|---|---|---|---|---|
| RFP slope | `rfpMargin = 84` per depth | `futilityMult = 76` (ttHit) per depth | SF ≈ **36.6** | we are ~2.3x WIDER, i.e. we prune LESS |
| RFP improving term | `rfpMargin * improving` = 84 | `2474 * futilityMult / 1024` = 183.6 | SF ≈ **88** | near-identical, no action |
| razoring | linear, `222 * depth`, capped `depth<=3` | quadratic, `485 + 281*d^2`, uncapped | SF ≈ `233 + 135*d^2` | already ported as `RAZORQUAD`, **default OFF** |
| singular margin | `35 * depth / 16` = `2.19*depth` | `(53 + 75*ttPv&&!PvNode) * depth / 60` | SF ≈ `0.43*depth`, `1.03*depth` ttPv | we are 2-5x wider, i.e. we extend LESS |
| NMP reduction | `R` includes `min((eval-beta)/nmpEvalDiv, 3)`, `nmpEvalDiv = 120` | `R = 7 + depth/3`, **no eval term at all** | — | we SPSA a term SF deleted |

The RFP and singular rows are the interesting ones: both say we are more conservative
than SF by roughly a factor of 2 in common units, in the two places that most control
tree shape. `nmpEvalDiv` is more pointed still — SPSA moved it 200→120 on a term SF
does not have, so it may be tuning a shape rather than a value.

Caveat that decides whether any of this is real: our margins were SPSA'd against OUR
net's output distribution, which Wave 3 measured as **railing to a per-bucket constant
on 100% of positions once a side is down N+B+R**. A margin tuned against a blind eval
is not obviously comparable to one tuned against a sighted one. Which is exactly why
the games half has to hold the net constant.

## 2. The games half — tests 3 and 4

| # | match | regime | answers |
|---|---|---|---|
| 3 | `zugzwang_sfnet` vs `stockfish` | matched TC, 1 thread | search vs search, SAME net |
| 4 | `zugzwang` vs `stockfish` | matched TC, 1 thread | the total gap (baseline) |

`3 - 4` decomposes the gap. `~/zugmatched.sh` on coalla already does matched-TC
1-thread measurement; reuse it rather than writing a third harness.

Confounds to state next to any number, not discover afterwards:

- **We feed our search a degraded signal.** SF consumes the `(psqt, positional)` PAIR
  natively plus complexity and optimism; we collapse it to one rescaled scalar. Some
  of test 3's gap is that collapse, not search quality. Restoring the pair through
  `corrected_eval` is a prerequisite for calling test 3 clean.
- **We are big-net-only.** SF switches to its small net above `|simple_eval| > 962`
  and re-evaluates with the big one when the small returns `|nnue| < 277`. That is a
  strength difference as well as a speed one.
- **Implementation speed is not search quality.** Our backend was 2.02x slower than
  our own engine before Wave 6; SF ships mature AVX2/AVX-512. A matched-TC number
  mixes both. Report the NPS ratio beside the Elo or the number means little.
- SF's net was trained on SF self-play for SF's search.

## 3. Why this is worth doing now

`gomachine/engine/docs/OPTIMIZATIONS.md` carries a washed ledger — SF techniques that
were ported and did not gain (NMP gate −27, ProbCut, rule50, TTCUTBONUS −28). Every
one of those was measured with our net in the loop. `zugzwang_sfnet` lets each be
re-measured with SF's net instead, which separates "the technique is bad" from "the
technique needs an eval that can see". Read that ledger before re-proposing anything;
this task is a way to re-open its verdicts, not to ignore them.
