# chessgo — Project Specification

> Living spec for the chessgo platform: a website to play chess against other
> humans (competitive matchmaking) and against an AI, with all chess rules and
> the AI implemented in a dedicated Go engine. This document captures the
> product decisions, the architecture, and the research that informs both.
>
> **Status:** v1 in progress. **Last updated:** 2026-06-18.
> Built & working: the Go engine (`gomachine`, perft-verified, ~2400+ Lichess
> strength), bot games + eval bar, the lobby, and **live human-vs-human play** —
> WebSocket hub with matchmaking, server clocks, and reconnect/resume. See
> `docs/COMMANDS.md` to run it, `CLAUDE.md` for a fast codebase orientation.

---

## 1. What we're building

Three components:

1. **Backend** — a [BaseAPI](https://github.com/timanthonyalexander/base-api) (PHP 8.4) REST API that persists users, games, the matchmaking queue, and game history; orchestrates play; and **calls the Go engine** for all rules + AI.
2. **Frontend** — a React single-page app to play chess (vs humans and vs AI), browse history, and manage an account.
3. **`gomachine`** — a Go chess engine that **owns all chess rules** (legal move generation + game-end detection) **and the AI** (classical search + evaluation, no Stockfish/NNUE). Exposed as a CLI first, then an internal HTTP service.

### Guiding principle — one engine, one source of truth

Chess rules are written **once, in Go**. The Go engine is the authority for:
move legality (castling, en passant, promotion, pins, check evasion) and
game-end detection (checkmate, stalemate, dead position, automatic draws). PHP
**never re-implements chess rules** — it calls Go. The Go engine is a **pure
function of the position it is handed**; PHP is the single source of truth for
game lifecycle, persistence, clocks, ratings, and matchmaking.

---

## 2. Product decisions (locked)

| Decision | Choice | Notes |
|---|---|---|
| **Engine ownership** | Go owns rules + AI; PHP calls it | DRY, one source of truth, fastest. |
| **AI scope (v1)** | Strong classical engine | Bitboards/magic, negamax+αβ, ID, TT, ordering, quiescence, tapered PeSTO eval. Target ~1800+ Elo. No Stockfish/NNUE. |
| **Real-time** | **WebSocket via a Go hub** | Dedicated realtime service (`gomachine hub`, §8); 30s ping heartbeat + client auto-reconnect (Cloudflare-ready). _Supersedes the earlier "polling first" call (SSE is unreliable behind Cloudflare)._ |
| **Frontend stack** | React + Vite + TypeScript + MUI + Lucide Icons + Bun + React-Router | Consumes BaseAPI's generated `types.ts`. |
| **Accounts** | Anonymous **casual** + accounts for **rated** (Lichess model) | Anonymous players (stable per-browser id) play casual/unrated; rated needs a registered account. Email/pw auth + **frontend signup/login (session cookies)** built; the ws-ticket carries the account identity + per-category ratings. |
| **Ratings** | **Elo, per time-control category** (bullet/blitz/rapid/classical) | For rated games (both accounts). Provisional K=40 for the first 20 games per category, then K=20; start 1500. Finished games persisted by the hub via `POST /internal/games`; Elo applied there. |
| **Clocks** | **Real server-authoritative clocks** | Bullet/Blitz/Rapid; the hub ticks clocks and flags, applying the FIDE 6.9 timeout-vs-material rule. _Supersedes the earlier "untimed first" call (the lobby commits to timed presets)._ |
| **AI difficulty** | **Levels 0–10** | See §6. Level 10 = max strength + slightly longer thinking; level 0 = short thinking + small blunder probability. Monotonic strength curve. |
| **Database** | **MySQL** | Local dev user `chessgo`@`localhost`. |
| **Cross-platform** | Ubuntu (deploy) + macOS (dev/deploy) | `gomachine` is **pure Go, no cgo** → cross-compiles cleanly. |

### Open / deferred (default = my best judgment, revisit anytime)

These were invited as free-form preferences and are not yet pinned. Current
working defaults:

- **Design vibe:** dark-first, lichess-like clean/minimal board (green or
  neutral wood theme, switchable). Refine later.
- **v1 game features:** resign, draw offers, move list (PGN), board flip,
  legal-move dots, last-move highlight. Premoves/spectating/chat/analysis
  deferred.
- **vs-AI UX:** pick level (0–10) + color before game; optional eval bar later.
- **Matchmaking:** single ranked pool by Elo proximity; rematch flow. Rating-range
  filters deferred.
- **Profiles:** game history + PGN export + W/L/D stats. Avatars deferred.
- **Engine protocol:** UCI-compatible CLI **and** internal JSON HTTP service
  (UCI lets us test with standard chess tools; JSON is the PHP boundary).
- **Opening book:** skip for v1 (pure search); small hand-curated book optional later.
- **Repo layout:** monorepo — `gomachine/` lives in this repo alongside the PHP app.
- **Hosting:** TBD (Linux box / container). No decision yet.

> Mark any of these as "locked" by telling me the preference; I'll update this table.

---

## 3. Architecture

```
                ┌─────────────────────────────────────────────┐
   Browser ────►│  Frontend (React+Vite+MUI+Bun)   :6465      │
                └──┬───────────────────────────────┬──────────┘
       REST/JSON   │                               │  WebSocket  (/ws, wss in prod)
                   ▼                               ▼
      ┌───────────────────────────┐   ┌──────────────────────────────────┐
      │ BaseAPI (PHP 8.4)  :6464  │   │ gomachine HUB (Go)   :6467        │
      │ • auth (+ anonymous)      │   │ • matchmaking pool (per TC)       │
      │ • bot games, /analyze     │   │ • live games + server clocks      │
      │ • /ws-ticket (HMAC sign)  │   │ • reconnect / resume (in-memory)  │
      │ • persistence (MySQL)     │   │ • verifies ticket (shared secret) │
      └─────────────┬─────────────┘   │ • imports internal/chess directly │
        internal HTTP│ (FEN-in)        └──────────────┬───────────────────┘
                     ▼                  persist results via BaseAPI (next phase)
      ┌───────────────────────────┐
      │ gomachine ENGINE (Go):6466│  rules + AI, pure (FEN, limit) → result
      └───────────────────────────┘  (same binary, `serve` subcommand)
                     │
                  MySQL :3306    durable data (users, games, ratings) — PHP only
```

> The engine (`:6466`) and hub (`:6467`) are the **same Go binary** with different
> subcommands (`serve` / `hub`). The hub reuses `internal/chess` for move
> validation + clocks + draw rules — no rules duplication, no HTTP hop.

### Source-of-truth split

| Owned by **PHP (BaseAPI)** | Owned by **gomachine — engine (`serve`) + hub** |
|---|---|
| Durable persistence (users, finished games, ratings) | Legal move generation + game-end detection (engine & hub) |
| Auth, accounts, signing WS tickets | Best-move search + evaluation (engine `serve`) |
| Bot-game orchestration, analyze proxy | **Live game state, matchmaking, server clocks (hub)** |
| Elo ratings (next phase) | Reconnect/resume + presence (hub, in-memory) |
| — | Zobrist keying, repetition/50-move, FIDE 6.9 timeout test |

### Ports (all `127.0.0.1`, all confirmed free at setup; theme = 64 squares)

| Service | Bind |
|---|---|
| BaseAPI REST | `127.0.0.1:6464` |
| Frontend (Vite dev / served build) | `127.0.0.1:6465` |
| `gomachine` engine HTTP (internal) | `127.0.0.1:6466` |
| `gomachine` hub — WebSocket (client-facing) | `127.0.0.1:6467` |
| MySQL | `127.0.0.1:3306` (always running on dev + prod) |

See `docs/COMMANDS.md` for how to start each service (dev screens + prod systemd/nginx).

### Database

- **MySQL** (`DB_DRIVER=mysql`). Local dev:

  ```sql
  CREATE USER 'chessgo'@'localhost' IDENTIFIED BY 'Development33!';
  -- grant on the chessgo schema once created
  ```

  `.env`: `DB_HOST=127.0.0.1`, `DB_PORT=3306`, `DB_NAME=chessgo`,
  `DB_USER=chessgo`, `DB_PASSWORD=Development33!`.
- **BaseAPI table naming is singular snake_case** (model `Game` → table `game`,
  `JobTask` → `job_task`). Schema changes flow **only** through
  `php mason migrate:generate` → `php mason migrate:apply -y` (never manual DDL).

### Cross-platform

`gomachine` builds with `CGO_ENABLED=0` for `linux/amd64`, `linux/arm64`,
`darwin/arm64`. No platform-specific code, no PEXT/BMI2 assembly (see §5.2) —
pure Go so a single `go build` cross-compiles to any target.

---

## 4. gomachine — engine design (research-backed)

> Full research synthesis with sources in §11. This section is the design we'll build.

### 4.1 Board representation
- **Bitboards**: 12 `uint64` (piece-type × color) = 96 B. Set bit = occupancy.
- Bitwise ops compute attack/push/pin sets over all 64 squares at once;
  enumerate via `bits.TrailingZeros64` + `bb &= bb-1`; count via
  `bits.OnesCount64` (both compile to single hardware instructions — Go intrinsics).
- Keep a redundant **`[64]Piece` mailbox** for fast square→piece lookup
  (bitboards' one weakness).
- Full state ≈ **150–250 bytes**, trivially copyable.

### 4.2 Sliding-piece attacks — **fancy magic bitboards**
- `index = (occupancy & mask) * magic >> (64 - n)` → precomputed attack bitboard.
- **Fancy magics ≈ 840 KiB** (800 KiB rook + 38 KiB bishop), 8-byte entries
  (rook 102,400 + bishop 5,248). Built once at startup.
- **PEXT/BMI2 is unavailable in pure Go** (`math/bits` has no `Pext`/`Pdep`);
  using it needs arch-specific assembly → breaks cross-compile. **Avoid.**
- Keep classical-ray sliders behind a build flag for perft cross-checking.

### 4.3 Move encoding
- CPW ideal = **16-bit** (6 `from` + 6 `to` + 4 flag). Production Go engines use
  **`uint32`** to also cache moving/captured/promoted piece (avoids board re-reads
  in make/SEE/ordering). **We use `uint32`.**
- **Move lists = fixed `[256]Move` arrays** (max 218 legal moves), never growing
  slices (avoids `growslice` heap alloc). Preallocated per-ply on a search stack.

### 4.4 Move generation
- **Pseudo-legal generation + make-time legality check** (`DoMove` returns false
  if it leaves own king attacked). Simplest correct approach; all reference Go
  engines do this.
- Check evasion: king moves, capture checker, or block a sliding checker;
  **double check → king moves only**. Handle absolute pins (move only along pin
  ray) and the **en-passant horizontal-pin** edge case.
- **Make/unmake** with a per-ply state snapshot (castling rights, ep square,
  captured piece, halfmove clock, Zobrist key). Copy-make on a preallocated
  `[MaxPly]Position` stack is an acceptable alternative — both are zero-alloc if
  `Position` never escapes to the heap.

### 4.5 Search (ordered by Elo-per-effort)
1. **Negamax + alpha-beta** (foundation; ~√b branching with good ordering).
2. **Quiescence search** (mandatory; resolves captures/promotions, stand-pat,
   delta pruning; no stand-pat when in check).
3. **Transposition table + Zobrist** (~150 Elo self-play; hash move drives ~75%
   of cutoffs).
4. **Iterative deepening + move ordering** (enables time mgmt; ordering is the
   hidden multiplier — target >90% first-move cutoffs at fail-high nodes).
5. **Null-move pruning** (~+100; R=2/3; never in check or zugzwang-prone endgames).
6. **Late move reductions** (~+100; only after good ordering; reduce late quiet
   non-PV moves at depth ≥ 3).
7. **PVS / NegaScout** (~10% node savings).
8. **Aspiration windows** (polish, ~noise-floor).

### 4.6 Transposition table
- **Zobrist**: ~781 random `uint64` (768 piece-square + 1 side + 4–16 castling +
  8 ep-file). XOR-incremental; on castling change XOR out old / in new.
- **Critical ep gotcha:** only hash the ep file when an ep capture is **actually
  legal** (a friendly pawn can really make it). Otherwise two identical positions
  hash differently → breaks TT **and** threefold repetition.
- **Entry ≈ 16 B**: key/signature + 16-bit move + 16-bit score + 8-bit depth +
  2-bit bound (EXACT/LOWER/UPPER) + 8-bit age.
- **Sizing** (power-of-two, `index = key & (n-1)`): 16 MB→1M, 64 MB→4M,
  256 MB→16M entries. Default **64 MB**.
- **Mate scores**: store `score±ply`, reverse on probe. Depth-preferred +
  always-replace, aged by generation.

### 4.7 Move ordering
TT/hash move → winning/equal captures by **MVV-LVA** (refined by **SEE**) →
**killer** moves (2/ply) → quiet moves by **history heuristic** (with gravity) →
losing captures (SEE < 0) last.

### 4.8 Evaluation
- **Minimal-but-strong = material + tapered piece-square tables (PeSTO) + tempo.**
  PeSTO-style eval + real search already plays well above club level.
- **Material (PeSTO MG/EG cp):** P 82/94 · N 337/281 · B 365/297 · R 477/512 ·
  Q 1025/936. Bishop-pair bonus.
- **Tapered eval:** interpolate MG↔EG by phase (N=1,B=1,R=2,Q=4, total 24):
  `eval = (mg·phase + eg·(24−phase)) / 24`.
- **Later (in order):** mobility → king safety → pawn structure (doubled/isolated/
  passed). Ship the minimal eval first.

### 4.9 Go-specific performance
- **Drive to 0 allocs/op** in the search hot path → GC barely runs. Verify with
  `go test -bench . -benchmem` and `go build -gcflags='-m -m'`.
- Fixed arrays (`[64]`, `[256]Move`) not slices; preallocated per-ply stacks
  (killers, move buffers, zobrist history); never `make()` inside the node loop.
- Concrete types (no interfaces) in eval/movegen/make hot loops so the inliner
  fires. Struct fields largest→smallest (kill padding; `fieldalignment`).
- `GOGC=200–400` + `GOMEMLIMIT` safety net given near-zero allocs.

### 4.10 Memory footprint (v1)

| Component | Footprint |
|---|---|
| Fancy magic attack tables | ~840 KiB |
| Knight/king/pawn tables | ~5 KiB |
| Zobrist keys | ~6 KiB |
| Per-ply search stack | ~1–2 MiB |
| **Transposition table** | 16 / **64** / 256 MiB (configurable) |
| Working set | < 1 MiB |

**Total ≈ TT budget + ~3–4 MiB.** Default 64 MiB TT → **~68 MiB**; lean 16 MiB → ~20 MiB.

### 4.11 Build order (strength-per-effort)
1. Board + magic sliders + make/unmake + **perft** (validate before anything else).
2. `uint32` move encoding + fixed `[256]Move` per-ply buffers (zero-alloc movegen).
3. Static eval: material + tapered PeSTO PSQT + tempo.
4. Negamax + αβ + iterative deepening + basic time mgmt.
5. Quiescence (MVV-LVA, stand-pat, delta pruning).
6. Move ordering (MVV-LVA → killers → history).
7. Transposition table + Zobrist (legal-ep fix, mate-score, bound semantics).
8. Null-move pruning (zugzwang-guarded).
9. Late move reductions.
10. SEE (qsearch + ordering).
11. PVS, then aspiration windows.
12. UCI/CLI + HTTP service; then iterate eval (mobility → king safety → pawn structure).

Steps 1–7 alone clear ~1800; 8–10 push past 2000.

---

## 5. Chess rules — representation (research-backed)

### 5.1 FEN (6 space-separated fields)
1. Piece placement, ranks 8→1 (`/`-separated), files a→h; `PNBRQK`/`pnbrqk`;
   digits = empty runs.
2. Side to move `w`/`b`.
3. Castling `-` or subset of `KQkq` (in that order).
4. En passant target `-` or square behind the double-pushed pawn (rank 3 or 6).
5. Halfmove clock (plies since last capture/pawn move; 50-move).
6. Fullmove number (starts 1, +1 after Black).

Start: `rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1`.

**En-passant convention (decided):** internally normalize ep to **"capturable"
semantics** (record ep only when a legal ep capture truly exists — pin/discovered-
check aware) for the **position key / repetition / draw logic**, matching FIDE's
"same position" test. May emit standard FEN on the wire, but **normalize before
hashing**.

### 5.2 Resumable game state
A single FEN is a snapshot — insufficient for repetition. Persist **current FEN**
(+ both clocks later) **plus the ordered move history** (UCI) back to at least the
last irreversible move (capture/pawn move/castling-right loss = last halfmove
reset). Go can rebuild any position from `startpos + moves` or a FEN.

### 5.3 Move notation
- **Wire + storage = UCI long algebraic**: `e2e4`, `e4d5` (no `x`), ep `e5d6`,
  promotion `e7e8q` (lowercase, no `=`), castling = king from→to `e1g1`/`e1c1`.
  Context-free, fixed-length, parseable without a generator.
- **SAN** generated only at the PGN/display layer by Go (it has the board):
  `Nf3`, `exd5`, `e8=Q`, `O-O`. Disambiguate file→rank→full square.

### 5.4 Game-end & draw rules (FIDE Laws, eff. 2023)
**Automatic** (Go ends the game, returns terminal status):
- Checkmate (win), Stalemate (draw), **Dead position** (mate impossible by any
  legal sequence), **Fivefold** repetition, **Seventy-five-move** rule.

**Claim-based** (Go reports as *claimable*; PHP surfaces to the player):
- **Threefold** repetition, **Fifty-move** rule.

**"Same position"** (for repetition) = side to move **+** identical piece
placement **+** identical castling rights **+** identical ep availability. The
**Zobrist key must encode castling rights and (legal) ep** exactly, or repetition
is wrong.

**Insufficient material / dead position** — true dead positions only:
- K vs K · K+B vs K · K+N vs K · K+B vs K+B with **bishops on the same color**.
- **NOT** automatic: K+N+N vs K, opposite-color K+B vs K+B, etc. (those draw only
  later via 75-move/fivefold).

**Timeout vs insufficient material (FIDE 6.9)** — *asymmetric*, uses an "any legal
series mates" test (not forced-mate, not the dead-position list):
- Flag while opponent has only **K / K+B / K+N** → **draw**.
- Flag while opponent has **K+N+N** → opponent **wins on time** (a helpmate
  exists). Needs a **separate** "can-opponent-mate-by-any-sequence" routine. PHP
  owns the clock that detects the flag; Go answers draw-or-loss.

### 5.5 Perft (movegen correctness gold standard)
`perft(N)` = count of strictly legal leaf nodes to depth N. Every rules bug shows
up as a wrong count; use **divide/split perft** to localize. Test positions
(verified node counts):

| Position | FEN | Depths checked |
|---|---|---|
| Initial | `rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1` | d1 20, d2 400, d3 8,902, d4 197,281, d5 4,865,609, d6 119,060,324 |
| Kiwipete | `r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1` | d1 48, d2 2,039, d3 97,862, d4 4,085,603, d5 193,690,690 |
| Position 3 | `8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1` | d1 14, d2 191, d3 2,812, d4 43,238, d5 674,624, d6 11,030,083 |
| Position 4 | `r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1` | d1 6, d2 264, d3 9,467, d4 422,333, d5 15,833,292 |
| Position 5 | `rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8` | d1 44, d2 1,486, d3 62,379, d4 2,103,487, d5 89,941,194 |
| Position 6 | `r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10` | d1 46, d2 2,079, d3 89,890, d4 3,894,594, d5 164,075,551 |

**CI gate:** all six at d1–d4 (sub-second). **Nightly:** Initial + Kiwipete d5–d6.

---

## 6. AI difficulty — levels 0–10

A single monotonic strength dial. Each level maps to a search budget + a
weakening model so low levels feel beatable without playing nonsensically.

| Dimension | Level 0 | … | Level 10 |
|---|---|---|---|
| Think budget (movetime/depth) | very short | increasing | longest (a bit longer than mid) |
| Blunder probability | small, non-zero | decreasing | 0 |
| Eval noise (random cp jitter) | highest | decreasing | 0 |
| Pruning aggressiveness | (full strength always; we weaken via the above, not by breaking search) |

Design intent (to be tuned during build):
- **Level 10** = the engine's best: deepest think time, no noise, no blunders.
- **Level 0** = short think time + a small per-move blunder chance (occasionally
  picks a clearly inferior but still *legal/plausible* move) + eval noise so it
  doesn't always find the best line.
- Levels 1–9 interpolate think time, blunder %, and noise on a smooth curve.
- Weakening is done by **adding noise / occasional sub-optimal selection**, never
  by feeding illegal moves or corrupting rules — the engine is always rules-correct.

`/bestmove` takes `limits.level` (0–10) and/or explicit `depth`/`movetime`. PHP
passes the player's chosen level.

---

## 7. PHP ↔ gomachine integration

### 7.1 Boundary decision
**Long-running, stateless Go HTTP/JSON service on localhost, FEN-in per request.**
Keeps magic tables + TT **warm** in one resident process while staying stateless;
the engine is a pure function `(FEN, limit) → result`. Rejected: subprocess-per-
request (rebuilds tables + cold TT every move) and UCI-over-pipe as the public
boundary (stateful single-conversation, forces a process pool). Upgrade to gRPC
only if JSON/HTTP-1.1 overhead is ever measured to matter.

### 7.2 Async AI moves
```
PHP (producer) → durable queue (JobTask / job_task) → worker → Go /bestmove → write back → notify (poll)
```
On a human move PHP validates+applies via Go, updates authoritative state, then
**enqueues** `{game_id, ply, fen, level}`. A worker calls `/bestmove`, writes the
reply into authoritative state, and the client picks it up on its next poll.
Jobs are **keyed by `game_id + ply`** (idempotent — a retried/crashed job can't
double-apply). Live vs correspondence = same pipeline, different priority/limits.

### 7.3 Go service API contract (all endpoints stateless, FEN-in)

```http
POST /move           # validate + apply one move
  req: { "fen": "<FEN>", "move": "e2e4", "history"?: ["<key|fen>", ...] }
  res: { "legal": true, "newFen": "<FEN>", "san": "e4",
         "status": "ongoing" | "checkmate" | "stalemate"
                  | "draw-fifty" | "draw-seventyfive"
                  | "draw-threefold-claimable" | "draw-fivefold"
                  | "draw-insufficient-material" | "draw-dead-position",
         "sideToMove": "w" | "b", "check": false,
         "claimableDraws": ["threefold","fifty"],
         "legalMoves"?: ["e2e4", ...] }
  # legal:false → { "legal": false, "reason": "leaves king in check" }

POST /legal-moves    # all legal moves, or for one square
  req: { "fen": "<FEN>", "square"?: "e2" }
  res: { "moves": ["e2e4","e2e3"], "count": 2 }

POST /bestmove       # AI move
  req: { "fen": "<FEN>", "limits": { "level"?: 5, "depth"?: 12, "movetime"?: 1000 },
         "history"?: [...] }
  res: { "bestmove": "g1f3", "san": "Nf3",
         "eval": { "type": "cp"|"mate", "value": 34 },
         "pv": ["g1f3","b8c6", ...], "depth": 12, "nodes": 1234567, "nps": 987654 }

POST /status         # adjudicate without moving (timeout, resume)
  req: { "fen": "<FEN>", "history"?: [...], "timeoutSide"?: "w" }
  res: { "status": "...", "result"?: "1-0"|"0-1"|"1/2-1/2",
         "reason": "timeout-vs-insufficient-material" | ... }

POST /perft          # debug / correctness
  req: { "fen": "<FEN>", "depth": 5, "divide"?: true }
  res: { "nodes": 193690690, "divide"?: { "a2a3": 4463267, ... } }

GET  /healthz        # liveness/readiness (tables loaded, ready to search)
```

`status` distinguishes **automatic** ends (terminal status) from **claimable**
draws (`claimableDraws` — PHP decides whether the player claimed). `timeoutSide`
triggers the FIDE 6.9 "any legal series" test.

---

## 8. Realtime multiplayer (the hub)

Human-vs-human play runs on a dedicated Go WebSocket service (`gomachine hub`,
`:6467`), separate from the stateless engine. It holds all live state **in
memory** and reuses `internal/chess` for rules.

### 8.1 Why WebSocket via Go
Live chess with clocks needs low-latency server push. Behind Cloudflare, **SSE is
unreliable** (response buffering until ~100 KB, a hard ~100 s idle timeout, and
silent regressions); WebSocket is officially supported. Go excels at concurrent
connections. So: WebSocket, with a **30 s `Ping` heartbeat** (beats the idle
drop) and **client auto-reconnect with backoff** (survives edge redeploys).

### 8.2 State & durability
The hub keeps the matchmaking pool + live games (board, clocks, move history) in
memory on a single goroutine (no locks; connections talk to it over channels).
Durable data (users, finished games, ratings) is persisted **via BaseAPI** — PHP
stays the MySQL authority. **Caveat:** resume is in-memory only — it survives tab
close / refresh / navigation / network blips, **not a hub process restart**
(restart-durable resume needs persisting live games via PHP — a later phase).

### 8.3 Identity — signed HMAC ticket
BaseAPI mints a short-lived ticket the client passes when opening the socket; the
hub verifies the signature with a shared secret (`WS_TICKET_SECRET`, must match
on both sides) — **no per-connect call to PHP**.

```
ticket = base64url(payloadJSON) . "." . base64url(HMAC-SHA256(base64url(payloadJSON)))
payload = { sub, anon, name, rating, exp }   # sub = user id, or a stable per-browser anon id
```

Anonymous players get a stable id (browser `localStorage` `chessgo.anonId` →
`GET /ws-ticket?anon=…` → ticket `sub`) so the hub can recognise them across
reconnects. **Anonymous = casual/unrated; rated requires a registered account**
(`anon=false`). Games are rated only when **both** players are accounts.

### 8.4 Matchmaking & clocks
- **Pools** keyed by time control (`"3+0"`, `"10+5"`, …); FIFO match (rating-
  proximity matching is a later refinement). Colors random.
- **Clocks are server-authoritative**: the side-to-move's time decreases from a
  per-move timestamp; on a move the mover's clock is debited + incremented. A
  200 ms ticker flags timeouts, applying the FIDE 6.9 timeout-vs-material rule.
- **Disconnect ≠ abandon**: the hub marks the player offline and keeps the game;
  the clock keeps running (so an absent player still flags). On reconnect (same
  identity) the hub reattaches and sends a full `resume`. Presence is pushed as
  `opponentGone` / `opponentBack`.

### 8.5 WebSocket protocol

```
client → hub:  { type: "queue", pool: "3+0" } | { type: "cancel" }
               { type: "move", move: "e2e4" }  | { type: "resign" }

hub → client:  hello   { name, anon, rating }
               queued  { pool }              | idle
               matched { gameId, color, rated, pool, fen, timeControl,
                         clock:{w,b}, opponent:{name,rating,anon}, legalMoves }
               state   { gameId, fen, sideToMove, lastMove, san, status, check,
                         clock:{w,b}, ply, legalMoves }
               resume  { …matched fields…, moves:[{uci,san}], opponentOnline }
               end     { gameId, result, reason, status, clock }
               opponentGone | opponentBack | error { message }
```

Frontend: a singleton WS store (`src/lib/socket.ts`, via `useSyncExternalStore`)
survives navigation; the lobby queues and routes to `/game/:id` on `matched`; the
homepage shows a "resume" banner whenever an unfinished game exists.

---

## 9. Repository layout

```
chessgo/
  app/            # BaseAPI PHP: Models, Controllers, Services, Providers, Auth
                  #   BotGame model; GomachineClient, BotGameService, WsTicketService
                  #   Controllers: BotGame, BotMove, Analyze, WsTicket, …
  routes/         # api.php
  config/         # app.php, i18n.php
  storage/        # migrations.json, logs, cache
  gomachine/      # Go module …/gomachine — engine + hub + CLI (one binary)
    cmd/gomachine/      # subcommands: serve, hub, uci, bestmove, perft, play,
                        #   selfplay, verifyticket
    internal/chess/     # rules core: bitboards, magic sliders, mailbox, FEN,
                        #   Zobrist, movegen, make/unmake, SAN, material/draw, perft
    internal/eval/      # material + tapered PeSTO PSQT + tempo
    internal/search/    # negamax, αβ, ID, quiescence, ordering, TT, null-move, LMR
    internal/engine/    # orchestration: level 0–10 mapping, status adjudication
    internal/server/    # stateless engine HTTP/JSON handlers (the §7.3 contract)
    internal/hub/       # realtime: matchmaking, live games, clocks, WS protocol
    internal/auth/      # HMAC ticket verification (shared secret)
    internal/uci/       # UCI protocol loop (for chess GUIs / test tools)
    Makefile            # build, test, perft, cross-compile (CGO_ENABLED=0)
  frontend/       # React + Vite + TS + MUI + Bun
    src/pages/          # Home (lobby), BotGame (/bot), LiveGame (/game/:id)
    src/components/      # Board, EvalBar, Clock, MoveList, Layout, GameModeCard
    src/lib/            # socket (WS store), chess (FEN/board helpers), sounds
    src/api/            # client (REST + ws-ticket)
    public/piece/cburnett/   # SVG piece set (Lichess cburnett, GPL)
  docs/           # SPEC.md (this file), COMMANDS.md (run/deploy)
  CLAUDE.md       # codebase orientation for Claude Code
```

---

## 10. Roadmap

- [x] **gomachine engine** — perft-verified rules, search, eval, CLI, HTTP service.
- [x] **Bot games** — BaseAPI `BotGame` + level 0–10, frontend `/bot`, eval bar.
- [x] **Lobby** — quick-pairing grid, action buttons, optimistic presentation.
- [x] **Live multiplayer (queue)** — Go hub, WebSocket, server clocks, ticket auth,
      reconnect/resume + presence, frontend live game view.
- [x] **Persistence + Elo + accounts** — `game` table + per-category `User`
      ratings; hub persists finished games via `POST /internal/games` (secret-gated)
      and applies provisional-K Elo for rated games; frontend signup/login (session
      cookies), header user menu with per-category ratings, rated/casual badge.
- [ ] **Hub-restart durability** — persist live games so resume survives a restart.
- [ ] **More lobby features** — Challenge-a-friend (private link), Custom games,
      correspondence; rating-proximity matchmaking.
- [ ] **Polish** — premoves, draw offers, takebacks, PGN export, profiles,
      spectating, richer eval terms / opening book.

---

## 11. Sources (research)

**Engine:** CPW — Bitboards, Magic Bitboards, BMI2, Encoding Moves, Move
Generation, Copy-Make, Alpha-Beta, Null Move Pruning, Late Move Reductions,
Quiescence Search, Transposition Table, Zobrist Hashing, Move Ordering, MVV-LVA,
Tapered Eval, PeSTO's & Simplified Evaluation; Analog Hors "Magical Bitboards";
Go engines blunder / CounterGo / Zurichess; Go `math/bits` (no Pext/Pdep), Go GC
Guide, Dave Cheney "Go compiler intrinsics"; Kaufman material imbalances.

**Rules/integration:** FIDE Laws of Chess (2023); CPW — FEN, Repetitions, Perft
& Perft Results, UCI, Algebraic Notation; X-FEN (Wikipedia); AWS gRPC-vs-REST.

> Key correctness invariants to never violate: (1) normalize ep to "capturable"
> before hashing; (2) Zobrist key includes castling + legal-ep per FIDE 9.2.3;
> (3) threefold & fifty-move are *claimable*, fivefold & seventy-five-move are
> *automatic*; (4) the timeout K+N+N case is a **win on time**, needing a separate
> "any-legal-series mate" test; (5) keep the Go boundary stateless (FEN-in) so
> tables + TT stay warm, PHP as source of truth.
