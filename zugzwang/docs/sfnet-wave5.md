# SF-net Wave 5 — a playable SF-backend binary + the centipawn scale fit, as-built notes

Two things stood between Wave 4's incremental accumulator and an SPRT: nothing loaded
an SF net at startup (§A), and the SF backend returned raw SF `Value` units with no
rescale onto zug's own pawn=100 margin scale (§B). Both are done. This file records
the method, the numbers, and — per the task's explicit permission — an honest account
of where the evidence disagrees with itself.

## A. A buildable, playable SF-backend engine

### A.1 `make sfnet` — a separate binary, separate objects

`Makefile` gained a `sfnet` target that compiles the **full** engine `SRC` list (every
TU, including `main.cpp`/`uci.cpp`/`serve.cpp`/`ratingtest.cpp`) plus
`sfnet_load.cpp`/`sfnet_eval.cpp`/`sfnet_accumulator.cpp`, all under `-DSFNET_BACKEND`,
into `objs_sfnet/*.o` — a directory the normal build never touches — linked into
`zugzwang_sfnet`, never overwriting `./zugzwang`.

Verified explicitly, not assumed:

```
$ make clean && make -j8                # normal build
$ make sfnet -j8                        # SF-backend build
$ stat -f "%m" src/uci.o                # note mtime
$ make -j8                              # third make
make: Nothing to be done for `all'.
$ stat -f "%m" src/uci.o                # unchanged — confirms src/*.o wasn't touched
$ nm src/uci.o        | grep -c SFNet   # 0 — normal build has no SF-backend code
$ nm objs_sfnet/uci.o | grep -c SFNet   # 1 — SF-backend build does
```

`src/*.o` (28 files) and `objs_sfnet/*.o` (32 files — the 28 plus the three SF-backend
TUs plus `syzygy/tbprobe.o` counted once each) never collide; a `make && make sfnet &&
make` cycle leaves both binaries correct and rebuilds nothing spuriously.

### A.2 Startup wiring

`src/uci.cpp:306`, `src/serve.cpp:190`, `src/ratingtest.cpp:81` each gained an
`#ifdef SFNET_BACKEND` branch replacing the `NNUE::load("net.nnue")` call: it loads
`getenv("SFNET_NET")` if set, else the cwd-relative `sfnet.nnue` symlink (same
convention as `net.nnue`). **A failed load is `std::exit(1)` with a `SFNet: FATAL —`
stderr line, not a fall-through** — verified:

```
$ SFNET_NET=/nonexistent/path.nnue ./zugzwang_sfnet
SFNet: cannot open net file
SFNet: FATAL — failed to load /nonexistent/path.nnue; SFNET_BACKEND requires a working
SF net (refusing to silently fall back to HCE)
$ echo $?
1
```

Non-`SFNET_BACKEND` builds take the untouched `#else` branch (byte-for-byte the
original code) — confirmed below (`golden_check` 38/38, `./zugzwang` stderr still says
`NNUE: loaded net.nnue`).

**A second gap, not in the task's three-site list, that would otherwise have made the
accumulator pointless:** `search.cpp:4439`'s `bool useAcc = NNUE::loaded();` — the gate
that decides whether `Search::start` attaches an accumulator to the position at all —
was still hardcoded to ask whether **our own** net loaded, exactly as Wave 4's own doc
flagged as a known follow-up ("this gate will need its own follow-up before the
accumulator is ever actually attached during a real search," `sfnet-wave4.md` §5).
Left alone: even after §A.2 loads an SF net, `NNUE::loaded()` is false under
`SFNET_BACKEND` (nothing calls `NNUE::load` anymore), so `useAcc` would be false, no
accumulator would ever attach, and `Eval::evaluate`'s `EngineAccStack* a =
pos.nnue_acc()` would be null on every node — falling through to
`SFNet::evaluate(pos)`, the **from-scratch** path, on every single eval. Not wrong
(still bit-exact), but it would silently defeat all of Wave 4's incremental-accumulator
work and make the search far slower than it needs to be. Fixed with a small
backend-dispatch helper in `src/engine_backend.h`:

```cpp
#ifdef SFNET_BACKEND
inline bool engine_backend_loaded() { return SFNet::loaded(); }
#else
inline bool engine_backend_loaded() { return NNUE::loaded(); }
#endif
```

and `search.cpp:4439` now reads `bool useAcc = engine_backend_loaded();` — a
compile-time-resolved inline call, not an indirect one, matching `EngineAccStack`'s own
existing compile-time-switch discipline. The `sfnet_acc_test` re-run below (§A.4) is
unaffected by this change (it attaches `SFNet::AccStack` directly, bypassing
`Search::start`), but real UCI/serve searches were not exercising the accumulator at
all until this fix — confirmed by NPS: depth-10 searches below run at ~300-400k nps,
which is far too fast for a from-scratch rebuild of an 82 MB int8 threat array plus a
46 MB int16 base array on every node.

### A.3 The net symlink

```
$ ln -sf ~/sf18-arm/src/nn-c288c895ea92.nnue zugzwang/sfnet.nnue
```

Added to `.gitignore` alongside `zugzwang_sfnet` and `objs_sfnet/` — the net is 104 MB
of GPLv3 Stockfish data, never committed (same policy as `net.nnue`/`book.bin`/`syzygy`).

### A.4 Smoke test

`OwnBook` disabled so `go depth 10` actually searches instead of returning an instant
book move. Start position and three midgame/endgame FENs, all real `go depth 10`:

```
$ ./zugzwang_sfnet
SFNet: loaded sfnet.nnue (SFNET_BACKEND build)
...
info depth 10 score cp 67 nodes 14349 nps 341642 time 42   pv e2e4 c7c5 g1f3 ...
bestmove e2e4 ponder c7c5

# r1bq1rk1/pp2ppbp/2np1np1/2p5/2P1P3/2NP1NP1/PP3PBP/R1BQ1RK1 w - - 0 1
info depth 10 score cp -9 nodes 10543 nps 329468 time 32   pv a1b1 c8g4 ...
bestmove a1b1 ponder c8g4

# 8/8/8/8/1k1K1P2/8/8/8 b - - 0 1  (Syzygy-resolved KPK loss for Black)
info depth 10 score cp -31497 nodes 11156 nps 796857 time 14   pv b4b5 d4d5 ...
bestmove b4b5 ponder d4d5

# rr1k4/8/2P1bbP1/p2p2Np/P2P2PP/3q4/2n1R3/4RK2 b - - 6 56
info depth 10 score cp 2544 nodes 58062 nps 408887 time 142  pv e6g4 g6g7 ...
bestmove e6g4 ponder g6g7

# r3k2r/pbppqppp/1pn2n2/4p3/2B1P3/2NP1N2/PPP2PPP/R1BQ1RK1 w KQkq - 0 1
info depth 10 score cp 987 nodes 14944 nps 373600 time 40   pv a2a4 e8c8 ...
bestmove a2a4 ponder e8c8
```

No crash, no hang, sane evals and PVs, plausible NPS for the SF net's larger weight
footprint (§7 of the task spec already flagged expecting real NPS loss vs our 512-wide
net — that is unmeasured/uncharacterized here, just not catastrophic).

`SFNETK` (§B) confirmed runtime-tunable with no rebuild — the same position's depth-6
score and node count both move with the env var:

```
$ SFNETK=48  ./zugzwang_sfnet < smoke.txt   ->  score cp -10, nodes 1209
$ SFNETK=100 ./zugzwang_sfnet < smoke.txt   ->  score cp   5, nodes 1227
$ SFNETK=200 ./zugzwang_sfnet < smoke.txt   ->  score cp -48, nodes 1480
```

### A.5 Non-`SFNET_BACKEND` build unaffected

```
$ ./zugzwang        # normal build, unchanged flags
NNUE: loaded net.nnue
Book: loaded book.bin
Syzygy: loaded syzygy (max 5-man)

$ ./test/golden_check.sh ./zugzwang
=== golden: 38/38 pass (tol 5), 0 fail ===

$ make perft && ./perft_test
ALL PERFT TESTS PASSED
```

### A.6 `sfnet_acc_test` re-run (post_process was touched — §B)

```
$ make sfnet_acc_test && ./test/sfnet_acc_test ~/sf18-arm/src/nn-c288c895ea92.nnue test/sfnet_corpus.epd --depth 3
sfnet_acc_test: 560 corpus FENs, 6 targeted FENs, depth 3 (+1 for targeted)
sfnet_acc_test: 11089304 nodes checked, 0 drift failures
RESULT: PASS
```

Identical node count and zero failures to Wave 4's run. Expected: `sfnet_acc_test`
compares `eval_pair()` (the pre-`post_process` `(psqt, positional)` pair) against
`evaluate_raw()`'s oracle — `post_process`'s new `SFNETK` scale is downstream of both
and touches neither.

## B. The centipawn scale fit

### B.1 What was tried first, and why it was abandoned as the basis for the default

The task handed over five band-restricted fits (`our_l1live > 0`, live-lane rows only):
1.62 (0-100cp), 1.07 (100-300), 0.70 (300-700), 0.81 (700-1500), 0.64 (1500+) — with the
explicit warning that fitting `our_eval` is fitting to a broken yardstick wherever our
net rails, and the direction to try a stricter liveness criterion.

Re-ran with `our_l1live >= 4` and `>= 8` (out of `D2=16` lanes) instead of `> 0`. If the
low band's instability were rail noise that a stricter filter cleans up, tightening the
threshold should make the low-band `k` **more** stable. It does the opposite:

| liveness filter | n (0-100cp band) | k (0-100cp band) | n (300-700) | k (300-700) |
|---|---|---|---|---|
| `l1live > 0` | 93 | 1.62 | 63 | 0.70 |
| `l1live >= 4` | 44 | 3.05 | 18 | 0.64 |
| `l1live >= 8` | 11 | 0.73 | 6 | 0.52 |

Tightening the filter from `>0` to `>=4` roughly **doubles** the low-band estimate
(1.62 → 3.05) while collapsing the sample from 93 to 44; tightening further to `>=8`
flips it back down to 0.73 on only 11 points. The corpus never contains a fully-live
row at all (max observed `our_l1live` is 15/16, on a single row; 109/560 rows — 19% —
are fully railed at `l1live == 0`, and 357/560 — 64% — have 2 or fewer live lanes).
**This is not noise a stricter filter cleans up — it is the signal disappearing as the
sample shrinks.** A "live" lane in a net that is 14/16 dead does not behave like a
small well-conditioned correction; it can dominate the position's whole output, which
is exactly why the estimate swings by 4x instead of converging. Fitting `our_eval`
against `full` on this corpus, at any liveness threshold tried, is not a reliable way
to recover a scale constant. That conclusion is itself the useful result of this
attempt — it rules the approach out, honestly, rather than picking whichever band
happened to look stable.

### B.2 What was used instead: a constant already shipped in this codebase for this exact purpose

`SFNet::post_process`'s pre-scale output (`full` in the corpus TSVs) is SF's own
`Eval::evaluate` blend — the same "SF eval scale" the constants in three other places
in `search.cpp` were already ported from, all using the same ratio:

- `search.cpp:994` (`Tune::capFutBase`/`capFutSlope`, ported from SF's
  `staticEval + 232 + 217*lmrDepth`): *"zug's eval/PieceVal scale is pawn=100, ratio
  100/208 ~= 0.4808: 232\*0.4808 ~= 111.5 -> 112, 217\*0.4808 ~= 104.3 -> 104."*
- `search.cpp:995-1006` (`Tune::capFutHistCoeff`): derived through the same 0.4808
  ratio combined with a history-scale correction.
- `search.cpp:3051` (`Tune::razorQuad`, ported from SF's
  `eval < alpha - 485 - 281*depth*depth`): *"SF-scaled quadratic curve (SF consts
  x0.481, zug/SF pawn-value ratio 100/208)"* — `485*0.4808 ≈ 233`, `281*0.4808 ≈ 135`,
  matching the shipped literals `233`/`135` exactly.

208 is SF's own declared `PawnValue` (`~/sf18-arm/src/types.h:185`), used directly
inside `evaluate.cpp` itself (the same file `post_process` reproduces) — not a
different-purpose constant borrowed out of context. **This ratio doesn't depend on our
own net's output at all**, which is exactly the property the corpus fit in §B.1 lacks:
it's declared by SF, already validated and shipped three times over in this codebase
for the identical "port an SF eval-scale margin constant onto zug's pawn=100 scale"
problem `post_process`'s output now has.

`k = 100/208 = 0.4808`, rounded to the codebase's existing convention (see the 232→112,
217→104, 485→233, 281→135 roundings above) → **`SFNETK` defaults to `48`.**

### B.3 A controlled cross-check that doesn't depend on real-game noise

Wave 3 already built the right instrument for this and it went unused for the scale
question: `tools/sfnet_material_ladder.py`'s **SUB ladder** — one black queen square,
progressively downgraded Q→R→B→N→P→(none). Its first five rungs hold the piece count,
and therefore both nets' material bucket, **exactly fixed** — the controlled
counterpart to the CUM ladder's confounded (bucket-changing) removal. Averaged across
the 12 base positions (`test/sfnet_ladder.tsv`, already on disk from Wave 3):

| rung | deficit (cp, our own P/N/B/R/Q=100/320/330/500/900 scale) | our_eval | our_l1live | sf `full` | our_eval / sf_full |
|---|---|---|---|---|---|
| R | 400 | 1049 | 0.83 | 2161 | **0.485** |
| B | 570 | 1175 | 0.75 | 2460 | **0.478** |
| N | 580 | 1087 | 0.83 | 2653 | **0.410** |

Three independent, bucket-fixed measurements, averaging **0.457** — within 5% of
0.4808, and nowhere near the corpus fit's low-band numbers (1.6, 3.05, ...). Two
things are worth being honest about here: (1) `our_l1live` is *already* down to
0.75-0.83/16 at these rungs — i.e. even this "clean" instrument's positions are mostly
rail-collapsed by lane count — yet the *ratio* stays tight across three rungs where the
raw noisy corpus fit didn't stay tight across five bands with 10x the sample size; (2)
the `none` rung (bucket changes) and the whole CUM ladder (bucket changes every rung)
both jump to 0.64-0.74, consistent with §B.1's diagnosis that bucket-crossing and
rail-collapse are the actual source of the corpus fit's instability, not a real k that
varies by magnitude. Full ladder data: `test/sfnet_ladder.tsv` (unmodified, Wave 3's
own output, re-read here rather than regenerated).

**Which regime this was optimised for, and why:** the low-|eval| regime, not the
whole-corpus average. RFP/razoring/futility/SEE pruning all compare `eval` against a
margin measured from `alpha`/`beta` — `rfpMargin=84` (depth ≤ 8, i.e. thresholds up to
~672cp), `razorMargin=222` (depth ≤ 3, up to 666cp), `futSlope=107` (depth < 13, up to
1391cp), `seeQuietCoeff=17*depth²` (depth ≤ 8, up to 1088cp) — all read directly out of
`Tune` in `search.cpp:942-957`, not guessed. A scale error at 2000cp of material
imbalance is close to irrelevant to these margins; a scale error in the 0-700cp band is
exactly what makes them prune the wrong nodes. The SUB ladder's controlled rungs (R/B/N,
400-580cp deficit) sit right in that regime, which is the other reason to weight it over
the whole-corpus fit even where they'd otherwise agree.

### B.4 Implementation

`SFNETK` is an integer percent (`SFNETK=100` == ×1.00), read once via the same
static-lambda-on-first-call pattern `THREATGATE`/`THREATDELTA` already use
(`nnue_features.cpp:795,837`), applied inside `SFNet::post_process`
(`sfnet_eval.cpp`) — the single function both `SFNet::evaluate()` (from-scratch) and
`SFNet::AccStack::eval()` (incremental) call, so one line covers both paths:

```cpp
int post_process(EvalPair ev, const Position& pos) {
    ...
    std::int32_t v = (nnue * (77871 + material)) / 77871;  // optimism = 0
    v -= v * pos.rule50_count() / 199;
    v = (v * sfnet_k_percent()) / 100;   // Wave 5
    return int(v);
}
```

Default `48`, override with `SFNETK=<percent>` — no rebuild, so an SPRT can sweep
candidate values freely (confirmed in §A.4: score and node count both move with the
env var on an unchanged binary).

### B.5 Sanity check: distribution, not a fit

Applied `k=0.48` to all 560 corpus rows' `full` column (not just the "live" subset —
real search sees every position) and compared against our own net's `our_eval`
distribution over the identical positions, plus the fraction landing inside the actual
pruning margins from §B.3:

| | median \|eval\| | IQR | in <700cp | in <1400cp | outside every margin (≥1400cp) |
|---|---|---|---|---|---|
| SF backend, `SFNETK=48` | 638 | [163, 1079] | 52.9% (296/560) | 86.8% (486/560) | 13.2% |
| our own net (`our_eval`) | 1056 | [227, 2044] | 38.8% (217/560) | 61.3% (343/560) | 38.8% |

At `k=0.48` the SF backend's eval distribution is **more** concentrated inside the
pruning-relevant band than our own net's *current, shipped* eval distribution is — not
worse. For contrast, sweeping `k` upward toward the unstable corpus-fit numbers makes
this steadily worse, confirming §B.1/§B.2's choice rather than just failing to
contradict it:

| k | median \|eval\| | in <700cp | in <1400cp |
|---|---|---|---|
| 0.48 (shipped default) | 641 | 52.9% | 86.8% |
| 0.66 (whole-corpus `l1live>0` fit) | 882 | 42.3% | 69.1% |
| 1.00 (naive through-origin, all 560) | 1336 | 35.4% | 52.1% |
| 1.60 (low-band `l1live>0` fit) | 2138 | 27.9% | 39.1% |

A single 700-line self-check confirms `k=0.48` does not put the search in the
"90% of positions outside every margin" failure mode the task named — if anything the
opposite failure mode (too concentrated near 0) would need checking in a real SPRT, but
that is exactly the kind of thing an SPRT measures and this static check cannot.

### B.6 Honest summary

This is **not** "k=1.0, no rescale" — SF's raw `Value` units and zug's pawn=100 cp are
different scales by construction (`PawnValue=208` vs `100`), and both the declared-ratio
calculation and the controlled ladder measurement agree they differ by roughly 2x, not
1x. It is also **not** a fit to `our_eval` — §B.1 shows that fit does not converge, and
picking a number out of it (even the "low-band, since margins bite at small |eval|"
number the task pointed at) would mean trusting a statistic that got *less* stable, not
more, under every attempt to clean it up. The shipped default (`SFNETK=48`) rests on a
ratio this codebase already committed to and shipped three times over for the identical
porting problem, corroborated by an independent controlled measurement (the SUB ladder)
that was already sitting on disk from Wave 3 and had not yet been read this way, and
checked — not fit — against the actual margin values in `search.cpp` so it doesn't
silently move the SPRT out of the regime those margins were tuned for.

## What this wave did not do

- No SPRT. That is explicitly the caller's call, not claimed here.
- No NPS/movetime characterization of `zugzwang_sfnet` — §A.4's numbers (300-800k nps)
  are smoke-test byproducts, not a measured comparison against `./zugzwang`'s own NPS.
  Task spec §7 already expects a real NPS loss from the SF net's larger weight
  footprint (82 MB int8 threats + 46 MB int16 base vs our 512-wide net); this wave
  does not quantify it.
- `SFNETK`'s value was chosen from a declared SF constant plus a controlled ladder
  measurement, not swept against search strength — that sweep is exactly what an SPRT
  with `SFNETK` as the tunable would do next, and is out of this wave's scope by design
  (the task asked for a justified *default*, not a converged optimum).
