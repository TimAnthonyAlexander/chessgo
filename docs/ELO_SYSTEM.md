# ELO_SYSTEM.md — chessgo ratings

How chessgo computes and stores player ratings. The model is **Lichess-style
per-time-control Elo**: a player has four independent ratings (bullet, blitz,
rapid, classical), each with its own provisional K-factor, updated only when a
game is *rated*. **Puzzles** add a fifth, fully isolated rating that reuses the
same math but never touches the game ratings — see §9.

Authoritative code:

- `app/Services/EloService.php` — the math (categories, expected score, new
  rating, K-factor).
- `app/Controllers/GameResultController.php` — applies Elo when the hub persists
  a finished game.
- `app/Models/User.php` — per-category rating + games-played columns.
- `app/Models/Game.php` — the durable game record (stores before/after ratings).
- `app/Controllers/WsTicketController.php` + `app/Services/WsTicketService.php` —
  load the player's ratings into the signed WebSocket ticket.
- `gomachine/internal/hub/{hub.go,bot.go,game.go}` + `internal/auth/ticket.go` —
  decide whether a live game is rated and carry ratings through the hub.
- `app/Controllers/PuzzleController.php` — applies the isolated **puzzle** Elo
  (§9); `app/Models/{Puzzle,PuzzleAttempt}.php` — the fixed puzzle rating + the
  rated-once attempt record.

---

## 1. Categories

A rating category is derived from the time-control **pool** (e.g. `"3+0"`,
`"10+5"`) by estimated game duration:

```
estSeconds = baseSeconds + 40 × incrementSeconds
```

| Estimated duration | Category    |
|--------------------|-------------|
| `< 180s`           | `bullet`    |
| `< 480s`           | `blitz`     |
| `< 1500s`          | `rapid`     |
| `≥ 1500s`          | `classical` |

The `40 × increment` term mirrors Lichess (a game is assumed to last ~40 moves,
so each increment second is worth ~40 real seconds). UltraBullet is folded into
`bullet`.

> **Two implementations, one rule.** The mapping exists in PHP
> (`EloService::categoryForPool`, base in minutes) and in Go
> (`hub/protocol.go: categoryForPool`, base in milliseconds). They must agree —
> the hub uses the category to show the opponent's rating in-game, and BaseAPI
> uses it to pick which rating column to update. The thresholds above are the
> contract between them.

---

## 2. Storage

Ratings live on the `User` model (`user` table), one rating + one games-played
counter per category:

```php
// app/Models/User.php
public int $rating_bullet   = 1500;   public int $games_bullet    = 0;
public int $rating_blitz    = 1500;   public int $games_blitz     = 0;
public int $rating_rapid    = 1500;   public int $games_rapid     = 0;
public int $rating_classical= 1500;   public int $games_classical = 0;
```

- **Start rating: 1500** (`EloService::START`).
- `games_<category>` counts *rated* games completed in that category and selects
  the K-factor (below). It is the count **before** the current game when the
  update is computed.
- Columns are named `rating_<category>` / `games_<category>`; the controller
  builds the column name from the category string at runtime.

Per BaseAPI conventions, schema changes go through the model →
`migrate:generate` → `migrate:apply -y`. Never hand-write DDL.

---

## 3. The math

All in `EloService`.

**Expected score** of A against B (standard Elo logistic, 400-point scale):

```
E_A = 1 / (1 + 10^((ratingB − ratingA) / 400))
```

**New rating** after one game:

```
rating' = round( rating + K × (score − E) )
```

where `score` is `1` (win), `0.5` (draw), or `0` (loss).

**K-factor** (provisional then stable):

| Condition                                   | K  |
|---------------------------------------------|----|
| `games_<category> < 20` (provisional)       | 40 |
| `games_<category> ≥ 20` (settled)           | 20 |

Provisional K is selected per category from the games-played count **before**
this game. Each category settles independently — a player can be settled at
blitz and still provisional at classical.

> Constants: `START = 1500`, `PROVISIONAL_GAMES = 20`, `K_PROVISIONAL = 40`,
> `K_STABLE = 20`.

---

## 4. When is a game rated?

"Rated" is decided by the **hub** at match time and carried on the game record;
BaseAPI trusts that flag (and re-checks account/bot status when applying Elo).

| Match-up                                    | Rated?                          |
|---------------------------------------------|---------------------------------|
| Two registered accounts (human vs human)    | **Yes** — symmetric Elo         |
| Logged-in account vs matchmaking fill-in bot| **Yes** — one-sided Elo         |
| Anonymous player involved (either side)     | **No**                          |
| Explicit `/bot` game (vs AI)                 | **No** — never reaches the hub  |
| Aborted game (first-move timeout)            | **No** — not reported at all    |

Decision points:

- Human-vs-human (`hub.go`): `rated = !white.anon && !black.anon` — both sides
  must be accounts.
- Bot fill-in (`bot.go: startBotGame`): `rated = !human.anon` — a logged-in
  human gets a one-sided rated game against the bot; an anonymous human does not.
- `/bot` games are handled entirely by `BotGameService` in PHP and never touch
  the hub, so they have no rating effect.
- Aborted games are **not** sent to `onFinish`, so they never reach
  `/internal/games`.

---

## 5. End-to-end flow (rated live game)

```
1. GET /ws-ticket
     WsTicketController loads the user's four ratings, mints an HMAC ticket
     carrying identity { sub, anon, name, rating, ratings:{bullet,…} }.

2. Hub match
     Hub verifies the ticket, pairs players, sets game.rated, and shows each
     side the opponent's rating in the game's category (Identity.RatingFor).

3. Game ends
     Hub fire-and-forgets POST {BASEAPI_URL}/internal/games
     header  X-Hub-Secret: <WS_TICKET_SECRET>
     body    { id, pool, rated, result, reason, white:{…,rating}, black:{…}, … }

4. GameResultController
     - idempotent on hub_game_id (a retried persist is a no-op),
     - derives category from pool,
     - stores the Game record,
     - if rated, applies Elo and writes rating before/after onto the record.
```

The shared secret is `WS_TICKET_SECRET` (same value BaseAPI uses to sign tickets
and the hub uses to authenticate the persist call). See CLAUDE.md for the env
wiring.

---

## 6. Applying Elo (`GameResultController`)

Two paths, chosen after resolving each side to a real account (`resolveAccount`
returns `null` for anonymous/bot/unknown uids):

**Symmetric — both sides are accounts** (`applyElo`):

```
ws, bs = score for white, black   (from "1-0" / "0-1" / "1/2-1/2")
newW = newRating(whiteRating, blackRating, ws, whiteGames)
newB = newRating(blackRating, whiteRating, bs, blackGames)
# each side's games_<category> += 1
```

Both ratings move, each against the opponent's *current* rating, with each
side's own K-factor.

**One-sided — account vs fill-in bot** (`applyEloVsBot`):

```
newU = newRating(userRating, botRating, userScore, userGames)
# only the human's rating + games count change
```

The bot has no account, so only the human's rating moves, against the **bot's
displayed rating** (sent by the hub in the persist body, default 1500 if
missing). The bot's "before/after" on the game record are both set to its static
displayed rating.

In every case the `Game` record stores `white_rating_before/after` and
`black_rating_before/after` (`null` for an unrated game or a non-account side).

---

## 7. Ratings through the hub

- The signed ticket's `Identity` carries `Ratings map[string]int` (per category)
  plus a default `Rating`. `Identity.RatingFor(category)` returns the category
  rating, falling back to the default when absent (e.g. bots).
- `WsTicketController` sets the default ticket `rating` to the player's **blitz**
  rating (shown when the category is unknown, e.g. the `hello` message before a
  pool is chosen).
- Fill-in bots are **Elo-matched to the human** (`startBotGame` + `bot.go`):
  the displayed rating wobbles around the human's category rating by
  `±botRatingJitter` (120), clamped to `[botRatingMin, botRatingMax]` = `[600,
  2600]`, and the engine level is derived from that displayed rating via
  `levelForRating` (~600→0, 1500→5, ≥2400→10) and stored on the game (`g.botLevel`).
  So the one-sided Elo opponent value is close to the human's own rating and the
  bot actually plays at roughly that strength. Anonymous humans have no rating, so
  the bot falls back to the configured `-bot-level` (`ratingForLevel`).

> **Heuristic, not yet calibrated:** `levelForRating` is a reasonable monotonic
> mapping, but the engine's levels aren't precisely Elo-calibrated, so a "1700"
> bot only plays *approximately* at 1700. Tightening the level↔Elo calibration is
> tracked in `docs/SPEC.md` §11.

---

## 8. Result → score mapping

`result` is always one of `"1-0"`, `"0-1"`, `"1/2-1/2"` (White, Black, draw).
Score per side:

| result      | White score | Black score |
|-------------|-------------|-------------|
| `1-0`       | 1.0         | 0.0         |
| `0-1`       | 0.0         | 1.0         |
| `1/2-1/2`   | 0.5         | 0.5         |

Timeout-with-insufficient-material is resolved upstream in the hub to one of
these three results before persistence (see the timeout handling in `hub.go` and
the correctness invariants in CLAUDE.md), so the Elo layer only ever sees a
standard result string.

---

## 9. Puzzles

Puzzle solving has its own rating — a **fifth, fully isolated category**. It
reuses the *exact same Elo math* (`EloService`), but it is **not** a time control
and it **never** reads or writes the bullet/blitz/rapid/classical columns. A
player's tactical strength and their game strength are tracked separately.

Authoritative code: `app/Controllers/PuzzleController.php` (applies it),
`app/Models/Puzzle.php` (the fixed puzzle rating), `app/Models/PuzzleAttempt.php`
(the rated-once record), `app/Models/User.php` (`rating_puzzle` / `games_puzzle`).
Full feature design: `docs/SPEC.md` §9.

### 9.1 What's different from game Elo

| Aspect            | Game Elo                          | Puzzle Elo                              |
|-------------------|-----------------------------------|-----------------------------------------|
| Categories        | 4 (per time control)              | 1 (`puzzle`), isolated                   |
| Opponent rating   | the other player (also moves)     | the **puzzle's** rating — **fixed**      |
| Whose rating moves| both sides                        | **only the solver's**                    |
| Score values      | 1 / 0.5 / 0                       | **1 (solved) or 0 (failed)** — no draws  |
| Time / increment  | affects the category              | **none** — solving fast ≠ more points    |
| Applied by        | `GameResultController`             | `PuzzleController`                        |
| Trigger           | `POST /internal/games`            | `POST /puzzles/{id}/move` (terminal ply) |

The puzzle's rating is treated as **ground truth** (settled over millions of
Lichess attempts, imported and held constant). So a puzzle attempt is just a
rated "game" against a fixed-rating opponent: the solver's rating moves, the
puzzle's does not.

### 9.2 Storage

```php
// app/Models/User.php
public int $rating_puzzle = 1500;   public int $games_puzzle = 0;
```

- **Start rating: 1500** (same `EloService::START`).
- `games_puzzle` counts rated puzzle attempts and selects the K-factor — it is
  the count **before** the current attempt, exactly like the game categories
  (provisional K=40 for the first 20, then K=20).
- `puzzle_attempt` (unique `(user_id, puzzle_id)`) records `solved` and
  `rating_before` / `rating_after` for each first encounter — the audit trail and
  the idempotency key (below). `puzzle_id` is the puzzle's UUID, not the
  case-sensitive Lichess `ext_id` (see SPEC §9.2).

### 9.3 The update

Same formula, same constants (§3):

```
score   = 1 if solved (no wrong move), else 0
E       = 1 / (1 + 10^((puzzleRating − userRating) / 400))
K       = 40 if games_puzzle < 20 else 20
rating' = round( userRating + K × (score − E) )
```

Worked example: a 1500-rated solver (provisional, K=40) solves an 1800-rated
puzzle. `E = 1/(1+10^(300/400)) ≈ 0.151`, so
`1500 + 40 × (1 − 0.151) ≈ 1534` (**+34**). Failing it instead would give
`1500 + 40 × (0 − 0.151) ≈ 1494` (**−6**) — harder puzzles cost little to miss
and reward a lot to solve, which is the whole point of rating-matched serving.

### 9.4 When is a puzzle attempt rated?

| Solver                         | Rated?                                   |
|--------------------------------|------------------------------------------|
| Logged-in account, first try   | **Yes** — `rating_puzzle` moves once     |
| Logged-in account, re-attempt  | **No** — already played (returns Δ 0)    |
| Anonymous solver               | **No** — no attempt recorded at all      |

- **Terminal event** = the attempt resolves: *solved* on the last correct player
  move, *failed* on the **first** wrong move. Intermediate correct moves change
  nothing.
- **Rated once.** Only a player's first encounter with a puzzle is rated (the
  Lichess model). `PuzzleController` guards on the existence of a `puzzle_attempt`
  row before applying Elo; a re-submission returns the current rating with
  `delta: 0` and writes nothing. Served puzzles also exclude already-attempted
  ones, so a second encounter is rare by construction.
- **Anonymous = casual.** No user → no Elo, no `puzzle_attempt` row.

### 9.5 Flow

```
1. GET /puzzles/next            (optional session, like /ws-ticket)
     Picks an unseen puzzle near user.rating_puzzle; solution withheld.

2. POST /puzzles/{id}/move      { move, fen, ply }
     Move validated against the stored line by INDEX (solution stays server-side).
     - correct & more   → return scripted reply + next position (no rating change)
     - correct & done   → SOLVED  → applyResult(user, puzzle, solved=true)
     - wrong            → FAILED  → applyResult(user, puzzle, solved=false)

3. applyResult (logged-in, first attempt only)
     - newRating(user.rating_puzzle, puzzle.rating, score, user.games_puzzle)
     - user.rating_puzzle = new;  user.games_puzzle += 1
     - insert puzzle_attempt { solved, rating_before, rating_after }
     - response carries { value, delta, games }; the SPA refreshes the header.
```

---

## Summary

| Aspect              | Value / rule                                              |
|---------------------|-----------------------------------------------------------|
| Model               | Per-time-control Elo (bullet/blitz/rapid/classical) + isolated puzzle Elo |
| Start rating        | 1500 (all categories, incl. puzzle)                       |
| K-factor            | 40 for first 20 games per category, then 20               |
| Expected score      | `1 / (1 + 10^((Rb − Ra)/400))`                            |
| Update              | `round(R + K·(score − E))`                                 |
| Rated games         | Both accounts (symmetric); account vs fill-in bot (one-sided) |
| Rated puzzles       | Logged-in solver, first attempt only (one-sided vs the puzzle's fixed rating) |
| Unrated             | Anyone anonymous; `/bot` games; aborted games; puzzle re-attempts |
| Storage             | `User.rating_<cat>` + `User.games_<cat>` (incl. `_puzzle`) |
| Applied by          | `GameResultController` on `POST /internal/games`; `PuzzleController` on `POST /puzzles/{id}/move` |
