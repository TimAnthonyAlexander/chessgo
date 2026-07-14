# Architecture

chessgo is five processes plus MySQL, all binding `127.0.0.1`. A PHP backend owns
durable state and orchestration; a C++ engine (zugzwang) owns rules + AI; a Go hub
owns live realtime games.

## Services

| Service | Tech | Port | Role |
|---|---|---|---|
| Frontend | React + Vite + TS + MUI + Bun | 6465 | SPA (nginx-served `dist/` in prod) |
| BaseAPI | PHP 8.4 (`base-api` / `mason`) | 6464 | REST: auth, persistence, ratings, orchestration; signs WS tickets; proxies hub |
| **zugzwang** | **C++17 NNUE engine** | **6476** | **primary** stateless rules + AI; variants; spawns Stockfish |
| gomachine **hub** | Go | 6467 | realtime: live games, clocks, matchmaking, bot backfill, spectating |
| gomachine **engine** | Go | 6466 | *legacy fallback* (deletable) |
| MySQL | — | 3306 | durable data — PHP only |

The gomachine **engine** and **hub** are the same Go binary under two subcommands
(`serve`, `hub`). zugzwang is a separate C++ binary. Since the 2026-07 cutover the
site's AI is zugzwang; the gomachine engine survives only as a fallback and an
admin Engine-vs-Engine option (see `tasks/open/remove-gomachine-engine.md`).

## Source-of-truth split

- **PHP owns:** users, games, ratings, puzzles (MySQL); auth/sessions; signing WS
  tickets; bot-game orchestration; analysis + full-game review; `/stats` + `/watch`
  proxies; Glicko-2; anti-cheat; admin.
- **Engine (zugzwang) owns:** legal move generation, game-end detection,
  best-move search + eval, variant rules/AI. Pure `(FEN, limits) → result`,
  stateless — so magic tables + TT stay warm and it scales by process.
- **Hub owns:** live game state, matchmaking pools, server clocks, reconnect/resume
  + presence, bot backfill, spectating, engine-vs-engine watch fillers — all
  **in memory**; persists finished games back to PHP.

Chess rules now exist twice — C++ in zugzwang and Go in `gomachine/internal/chess`
(the hub still uses it for move validation) — reconciled by shared perft counts
and the byte-compatible HTTP contract, not by single-sourcing.

## The engine-selection layer (PHP)

Most controllers/services inject `EngineSelector`, a decorator over two concrete
clients:

- `GomachineClient` → `gomachine.engine_url` (`:6466`).
- `ZugzwangClient extends GomachineClient` → `zugzwang.url` (`:6476`).
- `EngineSelector extends GomachineClient` → routes every standard-chess + variant
  call to `engine.primary` (default **zugzwang**), and `stockfishMove` always to
  zugzwang (which spawns its own Stockfish subprocess). **No automatic failover** —
  a primary error propagates.

`ENGINE_PRIMARY=gomachine` (env → `config/app.php` `engine.primary`) reverts the
whole site to gomachine with zero code change. `EngineMatchController` (admin EvE)
bypasses the selector and injects both clients directly for per-side choice.

zugzwang serve endpoints: `/bestmove`, `/candidates`, `/move`, `/legal-moves`,
`/status`, `/perft`, `/analyze-game`, `/sf-bestmove`, `/duck/{legal-moves,move,
bestmove,analyze-game}`, `/crazyhouse/{legal-moves,move,bestmove}`, `/healthz`.

## Request flows

- **Bot game.** Browser → `POST /bot-games` (`BotGameService`) → `EngineSelector.
  bestMove` → zugzwang `/bestmove`. Moves via `/bot-games/{id}/move`, undo
  `/bot-games/{id}/undo`. Persisted as `BotGame`; never rated, never touches the hub.
- **Live game.** Browser `GET /ws-ticket` (PHP mints a signed HMAC ticket) → opens
  a WebSocket to the hub (`:6467`, `wss://…/ws` in prod). The hub matches players,
  ticks clocks, validates moves (via `internal/chess`), gets bot moves from
  zugzwang. On finish it fire-and-forgets `POST /internal/games` (`X-Hub-Secret`),
  and PHP stores the `Game` + applies Glicko-2 if rated.
- **Analyze / eval bar.** `POST /analyze` (+ `/candidates`, `/sf-analyze`) →
  `EngineSelector`/`ZugzwangClient` → zugzwang. Full-game review
  `GET /games/{id}/analysis` (`GameAnalysisService`, cached per Game).
- **Puzzle.** `GET /puzzles/next` (rating-matched, solution withheld) →
  `POST /puzzles/{id}/move` validated server-side against the hidden line; the
  engine only computes display FENs/legal moves. Isolated puzzle Glicko-2 applied
  once per (user, puzzle).

## Realtime hub protocol (WebSocket)

Identity comes from the signed HMAC **ticket** minted by BaseAPI `GET /ws-ticket`
(shared `WS_TICKET_SECRET` — no per-connect PHP call). 30s ping heartbeat + client
auto-reconnect. The hub mutates all shared state on **one goroutine** (no locks);
clients talk to it over channels, and bot search runs off-goroutine (zugzwang call)
applied back via a channel.

- **client → hub:** `queue{pool}`, `cancel`, `move{move}`, `resign`,
  `drawOffer/Accept/Decline`, `takebackOffer/Accept/Decline`, `chat{text}`,
  `watch{gameId}`/`unwatch`, `createChallenge`/`joinChallenge`/`cancelChallenge`.
- **hub → client:** `hello`, `queued`/`idle`, `matched`, `state`, `resume`, `end`,
  `opponentGone`/`opponentBack`, `error`, `drawOffered`/`drawDeclined`,
  `takebackOffered`/`takebackDeclined`, `chat`, `watching`, `watchEnd`,
  `challengeCreated`/`challengeExpired`.

Clocks are server-authoritative (200 ms tick), start Lichess-style (untimed until
both players' first moves), with a 30s first-move abort and FIDE 6.9 timeout-vs-
material handling. Matchmaking pools are per time control; the rating gap widens
100→400 with wait; anonymous players are treated as 1500; a bot fills a lone waiter.

## Concurrency inside zugzwang serve

`serve` runs N independent `Search::Context`s (default `min(cores, 6)`), each with
its own TT and mutable search tables, leased per request via RAII. Two searches on
different Contexts run fully concurrently with no shared mutable state (only the
read-only NNUE weights are shared). Rules-only handlers never lease a Context, and
the httplib worker pool is oversized so they never starve behind a busy search.
Details in `../zugzwang/CLAUDE.md`.
