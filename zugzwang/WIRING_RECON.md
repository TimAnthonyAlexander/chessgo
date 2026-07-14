# Zugzwang Wiring Recon

READ-ONLY reconnaissance for wiring the C++ engine **zugzwang** into chessgo in place of / alongside
**gomachine**. Nothing here modifies code. All cites are `path:line` relative to repo root
`/Users/tim.alexander/chessgo`.

Goal of the upcoming waves:
1. **Wave 1** — give zugzwang an HTTP `serve` mode that mirrors gomachine's stateless engine API.
2. **Wave 2** — point the website at zugzwang (gomachine as fallback), rebrand the frontend, keep
   the admin EngineVsEngine page multi-engine (gomachine / zugzwang / stockfish per side).
3. **Wave 3** — implement variants (Duck Chess, Chess960, Crazyhouse) in zugzwang.

zugzwang today: from-scratch/ported bitboard C++ engine (magic bitboards, PVS negamax, TT,
LMR/NMP/RFP/SEE/singular, a bit-exact port of gomachine's NNUE). **UCI-CLI only, no HTTP serve mode,
standard chess only** (`zugzwang/HANDOFF.md:38-43`). Source is ~4,327 lines in `zugzwang/src/`.

---

## A. gomachine's engine HTTP API (the contract zugzwang must mirror)

### Port & configuration

- Default listen **`127.0.0.1:6466`**, overridable with `-addr` on `gomachine serve`
  (`gomachine/cmd/gomachine/commands.go:28` `cmdServe`; dispatch `gomachine/cmd/gomachine/main.go:94`).
- Other `serve` flags (`commands.go:26-77`): `-tt 64` (TT MB/worker), `-workers 4` (engine pool size),
  `-search-threads 1` (Lazy SMP per search), `-analysis-workers NumCPU`, `-analysis-tt 16`, `-pprof`,
  `-book data/book.bin`, `-tb-path` (Syzygy; env `SYZYGY_PATH` / auto-discover `data/syzygy`).
- PHP reads the URL from `ENGINE_URL` (config key `gomachine.engine_url`), default
  `http://127.0.0.1:6466` (`app/Services/GomachineClient.php:22`; `config/app.php:85`).
- Confirmed in `docs/SPEC.md:108,135`, `docs/COMMANDS.md:12,52,442,586`.

### Statelessness

Package doc: "stateless localhost HTTP/JSON API… every request carries the full position (FEN)"
(`gomachine/internal/server/server.go:1-4`). The server holds only a bounded pool of warm
`*engine.Engine` (TT stays hot; no per-request/game state) — `server.go:20-27`. Every handler rebuilds a
`chess.Position` from `fen` (+ optional `history []FEN` for repetition) per call. **Exception:**
`/duck/bestmove` and `/crazyhouse/bestmove` compute AND apply the move server-side and return the new
FEN — still stateless (caller carries `newFen` forward). Panics recover into a 500
(`recoverPanics`, `server.go:162-171`). Illegal-FEN guard (`parseLegal`, `server.go:175-186`) returns
`400 {"error":"invalid fen: …"}` / `{"error":"illegal position: …"}` before any handler runs — must be
replicated for error-shape parity.

### Route table (registration block `server.go:136-158`)

| Method + Path | Handler | File:line | Website uses |
|---|---|---|---|
| POST `/move` | handleMove | `server.go:346` | apply move (EvE, bot flow) |
| POST `/legal-moves` | handleLegalMoves | `server.go:393` | bot flow |
| POST `/bestmove` | handleBestMove | `server.go:428` | **analyze, bot move, EvE gomachine side** |
| POST `/candidates` | handleCandidates | `server.go:271` | analysis multi-PV bars |
| POST `/sf-bestmove` | handleStockfishMove | `stockfish.go:49` | EvE stockfish side, sf-analyze |
| POST `/analyze-game` | handleAnalyzeGame | `analyze.go:66` | post-game review |
| POST `/status` | handleStatus | `server.go:555` | adjudication |
| POST `/perft` | handlePerft | `server.go:607` | dev only |
| POST `/duck/legal-moves` | handleDuckLegalMoves | `duck.go:22` | duck board |
| POST `/duck/move` | handleDuckMove | `duck.go:48` | duck board |
| POST `/duck/bestmove` | handleDuckBestMove | `duck.go:83` | duck bot / EvE-duck |
| POST `/duck/analyze-game` | handleDuckAnalyzeGame | `duck_analyze.go:34` | duck post-game |
| POST `/crazyhouse/legal-moves` | handleCrazyhouseLegalMoves | `crazyhouse.go:22` | zh bot flow |
| POST `/crazyhouse/move` | handleCrazyhouseMove | `crazyhouse.go:47` | zh bot flow |
| POST `/crazyhouse/bestmove` | handleCrazyhouseBestMove | `crazyhouse.go:81` | zh bot |
| GET `/healthz` | handleHealth | `server.go:628` | `GomachineClient::healthy()` |

(All `server.go` cites are `gomachine/internal/server/…`.)

### Request/response shapes

**`POST /move`** — apply one move.
Req `moveRequest` (`server.go:339-344`): `fen string`, `move string` (UCI), `history []string`,
`includeLegalMoves bool`.
Resp (`server.go:370-385`): `legal bool`; illegal → `{legal:false, reason:"illegal move"}`; legal →
`newFen string`, `san string`, `status string`, `sideToMove "w"|"b"`, `check bool`,
`claimableDraws []string` (`"threefold"`,`"fifty"`), `result string` (only if over: `"1-0"|"0-1"|"1/2-1/2"`),
`legalMoves []string` (only if `includeLegalMoves`).

**`POST /legal-moves`** — Req `legalMovesRequest` (`server.go:388-391`): `fen string`, `square string`
(optional, e.g. `"e2"`; empty = all). Resp (`server.go:409`): `moves []string`, `count int`.

**`POST /bestmove`** — the AI-move + strength-limiting endpoint.
Req `bestMoveRequest` (`server.go:412-426`):
```
fen      string
history  []string
limits: {
  rating    *int    // target Elo, priority over level
  level     *int    // legacy 0..10
  depth     int
  movetime  int     // ms
  nodes     uint64  // hard node cap; admin engine-vs-engine only
  aggr      *int    // 0..100, nil→50 neutral; rating path only
  book      *bool   // rating path: consult book (default off there)
  fast      *bool   // rating path: RootNearBest fast weakening
  worst     *bool   // "Unlosable" bot: play worst legal move
}
```
Dispatch precedence (`server.go:442-520`): `worst` → `BestMoveWorst`; `rating+fast` →
`BestMoveForRatingFast`; `rating` → `BestMoveForRatingLimitedAggr` (honors `aggr`, optional `book`);
`level` → `BestMove`; `depth>0||movetime>0` → `SearchDirect`; default → `SearchDirect(pos,0,1s,hist)`.
Book shortcut when none of rating/level/worst set + book hit → served from book (`server.go:443-458`),
response with `nodes:0, nps:0, level:-1`.
Resp (`server.go:524-546`): no legal move → `{bestmove:null, reason:"no legal moves"}`; else
```
bestmove string   // UCI
san      string
eval     {type:"cp"|"mate", value:int}   // side-to-move relative
pv       []string  // UCI
depth    int
nodes    uint64
nps      int
level    int       // -1 for book/rating/worst, else the level passed
opening  *Opening|null   // {name,eco,…} from internal openings.Classify; null if unnamed
```

**`POST /candidates`** — analysis MultiPV bars.
Req `candidatesRequest` (`server.go:257-265`): `fen string`, `history []string`,
`limits:{multipv int, depth int, movetime int}` (default 300ms). Resp (`server.go:331-334`):
`opening *Opening|null`, `moves:[{uci, san, eval:{type,value}, pv:[]string, depth:int, opening:*Opening|null}]`
best-first, sliced to `multipv`. Cached by `(pos.Key(), depth, movetime)`.

**`POST /sf-bestmove`** — Stockfish proxy. **gomachine drives Stockfish itself** — see §A/Stockfish.
Req `sfMoveRequest` (`stockfish.go:39-44`): `fen string`, `elo int` (UCI_Elo 1320-3190; `<=0` = full
strength), `movetime int` (ms, default 100), `depth int` (takes precedence over movetime).
Resp (`stockfish.go:118`): `bestmove string|null` (+ `reason` if null), `san string`,
`eval:{type:"cp"|"mate", value:int}`. If SF binary not found → `503 {"error":"stockfish not found…"}`.

**`POST /analyze-game`** — full-game review.
Req `analyzeGameRequest` (`analyze.go:18-22`): `startFen string` (default StartFEN), `moves []string`
(UCI, ≤600), `movetime int` (0→100, clamp [100,3000]). Resp (`analyze.go:152-155`):
`positions:[{fen, sideToMove, eval:{type,value}|null, bestmove:string|null, bestSan:string|null,
pv:[]string, depth:int, terminal:bool, checkmate:bool, stalemate:bool}]`, `count int`. Full-strength,
consults book, no history threaded (`analyze.go:158-171`).

**`POST /status`** — adjudicate without moving.
Req `statusRequest` (`server.go:549-553`): `fen string`, `history []string`, `timeoutSide "w"|"b"`
(optional FIDE 6.9). Resp (`server.go:567-598`): `status string`, `sideToMove`, `check bool`,
`claimableDraws []string`, `result string` (if over); with `timeoutSide` → `status:"timeout"` +
`"1-0"/"0-1"` or `"draw-timeout-vs-insufficient-material"` + `"1/2-1/2"` (via `pos.CanAnyoneMate`) + `reason`.

**`POST /perft`** — Req (`server.go:601-605`): `fen`, `depth int` (1..8), `divide bool`. Resp: `{nodes:uint64}`
(+ `divide: map[string]uint64` if divide).

**`GET /healthz`** — Resp `{status:"ok"}` (`server.go:628-630`).

**Duck routes** (`internal/duckchess`, self-contained rule engine, no shared engine pool):
- `/duck/legal-moves` — req `{fen, duck}` (`duck.go:14-17`); resp `{moves:[]string}` (piece moves only,
  no self-check filter, king captures included).
- `/duck/move` — req `{fen, duck, move}`, move = `"<pieceUCI>:<duckSquare>"` (`duck.go:40-44`); resp
  illegal `{legal:false, error}`; legal `{legal:true, san, newFen, duck, sideToMove, status, result|null}`.
- `/duck/bestmove` — req `duckBestMoveRequest` (`duck.go:69-79`): `fen, duck, limits:{rating *int,
  level *int, movetime int, nodes uint64, depth int}`; computes+applies; resp `{bestmove:string|null,
  san, eval|null, reason?, newFen, duck, sideToMove, status, result|null}`.
- `/duck/analyze-game` — req (`duck_analyze.go:20-23`): `moves []string` (composite), `movetime int`
  (default 250). Resp `{positions:[{ply,fen,duck,sideToMove,eval|null,bestmove|null,bestSan|null,
  terminal,checkmate,stalemate}], count}`.

**Crazyhouse routes** (`internal/crazyhouse`, self-contained; FEN carries `[pocket]`):
- `/crazyhouse/legal-moves` — req `{fen}`; resp `{moves:[]string}` (incl. drops `"P@e4"`).
- `/crazyhouse/move` — req `{fen, move}` (`crazyhouse.go:40-43`); resp illegal `{legal:false, error}`;
  legal `{legal:true, san, newFen, pocket, sideToMove, status, result|null}`
  (status via `crazyhouseStatusName`: `"checkmate"`/`"draw"`/`"ongoing"`).
- `/crazyhouse/bestmove` — req (`crazyhouse.go:68-77`): `fen, limits:{rating *int, level *int, movetime,
  nodes, depth}`; computes+applies; resp `{bestmove:string|null, san, eval|null, reason?, newFen,
  pocket, sideToMove, status, result|null}`. **No `/crazyhouse/analyze-game` exists.**

### Strength / rating-limiting code path (core to port)

- `limits.rating` → `engine.BestMoveForRatingLimitedAggr` (`gomachine/internal/engine/engine.go:275-301`)
  → `configForRating(rating)` (`gomachine/internal/engine/rating.go:68-99`): clamp `[700,3500]`;
  `s=(rating-700)/2800`; **MoveTime** = `60ms*(1900/60)^s` (geometric); **Depth** = `int(2+16*s+0.5)`;
  below `ratingCleanFloor=2600` adds quadratic **NoiseCp** (≤160cp) and **Blunder** prob (≤0.33).
- `aggr` (0..100, 50=neutral) → `searcher.SetAggr(aggr)` for one search, reset after (`engine.go:282-285`).
- `book *bool` rating path → handler shortcut `server.go:490-505`.
- `level *int` (0..10) → `engine.BestMove` (`engine.go:154-184`) → `configForLevel`
  (`gomachine/internal/engine/levels.go:22-39`); weakened levels rank all root moves then `pickWeakened`
  (`engine.go:371-406`).
- `fast *bool` → `BestMoveForRatingFast` (`engine.go:315-332`) via `search.RootNearBest`.
- `worst *bool` → `BestMoveWorst` (`engine.go:420-435`), min-scoring move at fixed depth 6.

**Note for the port:** a faithful zugzwang HTTP layer needs, at minimum, a rating→(movetime,depth,noise,
blunder) mapping mirroring `configForRating` plus a full-strength `SearchDirect` path. The `aggr`/`fast`/
`worst`/`level`/`book`/`nodes` knobs can be stubbed early (return full-strength or ignore) as long as the
JSON response shape is preserved, but bot-game weakening (`rating`) is load-bearing for the website.

### Opening book invocation

- `Server.book *book.Book` set via `SetBook` (`server.go:29-31`), loaded at startup from `-book data/book.bin`
  (embedded fallback) — `commands.go:50-67`. `Server.bookHit(pos)` (`server.go:73-86`) looks up `pos.Key()`
  and validates the move is still legal.
- Invoked at HTTP layer in `/bestmove` full-strength path (`server.go:443-458`), the `book:true`
  rating-path shortcut (`server.go:490-505`), and `/analyze-game` (`analyze.go:189-198`).
- Separately, engine-internal book (`engine.bookMove`, `engine.go:96-112`) fires inside SearchDirect when
  `useBook` is on — same file, architecturally distinct hook.

### Stockfish involvement — **gomachine drives it, PHP never does**

`/sf-bestmove` spawns a **fresh Stockfish process per call** via `bench.StartUCI` (`stockfish.go:70`),
binary resolved from `$STOCKFISH_PATH` → `PATH` → hardcoded fallbacks (`/usr/games/stockfish`,
`/usr/local/bin/stockfish`, `/opt/homebrew/bin/stockfish`, …) — `stockfishPath()` `stockfish.go:18-37`.
`elo>0` sets `UCI_LimitStrength=true, UCI_Elo`. PHP's `stockfishMove()` (`GomachineClient.php:127-139`)
and both `EngineMatchController`/`SfAnalyzeController` just POST to this endpoint;
**no `exec`/`proc_open` of stockfish anywhere in `app/`**. Implication: if zugzwang is to serve the
"Stockfish opinion" role, it must itself spawn Stockfish (same as gomachine) — or that traffic stays
pointed at gomachine. This is why the fallback/selector design (below) matters.

### UCI bridge precedent — none

`gomachine/internal/uci/uci.go:1-4` states it is "NOT the PHP integration boundary — that is the
stateless HTTP service in package server." There is **no UCI→HTTP adapter** in the codebase. zugzwang's
HTTP `serve` must be built fresh mirroring `internal/server`, wrapping its existing search — not derived
from its UCI loop (`zugzwang/src/uci.cpp`).

### Port gotchas

1. `eval` is always `{type:"cp"|"mate", value:int}`, **side-to-move relative** (`server.go:220-226`).
2. `history []string` = prior-position FENs → Zobrist keys server-side (`server.go:210-218`), repetition only.
3. `opening` comes from an internal Zobrist name table — return `null` if zugzwang doesn't implement it,
   to keep the shape.
4. `/duck/*` and `/crazyhouse/*` are separate rule engines (Wave 3), not the base search — out of scope
   for Wave 1's standard-chess HTTP mirror.

---

## B. PHP (BaseAPI) wiring

### `app/Services/GomachineClient.php` — the single engine client

Base URL `rtrim(App::config('gomachine.engine_url') ?? 'http://127.0.0.1:6466','/')` (`:22`); timeout
`App::config('gomachine.engine_timeout_ms')` default 8000 (`:24`). All methods funnel through private
`post()` (`:422-455`) — cURL POST `Content-Type: application/json`, **throws `RuntimeException`** on cURL
error (`:439`), non-string body (`:442`), invalid JSON (`:447`), or HTTP ≥400 (`:451`). `healthy()`
(`:400-412`) is a raw GET `/healthz`.

| Method | file:line | HTTP built |
|---|---|---|
| `move` | `:33-40` | POST `/move` {fen, move, history} |
| `bestMove` | `:59-98` | POST `/bestmove` {fen, history, limits:{rating, depth\|nodes\|movetime, aggr?, book?, fast?}} |
| `worstMove` | `:110-117` | POST `/bestmove` {…limits:{worst:true}} |
| `stockfishMove` | `:127-139` | POST `/sf-bestmove` {fen, elo, movetime, depth?} |
| `analyze` | `:155-171` | POST `/bestmove` {fen, limits:{movetime, depth?}} |
| `candidates` | `:184-199` | POST `/candidates` {fen, history, limits:{movetime, multipv?, depth?}} |
| `analyzeGame` | `:212-225` | POST `/analyze-game` {moves, movetime, startFen?} (120s) |
| `duckAnalyzeGame` | `:241-249` | POST `/duck/analyze-game` {moves, movetime} (120s) |
| `legalMoves` | `:256-264` | POST `/legal-moves` {fen, square?} |
| `duckLegalMoves` | `:275-281` | POST `/duck/legal-moves` {fen, duck} |
| `duckMove` | `:291-298` | POST `/duck/move` {fen, duck, move} |
| `duckBestMove` | `:313-340` | POST `/duck/bestmove` {fen, duck, limits:{rating?, depth\|nodes\|movetime}} |
| `crazyhouseLegalMoves` | `:349-352` | POST `/crazyhouse/legal-moves` {fen} |
| `crazyhouseMove` | `:360-366` | POST `/crazyhouse/move` {fen, move} |
| `crazyhouseBestMove` | `:375-398` | POST `/crazyhouse/bestmove` {fen, limits:{rating?, depth\|nodes\|movetime}} |
| `healthy` | `:400-412` | GET `/healthz` → bool |

### `app/Services/HubClient.php` — hub only, never the engine

Base `App::config('gomachine.hub_url')` default `http://127.0.0.1:6467` (`:20`); secret
`gomachine.ws_ticket_secret` (`:21`). Fail-open methods `livePlayer()` (`:34-64`), `stats()` (`:72-96`),
`games()` (`:105-129`) hit the **hub** (matchmaking WS process), not the engine. Shares the `gomachine.*`
config namespace but is irrelevant to zugzwang wiring.

### Config resolution

`config/app.php:84-94` block `'gomachine' => [...]`: `engine_url` ← `ENGINE_URL` default
`http://127.0.0.1:6466` (`:85`); `engine_timeout_ms` ← `ENGINE_TIMEOUT_MS` (`:86`); `hub_url` ← `HUB_URL`
(`:87`); plus `ws_public_url`, `ws_ticket_secret`, `ws_ticket_ttl`, `stats_*` (`:88-93`). **`.env.example`
has no `ENGINE_URL`/`HUB_URL` — undocumented but supported.**
`App::config('gomachine…')` read sites: `StatsController.php:44,51,52`, `FillerFensController.php:67`,
`GameResultController.php:172`, `WsTicketController.php:72`, `BotChatController.php:199`,
`HubClient.php:20,21`, **`GomachineClient.php:22,24` (the only engine-URL read site)**,
`WsTicketService.php:26,27`.

### DI registration

`app/Providers/AppServiceProvider.php`: `singleton(GomachineClient::class)` (`:39`),
`singleton(BotGameService::class)` (`:40`), `singleton(GameAnalysisService::class)` (`:42`),
`singleton(HubClient::class)` (`:46`). **`GomachineClient` is one singleton bound to one URL — the single
chokepoint.**

### Controllers that call the engine

- **Analyze**: `app/Controllers/AnalyzeController.php` — ctor injects `GomachineClient $engine` (`:42`),
  `post()` → `analyze($fen,$movetime,$depth)` (`:69`).
- **BotMove/BotGame**: `BotMoveController::post()` (`BotMoveController.php:29-46`) and
  `BotGameController` (`BotGameController.php:40-76`) delegate to **`BotGameService`** — ctor
  `GomachineClient $engine` (`BotGameService.php:43-45`): `legalMoves` (`:115`),
  `move`/`duckMove`/`crazyhouseMove` (`:143,162,178`), `worstMove`/`bestMove` (`:269-275`),
  `crazyhouseBestMove` (`:298`), `duckBestMove` (`:352`), `duckLegalMoves`/`crazyhouseLegalMoves`/
  `legalMoves` (`:408-411`).
- **EngineVsEngine (admin)**: `app/Controllers/EngineMatchController.php` — ctor `GomachineClient $engine`
  (`:51`), `post()`: admin gate (`:57-60`), validate `side:"gomachine"|"stockfish"` (`:64`), then
  `stockfishMove()` (`:80`) or `bestMove()` (`:86-95`), then always `move()` to apply (`:103`). **The one
  controller with per-request engine choice.**
- **Duck**: `DuckLegalMovesController::post()` → `duckLegalMoves` (`:40`); `DuckMoveController::post()` →
  `duckMove` + `duckLegalMoves` (`:45,63`); `DuckAnalyzeController::post()` → `duckBestMove` (`:62`).
- Also: `GameAnalysisService` (`:36` ctor) → `analyzeGame` (`:70`)/`duckAnalyzeGame` (`:103`);
  `CandidatesController` (`:33,52`) → `candidates`; `SfAnalyzeController` (`:35,52`) →
  `stockfishMove(fen,0,…)` (full-strength SF "second opinion arrow").

### `routes/api.php` entries

`POST /bot-games` → BotGameController (`:70-73`); `GET /bot-games/{id}` (`:76`);
`POST /bot-games/{id}/move` → BotMoveController (`:79-82`); `POST /bot-games/{id}/undo` (`:85-88`);
`POST /analyze` → AnalyzeController (`:115-119`); `POST /duck/legal-moves` (`:123-126`);
`POST /duck/move` (`:130-133`); `POST /duck/analyze` (`:136-139`); `POST /sf-analyze` (`:144-148`);
`POST /candidates` (`:152-155`); `POST /admin/engine-vs/move` → EngineMatchController
(CombinedAuthMiddleware) (`:159-162`); `GET /games/{id}/analysis` → GameAnalysisController (`:268-271`).

### Four call-chain traces

**a. Analyze** — frontend POST `/analyze` → `routes/api.php:115-119` → `AnalyzeController::post()`
(`AnalyzeController.php:47-77`) → `GomachineClient::analyze()` (`:155-171`) → `post('/bestmove')`
(`:422`) → cURL `{engine_url}/bestmove`.

**b. Bot move** — frontend POST `/bot-games/{id}/move` → `routes/api.php:79-82` →
`BotMoveController::post()` (`:29-46`) → `BotGameService::humanMove()` (`:133-192`) applies via
`move`/`duckMove`/`crazyhouseMove` → `playBot()`/`playDuckBot()`/`playCrazyhouseBot()` →
`bestMove`/`worstMove`/`duckBestMove`/`crazyhouseBestMove` → `post()` → cURL `/bestmove` (or `/duck`,
`/crazyhouse`).

**c. Engine vs Engine** — `EngineVsEngine.tsx:357` `engineVsMove(paramsForSide(...))` →
`api/client.ts:120-134` POST `/admin/engine-vs/move` → `routes/api.php:159-162` →
`EngineMatchController::post()` (`:55-119`): branch on `side` (`:76-96`) → `stockfishMove()` (`:80`,
→ `/sf-bestmove`) or `bestMove()` (`:86-95`, → `/bestmove`) → always `move()` (`:103`, → `/move`).

**d. Duck** — free-play board: POST `/duck/{legal-moves,move,analyze}` → `routes/api.php:123-139` →
Duck*Controller → `duckLegalMoves`/`duckMove`/`duckBestMove`. Duck bot game: flow (b) via
`BotGameService::playDuckBot()` (`:347-394`). **Duck in EvE**: `EngineVsEngine.tsx` forces both sides to
gomachine (`:214-215`) and drives `duckEval()`/`duckPlay()` → the plain `/duck/*` routes — never reaches
`EngineMatchController`.

### Minimal-change wiring point

**Whole-app swap (zero code):** `engine_url` is read at exactly **one** site
(`GomachineClient.php:22`). Because zugzwang exposes the identical API, repointing `ENGINE_URL` makes
*every* call (analyze, bot games, candidates, duck, crazyhouse, analysis, and the gomachine side of EvE)
hit zugzwang — env + restart only. Covers flows (a),(b),(d) and the gomachine half of (c).

**Per-request selection (needs code)** — required for EvE (gomachine vs zugzwang vs stockfish per side)
and for a zugzwang-primary/gomachine-fallback policy. Cheapest correct shape:
1. Add `gomachine.zugzwang_url` in `config/app.php` (mirror `:85`). Add an **optional
   `?string $baseUrlOverride` ctor param to `GomachineClient`** and register a second DI binding, e.g.
   `singleton(ZugzwangClient::class, fn() => new GomachineClient($zugzwangUrl))`
   (`AppServiceProvider.php:39`). The class is a thin stateless HTTP shim with one ctor concern (URL) and
   ~15 identically-shaped POSTs — a ctor param + second binding beats duplicating 15 methods or an
   interface hierarchy.
2. `EngineMatchController` gains a third `side` value (`in:gomachine,zugzwang,stockfish`,
   `:64`) and picks the matching injected client instead of always `$this->engine`.
3. Everyday callers (bot/analyze/duck) opting into zugzwang would need a config flag
   (`gomachine.primary_engine`) or per-game `BotGame.engine` column — not present today, beyond "minimal".

**Fallback-to-gomachine belongs in a thin decorator** — a new `EngineSelector`/`PrimaryEngineClient`
service holding both a zugzwang and a gomachine `GomachineClient`, exposing the same method surface,
trying zugzwang first and catching the `RuntimeException` that `post()` already throws
(`GomachineClient.php:439,442,447,451`) to retry against gomachine. Bind it into DI in place of the raw
`GomachineClient::class` singleton for the consumers that should get automatic fallback (e.g.
`BotGameService`, `AnalyzeController`), while `EngineMatchController` keeps direct access to both concrete
clients for explicit per-side choice. This decorator is also where "zugzwang can't do `/sf-bestmove`" is
handled — route SF traffic to gomachine unconditionally.

### Stockfish from PHP

`grep -rni stockfish app/` → PHP **never** shells out to a stockfish binary. All references are
parameter plumbing to `GomachineClient::stockfishMove()` → gomachine's `/sf-bestmove`
(`EngineMatchController.php:80`, `SfAnalyzeController.php:52`). Stockfish subprocess is owned by the Go
engine, outside PHP's call path.

---

## C. Frontend rebrand surface

61 `gomachine` hits across **9 files**, all lowercase (no `Gomachine`/`GoMachine`/`GOMACHINE` variants
anywhere in `frontend/src`, `index.html`, or `public/`).

### User-visible text (rebrand to "Zugzwang" + new badge) — 2 files outside EvE

| file:line | Text | Change |
|---|---|---|
| `frontend/src/components/GameModeCard.tsx:73` | `<Typography>gomachine</Typography>` (lobby Opponent card) | → "Zugzwang" |
| `frontend/src/pages/BotGame.tsx:703` | `gomachine` (bot-game header opponent name) | → "Zugzwang" |
| `frontend/src/pages/BotGame.tsx:907` | `'Play the gomachine engine from this position.'` | copy |
| `frontend/src/pages/BotGame.tsx:908` | `'Play the gomachine engine.'` | copy |

**No existing engine badge/logo asset.** `Logo.tsx`/`Footer.tsx`/`favicon.svg`/piece SVGs are all
**chessgo** site brand (zero gomachine refs). The "new Zugzwang badge" is net-new, inserted where the
plain text above lives. `index.html` has no engine branding (title `chessgo`).

### Code identifiers (protocol; change in lockstep with PHP `side` key)

- `frontend/src/api/client.ts:99` — `export type EngineSide = 'gomachine' | 'stockfish'` → add `'zugzwang'`.
- `client.ts:110` — `by: EngineSide` field in `EngineVsMove` (response discriminator, same union).
- `EngineVsEngine.tsx:111` `engine:'gomachine'` default; `:139` `coerceSide` fallback; `:186`
  `paramsForSide` `side:'gomachine'`; `:192` `engineName` (returns literal `'gomachine'` — the label that
  should intentionally **stay** "gomachine" in EvE); `:194,593,766` engine branches; `:803`
  `<ToggleButton value="gomachine">gomachine</ToggleButton>` (picker value + label); `:811`
  `label="gomachine rating"`.
- `frontend/src/components/EvalBar.tsx:35` `const GOMACHINE_CP_SCALE = 0.5` (+ use `:69`) — internal
  constant, not user-visible; safe to leave or rename.

### Doc-comment-only (no runtime string, optional) — 5 files

`pages/Analysis.tsx` (`:65-66,154,395,554,557`), `pages/GuessTheElo.tsx:48`, `EvalBar.tsx` comments,
`lib/chess.ts:1`, `lib/variants.ts:2`, plus comment blocks in `client.ts` and `EngineVsEngine.tsx`.
No protocol/render impact.

### `client.ts` engine surface (file is 1135 lines)

- `EngineSide` (`:99`) — the single source-of-truth union; widening it auto-widens EvE's `EngineKind`.
- `EngineVsMove` (`:101-112`): `{bestmove, san, fen, status, result, sideToMove, claimableDraws, eval,
  by:EngineSide, reason?}`.
- `engineVsMove(params)` (`:120-135`): flat bag `{fen, side:EngineSide, rating?, elo?, movetime?, nodes?,
  depth?, aggr?, book?}` → POST `/admin/engine-vs/move`. gomachine-only (`rating`,`nodes`,`aggr`,`book`)
  and stockfish-only (`elo`) coexist; **zugzwang needs its own param carve-out**.
- `analyze(fen, opts?)` (`:218-233`) → `/analyze`; **engine-agnostic, no `EngineSide`** — hits whatever
  the backend wires as the analysis engine. No change unless analyze becomes engine-selectable.
- `sfAnalyze` (`:245-256`) → `/sf-analyze` (SF-only, no `EngineSide`).
- `duckEval(fen,duck,opts?)` (`:305-327`) → `/duck/analyze`; **no `side` param** — duck is gomachine-only.
- `duckPlay(fen,duck,move)` (`:288-293`) → `/duck/move`; move-application only.

### `EngineVsEngine.tsx` (1106 lines) — the ONLY page keeping a gomachine option

- `EngineKind = EngineSide` type alias (`:92`) — inherits from `client.ts`.
- `SideConfig` (`:98-108`): `{engine:EngineKind, rating, aggr, book, sfElo, limitKind:'movetime'|'nodes'|
  'depth', movetime, nodes, depth}` — per-engine fields coexist so switching preserves settings.
- `paramsForSide` (`:178-190`) — two-way `if stockfish {…} else gomachine`. `LimitKind` support is
  per-engine (SF has no nodes; `:769` `effKind` falls back).
- Engine-picker (`:784-806`): a 2-button `ToggleButtonGroup` (`value="gomachine"` `:803`,
  `value="stockfish"` `:804`), strength controls below via `isGoma` boolean (`:766`, controls `:808-863`).
- Move dispatch: single call `engineVsMove(paramsForSide(...))` (`:357`); duck flow hardcoded to
  `duckEval`/`duckPlay` (`:307-354`, both sides forced gomachine `:214`).

**Touch points to add a third `'zugzwang'` engine (all in `EngineVsEngine.tsx` unless noted):**
1. `client.ts:99` `EngineSide` → add `'zugzwang'`.
2. `:98-108` `SideConfig` → add zugzwang strength field(s).
3. `:110-121` `DEFAULT_WHITE`/`DEFAULT_BLACK` → 3-way default pairing.
4. `:136-158` `coerceSide` → 3-way engine fallback.
5. `:178-190` `paramsForSide` → 3-way branch + zugzwang params object.
6. `:192` `engineName` / `:194` `sideDetail` → 3-way label/detail.
7. `:593` icon ternary → 3rd icon (else zugzwang mislabels as SF `Bot`).
8. `:766` `isGoma` boolean → 3-way `engine`-keyed switch (drives `:769,808,878,907`).
9. `:769` `effKind` nodes-fallback → know zugzwang's `LimitKind` support.
10. `:784-806` picker → 3rd `<ToggleButton value="zugzwang">`.
11. `:808-863` strength-control ternary → 3-way render.
12. `:877-879` Search-limit toggle → per-engine `Nodes` gating.

**Duck in EvE is architecturally gomachine-only** (`duckEval`/`duckPlay` have no `side` param) — a
3-engine combo matrix for Duck needs new client+backend plumbing; flag as out of scope unless zugzwang
also implements Duck (Wave 3).

### Counts

- **9 files** contain `gomachine`.
- **Pure text/branding rebrand: 2 files** — `GameModeCard.tsx`, `BotGame.tsx`.
- **Code-identifier/protocol: 2 files** — `client.ts` (`EngineSide` + params), `EngineVsEngine.tsx`
  (picker/dispatch; also the one place "gomachine" text intentionally stays).
- **Doc-comment-only, optional: 5 files** — `Analysis.tsx`, `GuessTheElo.tsx`, `EvalBar.tsx`,
  `lib/chess.ts`, `lib/variants.ts`.
- **No badge/logo asset to rebrand** — new component needed.

---

## D. Variants scope

gomachine's variant abstraction: `gomachine/internal/variant/` — `State` interface
(`variant.go:30-59`), IDs `Standard/Chess960/Duck/Crazyhouse` (`variant.go:21-25`), dispatcher
`New(id,fen)` (`variant.go:62-71`). Two tiers (`variant.go:7-10`): **Tier 1** (Standard, Chess960) reuse
`chess.Position` + the shared engine pool via `standardState` (`standard.go:12-58`); **Tier 2** (Duck,
Crazyhouse) are self-contained self-searching packages that never touch the shared pool.

### Duck Chess — **SHIPPED**

- **Rules core**: `gomachine/internal/duckchess/` (12 files, self-contained, reads `internal/chess`
  read-only). Duck square stored **separate from the board** (`state.go:23-31`); `LegalPieceMoves`
  duck-aware with **no self-check filter and king captures included** (`movegen.go:10-40`); composite
  move `"<pieceUCI>:<duckSquare>"` (`apply.go:29-149`); terminal = king-capture win / no-moves loss /
  300-fullmove draw, **no check/checkmate** (`status.go:46-78`); own material+center+king-danger eval
  (`eval.go:50-79`) + Tier-2 negamax (`search.go:80-111`).
- **HTTP (gomachine)**: `/duck/{legal-moves,move,bestmove}` (`server.go:147-150`) + `/duck/analyze-game`.
- **HTTP (BaseAPI)**: `routes/api.php:121-138` (public free-play board); internal use in
  `BotGameService.php:72-80,142-151,347-357` and `GameAnalysisService.php:47-113` (`analyzeDuck`).
- **Hub**: full live wiring, **own isolated rating pool** (`hub.go:334-338`, `matchmaking.go:22-76`),
  rated when both accounts.
- **UI**: `DuckFreeBoard.tsx` (standalone analysis board, `Analysis.tsx:593`), `DuckGlyph.tsx`,
  `lib/useDuckInteraction.ts` (`LiveGame.tsx:198`, `BotGame.tsx:204`), `VariantPicker.tsx`, per-variant
  rating tiles (`api/client.ts:624-722`). Only gap: undo unsupported (`BotGameService.php:206-208`).

### Chess960 (FRC) — **SHIPPED** (rules-core + HTTP + UI; narrower — permanently unrated)

- **Rules core** is built into `internal/chess` itself (not a separate package):
  `chess/frc_random.go:5-48` (`RandomChess960FEN`), `chess/castling.go:5-11`, per-position `castleRook`
  origins in `chess/position.go:55-61`, castling gen from stored squares `chess/movegen.go:104-111`,
  king-captures-rook UCI `chess/move.go:56-76` + `chess/moveparse.go:6-15`, FRC edge cases
  `chess/makemove.go:79,192`. Perft-validated: `chess/frc_test.go` (6 Ethereal positions to depth 5).
- **HTTP**: no dedicated route — rides standard `/bot-game`/hub with `variant=chess960`; the only
  difference is the start FEN (`BotGameService.php:55-90`; `hub.go:339-346`
  `if variantID==chess960 { startFen = chess.RandomChess960FEN() }`).
- **Unrated**: `hub.go:335,338` carves Chess960 out of the rated set (no dedicated pool).
- **UI**: `VariantPicker.tsx:4` (`chess960`), `lib/variants.ts:88-106` (`random960()`),
  `ChallengeDialog.tsx:242`, `BotGame.tsx:352-358`; reuses the standard `<Board>`.

### Crazyhouse — **PARTIAL** (live/bot shipped; missing public routes + post-game analyzer)

- **Rules core**: `gomachine/internal/crazyhouse/` (11 files) **embeds `chess.Position`**, adds pockets +
  drops. `State{pos, pockets[2][5], promoted, history}` (`state.go:36-41`); FEN `[pocket]`+`~`
  (`state.go:179-215`); drop gen reusing `AttackersTo` (`movegen.go:9-57`); captured piece → pocket,
  promoted reverts to pawn (`apply.go:90-97`), composite Zobrist (`apply.go:110-118`); **real
  checkmate/stalemate** (a mate must survive all legal drops, `status.go:44-47`); pocket-aware eval
  (`eval.go:20-27,97-122`).
- **HTTP (gomachine)**: `/crazyhouse/{legal-moves,move,bestmove}` (`server.go:153-155`). **No
  `/crazyhouse/analyze-game`.**
- **HTTP (BaseAPI)**: **no dedicated PHP routes/controllers** — only `GomachineClient.php:343-394` used
  internally by `BotGameService.php:80-89,159-170,288-298`. No public free-play board endpoint,
  **no `analyzeCrazyhouse`** in `GameAnalysisService` (falls to the minimal generic analyzer,
  `GameAnalysisService.php:118`).
- **Hub**: full live wiring like Duck — isolated rating pool, rated when both accounts, pocket in
  `game.state.Extras()["pocket"]` (`hub/game.go`, `spectate.go`).
- **UI**: `lib/useCrazyhouseDrops.ts` (`LiveGame.tsx:207`, `BotGame.tsx:213`), `Pocket.tsx`/
  `PocketPanel.tsx`, `lib/variants.ts:30-79`, `VariantPicker.tsx`. **No standalone free-play analysis
  board** (no `CrazyhouseFreeBoard`).

### zugzwang gap per variant

zugzwang has **zero variant support** — standard chess only, no `internal/variant`-equivalent. Key
representation facts: `CastlingRight` is a flat 4-bit mask with **no rook-origin field**
(`zugzwang/src/types.h:57-64`); `generate_castling` **hardcodes** `G1/H1/A1/C1/G8/H8/A8/C8`
(`zugzwang/src/movegen.cpp:97-117`); `Position`/`StateInfo` = mailbox + bitboards + Zobrist sub-keys +
NNUE accumulator hook, **no pocket/duck-square/drop machinery** (`zugzwang/src/position.h:10-114`);
standard-chess-only PVS with classic check/mate assumptions (`zugzwang/src/search.cpp`, 1001 lines).
`PARITY_GOMACHINE.md`/`HANDOFF.md` are purely about standard-chess search parity — no variant notes.

**Chess960 — smallest lift.**
- Movegen: rework `generate_castling` (`movegen.cpp:97-117`) to read king/rook origins from state (mirror
  gomachine `chess/castling.go`, `chess/movegen.go:104-111`).
- Position: add per-`StateInfo` rook-origin pair (mirror `chess/position.go:55-61`); rights stay a
  4-bit mask, the *squares* become data not `G1/C1` literals.
- Move encoding: adopt king-captures-rook UCI (`chess/move.go:56-76`) so `e1h1` round-trips through
  `do_move`/`undo_move` (`position.h:72-75`).
- Search/eval: **none** — rules-identical to standard once castling generalizes; no NNUE change (gomachine
  shares `standardState`). HTTP: just accept an arbitrary FRC start FEN (rides the general HTTP-serve
  work). Verification: reuse gomachine's 6 FRC perft positions (`chess/frc_test.go:9-22`) as the oracle.

**Duck Chess — largest structural lift** (breaks core search assumptions).
- Movegen: fold a duck-occupancy bitboard into every attack/blocker computation as a 17th blocker that is
  never a target; make king-capture a legal, generated move — fundamentally conflicts with
  `blockersForKing`/`pinners`/`checkers`/`legal()` (`position.h:24-26,77-78`).
- Position: add a duck-square field separate from the board (mirror `duckchess/state.go:23-31`); a "turn"
  is (piece move, duck placement) — either one atomic `do_move` with a combined delta or two calls per
  ply with careful undo bookkeeping.
- Search/eval: Duck has **no check/checkmate**, so `in_check()`/`checkers()`/`blockersForKing` become
  meaningless — check extensions (`search.cpp:511-512`), TT/eval gating, legality filtering must be
  bypassed for the variant; two-part turns roughly double branching and invalidate depth-tuned margins
  (RFP/LMR/singular — the whole `PARITY_GOMACHINE.md` table becomes suspect). Eval: gomachine's duckchess
  uses its **own hand-rolled eval, not the shared NNUE** (`duckchess/eval.go:50-79`); the pragmatic port
  is a **self-contained duckchess-equivalent C++ module** reusing zugzwang's board primitives read-only
  with its own shallow search — exactly what gomachine did — not bending the PVS loop.
- HTTP: duck square in every position payload, composite move format, duck status vocab
  (`king-captured`/`no-legal-moves`/`draw-move-cap`, `duckchess/status.go:8-13`).

**Crazyhouse — moderate lift, cleanly additive.**
- Movegen: add drop generation (per pocketed type over empty squares, skip ranks 1/8 for pawns, reject
  king-exposing drops via `attackers_to(sq, occ|sq)` — `position.h:67-68` already provides the primitive;
  mirror `crazyhouse/movegen.go:24-57`); new `Move` encoding for drops (`move.h`, 46 lines, needs a drop
  flag + piece-type field).
- Position: add `pockets[2][5]` + a `promoted` bitboard (mirror `crazyhouse/state.go:36-41`);
  `do_move`/`undo_move` mutate pockets on captures (promoted → pawn, `crazyhouse/apply.go:90-97`) and feed
  into `key()`/`compute_key()` (`position.h:104`) so TT/repetition distinguish equal boards with
  different pockets.
- Search/eval: standard check/mate semantics **survive** (a mate must survive all drops,
  `crazyhouse/status.go:44-47`), so the PVS loop stays valid — but drops must be first-class in move
  ordering / history / qsearch (checking drops), and SEE skips drops (a drop never captures). Eval needs
  pocket-material + drop-aware king-danger (`crazyhouse/eval.go:20-27,97-122`); again gomachine did **not**
  extend its NNUE — hand-eval fork is the precedent.
- HTTP: `"P@e4"` drop notation, `[pocket]`+`~` FEN, pocket string in every response.

### zugzwang `src/` layout (reference)

```
zugzwang/src/
  types.h (91)              Color/PieceType/Piece/Square, CastlingRight (flat 4-bit)
  bitboard.{h,cpp}          magic bitboards + attack tables
  move.h (46)               Move encoding
  movegen.{h,cpp}           pseudo-legal gen; generate_castling hardcodes std squares (movegen.cpp:97-117)
  position.{h,cpp} (117+605) Position/StateInfo: board[64]+bitboards, do_move/undo_move, SEE, repetition
  zobrist.{h,cpp}           Zobrist tables
  eval.{h,cpp}              NNUE::evaluate when loaded, else hce_evaluate
  nnue_*.{h,cpp}            bit-exact port of gomachine's full-threats NNUE (king-buckets + SF threats)
  search.{h,cpp} (32+1001)  PVS: LMR/NMP/RFP/SEE/singular/aspiration, corrhist
  tt.{h,cpp}                4-way clustered TT
  perft.cpp                 perft harness
  uci.cpp (205)             UCI loop (CLI only — no HTTP serve)
```

---

## Implementation checklist per wave

### Wave 1 — zugzwang HTTP serve (mirror gomachine's standard-chess API)

New C++ HTTP layer in `zugzwang/src/` (e.g. `serve.cpp` + a small JSON + HTTP dep), wrapping the existing
search — **built fresh, not from `uci.cpp`**. Endpoints to implement for parity with the website's
standard-chess needs:
- `GET /healthz` → `{status:"ok"}`.
- `POST /move` — apply move, return `newFen/san/status/sideToMove/check/claimableDraws/result/legalMoves?`.
- `POST /legal-moves` — `{moves,count}`.
- `POST /bestmove` — the big one: `limits.{movetime,depth,nodes}` for full-strength + a `rating`→
  (movetime,depth,noise,blunder) map mirroring `configForRating` (`gomachine/internal/engine/rating.go`);
  response `{bestmove,san,eval:{type,value},pv,depth,nodes,nps,level,opening:null}`. `aggr/fast/worst/
  level/book` may stub initially (preserve shape); `rating` weakening is load-bearing for bot games.
- `POST /candidates` — MultiPV `{opening:null, moves:[{uci,san,eval,pv,depth,opening:null}]}`.
- `POST /status` — adjudication incl. `timeoutSide`.
- `POST /analyze-game` — per-position review array.
- `POST /perft` — (nice-to-have, cheap given `perft.cpp`).
- Decide policy for `POST /sf-bestmove`: either implement (zugzwang spawns Stockfish like gomachine) or
  leave it 404/501 and route SF traffic to gomachine via the PHP selector.
- Match error shapes: `400 {"error":"invalid fen…"}`, `503` for missing SF, panic→500.
- Config: an `-addr` flag defaulting to a distinct port (gomachine already owns 6466). `eval` is always
  side-to-move-relative `{type:"cp"|"mate"}`; `opening` returns `null`.

### Wave 2 — wiring + rebrand + EvE

PHP:
- `config/app.php` — add `gomachine.zugzwang_url` (`ZUGZWANG_URL` env) next to `:85`.
- `app/Services/GomachineClient.php` — add optional `?string $baseUrlOverride` ctor param (URL only).
- `app/Providers/AppServiceProvider.php:39` — add a `ZugzwangClient` binding
  (`new GomachineClient($zugzwangUrl)`); optionally add an `EngineSelector` decorator (zugzwang-primary,
  gomachine fallback on `RuntimeException`; SF traffic → gomachine) and bind it for `BotGameService`,
  `AnalyzeController`, `GameAnalysisService`, `CandidatesController`.
- `app/Controllers/EngineMatchController.php` — validate `side:in:gomachine,zugzwang,stockfish` (`:64`),
  pick the matching client (`:76-103`).
- (Zero-code alternative for a full cutover: just repoint `ENGINE_URL` and skip the above.)

Frontend rebrand (user-visible → "Zugzwang" + new badge):
- `frontend/src/components/GameModeCard.tsx:73`.
- `frontend/src/pages/BotGame.tsx:703,907,908`.
- New Zugzwang badge component (no existing asset).

Frontend EvE / protocol (add `'zugzwang'` third engine):
- `frontend/src/api/client.ts:99` (`EngineSide`) + `engineVsMove` params carve-out (`:120-135`).
- `frontend/src/pages/EngineVsEngine.tsx` touch points (2)-(12) above (`:98-108,110-121,136-158,178-190,
  192-194,593,766,769,784-806,808-863,877-879`). Keep the literal "gomachine" label there.

### Wave 3 — variants in zugzwang

- **Chess960** (smallest): generalize `movegen.cpp:97-117` castling to stored rook origins; add rook-origin
  field to `position.h`; king-captures-rook UCI in `move.h`; validate against gomachine's FRC perft
  positions. HTTP: accept arbitrary start FEN (rides Wave 1). Website already offers 960 — points at
  whichever engine serves the standard flow, so it works once zugzwang parses 960 FENs.
- **Crazyhouse** (moderate, additive): pockets `[2][5]` + `promoted` bitboard in `position.h`; drop-move
  gen in `movegen.cpp` (reuse `attackers_to`); drop `Move` encoding in `move.h`; pocket-aware `do_move`/
  `undo_move`/`key()`; drops in move-ordering/qsearch; pocket eval terms; `[pocket]`/`~` FEN + `"P@e4"`.
  New HTTP `/crazyhouse/{legal-moves,move,bestmove}`. (Note the gomachine gaps this could also close:
  no public BaseAPI routes, no post-game analyzer.)
- **Duck** (largest, self-contained): a duckchess-equivalent C++ module reusing zugzwang board primitives
  read-only, with duck-occupancy movegen, king-capture wins, no-check model, composite turn, own shallow
  search + hand eval (mirror gomachine's `internal/duckchess`). New HTTP `/duck/{legal-moves,move,bestmove,
  analyze-game}`.
- Per-variant, the website UI already exists (Duck, Crazyhouse, 960 all wired to gomachine today), so the
  variant wave is engine-side + pointing the relevant `/duck/*`, `/crazyhouse/*` PHP calls at zugzwang.
```
```
