# CLAUDE.md — chessgo

A website to play chess **vs other humans** (live matchmaking with clocks) and
**vs an AI**, with all chess rules + the AI implemented in a dedicated Go engine.

> Read `docs/SPEC.md` for the full design and `docs/COMMANDS.md` to run/deploy.
> This file is the fast orientation.

## Components (4 services + MySQL)

| Service | Tech | Port | Role |
|---|---|---|---|
| BaseAPI | PHP 8.4 (`base-api` / `mason`) | 6464 | REST: auth (session cookies), bot games, `/analyze`, `/ws-ticket`, `/stats`, game persistence + Elo (`/internal/games`) |
| Frontend | React + Vite + TS + MUI + Bun | 6465 | lobby, `/bot`, live game `/game/:id`, signup/login + user menu |
| gomachine **engine** | Go | 6466 | internal HTTP: rules + AI, pure `(FEN, limit) → result` |
| gomachine **hub** | Go | 6467 | WebSocket: matchmaking + live games + clocks + **bot backfill**; `GET /stats`; persists results to BaseAPI |
| MySQL | — | 3306 | durable data (always running; chessgo never manages it) |

**The engine and hub are the same Go binary** (`gomachine`) with subcommands
`serve` and `hub`. The hub imports `internal/chess` directly — no rules
duplication, no HTTP hop. Engine is internal (PHP calls it); hub is client-facing
(browser WebSocket, proxied as `wss://…/ws` in prod).

## Where things live

- `app/` — BaseAPI PHP. Models (`User` w/ per-category ratings, `BotGame`,
  `Game`), Services (`GomachineClient`, `BotGameService`, `WsTicketService`,
  `HubClient`, `EloService`), Controllers (`BotGame`, `BotMove`, `Analyze`,
  `WsTicket`, `Stats`, `GameResult`, plus auth `Login`/`Signup`/`Logout`/`Me`),
  `Providers/AppServiceProvider` (DI). Routes in `routes/api.php`.
- `gomachine/internal/chess` — the rules core (bitboards/magic, FEN, Zobrist,
  movegen, make/unmake, SAN, draw rules, perft). **Single source of truth for chess.**
- `gomachine/internal/{eval,search,engine}` — PeSTO eval, αβ search, level mapping.
- `gomachine/internal/{hub,auth}` — realtime hub (`hub.go` matchmaking/clocks/
  persistence, `bot.go` bot backfill) + HMAC ticket verify (`auth.Identity` carries
  per-category `Ratings`).
- `gomachine/cmd/gomachine` — CLI dispatch; `hub.go` wires bot flags + posts
  finished games to BaseAPI.
- `frontend/src/{pages,components,lib,api}` — `lib/socket.ts` is the WS store
  (singleton, `useSyncExternalStore`); `lib/auth.ts` is the session/user store;
  `lib/sounds.ts` is the Web-Audio engine; `lib/chess.ts` is display-only board
  helpers; `components/AuthDialog.tsx` is login/signup.

## Run (dev)

See `docs/COMMANDS.md` for the canonical commands (screens, prod, health checks).
Quick version: `./mason serve --screen` (API), `gomachine serve` (engine),
`WS_TICKET_SECRET=… gomachine hub` (hub), `cd frontend && bun run dev`. Open
<http://127.0.0.1:6465>.

## Build / test

```sh
cd gomachine && go build -o bin/gomachine ./cmd/gomachine && go test ./...   # Go
cd gomachine && ./bin/gomachine perft -depth 5                                # movegen sanity
cd frontend && bun run typecheck && bun run build                            # frontend
php mason migrate:generate && php mason migrate:apply -y                     # DB schema
```

## Conventions & gotchas (project-specific)

- **Schema = models.** Change a BaseAPI model, then `migrate:generate` →
  `migrate:apply -y`. **Never** hand-write SQL/DDL, never `--safe`. Table names
  are **singular snake_case** (`BotGame` → `bot_game`).
- **BaseAPI array-cast footgun:** an `array`-typed model property is decoded on
  read but **NOT encoded on write** (it becomes the string `"Array"`). Store
  JSON-shaped data in a `?string` TEXT column (`static $columns`) with explicit
  `json_encode/decode` accessors. See `app/Models/BotGame.php`.
- **Controllers** use HTTP-verb methods (`get`/`post`/…), `$this->validate([...])`
  first, `JsonResponse` helpers, constructor DI. Always null-check `find()` with
  `instanceof`.
- **Engine owns rules.** PHP never re-implements chess — it calls the engine /
  the hub uses `internal/chess`. Keep the engine HTTP boundary **stateless**
  (FEN-in) so magic tables + TT stay warm.
- **`WS_TICKET_SECRET` must match** between BaseAPI (`.env`) and the hub's env, or
  every WebSocket connection is rejected. It's **also** the shared secret the hub
  sends as `X-Hub-Secret` when persisting games to `POST /internal/games`. The dev
  commands derive it from `.env`.
- **Hub→BaseAPI persistence:** on game end the hub fire-and-forgets a POST to
  `BASEAPI_URL/internal/games` (off its goroutine). BaseAPI stores the `Game` and,
  if rated, applies Elo. `HUB_URL` lets BaseAPI proxy the hub's `/stats`.
- **Session-cookie auth:** the SPA sends `credentials: 'include'`; CORS must
  echo the origin + allow credentials (`CORS_ALLOWLIST` includes `:6465`).
  `/ws-ticket` runs `SessionStartMiddleware` and resolves the user from the
  session (optional auth — anonymous still gets a casual ticket).
- **Web Audio needs a user gesture:** the `AudioContext` starts *suspended* and
  only resumes inside a gesture handler. Play the local player's own move
  **synchronously in the click handler** (not from an async socket/state effect),
  and `lib/sounds.ts` installs a one-time `pointerdown`/`keydown` unlock. Safari
  is strictest here.
- **After Go changes**, rebuild the binary and **restart the engine + hub
  screens** (no hot reload). The frontend has Vite HMR; PHP re-reads code per
  request — but **`.env` is read at boot, so restart `chessgo-api` after `.env` edits**.
- **Frontend TS is strict** (`noUnusedLocals/Parameters`); run `bun run typecheck`
  before claiming done. Pieces are real cburnett SVGs in `public/piece/cburnett/`.

## Correctness invariants (don't break)

- Zobrist key includes castling rights + **legal** en-passant (FIDE 9.2.3);
  normalize ep to "capturable" before hashing.
- **Threefold & fifty-move are claimable; fivefold & seventy-five-move are
  automatic.** The timeout K+N+N case is a **win on time** (separate "any legal
  series mates" test — `Position.CanAnyoneMate`).
- Movegen is guarded by **perft** against 6 known positions — keep it green.
- The hub mutates all shared state on **one goroutine** (no locks); connections
  talk to it via channels. A slow client must never block the hub (per-client
  send channel + writer goroutine). **Bot move search runs off the goroutine**
  (engine pool) and is applied back via the `botMoves` channel.
- **Clocks start Lichess-style:** neither side's clock runs until it has made its
  first move — i.e. the clock is live only once 2 plies are played
  (`game.clocksRunning()`); both opening moves are untimed. A stalled first move
  is handled by a **30s abort** (`firstMoveTimeout`), not the clock.
- **`finish()` snapshots both clocks BEFORE setting `over=true`** — `remainingMs`
  stops deducting once `over`, so reading after would report the flagged side's
  pre-flag time instead of 0.

## Status / next

Built and tested: engine, bot games, lobby, **live human-vs-human play**
(matchmaking, server clocks, reconnect/resume), **bot backfill** (a fill-in bot
after a 15s wait, level 6, human-like pacing, random identity — `-bots`/
`-bot-level`/`-bot-delay` flags), **accounts** (signup/login via session cookies),
**per-time-control Elo** (bullet/blitz/rapid/classical, provisional K), and
**game persistence** (hub → `POST /internal/games`). Rated when both are accounts;
a logged-in human vs a fill-in bot is one-sided rated; explicit `/bot` games never
hit the hub so they're unrated. **Resume is still in-memory** — survives tab
close/refresh but not a hub restart. Also: **Puzzles** (`/puzzles`) — Lichess-
seeded tactical trainer on an **isolated** `rating_puzzle` (never touches the
time-control ratings); `puzzle`/`puzzle_theme`/`puzzle_attempt` models + the
`scripts/import_puzzles.php` CSV importer; serving is rating-matched + de-duped
with a theme filter, and the solution is validated server-side (never sent to the
client). See SPEC.md §9. Next: hub-restart-durable resume, puzzle generation
pipeline, rating-proximity matchmaking, matching bot *strength* to its displayed
rating. See `docs/SPEC.md` §11 roadmap.
