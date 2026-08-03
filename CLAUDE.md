# CLAUDE.md — chessgo

A **production chess platform** built around **zugzwang**, a strong C++ NNUE
chess engine. Play chess **vs other humans** (live matchmaking with server
clocks), **vs the AI**, solve **puzzles**, and play four **variants** (Chess960,
Crazyhouse, Duck, Antichess) — all rules and all AI served by zugzwang. Runs in prod at
[chessgo.timanthonyalexander.de](https://chessgo.timanthonyalexander.de).

> Read `docs/SPEC.md` for the product design, `docs/ARCHITECTURE.md` for how the
> services fit together, and `docs/COMMANDS.md` to run/deploy. This file is the
> fast orientation.

## The engine cutover (important context)

zugzwang is the **primary engine as of the 2026-07 cutover** — it beat the old
Go engine, **gomachine**, by **+24.6 Elo on the same net**. The entire site now
runs on zugzwang: analysis, bot games, Stockfish proxying, the four variants,
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

## Components (5 services + MySQL + iOS client)

| Service | Tech | Port | Role |
|---|---|---|---|
| BaseAPI | PHP 8.4 (`base-api` / `mason`) | 6464 | REST: auth (session cookies **+ bearer tokens for iOS**), bot games, `/analyze`, `/ws-ticket`, `/stats`, game persistence + Elo |
| Frontend | React + Vite + TS + MUI + Bun | 6465 | lobby, `/bot`, live `/game/:id`, puzzles, analysis, variants, auth |
| **zugzwang engine** | **C++17** | **6476** | **PRIMARY engine: rules + AI, stateless `(FEN, limit) → result`; standard chess, 3 variants, SF proxy** |
| gomachine **hub** | Go | 6467 | WebSocket: matchmaking + live games + clocks + bot backfill; calls zugzwang for bot moves; persists to BaseAPI |
| gomachine **engine** | Go | 6466 | *legacy, deletable* — EvE-only + removable hub fallback |
| MySQL | — | 3306 | durable data (always running; chessgo never manages it) |
| **iOS client** | **SwiftUI (iOS 18+)** | — | **native full-parity app: full lobby/live/bot/puzzles/analysis/profile/spectate/settings; talks to BaseAPI (HTTPS) + hub (WS)** |

## The engine: zugzwang

- **Build:** `cd zugzwang && make` (arch-detected native: `-mcpu=native` arm64,
  `-march=native` amd64; `-O3 -flto`). Prod amd64 builds SIMD the same way.
- **Serve:** `zugzwang serve -addr 127.0.0.1:6476` (dev alias `chessgo-zugzwang`).
  Stateless HTTP; endpoints: `/bestmove /candidates /move /legal-moves /perft
  /status /analyze-game /sf-bestmove /duck/* /crazyhouse/* /antichess/*` (`/healthz`).
- **Search:** PVS + NNUE — LMR, SEE, null-move, RFP/futility, singular extensions,
  correction + continuation history; **8 SPSA-tunable margins**.
- **NNUE:** loads `net.nnue` (→ `gomachine/data/nnue/kb-mirror.bin`, the prod
  full-threats net); falls back to a hand-crafted eval if absent.
- **Concurrent search pool:** N independent `Search::Context`s (default
  `min(cores,6)`) so serve handles concurrent searches lock-free.
- **Variants:** Chess960 (castling generalized in core movegen), Crazyhouse
  (`src/crazyhouse.cpp`, pockets/drops + pocket-aware eval), Duck (`src/duck.cpp`,
  self-contained rules/eval/search), Antichess (`/antichess/*`).
- **Syzygy tablebases are native** (`src/zug_tb.cpp`, probed from `search.cpp` and
  `serve.cpp`; the hub attaches one via `Hub.SetTablebase`). It acts inside search
  and eval — treat it as engine strength, and grep the frontend before assuming
  anything about how it's presented.
- Deep dive: **`zugzwang/CLAUDE.md`**.

## The iOS app

Native SwiftUI client at **`ios/`** (Xcode project `ios/ios.xcodeproj`, target/scheme
`chessgo`, bundle `de.timanthonyalexander.chessgo`, **deployment iOS 18**, built in
**Xcode 27**). Full parity with the web: guest+login, lobby/matchmaking, live WS games
(clocks/offers/reconnect/premoves/chat), bot games (8 variants incl. Duck/Crazyhouse),
puzzles, analysis, profile/leaderboard/streak, spectate, settings, sound.

- **Auth is bearer-token, not cookies** (cookies were unreliable on iOS). Login/signup
  return `api_token` + `api_token_id` inline; the token lives in the Keychain and rides
  as `Authorization: Bearer`. Guest play needs no token.
- **Env switch:** Simulator → `http://127.0.0.1:6464`; device → `https://chessgo-api.timanthonyalexander.de`.
  The WS URL is never hardcoded — it comes back from `/ws-ticket` as `wsUrl`.
- **Engine still owns the rules.** The client parses FEN for rendering and submits UCI;
  it never generates legal moves — it renders the server's `legalMoves`/`status`.
- **Board themes are ported from the web:** `Theme/BoardTheme.swift` carries the same 16
  board palettes + 7 piece sets as `frontend/src/lib/boardTheme.ts`, selected by
  `SettingsStore.boardTheme`/`.pieceSet` and read from the environment by
  `BoardView`/`PieceView` (so every board follows it). **iOS defaults to Amethyst +
  Neo**, web to Cherry + Cburnett. Artwork is `<set>_<code>` imagesets (rasterized PNG).
- Structure: `ios/chessgo/{Core,Models,Services,State,Chess,Theme,Views,Sound}`, plus the
  piece sets + Cherry wood textures in `ios/chessgo/Assets.xcassets`. Xcode-16 file-system-synchronized
  group — new `.swift` files are picked up without editing `project.pbxproj`.
- **Backend changes this added (kept):** `app/Middleware/OptionalAuthMiddleware.php`
  (auth-if-present, never 401; on the `/ws-ticket` route so bearer clients get *rated*
  tickets), and inline token minting in `LoginController`/`SignupController`.
- Design + as-built notes: **`ios/docs/SPEC.md`** and `ios/docs/analysis/*.md`
  (REST/WS contracts, auth decision, iOS patterns, feature inventory).

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
- `ios/chessgo/` — the native app. `Core/` (APIClient, APIConfig, Keychain,
  Resilient `@Default` wrappers), `Services/` (per-domain REST), `State/`
  (`AuthStore`, `SocketStore` WS store + `LiveGameDriver`, `SettingsStore`,
  `SpectateStore`), `Chess/` (client-side FEN/board, engine stays rules
  authority), `Views/` (feature-grouped; `Board/` is the shared board).
  Docs in `ios/docs/`.

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

## Product feature map (where each user-facing feature actually lives)

Several of these are easy to *infer wrong* from the file tree, so: the mapping
below is what the code does. Note `docs/SPEC.md` §"Variants" is stale (lists
three).

**Variants.** The canonical live-play enum is
`gomachine/internal/variant/variant.go`: standard, chess960, duck, crazyhouse,
antichess. Chess960 reaches human play through challenge links; Duck/Crazyhouse/
Antichess each also have one fixed quick-pair pool (5+0 / 3+0 / 3+0) in
`frontend/src/pages/home/parts.tsx`. **Fading, Glass Jaw and Double Move are a
separate axis** — they live in `BotGameService`/`BotGame` (rating decays per move
/ per check given) and are unknown to the hub's `normalizeVariant`, so they're
reachable from `/bot` only. `frontend/src/lib/variants.ts` and
`ios/chessgo/Models/Variant.swift` carry all eight.

**Time controls.** Live/hub games take base 0-180 min + inc 0-180 s in any
combination (`parseTimeControl`, `hub/protocol.go`); presets run 1+0…30+20. Bot
games (`/bot`, BaseAPI-direct, never touches the hub) are untimed by design —
`BotGame` carries an Elo slider, not a clock.

**Puzzles** (`Puzzles.tsx`) already include a Puzzle-Rush-style timed session
mode (Sprint 60s / Blitz 180s / Marathon 300s / untimed) with streak + summary,
and a 12-theme picker served from the denormalized
`puzzle_theme(puzzle_id, theme, rating)` index. Puzzle rating is a single global
`User::rating_puzzle`, not per-theme.

**Analysis** (`lib/analysisTree.ts` + `components/MoveTree.tsx`) is a real
Lichess-style branching tree: playing an alternative from any node forks a
variation, and a loaded game's mainline carries judgment glyphs. The board's
"annotations" (`Board.tsx`) are right-click arrows/circles. State is client-side;
PGN export emits mainline SAN.

**`OpeningPanel.tsx` is engine-computed, not corpus-derived.** The ECO name comes
from zugzwang's Zobrist opening-name table; each candidate row is a live 350ms
`/candidates` search with an engine eval. Anything involving move popularity or
win rates from a games database is the separate, unstarted
`docs/tasks/open/opening-explorer.md`.

**Token auth doubles as a play API.** `ApiToken` + `/api-tokens` CRUD +
`GET /openapi.json`, and `/ws-ticket` accepts a bearer token and returns a
`wsUrl` — so a token holder can drive matchmaking and moves over the hub WS
without a browser. `app/Middleware/ApiTokenAuthMiddleware.php` is dead code;
routes use `CombinedAuthMiddleware`.

**Email** goes through `EmailService` (Symfony Mailer) + the queueable
`SendEmailJob`; the wired call site is the signup welcome mail in
`SignupController`.

**Anti-cheat** (`FlaggedUser`, `UserFlag`, `AnticheatService`) is advisory —
flags only, an admin decides — and is surfaced on the `/admin/anticheat*` pages
behind the admin role check.

**Profiles** (`ProfileController` + `pages/Profile.tsx`) serve member-since,
last-active, per-category Glicko with rating-history sparklines, lifetime W/L/D,
and a paginated game history filterable by category/result/opponent/date.

**Live games always start from the standard position** — `hub.go` builds from
`chess.StartFEN`, or `RandomChess960FEN()` for 960, and the `challenge` struct
carries no FEN. The Editor's exits are `/analysis`, `/bot`, and (admin)
`/engine-vs` (the page route carries no `/admin` prefix; its API endpoint
`POST /admin/engine-vs/move` still does, and the controller enforces the role).

**Pairing** is `matchmaking.go` (rating tolerance widening 100→400 Elo the longer
you wait) plus `challenge.go` (private 6-char codes, shared out of band, pairing
exactly two clients). The UI's "Challenge a friend" is that code flow —
`ChallengeDialog.tsx` sets time control, color, rated/casual and variant.

**Spectating:** `/watch` polls the hub's top-5 notable live games; `/watch/:id`
opens a separate spectator WS (`spectateSocket`) with live board and clocks, plus
an admin-only eval bar and best-move arrow. Ply scrubbing is
`docs/tasks/open/spectate-ply-scrubbing.md`.

**Social graph.** `FriendLink` (`friend_link`) holds requester/addressee/status;
`GET /friends` returns accepted friends with a `linkId` (for unfriending), the
friend's `userId`, title, rating and an `online` flag resolved through
`HubClient::onlineSubs()` → the hub's `GET /internal/online`. Requests, accept,
decline and cancel are the `/friends/*` routes; a mutual pending request
auto-accepts. UI is `pages/Friends.tsx` + `components/friends/`.

**Notifications** are `Notification` (`notification`, JSON `payload` as a
`?string` with accessors) pushed via `NotificationService::push()` for
`friend_request`, `friend_accepted`, `challenge`, `challenge_accepted`,
`challenge_declined`. The nav bell (`components/notifications/`) polls
`GET /notifications` every 20s, pauses on a hidden tab, and acts inline — accept
on a challenge returns a code and lands you in the game.

**Two challenge systems, deliberately.** The hub's ephemeral 6-char code
(`challenge.go`) is the anonymous share-a-link flow. `Challenge` (`challenge`) is
the persistent user-to-user one: it survives both players being offline, notifies
the opponent, and on accept mints a code through
`HubClient::createServerChallenge()` → the hub's `POST /internal/challenge`,
which registers a challenge restricted to exactly two identity subs
(`serverchallenge.go`). The first of the two to arrive parks as `waitingClient`
and gets `challengeWaiting`; a parked waiter whose socket died re-attaches on
reconnect via the same session index live-game resume uses.

**Custom start positions.** A challenge may carry a `fen`; the hub validates it
through `variant.New()` at registration (rejecting chess960 + FEN) and **forces
the game casual**. `ChallengeDialog` takes a `startFen` prop and the Editor has a
"Challenge a player from here" exit. `Game` stores `start_fen`.

**Arena tournaments.** `Tournament` + `TournamentPlayer`; status is derived from
`starts_at` + `duration_minutes` by `reconcileStatus()`, never a cron. Scoring
happens in `GameResultController` when the hub persists a game carrying
`tournamentId`: win 2, draw 1, and 4 per win once a player is on 2+ consecutive
wins. It is wrapped so a scoring failure can never block the game persist. The
hub polls `GET /internal/arenas/active` every 5s into a Run-goroutine cache
(`arena.go`), takes `joinArena`/`leaveArena` over WS, pairs by **closest score**
(not rating), avoids an immediate rematch when a third player is free, and
returns both players to the pool when a game ends. UI: `pages/Tournaments.tsx`,
`pages/Tournament.tsx`.

**Titles.** `User::displayTitle()` returns the stored `title` or `'AM'` (Admin
Master) for admins — `AM` is derived, never stored. `components/TitleBadge.tsx`
renders it as a **solid red chip with white text**; that styling is a deliberate
user decision, so place the badge, don't restyle it. Controllers that hand-build
player rows use `User::titleMapFor()` / `Game::summaryRowsWithTitles()` to batch
the lookup. Live games, watch and spectate get it from an optional `title` claim
on the WS ticket → `auth.Identity.Title` → the hub's opponent/hello/lobby
payloads.

**Profile identity.** `User` carries `bio` (≤300 chars) and `country` (ISO-3166
alpha-2, whitelisted on the model), edited through `POST /me/profile` and
rendered on your own profile behind an edit dialog. Country shows as a name in
text, no flags.

**Timed bot games.** `BotGame` gained `time_control`, `white_ms`, `black_ms` and
`last_move_at` (stored as **epoch milliseconds**, not the usual datetime string,
so a bullet clock doesn't drift a second a move). Clocks are enforced entirely
server-side in `BotGameService` on each move: charge the human's elapsed time,
flag if it hits zero, add increment, time the engine call and charge the bot,
then restamp. `botMovetimeMs()` caps engine think time by the bot's remaining
clock. Untimed (`time_control` null) is the default and unchanged. Undo is
refused on a timed game.

**PGN/FEN** live in `frontend/src/lib/pgn.ts` (`toPgn`/`fromPgn`/`downloadPgn`,
tolerant of comments/NAGs/`%clk`/`%eval`/RAV), wired into `AnalysisAside.tsx`
(import, copy, download, copy link, copy/paste FEN) and `BoardActions.tsx`
(post-game handoff into analysis/editor/bot).

## Status / next

Live: engine cutover to zugzwang (standard + 4 variants + SF), live human play
(rating-proximity matchmaking, server clocks, reconnect/resume), bot backfill,
accounts, per-time-control Glicko-2, game persistence, puzzles, premoves,
friends + notifications + directed challenges, arena tournaments, player titles,
timed bot games, and challenges from a custom position.
Backlog is per-item under **`docs/tasks/open/`**; banked milestones in
**`docs/tasks/done/`**.
