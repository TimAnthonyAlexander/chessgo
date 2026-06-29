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
  `HubClient`, `Glicko2Service`), Controllers (`BotGame`, `BotMove`, `Analyze`,
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
  helpers; `lib/useBoardInteraction.ts` is the board-interaction controller (the
  local player's move lifecycle — optimistic overlay + sound + submit + **premove**
  queue — behind a `BoardControl` contract, so live/bot wire it once, not per page);
  `components/AuthDialog.tsx` is login/signup.

## Run (dev)

See `docs/COMMANDS.md` for the canonical commands (screens, prod, health checks).
Quick version: `./mason serve --screen` (API), `gomachine serve` (engine),
`WS_TICKET_SECRET=… gomachine hub` (hub), `cd frontend && bun run dev`. Open
<http://127.0.0.1:6465>.

## Build / test

```sh
cd gomachine && go build -o bin/gomachine ./cmd/gomachine && go test ./...   # Go
cd gomachine && ./bin/gomachine perft -depth 5                                # movegen sanity
cd gomachine && ./bin/gomachine bench sprt --new "" --old "lmr=off"           # strength SPRT (self-play; docs/ENGINE_STRENGTH.md)
cd gomachine && ./bin/gomachine bench vs-stockfish --sf-elo 2500              # absolute Elo anchor (noisy — a band, not a number)
cd gomachine && ./bin/gomachine tune --epd quiet-labeled.epd --out internal/eval/tuned_tables.go   # Texel eval tuner (shipped, +101 Elo)
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
- **Env reaches code via `config/app.php` + `App::config()`, NOT `$_ENV`.** Under
  PHP-FPM (`variables_order` has no `E` + `App::boot()`'s static guard) `$_ENV` is
  empty on a worker's 2nd+ request, so direct `$_ENV` reads silently fall back to
  defaults in prod. Resolve env in `config/app.php` (the `gomachine` block) at
  boot and read via `App::config('gomachine.*')`. Also: prod `.env` must be
  readable by the FPM user (`640 tim:www-data`, never `600`), and after a
  `.env`/`config` change **restart** php-fpm (reload won't re-read). See
  `docs/COMMANDS.md` → Critical prod gotchas.
- **Controllers** use HTTP-verb methods (`get`/`post`/…), `$this->validate([...])`
  first, `JsonResponse` helpers, constructor DI. Always null-check `find()` with
  `instanceof`.
- **Engine owns rules.** PHP never re-implements chess — it calls the engine /
  the hub uses `internal/chess`. Keep the engine HTTP boundary **stateless**
  (FEN-in) so magic tables + TT stay warm.
- **Engine strength = SPRT, not vibes** (see `docs/ENGINE_STRENGTH.md`). To change
  playing strength: implement behind a `search.Params`/`eval.Config` flag
  (default off), then `gomachine bench sprt --new "flag=on" --old "flag=off"`; only
  flip the default if it accepts H1. Search patches (SEE/delta/aspiration/RFP/LMP)
  + **Lazy SMP** are shipped (~+250/+97 Elo), plus a later wave —
  **corrhist/singular/futility** (+66.9/+22.2/+21.3 @ 40k nodes, `docs/ENGINE_STRENGTH.md
  §13`; the cheap long tail — conthist/IIR/capthist/probcut/razor + lmr2-on-singular —
  all SPRT'd flat/negative on our already-heavily-pruned baseline). **The Texel-tuned eval is ON by
  default** (tuned PSQT + knowledge terms, `internal/eval/tuned_tables.go`):
  +128 Elo @ fixed nodes, **+101 Elo @ 100ms/move**, SPRT-gated. This *replaced*
  the old result: the earlier −148 Elo loss was a broken *method* (coordinate
  descent on MSE, distilled CP target, frozen PSQT), not a verdict on HCE — the
  rebuilt tuner (joint Adam on WDL, **tuning the PSQT itself**, quiet Lichess
  positions; `internal/tune`) wins. Re-tune via `gomachine tune --epd <file>
  --out internal/eval/tuned_tables.go`, then SPRT `--new "tuned=on"`. The lock-free TT (`tt.go`, Hyatt XOR) makes the
  TT concurrency-safe; `threads=1` is byte-identical to serial — **run
  `go test -race ./internal/search/` after touching the TT or the parallel driver.**
- **`WS_TICKET_SECRET` must match** between BaseAPI (`.env`) and the hub's env, or
  every WebSocket connection is rejected. It's **also** the shared secret the hub
  sends as `X-Hub-Secret` when persisting games to `POST /internal/games`. The dev
  commands derive it from `.env`.
- **Hub→BaseAPI persistence:** on game end the hub fire-and-forgets a POST to
  `BASEAPI_URL/internal/games` (off its goroutine). BaseAPI stores the `Game` and,
  if rated, applies Elo. `HUB_URL` lets BaseAPI proxy the hub's `/stats` **and
  `/games`** (the Watch lobby; BaseAPI route `GET /watch`).
- **Watch / spectating:** read-only viewers connect with `?spectate=1` (the hub
  skips player reattach + doesn't count them online) and send `watch`/`unwatch`;
  the game fans `state`/`end` out to its `spectators` set. The Watch page **polls**
  `GET /watch` (top-5 snapshot, hub-side sorted real-first-by-rating, capped at
  `lobbyMax`) for previews; clicking opens a **separate** spectator socket
  (`lib/spectate.ts`, not `lib/socket.ts`, so it never clobbers your own game).
- **Watch fillers are JIT engine-vs-engine games** (`filler.go`): they pad the
  lobby up to `-watch-target` (5) on a **dedicated** small engine pool (can't
  starve human bot-fill), and **only while someone's watching** — the `GET /games`
  poll stamps `lastWatchActivity` (`watchWindow` 12s). They're `filler=true`:
  **never `onFinish`-persisted, never Elo'd** — `finish()` gates that on the
  `filler` flag, NOT on `rated`. They're created with `rated:true` purely for
  **display** (so the lobby looks like ranked play); the single `rated` field is
  the source of truth both the `/games` summary and the `watching` payload read,
  so overview + spectate stay consistent. Their bot-ness is **never sent to the
  client** (no `bot` flag in `sideInfo`/the summary). In-flight fillers always
  **finish naturally**; we only stop replenishing once watchers leave. They DO
  count toward `activeGames` (so the homepage stat ticks up a few while watched).
  Both filler sides are bots → `scheduleBotMove` reschedules from `applyBotMove`
  (not just `move()`); each `player` carries its own `level`. **~80% of fillers
  are seeded from a realistic midgame** (the rest from the opening): at hub
  startup `cmd/gomachine/hub.go` fetches a pool of puzzle FENs from BaseAPI's
  hub-secret-gated `GET /internal/filler-fens?theme=pin` (`FillerFensController`)
  and hands it to the hub via `SetFillerFENs` (delivered to the Run goroutine over
  `fillerFensCh`); `pickFillerStart` chooses per game, validating the FEN and
  falling back to `StartFEN` on any miss — so an empty/unreachable pool degrades to
  opening-only. We seed from the puzzle's **raw `fen`** (a balanced position, per
  Lichess convention `fen` is *before* the setup blunder), **not** after `moves[0]`
  — the theme just selects believable middlegames, it doesn't put a motif on the
  board. `scheduleBotMove` keys off `pos.SideToMove()`, so a Black-to-move seed
  works (White no longer always moves first).
- **Session-cookie auth:** the SPA sends `credentials: 'include'`; CORS must
  echo the origin + allow credentials (`CORS_ALLOWLIST` includes `:6465`).
  `/ws-ticket` runs `SessionStartMiddleware` and resolves the user from the
  session (optional auth — anonymous still gets a casual ticket).
- **Web Audio needs a user gesture:** the `AudioContext` starts *suspended* and
  only resumes inside a gesture handler. Play the local player's own move
  **synchronously in the click handler** (not from an async socket/state effect),
  and `lib/sounds.ts` installs a one-time `pointerdown`/`keydown` unlock. Safari
  is strictest here. `useBoardInteraction` already plays the move sound
  synchronously in its `onMove` — route player moves through it, don't re-add sound.
- **Premoves are client-side only** (`useBoardInteraction`): a move made while
  it's not your turn is queued (not sent), shown with the `.premove` highlight, and
  **survives the opponent's reply**; when it becomes your turn the controller plays
  it if it matches a move in the new `legalMoves` (ignoring the promo piece —
  auto-queen), else discards it. No hub/protocol change — it's sent as a normal
  `move` once legal. Board input during the opponent's turn is gated by
  `premoveColor` (the player's own color) + `premoveTargets` (pseudo-legal dots).
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
(**rating-proximity matchmaking** — a wait-widening rating bracket, 100→400 cap, so
mismatched players never pair; server clocks, reconnect/resume), **bot backfill**
(a fill-in bot after a 15s wait, **rating-matched to the human** — displayed rating
±120 of the user, engine level derived via `levelForRating`; human-like pacing —
`-bots`/`-bot-level`/`-bot-delay` flags), **accounts** (signup/login via session cookies),
**per-time-control Glicko-2** (bullet/blitz/rapid/classical; rating + RD +
volatility, start 1500/RD 350, RD-scaled steps, provisional while RD>110,
inactivity RD regrowth; see `docs/ELO_SYSTEM.md`), and
**game persistence** (hub → `POST /internal/games`). Rated when both are accounts;
a logged-in human vs a fill-in bot is one-sided rated; explicit `/bot` games never
hit the hub so they're unrated. **Resume is still in-memory** — survives tab
close/refresh but not a hub restart. Also: **Puzzles** (`/puzzles`) — Lichess-
seeded tactical trainer on an **isolated** `rating_puzzle` (never touches the
time-control ratings); `puzzle`/`puzzle_theme`/`puzzle_attempt` models + the
`scripts/import_puzzles.php` CSV importer; serving is rating-matched + de-duped
with a theme filter, and the solution is validated server-side (never sent to the
client). See SPEC.md §9. Also: **premoves** — a move made during the opponent's
turn is queued by the shared `useBoardInteraction` controller, held across the
reply, then played if legal in the new position (else discarded); client-side
only, live + bot. Also: **engine strength push** (`docs/ENGINE_STRENGTH.md`)
— a native in-process self-play **SPRT** harness (`gomachine bench`) drove five
SPRT-gated search improvements (SEE, delta/aspiration/reverse-futility/late-move
pruning; ~+250 Elo) and **Lazy SMP** (lock-free TT; ~+97 Elo), then the
**Texel-tuned eval** (`gomachine tune`: joint Adam on WDL-labelled quiet Lichess
positions, tuning the PSQT itself via coefficient tracing; **+101 Elo @ movetime**,
SPRT-gated), then **5-piece Syzygy tablebases** (CGo + Fathom, root DTZ probe, `tb`
flag; **+18.8 Elo @ movetime**, SPRT-accepted, zero lost pairs) — reaching **≈2782**
on the Stockfish-2500 anchor (83.5%, up from ~2600). The old −148 Elo eval was a
broken method (coordinate-descent MSE on a frozen PSQT), not HCE itself.
**Syzygy auto-loads in prod** from `gomachine/data/syzygy/` (in-repo, gitignored,
next to `data/book.bin`; `serve`+`hub` discover it cwd-relative with no env/flag/
deploy change — `SYZYGY_PATH` overrides). Default-on but inert until a tablebase is
attached; full-strength bot moves + `/analyze` probe it, weakened bots stay at
their level. See `docs/SYZYGY_PLAN.md` for the download command, the
*legal-positions-only* Fathom gotcha, and why the simple `tb_probe_root` (not
`tb_probe_root_dtz`, whose rank shuffles a won KBN to a draw) is the right probe.
**SMP is live in prod** (balanced 2-thread: `serve -workers 2 -search-threads 2`,
`hub -bot-search-threads 2` in the systemd units; Syzygy already auto-loads).
Then **NNUE replaced HCE as the default eval** (`docs/NNUE/PLAN.md`): a
`(768→256)×2→1` SCReLU net trained with **bullet** on the M3 Pro's Metal GPU over
~40 GB of Stockfish data, made movetime-viable by an incremental int16 accumulator
— **+212 Elo @ movetime** over HCE (v4), shipped default-on. Then **v6 (512-wide) +
`archsimd` AVX2/NEON SIMD** (bit-exact kernels; 6.5×/4.16× eval): **+124 @ fixed
nodes / +101 @ movetime** over v4, **live in prod** (lairner = amd64, Go 1.26.4
`GOEXPERIMENT=simd GOAMD64=v3`; the v6 net + SIMD build ship together — v6 on a
scalar build is a movetime wash). Then a **search-feature wave** (`docs/ENGINE_STRENGTH.md
§13`) shipped **corrhist + singular + futility** (+66.9/+22.2/+21.3 @ 40k nodes; owes a
movetime re-anchor) and rejected the cheap long tail (conthist/IIR/capthist/probcut/razor
flat-or-negative; lmr2-on-singular −67 anti-synergy) — the cheap-search-patch well is now
mostly dry on this baseline. Current strength **≈3260 "dirty" CCRL Blitz**
(2026-06-29, two-NNUE-anchor agreement: Starzix 5.0 3276±83 / Viridithas 17 3245±94 @
100ms — ENGINE_STRENGTH.md §15), which **supersedes** the old SF-UCI_Elo **≈2882**
reading (that scale sits ~390 below CCRL; 2882+390≈3270, so the two agree). Next:
NNUE width → **1024** (cheap behind SIMD), hub-restart-durable resume, puzzle generation
pipeline, reworked-selective versions of the rejected search patches (PV-only IIR,
scaled capthist, conthist that doesn't double-count history), **SPSA**,
precise level↔Elo *calibration*, a true cross-pool ranked queue. See `docs/SPEC.md` §11 roadmap.
