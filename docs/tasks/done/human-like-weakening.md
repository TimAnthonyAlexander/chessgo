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
