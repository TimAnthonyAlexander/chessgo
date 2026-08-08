# Premove Trainer

A solo training mode: you are handed a position with a forced mate, you queue a
whole chain of premoves **blind**, you release it, and it plays out against the
engine. No feedback between moves. Either you mated them or you didn't.

Two modes, one mechanic:

- **Rated** — a real 10-second bullet clock. It runs while you queue. Release the
  chain and it costs you nothing (a queued premove means it's the opponent's
  turn, so your clock is stopped — our existing live-game rule). Flag before you
  release and you lose. If the chain **collapses** because the defender didn't
  play the move you assumed, you land in a live position with the clock running
  and have to keep going.
- **Casual** — no clock, no rating, one shot. Queue, release, watch, result.

The rated mode is the point of the feature: the collapse-and-recover moment is
the thing no existing puzzle trainer can teach, because every other trainer tells
you "correct!" after move one.

> Status: contract frozen, implementation in progress. This document is the
> single source of truth for the API, the schema and the constants. Implementers
> build against it; if reality has to diverge, change this file in the same
> commit.

---

## 1. Where it lives, and why

**BaseAPI only. No hub changes, no Go changes.**

The gomachine hub is strictly two-player plus backfill/filler/arena — there is no
single-player-vs-engine path in it, and explicit `/bot` games deliberately never
reach it (`gomachine/internal/hub/bot.go:166`). Solo-vs-engine already lives in
BaseAPI.

More importantly, `BotGameService` already implements exactly the server-side
bullet clock this needs: `flagHumanIfOutOfTime()` charges `now - last_move_at`
before the submitted move is even validated, `settleBotClockAfterMove()` restamps
to start the human's next turn, and the clock lives in epoch **milliseconds** in a
TEXT column so a bullet clock doesn't drift a second a move. We mirror that
discipline rather than inventing a second one.

`gomachine/internal/hub/filler.go` and `bot.go`'s `botThinkDelay` are **not**
reused. That pacing model (rating-scaled, material-scaled, fat-tailed tempo
jitter) exists to make a bot look human *inside a real game where its own clock is
running*. Here the engine's think time is off-clock by construction, so playout
pacing is purely presentational and gets a flat cadence instead.

---

## 2. The clock rule

**Your clock runs from the moment the position is served until your release
request arrives. That is the only time it runs.**

Everything inside the playout is free, because from the instant you release there
is always a premove queued and it is always the engine's move. This is our live
rule (`game.go:295` charges wall time to the side to move), applied unchanged.

Three consequences that must be implemented exactly:

### 2.1 Engine think time is never charged

A chain of N player moves means up to N sequential `/bestmove` calls inside one
PHP request — zugzwang has no multi-ply playout endpoint (`/analyze-game` only
re-scores an already-decided move list). At `DEFENDER_MOVETIME_MS` each that is
several hundred milliseconds of real wall time in the request, and **none of it
may touch the player's clock**.

Therefore: snapshot `elapsed = now - last_move_at` **once**, on request arrival,
before any engine call. Charge it once. Never re-read the wall clock during the
playout.

### 2.2 `last_move_at` is stamped into the future

The client animates the playout over `plies * PLY_MS`. If the server stamped
"now" when the request finished, the player would silently lose the entire
animation off their clock on a collapse — they cannot move during moves they
haven't been shown yet.

So on any non-terminal outcome:

```
animationMs   = playoutPlies * PLY_MS[format]
last_move_at  = nowMs() + animationMs
```

Deterministic, computed server-side, no extra round trip, nothing trusted from
the client. The response echoes it as `resume_at` so the client's countdown and
the server's authority agree to the millisecond.

### 2.3 A start grace covers transit

"The clock starts NOW" must mean when the player *sees* the board, not when PHP
finished serializing. At creation the server stamps
`last_move_at = nowMs() + START_GRACE_MS`.

---

## 3. Position pool

**Syzygy-generated low-piece endgames. The puzzle database is NOT the source.**

The first build served forced-mate puzzles and that was wrong. A puzzle is
*crafted so exactly one line works* — that is the definition of a tactic, and the
exact opposite of what this mode trains. Premoving is about committing a fast,
safe conversion when several moves all win; if only one move wins, the drill is
"find the move" and the premove mechanic is decoration.

So the pool is generated, not mined. We hold the full 5-piece Syzygy set locally
(`gomachine/data/syzygy/`, 292 files, ~1.9 GB) and zugzwang probes it live in
about a millisecond, which lets us ask the question that actually matters: not
"is this won" but **how many of my legal moves keep the win**.

### 3.1 What qualifies

Random placements for a target material signature, kept only if all hold:

- Syzygy says it is a **win for the side to move**.
- **Breadth**: at least 3 legal moves preserve the win, AND at least 40% of all
  legal moves do. This is the load-bearing filter — it is what makes the position
  a premove drill instead of a puzzle.
- **Convertible in the time given**: playing it out full-strength for both sides
  reaches mate within `MAX_CONVERSION_PLIES` (30).

Breadth is measured per move by applying it and evaluating the child from the
opponent's point of view (a move keeps the win iff the child is lost for them).
`/candidates` at `multipv = <legal move count>` gives the same answer in one call
and is TB-exact — both methods agree (86% on a sample KQvK) — so use `/candidates`
for speed and the per-child probe only to spot-check.

### 3.2 Signatures

Weighted toward promotion races, which is the premove scenario:

| band | signatures | character |
|---|---|---|
| promotion | `KPvK`, `KPPvK`, `KPvKP`, `KPPvKP` | race to queen, many winning move orders |
| basic mate | `KQvK`, `KRvK` | pure premove speed |
| technique | `KRPvKR`, `KQvKP`, `KRvKP` | the hard end |

Do NOT hand-exclude signatures beyond this list. Narrow-technique endings
(`KBNvK` being the obvious one) are removed by the breadth rule on their own,
which is the point of having the rule.

### 3.3 Table `premove_position`, and why the builder reads Syzygy directly

Built by `scripts/build_premove_positions.py`, which probes the tablebase files
directly (python-chess) and **never calls the engine**.

That is not a style choice. The first builder drove zugzwang over HTTP and it
could not work, for a reason worth recording: zugzwang's root tablebase probe is
`tb_probe_root` — WDL, chosen deliberately (see `gomachine/CLAUDE.md` on why the
DTZ-ranked variant shuffles a won KBN to a draw). A WDL-optimal move *preserves*
the win but need not progress toward mate, so the engine playing both sides of a
won endgame shuffles forever. Measured: **0 of 15 random KQvK positions reached
mate at 100ms, 400ms or 1500ms per move.** Any "is this convertible?" filter built
on engine self-play measures nothing — ours was silently rejecting 57% of good
positions as unconvertible.

Reading Syzygy answers all three questions exactly and locally: is it won (WDL),
how long does it take (a DTZ-optimal walk to mate), and how many moves keep the
win (WDL of each child). It is also ~30x faster end to end with a ~24x better
keep rate (53% at 15/s, against 2.2% at 0.5/s through the engine), and it uses no
sockets — the HTTP builder exhausted the machine's entire ephemeral port range
and took MySQL down with it.

Columns: `fen`, `signature`, `side_to_move`, `piece_count`, `breadth_pct`,
`winning_moves`, `legal_moves`, `conversion_plies`, `rating`.

`rating` is the difficulty the player is rated against, derived from
**conversion length** and **breadth** (longer and narrower is harder) with piece
count as a minor term. It is an explicitly uncalibrated heuristic; every input is
stored on the row so it can be refit from real attempt data without regenerating
the pool.

**None of this metadata may reach the client.** `conversion_plies` states exactly
how long the win is, and `chain_target` is derived from it — either one hands the
player a third of the work. `PremoveGame::jsonSerialize()` and
`PremoveTrainerService::present()` whitelist the payload, and
`PremoveTrainerTest` asserts against the serialized JSON so a leak through a
newly-added field fails the suite.

### 3.4 Picking

Same widening-window indexed picker as before (`RATING_WINDOWS = [300, 600, 1200,
10000]`, random pivot, randomized scan direction, SQL `NOT EXISTS` de-dup against
this user's own `premove_game` rows, never `ORDER BY RAND()`), now against
`premove_position.rating`. Index `(signature, rating)` and `(rating)`.

Anonymous players skip de-dup and may see repeats.
## 4. Interaction model

**You are always building a chain and releasing it — in both modes, and also
after a collapse.** A single move is just a chain of length 1.

One code path, and it preserves the no-feedback-between-moves property that is
the entire point of the feature. Release is bound to the GO button, `Enter` and
`Space`.

This needs **no change to `useBoardInteraction`**. Wire it with:

```ts
useBoardInteraction({
    fen,
    myTurn: false,            // deliberate: keeps the chain from auto-firing
    legalMoves: NO_MOVES,
    submit: noop,             // never used; we release explicitly
    canPremove: true,
})
```

With `myTurn: false` the hook's fire effect (`useBoardInteraction.ts:152-164`)
never runs, so the chain accumulates in `interaction.premoves` until we read it.
`<Board>` gets `interactive={false}` and `premoveColor={playerColor}`, which is
what enables premove input and `premoveTargets` dots.

`interaction.premoves` is `{from, to}[]` — no promotion suffix. That is fine: the
chain is submitted as **4-character `from+to` strings** and the server resolves
any promotion to a queen, matching the hook's existing auto-queen premove
semantics (it already matches legal moves on the first 4 chars).

After release, call `interaction.cancelPremove()` to clear.

---

## 5. Playout semantics

Given a chain `[m1, m2, ... mN]`:

```
1. If timed: elapsed = nowMs() - last_move_at  (snapshot once)
   remaining = clock_ms - elapsed
   if remaining <= 0  -> status=lost, end_reason=flagged. STOP. (chain discarded)
   clock_ms = remaining
2. For each mi:
   a. legal = engine.move(fen, resolvePromotion(mi), history)
      if !legal.legal -> collapse at index i. Break.
   b. apply: append {ply, uci, san, fen, by:'player'}
   c. if legal.status is terminal -> finish(). Break.
   d. reply = engine.bestMove(fen, history, movetime=DEFENDER_MOVETIME_MS)
      apply: append {ply, uci, san, fen, by:'engine'}
   e. if reply status is terminal -> finish(). Break.
3. If the game is over  -> rate it (if rated), return the result.
   Else (chain exhausted or collapsed):
     casual -> status=lost, end_reason='chain-broke' (or 'unresolved' if the
               chain simply ran out without mating). Attempt over.
     rated  -> stay ongoing. last_move_at = nowMs() + plies * PLY_MS.
               Return the live position, its legal moves, and clock_ms.
```

`resolvePromotion(m)`: if `m` is 4 chars and moving a pawn to the back rank,
append `q`.

**Terminal mapping** (from zugzwang's `/move` `status`, `rules.cpp:196-236`):

| status | outcome |
|---|---|
| `checkmate`, player delivered | **won**, `end_reason=checkmate` |
| `checkmate`, engine delivered | lost, `end_reason=mated` |
| `stalemate` | lost, `end_reason=stalemate` |
| `draw-*` | lost, `end_reason=draw` |
| clock hits 0 | lost, `end_reason=flagged` |
| casual chain ends, no mate | lost, `end_reason=chain-broke` |

Anything short of mate is a loss. This is a mate trainer; "you didn't finish it"
is the same result however it happened.

**Defender**: full-strength zugzwang, `DEFENDER_MOVETIME_MS` cap, via the
**un-weakened** `/bestmove` path (no `rating`/`level`/`worst` in `limits` —
`EngineSelector::analyze`, not `bestMove`). In a mate position full strength
naturally plays the longest defense, which is what makes a deviation instructive
rather than random.

**History** for repetition is derived, not stored separately:
`[start_fen, ...moves.map(m => m.fen)]` minus the last entry.

**Bounds**: `MAX_CHAIN = 12` moves per release, `MAX_PLIES = 60` per game. Both
are request-bounding safety rails, not gameplay rules — a 10-second clock
terminates a rated game long before either.

---

## 6. Rating

New **isolated** Glicko-2 category `premove`, exactly like `puzzle`. It is not a
time-control category, never enters the WS ticket's ratings map, and never
touches live matchmaking.

Rated against the puzzle's own rating as a fixed opponent, mirroring
`PuzzleController::applyResult`:

```php
$rd = $this->glicko->inflateRd((float) $user->rd_premove, $idleDays);
[$r, $newRd, $vol] = $this->glicko->update(
    (float) $user->rating_premove,
    $rd,
    (float) $user->vol_premove,
    [['rating' => (float) $opponentRating, 'rd' => self::PREMOVE_RD, 'score' => $won ? 1.0 : 0.0]],
);
```

`PREMOVE_RD = 60.0` (same as `PUZZLE_RD` — Lichess puzzle ratings are settled
over millions of attempts).

`opponent_rating` is stored **on every row**. For v1 it is just `puzzle.rating`,
unadjusted. Chain length probably deserves a bonus — each extra ply is another
chance for the defender to deviate, and premoving punishes that superlinearly —
but inventing that constant now is guessing. Storing the value per row makes
recalibration a data question instead of a migration.

Rated only when `user_id !== null` **and** the format is rated. Anonymous players
may play the rated format (10-second clock and all); nothing is rated, and the UI
says so quietly. This matches how puzzles already treat anonymous solvers.

Rated **once per row**, and a row is one attempt, so there is no
`alreadyPlayed` guard to write — creating a game is the attempt.

---

## 7. Schema

### 7.1 `PremoveGame` → table `premove_game`

One model. It is simultaneously the live game and the attempt record (the
`GuessGame` precedent).

```php
public ?string $user_id = null;      // null = anonymous, never rated
public string $puzzle_id = '';
public bool $rated = false;          // was Glicko actually applied
public ?string $time_control = null; // "10+0" = rated format; null = casual
public string $player_color = 'w';
public string $start_fen = '';       // after the puzzle's setup move
public string $fen = '';             // current
public string $side_to_move = 'w';
public ?int $clock_ms = null;        // player's remaining; no opponent clock exists
public ?string $last_move_at = null; // epoch MILLISECONDS as a string
public string $status = 'ongoing';   // ongoing | won | lost
public ?string $end_reason = null;   // checkmate|mated|flagged|stalemate|draw|chain-broke|unresolved
public ?string $moves = null;        // JSON-in-TEXT: [{ply,uci,san,fen,by}]
public ?string $chains = null;       // JSON-in-TEXT: [["e2e4","d1h5"], ...] as released
public int $chain_target = 0;        // the puzzle's player-move count
public int $opponent_rating = 1500;  // what we rated against
public ?int $rating_before = null;
public ?int $rating_after = null;
public ?int $rating_delta = null;
```

`$indexes`: `user_id` index, `puzzle_id` index.

`$columns` must force TEXT + nullable for `moves`, `chains`, `time_control`,
`last_move_at` and `end_reason`. **`last_move_at` in particular** — without an
explicit entry BaseAPI coerces it to a datetime column and the epoch-ms string
breaks, which is precisely why `BotGame` declares it (`BotGame.php:113-118`).

JSON-in-TEXT accessors (`getMoves`/`setMoves`, `getChains`/`setChains`) follow the
`BotGame` pattern — BaseAPI's array cast decodes on read but does **not** encode
on write, so it must be hand-rolled.

`jsonSerialize()` decodes `moves` and `chains` for output and **strips
`puzzle_id`** — the puzzle id is a lookup key into a public CC0 dataset whose
solution is one query away.

### 7.2 `User` additions

Per the existing per-category block:

```php
public int $rating_premove = 1500;
public float $rd_premove = 350.0;
public float $vol_premove = 0.06;
public ?string $rated_at_premove = null;
public int $games_premove = 0;
```

Plus `'rated_at_premove' => ['type' => 'TEXT', 'nullable' => true]` in
`$columns`, and `'premove'` appended to `RATING_CATEGORIES`.

Then `php mason migrate:generate && php mason migrate:apply -y`. Never hand-write
DDL, never `--safe`.

---

## 8. API

Three endpoints. **The puzzle's solution never reaches the client** — it only
ever receives the current FEN, that position's legal moves, and the clock.

### `POST /premove-games`

Create, which doubles as "next". Rate limit `300/1m`, `SessionStartMiddleware`
(optional auth).

```jsonc
// request
{ "format": "rated" | "casual" }

// 201
{
  "id": "uuid",
  "format": "rated",
  "rated": true,              // false when anonymous, even in rated format
  "player_color": "w",
  "fen": "<start_fen>",
  "side_to_move": "w",
  "legal_moves": ["e2e4", ...],
  "status": "ongoing",
  "end_reason": null,
  "clock_ms": 10000,          // null in casual
  "resume_at": 1754650000250, // epoch ms the clock starts; null in casual
  "ply_ms": 320,              // playout cadence the client MUST animate at
  "moves": [],
  "rating": { "before": 1500, "provisional": true }   // omitted when unrated
}
```

`503` with `{"error":"no puzzle available"}` if the pool is exhausted.

### `POST /premove-games/{id}/release`

Rate limit `1200/1m`.

```jsonc
// request
{ "chain": ["e2e4", "d1h5"] }    // 4-char from+to, 1..12 entries

// 200 — same shape as create, plus:
{
  ...,
  "status": "won",
  "end_reason": "checkmate",
  "playout": [                       // the plies to animate, in order
    { "ply": 1, "uci": "d1h5", "san": "Qh5+", "fen": "...", "by": "player" },
    { "ply": 2, "uci": "g8h8", "san": "Kh8",  "fen": "...", "by": "engine" }
  ],
  "collapsed_at": null,              // 0-based index into the submitted chain, or null
  "clock_ms": 7420,
  "resume_at": 1754650003100,        // null when the game is over
  "rating": { "before": 1500, "after": 1531, "delta": 31, "provisional": true }
}
```

`422` on a malformed chain (empty, over `MAX_CHAIN`, non-UCI-shaped) or a move
submitted to a finished game. A chain whose **first** move is illegal is not an
error — it is `collapsed_at: 0`, which is a legitimate and instructive outcome.

### `GET /premove-games/{id}`

Current state, same shape, for refresh and resume. No `playout`.

---

## 9. Constants

| name | value | where | why |
|---|---|---|---|
| `RATED_TIME_CONTROL` | `"10+0"` | service | single fixed control; difficulty lives in the position's rating, so a fixed clock is the clean rating axis |
| `START_GRACE_MS` | `250` | service | covers response transit + first paint so "starts NOW" means when you see it |
| `DEFENDER_MOVETIME_MS` | `120` | service | off-clock, so it can be generous; bounds the request at ~1.5s for a 12-move chain |
| `PLY_MS_RATED` | `320` | service | playout cadence; also the future-stamp multiplier |
| `PLY_MS_CASUAL` | `180` | service | nothing at stake, so move it along |
| `MAX_CHAIN` | `12` | service | request bound |
| `MAX_PLIES` | `60` | service | row bound |
| `PREMOVE_RD` | `60.0` | service | fixed-opponent RD, same as `PUZZLE_RD` |

`PLY_MS` is load-bearing on both sides: the server multiplies by it to compute the
future-stamp, the client animates at it. It is defined **once, server-side**, and
every create/release response carries it as `ply_ms`. The client animates at
whatever the server says and never hardcodes a cadence — otherwise the two drift
and the player silently gains or loses clock on every collapse.

---

## 10. Surfaces

- Route `/premove` → `pages/PremoveTrainer.tsx`, lazy (`suspended()`), registered
  in `frontend/src/main.tsx`.
- Nav: an entry under **Play**, next to Puzzles (`components/Layout.tsx:56-67`).
- Home page: the "More" grid is deliberately six cells so it fills the 3-up and
  2-up layouts exactly; a seventh orphans a row. So **Guess the Elo moves out of
  "More"** into a new **"Train"** row of three — Puzzles, Premove Trainer, Guess
  the Elo — leaving "More" as the five variants. Update the block comment at
  `pages/home/parts.tsx:407-410`, which currently asserts the six-cell property.
- Profile: a `premove` block in `ProfileController::get()` plus a rating-history
  series (modelled on `puzzleRatingSeries()`, sourced from `premove_game` rows),
  and a tile in `components/profile/RatingsPanel.tsx`.
- Leaderboard: add `'premove'` to `LeaderboardController::CATEGORIES`. **Also add
  the missing `'crazyhouse'`** while in that array — a pre-existing gap, fixed as
  a drive-by and called out in the commit.

**iOS is out of scope** and is not touched. Full parity is a project value but it
is a second full client and deserves its own task.

---

## 11. Client flow

```
/premove
  └─ format picker: [ Rated ] [ Casual ]         (empty board behind it)
       └─ START
            └─ POST /premove-games  → position renders, clock starts at resume_at
                 └─ queue premoves (board is interactive=false, premoveColor=you)
                      └─ GO / Enter / Space
                           └─ POST .../release
                                └─ animate `playout` at ply_ms, input blocked
                                     ├─ status !== ongoing → result card → NEXT
                                     └─ ongoing (rated collapse) → clock resumes
                                        at resume_at, queue again
```

The result card states what happened in one line: mated in N, flagged, or the
chain broke at move K (`collapsed_at + 1`). Rated shows the rating delta. NEXT
posts a new game in the same format.

A running streak is kept client-side in `localStorage` (`chessgo.premoveStreak`),
same as `chessgo.puzzleStreak`. There is no session/rush wrapper in v1 — the loop
is endless, which is what the mode is for.

`<Board>` has no sequence API, so the animator steps `fen`, `overrideBoard` and
`lastMove` on timers, exactly the way `Puzzles.tsx` stages its opponent replies
via `applyUciVisually` + a `later()` helper.

---

## 12. Test surface

PHPUnit, `tests/Unit/PremoveTrainerTest.php`:

- clock charge: elapsed is snapshotted once and engine think time never lands on it
- flag on release after the clock has run out; the chain is discarded
- collapse mid-chain in rated → still `ongoing`, correct `collapsed_at`, correct
  remaining clock
- collapse in casual → `lost` / `chain-broke`
- the future-stamp: `last_move_at - nowMs() ≈ plies * PLY_MS`
- mate detection maps to `won` / `checkmate`
- rating applied exactly once and only for a logged-in rated game
- **the solution never appears in any response payload** (assert against the
  serialized JSON, so a leak through a newly-added field still fails the test —
  the `SecretQueenRedactionTest` pattern)

Frontend: `bun run typecheck && bun run build` must be green.
