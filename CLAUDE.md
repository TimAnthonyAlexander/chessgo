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

zugzwang is the **primary engine as of the 2026-07 cutover**. It initially beat
gomachine by **+24.6 Elo on the same net**; search improvements since then have
pushed the gap to **~200 Elo** (**~3500 CCRL**). The entire site now
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

## Frontend look: square, flat, gradientless (one token each)

The chrome is deliberately undecorated, and every component reads the same tokens
in `frontend/src/styles.css` rather than carrying its own values — a hardcoded
`borderRadius: '8px'` or `boxShadow: '0 18px 50px …'` in a component IS the bug,
because it is what made the UI drift component-by-component before.

- **`--radius`** (currently `0px`) is THE corner radius: panels, cards, buttons,
  dialogs, inputs, chips, badges, the board frame, and MUI's `shape.borderRadius`
  in `theme.ts`. The only exceptions are three `border-radius: 50%` rules in
  `components/Board.css` (legal-move dots/rings, the Secret-Queen badge and its
  pick halo) where the circle carries meaning; they say so in a comment.
- **`--shadow`** (currently `none`) is THE elevation. `PANEL_SHADOW` in
  `components/PanelUI.tsx` is just this token under its old name.
- **No gradients anywhere.** `--accent-fill` / `--accent-fill-hover` are flat
  colours (the old names were `--accent-grad*`, which is why they are named
  `-fill` now), and the page backdrop is Flat or a hairline Grid — the accent-glow
  "Atmosphere" backdrop was removed, and a persisted choice falls back to Flat.
  No accent glow box-shadows either.
- **Palette-derived colours only.** `var(--accent)`, `var(--on-accent)`,
  `var(--eval-white/-black)` etc., never a brass literal like `#d8a657` /
  `#15171c` — those looked wrong in the five non-brass palettes. The categorical
  data colours (`lib/timeControl.ts`, `profile/shared.ts`) are the exception, on
  purpose: they must stay distinguishable from each other, not match the accent.
- **Nav controls go through `components/nav/IconBtn.tsx`** — one square 30px cell
  used by both the top bar and the side rail, so the bell/palette/shortcuts/logout
  buttons cannot drift apart again. The notification panel is portalled to the body
  and positioned by measurement (`place()` in `notifications/NotificationBell.tsx`):
  right-aligned + below under the top bar, and it FLIPS to the right of the rail and
  rides up off the bottom edge in the side layout, where a plain drop-down opened
  99% off-screen.

## Product feature map (where each user-facing feature actually lives)

Several of these are easy to *infer wrong* from the file tree, so: the mapping
below is what the code does. Note `docs/SPEC.md` §"Variants" is stale (lists
three).

**Variants.** The canonical live-play enum is
`gomachine/internal/variant/variant.go`: standard, chess960, duck, crazyhouse,
antichess (plus secretqueen, declared in `secretqueen.go`). Each has one fixed
quick-pair pool — Chess960 5+0, Duck 5+0, Crazyhouse 3+0, Antichess 3+0, Secret
Queen 3+0 — in `frontend/src/pages/home/parts.tsx` / iOS `VariantPool.all`; the
two must agree, since a phone and a browser queueing the same variant with
different pool strings land in queues that never pair. They sit under the
homepage's **"More"** heading, whose sixth cell is Guess the Elo (a solo mode, no
pool and no rating — the slot the variant cells give the clock holds its icon).
**Every variant is its own isolated Glicko category**, no time-control split:
`categoryFor` (hub) and `GameResultController` route them, `User` carries the
`rating_/rd_/vol_/rated_at_/games_` block, and `WsTicketController` must ship the
rating in the ticket's `ratings` map — a category missing from THAT map doesn't
fail loudly, it silently pairs that variant by the player's blitz rating
(`auth.Identity.RatingFor` falls back to `Identity.Rating`). Chess960 is in this
set despite being standard rules, because a shuffled back rank is a different
skill from the book. **Fading, Glass Jaw and Double Move are a separate axis** —
they live in `BotGameService`/`BotGame` (rating decays per move / per check
given) and are unknown to the hub's `normalizeVariant`, so they're reachable from
`/bot` only; Double Move is a real ruleset but it exists only as a side-to-move
flip in PHP, with no zugzwang rules and no `variant.State`, so it cannot go live
without a port. `frontend/src/lib/variants.ts` and
`ios/chessgo/Models/Variant.swift` carry all nine.

**Secret Queen** (`secretqueen`) is the platform's first **hidden-information**
variant, and it is the reason several things above are no longer universally
true. Each side secretly designates one of its own home-rank pawns; that pawn
also moves as a queen, and any non-pawn move reveals it permanently. No en
passant, no check, no checkmate — you win by **capturing the king**, like Duck.
The canonical FEN is an ordinary FEN plus a trailing `[e2|h7]` naming the
still-hidden queens, and **the board itself never encodes the secret** (a hidden
queen is a plain pawn on it), so redaction is subtractive.

The load-bearing consequence: **every FEN and every move list that leaves the
server is per-recipient.** The hub's one-payload-for-everyone `broadcast` is not
safe here — `game.go`'s `snapshotFor` sends each player only their own
`secretSquare` and sends `legalMoves` only to the mover, spectators get neither,
and everyone gets both once the game ends. BaseAPI's `present()` redacts the live
FEN **and every move-history FEN** (missing the latter leaked the bot's secret on
ply 1). `internal/hub/secretqueen_test.go` and `tests/Unit/SecretQueenRedactionTest.php`
pin this; the Go one asserts against the marshalled JSON so a leak through a
newly-added field still fails it. Rules live only in
`zugzwang/src/secretqueen.{h,cpp}` — `internal/variant/secretqueen.go` is the
first `State` that calls the engine over HTTP rather than porting a ruleset
twice, deliberately (see its header for the goroutine-blocking cost that buys).
Full design, rules sources and the bugs found while building it:
`docs/tasks/open/secret-queen.md`.

**Time controls.** Live/hub games take base 0-180 min + inc 0-180 s in any
combination (`parseTimeControl`, `hub/protocol.go`); presets run 1+0…30+20. Bot
games (`/bot`, BaseAPI-direct, never touches the hub) are untimed by design —
`BotGame` carries an Elo slider, not a clock.

**Puzzles** (`Puzzles.tsx`) already include a Puzzle-Rush-style timed session
mode (Sprint 60s / Blitz 180s / Marathon 300s / untimed) with streak + summary,
and a 12-theme picker served from the denormalized
`puzzle_theme(puzzle_id, theme, rating)` index. Puzzle rating is a single global
`User::rating_puzzle`, not per-theme.

**Premove Trainer** (`/premove`, `pages/PremoveTrainer.tsx`,
`PremoveTrainerService`, isolated `User::rating_premove`) is a solo mode where you
queue a whole chain of premoves **blind**, release it, and watch it play out with
no feedback between moves. Rated runs a real 15s clock that ticks while you queue
and stops the moment a premove is queued — our live-game rule (`game.go:295`)
applied unchanged; casual is untimed and one-shot. It is BaseAPI-only: the hub is
strictly two-player, so this mirrors `BotGameService`'s epoch-ms server clock
instead of inventing a second one.

Three things are load-bearing and easy to get wrong. **A position qualifies only
if a chain of premoves MATES against every defence** — queue N moves, release, it
mates whatever they play (`forced_chain_len`, `scripts/build_premove_positions.py`,
`premove_position`). Two weaker filters both produced a tactics trainer and were
replaced: breadth (how many of YOUR moves win) says nothing about whether the
DEFENDER is predictable, and safe-depth (moves that stay legal and winning) is
satisfiable by shuffling a queen around a corner. Forcing needs a **bare enemy
king** — KRvK, KQvKR and every pawn signature measure 0%, so there are no
promotion races, deliberately. **The builder reads the tablebase files directly
and must not use the engine**: zugzwang's root probe is WDL (`tb_probe_root`,
deliberate — see `gomachine/CLAUDE.md`), so it preserves a win without
progressing to mate and self-play shuffles forever (0/15 random KQvK mated at any
movetime). **`last_move_at` is stamped into the future** by `plies * ply_ms` so
the client's playout animation isn't charged to the clock — and a release
arriving before that stamp must be refused, or `max(0, ...)` clamps elapsed to
zero and every release is free (9 releases, clock never moved). `ply_ms` and
`max_chain` are sent to the client and must never be mirrored there; a hardcoded
`MAX_CHAIN` copy drifted and silently capped players at 12. `forced_chain_len`
and `chain_target` never reach the client — they are the answer. Full contract:
`docs/tasks/open/premove-trainer.md`.

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

**Tutor** (`docs/tasks/open/tutor.md`) is a requested, dated player report card:
press a button, a queued job measures a random sample of your recent games
against peers at your rating, and every weakness ends in a drill. Routes
`/tutor` (shelf + request button), `/tutor/:id` (the **overview** — headline
plus one scannable block per rating category), `/tutor/:id/:category` (the
**detail** — drills, skills with plain-language descriptions, phases, pieces,
openings) and `/tutor/trend` (`pages/Tutor.tsx` / `TutorReport.tsx` /
`TutorCategory.tsx` / `TutorTrend.tsx`, `components/tutor/*`). The
overview/detail split is deliberate and was the third attempt at this page:
everything on one screen was unreadable. **`SegmentMeter` is the only
comparison primitive** — seven segments whose count IS the backend's seven
verdict words and whose colour (`--bad` / `--warn` / neutral / `--good`, fixed
per mode, never `--accent`, which is itself red in the Claret palette) says
good or bad without a legend. There is no legend, by design; if a meter needs
one it is the meter that is wrong. API is `GET/POST /tutor/reports`,
`GET/DELETE /tutor/reports/{id}`, `GET /tutor/reports/{id}/opening`,
`GET /tutor/trend` (`TutorController`, `TutorReportController`,
`TutorOpeningController`, `TutorTrendController`). `App\Services\Tutor\TutorMetrics`
is the single definition of every metric (accuracy, ACPL, awareness,
conversion, resourcefulness, flagging, clock, performance) — deliberately the
only place either corpus is measured, shared by `TutorBuildService` (via
`TutorGameReader`, a user's own games through `/analyze-game`) and
`scripts/import_tutor_baselines.php` (the peer corpus), because two different
accuracy numbers for the same kind of game would make the comparison
meaningless. Peer baselines come from the public Lichess database dump, land
in `tutor_baseline` as 50-point rating bands (`TutorBaseline::BUCKET_WIDTH`),
and carry two measured corrections: an eval-scale calibration (zugzwang ≈
2.81× Stockfish, Pearson 0.969 — `TutorMetrics::SF_SCALE`, refit via
`scripts/calibrate_tutor_evals.php`) and a split-corpus fix, where the outcome
metrics (`win_rate`, `flagging_loss`) are imported from the full Lichess
population rather than the analyzed subset because analyzed games were
measured to under-report losses on time by ~3pp (`scripts/tutor/bias_check.py`,
population games from `scripts/tutor/outcome_games.py`, importer flags via
`--only`/`--exclude`). Conversion and resourcefulness trigger on win
probability (`TutorMetrics::winProbability()`, thresholds `WINNING_PROB`/
`LOSING_PROB`), never centipawns, so both are invariant to the engine's eval
scale. `TutorReport::status` (queued → building → ready|insufficient|failed)
means the report row doubles as its own job record — there is no separate
queue table — and rows are never deleted, since `/tutor/trend` reads the whole
history. Every weakness card carries exactly one button
(`App\Services\Tutor\TutorDrillBuilder`): puzzle sets filtered to the user's
weak themes, or a replay drill built from positions in the user's own games
(the moment a won game slipped, or a lost one became hopeless), landing on
`/puzzles?theme=` or `/bot?fen=&color=` deep links (`DrillCard.tsx`). Gotchas:
the start position carries no eval in either corpus, so White's first move is
never scored (`TutorMetrics::perGame`, the `$i === 0` skip); openings are
split by colour inside the dimension key (`opening:w:Sicilian Defense`);
dimension baseline cells (phase/piece/opening) keep no percentile reservoir by
design (`RESERVOIR_DIMENSION = 0` in the importer), so `TutorGrade::percentileOf`
returns `null` for them rather than a manufactured rank; and a BaseAPI model's
`$columns` entry ignores a separate `length` hint, so `TutorBaseline`'s
identity columns (`source`, `category`, `metric`, `dimension`, `cell_key`) are
declared with a full `VARCHAR(n)` type string.

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
