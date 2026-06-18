# CLAUDE.md — chessgo

A website to play chess **vs other humans** (live matchmaking with clocks) and
**vs an AI**, with all chess rules + the AI implemented in a dedicated Go engine.

> Read `docs/SPEC.md` for the full design and `docs/COMMANDS.md` to run/deploy.
> This file is the fast orientation.

## Components (4 services + MySQL)

| Service | Tech | Port | Role |
|---|---|---|---|
| BaseAPI | PHP 8.4 (`base-api` / `mason`) | 6464 | REST: auth, bot games, `/analyze`, `/ws-ticket`, persistence |
| Frontend | React + Vite + TS + MUI + Bun | 6465 | lobby, `/bot`, live game `/game/:id` |
| gomachine **engine** | Go | 6466 | internal HTTP: rules + AI, pure `(FEN, limit) → result` |
| gomachine **hub** | Go | 6467 | WebSocket: matchmaking + live games + clocks |
| MySQL | — | 3306 | durable data (always running; chessgo never manages it) |

**The engine and hub are the same Go binary** (`gomachine`) with subcommands
`serve` and `hub`. The hub imports `internal/chess` directly — no rules
duplication, no HTTP hop. Engine is internal (PHP calls it); hub is client-facing
(browser WebSocket, proxied as `wss://…/ws` in prod).

## Where things live

- `app/` — BaseAPI PHP. Models (`BotGame`), Services (`GomachineClient`,
  `BotGameService`, `WsTicketService`), Controllers (`BotGame`, `BotMove`,
  `Analyze`, `WsTicket`), `Providers/AppServiceProvider` (DI). Routes in `routes/api.php`.
- `gomachine/internal/chess` — the rules core (bitboards/magic, FEN, Zobrist,
  movegen, make/unmake, SAN, draw rules, perft). **Single source of truth for chess.**
- `gomachine/internal/{eval,search,engine}` — PeSTO eval, αβ search, level mapping.
- `gomachine/internal/{hub,auth}` — realtime hub + HMAC ticket verify.
- `gomachine/cmd/gomachine` — CLI dispatch.
- `frontend/src/{pages,components,lib,api}` — `lib/socket.ts` is the WS store
  (singleton, `useSyncExternalStore`); `lib/chess.ts` is display-only board helpers.

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
  every WebSocket connection is rejected. The dev commands derive it from `.env`.
- **After Go changes**, rebuild the binary and **restart the engine + hub
  screens** (no hot reload). The frontend has Vite HMR; PHP re-reads per request.
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
  send channel + writer goroutine).

## Status / next

Engine, bot games, lobby, and **live human-vs-human play** (matchmaking, server
clocks, reconnect/resume) are built and tested. **Resume is in-memory** — it
survives tab close/refresh but not a hub restart. Next: game persistence + Elo +
accounts (rated play + frontend login). See `docs/SPEC.md` §10 roadmap.
