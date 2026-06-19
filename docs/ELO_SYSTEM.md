# ELO_SYSTEM.md — chessgo ratings

How chessgo computes and stores player ratings. The model is **Lichess-style
per-time-control Glicko-2**: a player has four independent ratings (bullet,
blitz, rapid, classical), each carrying not just a number but the system's
*confidence* in it, updated only when a game is *rated*. **Puzzles** add a fifth,
fully isolated rating that reuses the same math but never touches the game
ratings — see §9.

Glicko-2 tracks three numbers per category:

| Symbol | Stored as | Meaning |
|--------|-----------|---------|
| **rating** | `rating_<cat>` (int) | the skill estimate (display scale, anchored at 1500) |
| **RD** (rating deviation) | `rd_<cat>` (double) | the system's *uncertainty* — a 95% interval of ±2·RD |
| **σ** (volatility) | `vol_<cat>` (double) | how erratic the player's recent results have been |

A new account starts at **1500 / RD 350 / σ 0.06**: the system is ~95% sure your
real rating is somewhere in 800–2200, so the first results swing **±150–400
points**. Each game shrinks RD (more confidence ⇒ smaller future moves); idle
time grows it back. Once **RD ≤ 110** the rating is *established* (no longer
shown with a "?"). chessgo rates **one game at a time** (no rating periods),
matching Lichess.

Authoritative code:

- `app/Services/Glicko2Service.php` — the math (categories, the Glicko-2 update,
  provisional test, inactivity RD inflation). Pinned to Glickman's published
  worked example by `tests/Unit/Glicko2ServiceTest.php`.
- `app/Controllers/GameResultController.php` — applies the update when the hub
  persists a finished game.
- `app/Models/User.php` — per-category rating + RD + volatility + last-rated +
  games-played columns, and the derived `provisional` map in `jsonSerialize()`.
- `app/Models/Game.php` — the durable game record (stores before/after ratings).
- `app/Controllers/WsTicketController.php` + `app/Services/WsTicketService.php` —
  load the player's ratings into the signed WebSocket ticket (rating *number*
  only — RD is never sent to the hub; matchmaking treats provisional and
  established ratings equally).
- `gomachine/internal/hub/{hub.go,bot.go,game.go}` + `internal/auth/ticket.go` —
  decide whether a live game is rated and carry ratings through the hub.
- `app/Controllers/PuzzleController.php` — applies the isolated **puzzle** rating
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
> (`Glicko2Service::categoryForPool`, base in minutes) and in Go
> (`hub/protocol.go: categoryForPool`, base in milliseconds). They must agree —
> the hub uses the category to show the opponent's rating in-game, and BaseAPI
> uses it to pick which rating column to update. The thresholds above are the
> contract between them.

---

## 2. Storage

Ratings live on the `User` model (`user` table), one **triple** plus a
last-rated timestamp and a games-played counter per category:

```php
// app/Models/User.php
public int     $rating_bullet   = 1500;   public float  $rd_bullet  = 350.0;
public float   $vol_bullet      = 0.06;    public ?string $rated_at_bullet = null;
public int     $games_bullet    = 0;
// … blitz / rapid / classical identical, plus the isolated puzzle set …
```

- **Start rating: 1500**, **start RD: 350**, **start σ: 0.06**
  (`Glicko2Service::START` / `START_RD` / `START_VOL`).
- `rd_<category>` is the live uncertainty. `vol_<category>` feeds the volatility
  step. `rated_at_<category>` (nullable TEXT ISO datetime, like `ApiToken`) is
  the last rated game in that category — read via `strtotime()` to grow RD over
  idle time (§3, inactivity).
- `games_<category>` is **display-only** now (the K-factor it used to drive is
  gone — Glicko-2 derives step size from RD, not a game count).
- Columns are named `rating_/rd_/vol_/rated_at_/games_<category>`; the controllers
  build the column name from the category string at runtime.
- `User::jsonSerialize()` adds a derived **`provisional`** map (`{ bullet: bool,
  …, puzzle: bool }`, each `rd > 110`) so the frontend can render the "?" without
  re-deriving the threshold.

Per BaseAPI conventions, schema changes go through the model →
`migrate:generate` → `migrate:apply -y`. Never hand-write DDL. (The RD/vol/
rated_at columns were added this way; existing rows defaulted to RD 350.)

---

## 3. The math

All in `Glicko2Service`, following Glickman's *"Example of the Glicko-2 system"*.
Constants: `START = 1500`, `START_RD = 350`, `START_VOL = 0.06`,
`PROVISIONAL_RD = 110`, `MAX_RD = 350`, `TAU = 0.5` (volatility-change limit),
`SCALE = 173.7178` (display ↔ internal μ/φ).

**One update** (`update(rating, rd, vol, results)`) — `results` is the list of
opponents faced (chessgo passes exactly one; the multi-opponent form is the
general Glicko-2 rating period the canonical test exercises). Sketch:

```
μ, φ   = (rating − 1500)/173.7178,  rd/173.7178          # to internal scale
for each opponent j:                                      # g(): certainty weight; E(): expected score
  g_j  = 1 / sqrt(1 + 3φ_j²/π²)
  E_j  = 1 / (1 + exp(−g_j·(μ − μ_j)))
v      = 1 / Σ g_j²·E_j·(1−E_j)                            # estimated variance
Δ      = v · Σ g_j·(s_j − E_j)                            # rating-change direction
σ'     = solve volatility (Illinois iteration, τ)          # erraticness update
φ*     = sqrt(φ² + σ'²)                                    # single-game RD growth
φ'     = 1 / sqrt(1/φ*² + 1/v)                             # shrunk by the new evidence
μ'     = μ + φ'²·Σ g_j·(s_j − E_j)
rating', rd' = 173.7178·μ' + 1500,  min(173.7178·φ', 350)
```

where `s` is `1` (win), `0.5` (draw), or `0` (loss). The net effect: **RD scales
the step**. The same single result moves a player very differently by confidence:

| Player                | Result vs equal (1500/RD60) | New rating | New RD |
|-----------------------|-----------------------------|-----------:|-------:|
| Fresh (RD 350)        | win                         | **+175**   | 249    |
| Fresh (RD 350)        | loss                        | **−175**   | 249    |
| Settled (RD 45)       | win                         | **+6**     | 46     |
| Settled (RD 45)       | loss                        | **−6**     | 46     |

So a few games in you move in big steps; ~15–20 games in, RD has dropped below
110 (no longer provisional) and each game only nudges you a handful of points.

**Provisional** (`provisional(rd)`): `rd > 110`. Shown with a "?". Provisional
and established ratings count *equally* for matchmaking — the flag is cosmetic +
informational, it doesn't gate pairing.

**Inactivity** (`inflateRd(rd, idleDays)`): before each game the controllers grow
the stored RD for the time since the last rated game in that category — the
rating *number* is untouched, only the uncertainty rises, so the next games after
a break move in bigger steps until RD settles again. The growth constant is
chosen so a just-established player (RD 110) climbs back to the full 350 over
roughly a year idle, then is capped:

```
RD ← min( sqrt(RD² + c²·idleDays),  350 ),   c² = (350² − 110²)/365
```

e.g. a settled RD-60 rating grows to **~176 after 90 days** (provisional again)
and **~338 after a year**.

---

## 4. When is a game rated?

"Rated" is decided by the **hub** at match time and carried on the game record;
BaseAPI trusts that flag (and re-checks account/bot status when applying the
update).

| Match-up                                    | Rated?                          |
|---------------------------------------------|---------------------------------|
| Two registered accounts (human vs human)    | **Yes** — symmetric update      |
| Logged-in account vs matchmaking fill-in bot| **Yes** — one-sided update      |
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
     (Numbers only — RD/σ stay server-side.)

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
     - if rated, applies the Glicko-2 update and writes rating before/after
       onto the record.
```

The shared secret is `WS_TICKET_SECRET` (same value BaseAPI uses to sign tickets
and the hub uses to authenticate the persist call). See CLAUDE.md for the env
wiring.

---

## 6. Applying the update (`GameResultController`)

Two paths, chosen after resolving each side to a real account (`resolveAccount`
returns `null` for anonymous/bot/unknown uids). Both first compute each player's
**current RD** (`currentRd`: stored `rd_<cat>` inflated for idle time since
`rated_at_<cat>`), then write back the new triple, bump `games_<cat>`, and stamp
`rated_at_<cat>` (`writeRating`).

**Symmetric — both sides are accounts** (`applyElo`):

```
ws, bs   = score for white, black   (from "1-0" / "0-1" / "1/2-1/2")
wRd, bRd = currentRd(white), currentRd(black)        # pre-game, idle-inflated
newW = update(whiteRating, wRd, whiteVol, [{ black: bRd, score: ws }])
newB = update(blackRating, bRd, blackVol, [{ white: wRd, score: bs }])
```

Both players move, each against the opponent's *pre-game* rating **and RD** (a
result against a high-RD opponent counts for less), with their own RD setting
their own step size.

**One-sided — account vs fill-in bot** (`applyEloVsBot`):

```
newU = update(userRating, currentRd(user), userVol,
              [{ rating: botRating, rd: BOT_RD, score: userScore }])
```

The bot has no account, so only the human's rating moves, against the **bot's
displayed rating** (sent by the hub, default 1500 if missing) treated as a
stable, established opponent — **`BOT_RD = 50`**. The bot's "before/after" on the
game record are both its static displayed rating.

In every case the `Game` record stores `white_rating_before/after` and
`black_rating_before/after` (the rounded rating; `null` for an unrated game or a
non-account side).

---

## 7. Ratings through the hub

- The signed ticket's `Identity` carries `Ratings map[string]int` (per category)
  plus a default `Rating`. `Identity.RatingFor(category)` returns the category
  rating, falling back to the default when absent (e.g. bots). **RD is not in the
  ticket** — the hub never needs it (matchmaking is by rating number).
- `WsTicketController` sets the default ticket `rating` to the player's **blitz**
  rating (shown when the category is unknown, e.g. the `hello` message before a
  pool is chosen).
- Fill-in bots are **rating-matched to the human** (`startBotGame` + `bot.go`):
  the displayed rating wobbles around the human's category rating by
  `±botRatingJitter` (120), clamped to `[botRatingMin, botRatingMax]` = `[600,
  2600]`, and the engine level is derived from that displayed rating via
  `levelForRating` (~600→0, 1500→5, ≥2400→10) and stored on the game (`g.botLevel`).
  So the one-sided opponent value is close to the human's own rating and the bot
  actually plays at roughly that strength. Anonymous humans have no rating, so
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
the correctness invariants in CLAUDE.md), so the rating layer only ever sees a
standard result string.

> **Color advantage (not implemented):** Lichess awards slightly more for a win
> with Black. chessgo's v1 uses standard symmetric Glicko-2 — score depends only
> on the result, not the color. This is a deliberate omission, layerable later.

---

## 9. Puzzles

Puzzle solving has its own rating — a **fifth, fully isolated category**. It
reuses the *exact same Glicko-2 math* (`Glicko2Service`), but it is **not** a
time control and it **never** reads or writes the bullet/blitz/rapid/classical
columns. A player's tactical strength and their game strength are tracked
separately.

Authoritative code: `app/Controllers/PuzzleController.php` (applies it),
`app/Models/Puzzle.php` (the fixed puzzle rating), `app/Models/PuzzleAttempt.php`
(the rated-once record), `app/Models/User.php` (`rating_puzzle` / `rd_puzzle` /
`vol_puzzle` / `rated_at_puzzle` / `games_puzzle`). Full feature design:
`docs/SPEC.md` §9.

### 9.1 What's different from game ratings

| Aspect            | Game rating                       | Puzzle rating                           |
|-------------------|-----------------------------------|-----------------------------------------|
| Categories        | 4 (per time control)              | 1 (`puzzle`), isolated                   |
| Opponent          | the other player (RD moves too)   | the **puzzle's** rating — **fixed**, `PUZZLE_RD = 60` |
| Whose rating moves| both sides                        | **only the solver's**                    |
| Score values      | 1 / 0.5 / 0                       | **1 (solved) or 0 (failed)** — no draws  |
| Time / increment  | affects the category              | **none** — solving fast ≠ more points    |
| Applied by        | `GameResultController`             | `PuzzleController`                        |
| Trigger           | `POST /internal/games`            | `POST /puzzles/{id}/move` (terminal ply) |

The puzzle's rating is treated as **ground truth** (settled over millions of
Lichess attempts, imported and held constant). So a puzzle attempt is just a
rated "game" against a fixed, well-established opponent (RD 60): the solver's
rating + RD move, the puzzle's does not.

### 9.2 Storage

```php
// app/Models/User.php
public int $rating_puzzle = 1500;  public float $rd_puzzle = 350.0;
public float $vol_puzzle = 0.06;   public ?string $rated_at_puzzle = null;
public int $games_puzzle = 0;
```

- **Start: 1500 / RD 350 / σ 0.06** (same constants as the game categories).
- `games_puzzle` counts rated puzzle attempts (display-only). `rd_puzzle` drives
  the step size and the provisional "?" exactly like the game categories;
  `rated_at_puzzle` ages RD over idle time.
- `puzzle_attempt` (unique `(user_id, puzzle_id)`) records `solved` and
  `rating_before` / `rating_after` for each first encounter — the audit trail and
  the idempotency key (below). `puzzle_id` is the puzzle's UUID, not the
  case-sensitive Lichess `ext_id` (see SPEC §9.2).

### 9.3 The update

Same `update()` as §3, opponent = the puzzle at a fixed RD 60, score 1/0:

```
score        = 1 if solved (no wrong move), else 0
[r', rd', σ'] = update(rating_puzzle, inflateRd(rd_puzzle, idleDays), vol_puzzle,
                       [{ rating: puzzle.rating, rd: 60, score }])
```

Because RD scales the step, a **fresh** solver's puzzle rating finds its level
fast, while a settled one barely moves:

| Solver            | 1800-rated puzzle | New rating |
|-------------------|-------------------|-----------:|
| Fresh (RD 350)    | solved            | **+387**   |
| Fresh (RD 350)    | failed            | **−71**    |
| Settled (RD 55)   | solved            | **+15**    |

(Harder puzzles still cost little to miss and reward a lot to solve — the point
of rating-matched serving — but now the *magnitude* tracks confidence, not a flat
K-factor.)

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
  row before applying the update; a re-submission returns the current rating with
  `delta: 0` and writes nothing. Served puzzles also exclude already-attempted
  ones, so a second encounter is rare by construction.
- **Anonymous = casual.** No user → no rating change, no `puzzle_attempt` row.

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
     - update(rating_puzzle, inflated rd_puzzle, vol_puzzle, [puzzle @ RD 60, score])
     - write rating_puzzle / rd_puzzle / vol_puzzle / rated_at_puzzle; games_puzzle += 1
     - insert puzzle_attempt { solved, rating_before, rating_after }
     - response carries { value, delta, games }; the SPA refreshes the header.
```

---

## Summary

| Aspect              | Value / rule                                              |
|---------------------|-----------------------------------------------------------|
| Model               | Per-time-control **Glicko-2** (bullet/blitz/rapid/classical) + isolated puzzle |
| Per category        | rating + RD (uncertainty) + σ (volatility) + last-rated time |
| Start               | 1500 / RD 350 / σ 0.06 (all categories, incl. puzzle)     |
| Step size           | set by RD — fresh ≈ ±175 vs equal; settled ≈ ±6           |
| Provisional ("?")   | RD > 110 (cosmetic; doesn't affect matchmaking)           |
| Inactivity          | RD grows with idle time (≈1 year → back to 350), rating unchanged |
| Update              | one game at a time (no rating periods); Glicko-2 `update()` |
| Rated games         | Both accounts (symmetric); account vs fill-in bot (one-sided, BOT_RD 50) |
| Rated puzzles       | Logged-in solver, first attempt only (one-sided vs the puzzle's fixed rating, PUZZLE_RD 60) |
| Unrated             | Anyone anonymous; `/bot` games; aborted games; puzzle re-attempts |
| Storage             | `User.{rating,rd,vol,rated_at,games}_<cat>` (incl. `_puzzle`) |
| Applied by          | `GameResultController` on `POST /internal/games`; `PuzzleController` on `POST /puzzles/{id}/move` |
| Not implemented     | Color advantage (Lichess awards more for a Black win) — standard symmetric v1 |
