# Human-like bot weakening (rating ladder redesign)

**Status:** shipped in zugzwang (standard + Crazyhouse + Duck), pending user feel-test
for final constant tuning. 2026-07-18.

## Problem

The old rating weakening (`pick_weakened`, ported from gomachine) was **bimodal**:
`config_for_rating` added small uniform cp *noise* to the ranked moves and, with
probability `blunder`, jumped to a **uniformly random move from the worse half**.
At e.g. 1800 the noise (~28cp) almost never reordered the top move, so ~94% of
moves were the *true best move*; the remaining ~6% were catastrophic (hang a queen
for free). Result: "plays perfectly for 30 moves, then throws a piece, then
perfect again" — the opposite of how rating works. Real strength = **every move
slightly inaccurate, consistency rising with rating, blunders bounded and shrinking
with rating** (missed tactics, not random free material). Also: everything ≥2600
CCRL was a hard "clean" full-strength search, so mid/high bots played perfectly.

## Model (`src/weakening.{h,cpp}` — shared by all three engines)

1. Rank every legal move (mover-relative cp) at a **rating-scaled depth** (the
   realistic blunder source: a tactic beyond that depth is unseen → can be played;
   severity shrinks as depth grows with rating).
2. Map each score → **win probability** via a base-10 logistic (`winProbScale`
   ≈350cp): a 40cp error near equality matters; the same 40cp at +900 barely does
   (relax when winning, sharp near equal).
3. **Severity cap**: drop any move whose win-prob is > `capDelta` below the best —
   a shallow-obvious blunder never survives (its win-prob is far below best), while
   a deep tactic the ranking didn't see slips through. This is the "no free queen"
   guarantee. In a lost position the window naturally widens (bestW small).
4. **Softmax** (Boltzmann) over the survivors' win-prob with `temperature` — every
   move slightly off, near-equal moves near-equiprobable ("barely plays the best
   move"), consistency rises smoothly as T→0 near full strength.
5. Forced winning mates are never passed up.

## Rating ladder (`src/rating.cpp` `config_for_rating`)

Human/FIDE scale, `RatingMin=700 .. RatingMax=2900` (full strength), `RatingFull=2850`
(at/above → clean full-strength group search). Weakened branch, `u=(2850-r)/(2850-700)`:

- `rankDepth = round(3 + 9*(1-u))`  → 3 (700) .. 12 (near full)
- `temperature = 0.40 * u^1.35`
- `capDelta = 0.03 + 0.52 * u^1.10`  (win-prob units)
- `winProbScale = 350` (variants: 3.5 × their pawn value, also 350)

`root_scores` does a cheap depth-1 ordering pre-pass then deep-ranks best-first
until the movetime budget is spent (so the clock, if it binds, only degrades
already-weak moves to their shallow score). RNG is `thread_rng()` (thread-local —
fixes a latent data race on the old shared static across the serve pool).

Variants (`crazyhouse.cpp`, `duck.cpp`) keep their own depth ladder as their
"sight" and reuse `Weakening::pick` with the same temperature/cap formulas; they
keep a hand-rolled mate guard (their MATE_SCORE=1e6 ≠ the standard is_mate_score
threshold). Duck's separate `duckRandom` placement noise is unchanged.

## Strength is now an ENGINE param (moved out of website/hub)

Previously the hub (`humanizedEngineRating` -500 handicap + `EngineRatingForHuman`
CCRL remap) and PHP (`BotGameService`/`GuessGameService::engineRatingForHuman`)
each did their own strength math to compensate for the ladder "playing too strong
for its number." The recalibrated ladder plays like its number, so all that math
was **deleted** — callers forward the user-facing rating verbatim:

- `app/Services/{BotGameService,GuessGameService}.php`: pass `$game->rating` directly.
- `gomachine/internal/hub/bot.go`: `rating: bot.rating` (deleted `humanizedEngineRating`
  + `botMaxHandicap/botHandicapFloor/ratingCleanTop`; deleted its unit test).
- Fillers (1700-2600) + backfill (600-2600) now forward their display rating natively.
- Admin Engine-vs-Engine slider: 700-2900 (was 700-3500 CCRL).
- New UCI options `UCI_LimitStrength` / `UCI_Elo` (`uci.cpp`) route `go` through
  `Rating::best_move_for_rating_single` — strength is a first-class, SPRT-testable
  UCI param. Default off → UCI/bench/golden byte-identical to full strength.

## Calibration (first draft — golden 38-FEN set, 300ms, `scratchpad/acpl.py`)

Median cp-loss & %best are cleanly monotone: med ~71/58/52/28/3 and %best
10/16/16/30/44 at 700/1300/1800/2500/2850. Inspecting the 1800 tail (`worst.py`):
of ~228 samples only 8 lose >300cp, and NONE are free-piece hangs — they're
still-winning suboptimal conversions (the win-prob cap relaxing when decided) plus
occasional overpush tactical errors. Exactly the target profile.

Tuning knobs if the feel-test wants adjustment: `temperature`/`capDelta`/`rankDepth`
coefficients in `config_for_rating` (and the variant `apply_rating`s). Re-measure
with `acpl.py` (GT is cached in `scratchpad/gt_cache.json`, independent of the
weakening constants).

## Update (v2, 2026-07-18) — Regan curve + difficulty-aware + phase-aware

Feel-testing exposed two real flaws the first calibration missed, fixed in a
second pass (research: Maia KDD'20 arXiv:2006.01855, Regan–Haworth intrinsic
ratings, Guid–Bratko complexity, SF WDL model — see the research digest):

1. **Errors were difficulty-INVERTED** — the bot nailed hard moves (its strong
   deep search found subtle best moves) but blundered easy ones (uniform softmax
   noise deviates as often on obvious positions as sharp ones). This is the exact
   documented failure of Stockfish "Skill Level". Fix: selection now follows the
   **Regan–Haworth curve `p ∝ exp(−(δ/s)^c)`** (δ = win-prob gap to best) with a
   **consistency exponent `c > 1`** (`SoftmaxConfig::consistency`, weakening.cpp).
   c>1 kills clearly-worse moves hard (no easy blunders) while keeping near-best
   moves ~equiprobable (spread on genuinely hard positions) — so errors land on
   hard positions like a human. c==1 is the old plain softmax.
2. **Queen hangs** — `root_scores` scored moves with a capture-BLIND static eval
   as the ordering/fallback; a hanging move looked fine and could be sampled. Now
   the base score is a **depth-1 search (quiescence resolves captures)**.

Also: the weakened branch is now **movetime-independent (depth-bound)** — rating
alone sets rankDepth, so a bot plays its rating regardless of the think-time the
caller grants (an explicit movetime/depth is only a cost cap, never a strength
boost). And **phase-aware endgame weakening** (`apply_endgame_scaling`): eval-
softmax barely bites with few pieces (strong eval + enough depth ⇒ engine-perfect
technique), so as material comes off we raise sensitivity, lower consistency, and
cut rankDepth — the bot calculates endgames shallowly like a human.

Final ladder (`config_for_rating`, engine scale **700..3500**; 3500 = TRUE full
strength ~3500 CCRL, plays with ZERO weakening — no depth cap, full time):
weakened band [700, RatingFull=2850): `rankDepth = clamp(6 + 6·(1−u), 2, 10)`,
`sensitivity = 0.10·u^1.9`, `consistency = 1.8 + 0.5·(1−u)`,
`capDelta = 0.02 + 0.13·u^1.6`, where `u = (2850−rating)/(2850−700)`. Clean band
[2850, 3500]: full-strength search whose depth/time budget scales with the rating
(a real gradient, not a flat full-strength zone). Variants use the shared curve
with c=1.8. **The weakened band is keyed off RatingFull, NOT RatingMax**, so the
SF-anchored calibration is independent of the ceiling — restoring RatingMax to the
true 3500 (a prior 2900 cap was a bug: 2900 is not max Elo) left it intact. All
surfaces use 700..3500: `BotGameService`/`BotGameController` (PHP), `botSettings.ts`
`RATING_MAX` + `ratingHint` tiers, `EngineVsEngine.tsx` `GOMA_RATING_MAX`, UCI_Elo.

### Calibration methodology (two SEPARATE axes — do not conflate)
- **Strength** (whole-game): `scratchpad/match.py` anchors zugzwang `UCI_Elo=R`
  vs **Stockfish `UCI_Elo=R`** (SF's ladder is a human-Elo proxy). ~0 gap = honest.
  Result: 1200 +39, 1500 −0, 1800 −19. NOTE: launch zugzwang with `cwd=zugzwang/`
  or `net.nnue` won't load (silent HCE fallback = meaningless anchor).
- **Error character**: `scratchpad/difficulty.py` — win-prob loss on ROUGHLY-EQUAL
  positions only (|eval|<250cp; decided positions falsely inflate cp-loss because
  win-prob weakening correctly relaxes when winning), bucketed easy vs hard by
  shallow(d2)-vs-deep(d12) best-move disagreement. Want hard-loss >> easy-loss.
  Result: 1500 easy 4.6% / hard 7.5% (1.6×); 1800 easy 3.8% / hard 7.4% (1.9×).
- Positions from `scratchpad/genpos.py` (SF self-play → middlegame/tactical mix).
- **Do NOT calibrate from ACPL** (R²≈0.05 vs rating; opening moves deflate it).
- UCI weakening is testable via `UCI_LimitStrength`/`UCI_Elo` (default off →
  byte-identical full strength). python-chess venv at `scratchpad/cchess/`.
