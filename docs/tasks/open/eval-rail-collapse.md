# Eval rail collapse — the net goes completely blind once either side is up a piece

Status: **root cause found and measured; retrain-free fix implemented behind `SATFIX`
(default OFF); needs SPRT before the default flips.**

Supersedes the diagnosis in `MATGRAD`/`HCEBLEND` (`src/eval.cpp`), which were built on
a wrong model of the failure and cannot work at any constant setting — see §3.

## Symptom

In decided positions zugzwang gives material away for nothing. Reported case: down
six queens it answers `O-O` and lets `Nxg5` take a free queen; three moves later it
drops a knight to a one-move threat. Same sloppiness when far *ahead*, and the eval
bar reads a meaningless number at both extremes.

## 1. Root cause: the D2=16 L1 layer rails, so the tail output is a constant

The tail is `FT(512) -> pairwise-u8 -> L1(D2=16) -> L2(D3=32) -> 1`, and the L1
activation is SCReLU, `clamp(x,0,1)^2`. Measured with `SATDIAG=1` (`eval` prints
`sat l1 <lo>/<hi> of 16`):

| position | l1 lo/hi of 16 | live lanes | eval |
|---|---|---|---|
| startpos | 14/0 | **2** | 69 |
| balanced middlegame | 14/0 | **2** | 64 |
| white up **one bishop** (31 pieces) | 14/2 | **0** | **+1086** |
| white up a piece (29 pieces) | 14/2 | **0** | **+1235** |
| black down a queen | 15/1 | **0** | **-887** |
| black down queen + bishop + rook | 13/3 | **0** | **-1062** |

Once every L1 lane is pinned to a rail, `l1[]` is a fixed 0/1 vector, so the L2 GEMV
and the output GEMV are applied to a constant input and the eval degenerates to a
table lookup keyed only by (output bucket, rail pattern). It is not compressed, it is
**constant**: five structurally unrelated down-a-queen positions — different openings,
different pawn structures, one of them with an extra black rook *and* bishop — all
evaluate to **exactly -887**.

Two consequences worth stating separately:

- **The collapse starts at about one piece, not one queen.** 3 of the 38 golden FENs
  in `test/golden_eval.txt` are already fully railed, and their frozen "correct"
  values (1086, 1235, 1235) *are* the rail constants. `+1086` for up-a-bishop is also
  simply wrong in magnitude — the hand eval reads `+443`.
- **It is symmetric.** The winning side rails just as hard, which is why conversion is
  sloppy and why the eval bar is bad at both ends, not just when losing.

Frequency, measured over 964 positions from 8 self-play games (`railfreq.py`):
**6.6% of positions played have `live == 0`** (opening 10.0%, middlegame 3.8%, endgame
7.4%), plus another 5.1% at `live == 1`. Self-play is balanced, so on the live site —
a 3000+ bot against humans — the real rate is far higher.

With zero eval gradient the search cannot distinguish "keep the queen" from "hang the
queen too", so the choice among losing moves is arbitrary. The gradient table
(`evalprobe.py A`, 4 middlegames × an 8-step material ladder) shows **21 of 32 steps
move the eval by 0 cp**, including removing a rook and then a bishop for no change.

## 2. What Stockfish and Stormphrax do here

- **SF18 survives this architecturally, not with a search trick.** `Network::evaluate`
  (`~/sf18-arm/src/nnue/network.cpp:172-188`) returns `{psqt, positional}` from the
  same feature transformer, and `psqt` is a **purely linear, unclipped** bucketed sum
  over active features. `Eval::evaluate` (`evaluate.cpp:53-90`) then uses
  `(125*psqt + 131*positional)/128` — roughly half the eval comes down a path that
  structurally *cannot* rail. That linear path is exactly what our single-output net
  lacks. SF's clamp (`std::clamp(v, VALUE_TB_LOSS_IN_MAX_PLY+1, ...)`) is only a
  mate-encoding guard, not a practical-range clamp.
- **Stormphrax has no psqt head either** and only does material/50-move scaling
  (`~/stormphrax/src/eval/eval.cpp:31-67`), so it is in the same boat as us.
- Neither engine clamps eval to a narrow range, and clamping would not help anyway:
  the problem is missing gradient *inside* the range, and truncating the tail makes it
  flatter, not steeper.
- Both engines' RFP/razoring/futility shortcuts are guarded only against *mate-range*
  scores (`is_loss(beta)`, and our `eval < VALUE_MATE_IN_MAX_PLY` at
  `src/search.cpp:2572`), never against "far from zero". Those shortcuts are sound for
  SF because its eval keeps resolution; they are unsound for us because ours does not.
  Loosening them is a compensating control, not the fix.

## 3. Why `MATGRAD` and `HCEBLEND` could not have worked

Both ramp their correction on `|net eval|` over `[800, 1600]`. But the railed constant
**is** the net eval, so:

1. In bucket 7 the constant is 887, giving ramp weight `(887-800)/800 = 11%`. Against
   a 900 cp blunder `HCEBLEND` contributes at most `300 * 0.11 ≈ 33` cp and `MATGRAD`
   at most `400 * 0.11 ≈ 43` cp.
2. The ramp weight then jumps arbitrarily with piece count, because the constant does
   (887 / 1062 / 1378 → 11% / 33% / 72%) — it tracks occupancy, not how lost you are.
3. Most fundamentally, the gate variable carries **zero information**. Scaling a
   correction by a function of a dead eval cannot recover the gradient at any setting.

`HCEBLEND` is also losing-side-only, so the winning-side half of the bug gets no
correction at all. Its "+0.5 ± 9 @1372g" SPRT is consistent with being inert.

## 4. The fix: `SATFIX`

Gate on the actual information loss instead. `nnue_eval.cpp` recovers the rail count
from `l1[]` after the hot loop (`screlu` maps `(0,1)` strictly into `(0,1)`, so
`l1[o]==0.0f` ⇔ pre-activation `<= 0` and `l1[o]==1.0f` ⇔ `>= 1`), and the tally is
skipped entirely unless `SATFIX`/`SATDIAG` is on — the shipped build is byte-identical
and pays nothing (verified: same nodes/score/PV, time-to-depth-21 unchanged).

`Eval::evaluate` then, when `l1live == 0`:

- `SATFIX=1` — return `hce_evaluate(pos)` outright. The hand eval is a linear sum, so
  it is monotone in material at full piece values and never saturates.
- `SATFIX=2` — keep the net constant as the anchor and add only the HCE's deviation
  from its typical value at rail onset: `raw + (hce - sign*SATHCEREF)`, `SATHCEREF=450`.
  Stays on the net's scale where the rails begin (up a bishop: `1086 + (443-450) =
  1079`), which matters because RFP/razoring/futility/time-management read eval
  magnitudes.

### Measured effect

Material-gradient monotonicity (`evalprobe.py A`, 32 ladder steps):

| | steps with zero gradient |
|---|---|
| shipped | **21 / 32 (66%)** |
| `SATFIX=1` | 0 / 32 |
| `SATFIX=2` | 0 / 32 |

`SATFIX=1` also tracks true material closely (down a queen `-917` vs true `-900`;
down `q+r` `-1373` vs `-1400`; down `q+r+n` `-1718` vs `-1720`).

Hangs-free-material suite (`blundersuite.py`, 144 decided positions from 12
middlegames × 6 material deficits × losing and winning side, 300 ms/move; a "hang"
is an undefended piece the opponent can just take, netting out our own captures):

| | hangs ≥300cp | total hung |
|---|---|---|
| shipped | 3 (2.1%) | **5760 cp** |
| `SATFIX=1` | 2 (1.4%) | 1250 cp |
| `SATFIX=2` | **0 (0.0%)** | **300 cp** (−95%) |

Worst shipped case reproduced automatically: `r3k2r/p1ppqppp/1p3n2/4p3/2B1P3/2NP1N2/PPP2PPP/R1BQ1RK1 b`
→ `Qe7a3`, hanging the queen for nothing.

Reported positions, all movetimes 300/1000/3000 ms:

- `r1b1k2r/ppppnp2/2n1p1p1/2N1P1qp/2Q1N3/2B2B2/PPPPQPPP/QQQ1K1QQ b kq -` (black's
  `Qg5` attacked by `Ne4`, undefended): shipped plays `O-O` every time and loses the
  queen; `SATFIX=1/2` play `Qh6` and save it. **SF18 also fails this one** — its own
  net inverts here, reporting `+19` for the side that is down six queens, and it plays
  `h5h4`. Stormphrax refuses the FEN outright (`position.cpp:950`, `occ > 32`).
- `r1b2rk1/ppp1np2/2n1p1p1/1QNpP1Np/8/2B2B2/PPPPQPPP/QQQ1K1QQ b - -`: shipped plays
  `a7a5`, hanging the pawn to `Bxa5`/`Qxa5`; `SATFIX` plays `b6`/`a6`/`Kg7`, none of
  which drop anything. Neither config picks the reported `Nb4`.

## 4b. SPRT result: the symmetric substitution is a REGRESSION

`SATFIX=2` (both sides) measured **-12.1 +/- 8.4 Elo** at normal play, 1393 games,
movetime 100 ms, bounds [-5, 0], pentanomial `[12, 128, 443, 91, 6]`. Not noise.

Why, and it is the same trap `HCEBLEND` fell into: **a railed node is not a blind
search.** Captures change piece count, which changes the output bucket and the rail
pattern, so the eval still moves from ply to ply even while it is locally constant.
Substituting the HCE therefore does not fill a vacuum — it replaces a strong signal
with a weak one at *every* railed node, including up-a-piece middlegames that are
WINNING and were converting perfectly well. `HCEBLEND`'s own notes record the same
finding ("blending on the winning side just injected weaker-HCE noise; that was the
small standard-play dip"), which is why it ended up losing-side-only.

So the gate has to be one-sided, and the substitution should import as little
hand-crafted opinion as possible. Modes added:

| mode | what | golden | suite: total hung | pos1 |
|---|---|---|---|---|
| 0 (shipped) | — | 37/38 | 4580 cp | `O-O`, loses Q |
| 9 | tally only, no substitution (**control**) | 37/38 | 4330 cp | `O-O`, loses Q |
| 2 | anchored HCE, both sides | 34/38 | 300 cp | saves Q |
| 3 | anchored HCE, **losing side only** | 37/38 | 440 cp | saves Q |
| 5 | **material-only**, losing side only | 37/38 | 420 cp | saves Q |

Mode 9 confirms the instrumentation itself is behaviourally inert, so the -12.1 is all
substitution, not measurement cost. Modes 3 and 5 keep essentially the whole
correctness win (~90% less material given away) while touching none of the three
railed golden FENs — all of which are winning-side. Mode 5 is the minimal intervention:
full-value linear material and nothing else, no PST/mobility/king-safety opinion, and
reference-free.

Note the suite has run-to-run variance at fixed movetime (baseline measured 5760 cp and
4580 cp on two runs), so read the ~10x gap, not the exact percentage.

## 4d. The symptom is CONVERSION, not defence

Splitting the 144-position suite by which side the engine is actually playing changes
the whole framing. Clean build, three independent baseline runs (fixed movetime is
nondeterministic, so the spread is real):

| config | LOSING side (72 pos) | WINNING side (72 pos) |
|---|---|---|
| baseline | 950 / 720 / 950 cp | **4840 / 4030 / 3600 cp** |
| `SATSOFT=1000` | 250 / 220 cp | **910 / 690 cp** |

**The engine gives away roughly 4.8x more material when it is winning than when it is
lost.** The reported queen-hang is the vivid case but it is the minor half of the bug;
the dominant failure is sloppy conversion, which is exactly the complaint that the eval
bar reads +14 and the suggested moves are bad. `SATSOFT` cuts the winning-side loss by
about 81%.

This also reframes the `HCEBLEND` lesson. Restricting the blend to the losing side was
treating the *smaller* half of the problem as the whole problem. Note that a losing-side
gate still helps conversion, because inside a winning-side search the opponent is to move
at every other ply and those nodes are "losing side" — which is why `SATFIX=3` reduces
winning-side hangs despite never firing at the root.

And it explains the SPRT nulls. Hanging a rook while up a queen does not change the
result against an opponent that converts anyway, so fastchess cannot see it; against a
human it hands the game back. Elo is the wrong instrument, exactly as predicted.

## 4c. The tuning-co-adaptation question (open, and bigger than this fix)

Every search flag default and all 8 SPSA margins were accepted by SPRT against an eval
that is blind in ~6.6% of positions. That does not make the tuning *wrong* — it is
correctly fitted to the eval the engine actually has — but it does mean:

- The margins were never fitted to the railed tail, so any eval fix moves that tail
  into a region the tuning has never seen. Re-SPSA with the fix on before judging it.
- **Techniques whose value depends on eval quality in decisive positions may have
  washed for the wrong reason.** `optimism` is the sharpest example: SF derives it from
  `|psqt - positional|`, a complexity signal our single-head net structurally cannot
  produce, and a railed eval makes it meaningless. Same suspicion applies to `EVALHIST`
  and the RFP/razoring margin variants. These deserve a re-test *after* the eval is
  fixed, not before — check the washed ledger in
  `../../gomachine/engine/docs/OPTIMIZATIONS.md` for candidates.
- After the August retrain the whole margin set must be re-SPSA'd; current values are
  not portable to a net with a working gradient.
- **`test/golden_eval.txt` currently freezes rail constants (1086, 1235, 1235) as the
  reference values**, so the golden gate will actively resist any eval fix. Re-freeze it
  once the eval is settled.

## 4e. SATSOFT — recover the gradient from the net, not from a hand eval

Every `SATFIX` mode substitutes a weaker function, which is why they all cost Elo. But
the clamp, not the layer, is what destroys the information: black down Q+B+R and down
Q+B+2R both evaluate to exactly -1062 while the largest L1 pre-activation overshoot
moves 2.95 -> 3.65. The extra rook is visible to the net; `screlu` discards it
(`SATDIAG=1` now reports the overshoot).

`SATSOFT` continues the activation linearly past both rails so that variation survives,
using the net's own weights. Three measured constraints shaped it:

1. **It cannot be global.** 14 of 16 lanes rail even in the starting position — SCReLU
   sparsity is the normal operating mode — so an ungated leak rewrites every eval and
   fails the golden gate 0/38. It is gated on TOTAL collapse, the only regime where the
   output is a constant.
2. **Leaking L2 alone does nothing** (66% broken, unchanged), because its inputs are the
   constant. L1 is where the information dies.
3. **The raw soft output is ~7x out of scale** (+7549 for up one bishop). Used directly
   it would disturb every eval margin and put nonsense on the eval bar. So the soft pass
   supplies DIRECTION only: the constant remains the anchor and `SATSOFTK` (per-mille,
   default 120) of the deviation is added back.

| `SATSOFTK` | broken ladder steps | material hung |
|---|---|---|
| off | 21/32 (66%) | 5670 cp |
| 60 | 13/32 (41%) | 1240 cp |
| **120** | **5/32 (16%)** | **780 cp** |
| 250 | 4/32 (12%) | 1360 cp |

Two ladder steps stay inverted — the extrapolation is not perfectly monotone, since
those weights were never trained past the rails. `SATSOFTK` is an SPSA candidate.
Off is byte-identical; the second tail pass runs only at the ~6.6% collapsed nodes.

## 5. Next

1. **SPRT `SATFIX=2` and `SATFIX=1` at normal play** (movetime, on coalla). This is
   *not* inert — it changes the eval in ~6.6% of positions, including common up-a-piece
   middlegames — so the default cannot flip without it.
2. **SPRT from material-odds start positions** (one side down a queen / a piece),
   which is the regime the fix targets and where an aggregate SPRT has little power.
3. SPSA `SATHCEREF` if `SATFIX=2` wins.
4. Consider whether the search-side compensating control is still worth it on top —
   loosening RFP/razoring/futility while `l1live == 0`, since those shortcuts return a
   static eval that the fix has only just made trustworthy.
5. **August retrain is still the real fix**, and this sharpens its spec: a linear
   psqt-style second head as SF has, and D2=16 is far too narrow a bottleneck to be
   riding on ~2 live lanes in a balanced position.

## Repro scripts

`evalprobe.py` (gradient ladder + hang detector), `blundersuite.py` (144-position
suite), `railfreq.py` (rail frequency over self-play) — written for this
investigation; `SATDIAG=1` makes `eval` print the rail state.
