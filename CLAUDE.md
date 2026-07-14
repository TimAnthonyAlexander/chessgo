# CLAUDE.md — chessgo

A **production chess platform** built around **zugzwang**, a strong C++ NNUE
chess engine. Play chess **vs other humans** (live matchmaking with server
clocks), **vs the AI**, solve **puzzles**, and play three **variants** (Chess960,
Crazyhouse, Duck) — all rules and all AI served by zugzwang. Runs in prod at
[chessgo.timanthonyalexander.de](https://chessgo.timanthonyalexander.de).

> Read `docs/SPEC.md` for the product design, `docs/ARCHITECTURE.md` for how the
> services fit together, and `docs/COMMANDS.md` to run/deploy. This file is the
> fast orientation.

## The engine cutover (important context)

zugzwang is the **primary engine as of the 2026-07 cutover** — it beat the old
Go engine, **gomachine**, by **+24.6 Elo on the same net**. The entire site now
runs on zugzwang: analysis, bot games, Stockfish proxying, the three variants,
and the hub's bot moves. **gomachine is the retired reference:**

- The gomachine **hub** (`gomachine/internal/hub`, `:6467`) **stays** — it's the
  realtime infra (matchmaking, clocks, live games, bot backfill). It now calls
  zugzwang for bot moves.
- The gomachine **engine** (`:6466`) is **legacy and deletable** — its only live
  use is an explicit "gomachine" option in the admin Engine-vs-Engine page plus a
  removable hub `-emergency-inproc` fallback. Planned deletion in ~a week
  (`docs/tasks/open/remove-gomachine-engine.md`). `ENGINE_PRIMARY=gomachine`
  flips the site back to it with zero code change.

The old gomachine-era docs are archived under `gomachine/docs/` (platform) and
`gomachine/engine/docs/` (engine); `gomachine/CLAUDE.md` is the old root file.

## Components (5 services + MySQL)

| Service | Tech | Port | Role |
|---|---|---|---|
| BaseAPI | PHP 8.4 (`base-api` / `mason`) | 6464 | REST: auth (session cookies), bot games, `/analyze`, `/ws-ticket`, `/stats`, game persistence + Elo |
| Frontend | React + Vite + TS + MUI + Bun | 6465 | lobby, `/bot`, live `/game/:id`, puzzles, analysis, variants, auth |
| **zugzwang engine** | **C++17** | **6476** | **PRIMARY engine: rules + AI, stateless `(FEN, limit) → result`; standard chess, 3 variants, SF proxy** |
| gomachine **hub** | Go | 6467 | WebSocket: matchmaking + live games + clocks + bot backfill; calls zugzwang for bot moves; persists to BaseAPI |
| gomachine **engine** | Go | 6466 | *legacy, deletable* — EvE-only + removable hub fallback |
| MySQL | — | 3306 | durable data (always running; chessgo never manages it) |

## The engine: zugzwang

- **Build:** `cd zugzwang && make` (arch-detected native: `-mcpu=native` arm64,
  `-march=native` amd64; `-O3 -flto`). Prod amd64 builds SIMD the same way.
- **Serve:** `zugzwang serve -addr 127.0.0.1:6476` (dev alias `chessgo-zugzwang`).
  Stateless HTTP; endpoints: `/bestmove /candidates /move /legal-moves /perft
  /status /analyze-game /sf-bestmove /duck/* /crazyhouse/*` (`/healthz`).
- **Search:** PVS + NNUE — LMR, SEE, null-move, RFP/futility, singular extensions,
  correction + continuation history; **8 SPSA-tunable margins**.
- **NNUE:** loads `net.nnue` (→ `gomachine/data/nnue/kb-mirror.bin`, the prod
  full-threats net); falls back to a hand-crafted eval if absent.
- **Concurrent search pool:** N independent `Search::Context`s (default
  `min(cores,6)`) so serve handles concurrent searches lock-free.
- **Variants:** Chess960 (castling generalized in core movegen), Crazyhouse
  (`src/crazyhouse.cpp`, pockets/drops + pocket-aware eval), Duck (`src/duck.cpp`,
  self-contained rules/eval/search).
- Deep dive: **`zugzwang/CLAUDE.md`**.

## Where things live

- `app/` — BaseAPI PHP. Models, Services (`ZugzwangClient`, `GomachineClient`,
  `EngineSelector` — zugzwang-primary/no-fallback; `BotGameService`,
  `WsTicketService`, `HubClient`, `Glicko2Service`), Controllers, DI in
  `Providers/AppServiceProvider`. Routes in `routes/api.php`.
- `zugzwang/src/` — the primary engine (rules/movegen/search/NNUE/serve/variants).
- `gomachine/internal/hub` — the realtime hub (stays). `gomachine/internal/{chess,
  eval,search,nnue}` — the legacy Go engine (deletable).
- `frontend/src/{pages,components,lib,api}` — `lib/socket.ts` WS store,
  `lib/auth.ts` session store, `lib/useBoardInteraction.ts` board/premove
  controller, `lib/sounds.ts` Web-Audio.

## Run (dev)

`chessgo-up` starts all five (see `docs/COMMANDS.md` for the `chessgo-*` aliases).
Manual: `./mason serve --screen` (API :6464), `zugzwang serve` (:6476),
`WS_TICKET_SECRET=… gomachine hub` (:6467), `cd frontend && bun run dev` (:6465),
`gomachine serve` (:6466, legacy — optional). Open <http://127.0.0.1:6465>.

## Kept conventions & gotchas (BaseAPI / PHP)

- **Schema = models.** Edit a BaseAPI model, then `php mason migrate:generate` →
  `php mason migrate:apply -y`. **Never** hand-write SQL/DDL, never `--safe`.
  Table names are **singular snake_case** (`BotGame` → `bot_game`).
- **Array-cast footgun:** an `array`-typed model property is decoded on read but
  **NOT encoded on write** (becomes the string `"Array"`). Store JSON in a
  `?string` TEXT column (`static $columns`) with explicit `json_encode/decode`
  accessors. See `app/Models/BotGame.php`.
- **Env reaches code via `config/app.php` + `App::config()`, NOT `$_ENV`.** Under
  PHP-FPM `$_ENV` is empty on a worker's 2nd+ request. Resolve env in
  `config/app.php` at boot, read via `App::config('...')`. Prod `.env` must be
  FPM-readable (`640 tim:www-data`); **restart php-fpm** after `.env`/config edits
  (reload won't re-read).
- **Controllers** use HTTP-verb methods (`get`/`post`/…), `$this->validate([...])`
  first, `JsonResponse` helpers, constructor DI. Always null-check `find()` with
  `instanceof`.
- **Engine owns rules.** PHP never re-implements chess — it calls zugzwang (via
  `EngineSelector`); the hub uses `internal/chess`. Keep the engine HTTP boundary
  **stateless** (FEN-in) so tables/TT stay warm.
- **Session-cookie auth:** the SPA sends `credentials: 'include'`; CORS must echo
  the origin + allow credentials (`CORS_ALLOWLIST` includes `:6465`).
- **`WS_TICKET_SECRET` must match** between BaseAPI `.env` and the hub's env, or
  every WebSocket is rejected. It's also the `X-Hub-Secret` the hub sends when
  persisting games to `POST /internal/games`.
- **Dev aliases** (`chessgo-*`, in `~/.customrc`): `chessgo-up`/`-down`/`-restart`/
  `-ls`/`-stop <name>`; each service runs in a `screen`. `chessgo-restart`
  rebuilds gomachine + zugzwang and restarts engine/zugzwang/hub (api & web untouched).

## Status / next

Live: engine cutover to zugzwang (standard + 3 variants + SF), live human play
(rating-proximity matchmaking, server clocks, reconnect/resume), bot backfill,
accounts, per-time-control Glicko-2, game persistence, puzzles, premoves.
Backlog is per-item under **`docs/tasks/open/`**; banked milestones in
**`docs/tasks/done/`**.
