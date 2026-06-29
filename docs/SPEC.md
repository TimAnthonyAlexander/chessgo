# chessgo — Project Specification

> Living spec for the chessgo platform: a website to play chess against other
> humans (competitive matchmaking) and against an AI, with all chess rules and
> the AI implemented in a dedicated Go engine. This document captures the
> product decisions, the architecture, and the research that informs both.
>
> **Status:** v1 in progress. **Last updated:** 2026-06-20.
> Built & working: the Go engine (`gomachine`, perft-verified, **~2880-class** vs
> handicapped Stockfish after the SPRT-gated search, Lazy-SMP, Texel eval **and
> NNUE v6 (512-wide) + SIMD, now the default eval** — see `docs/ENGINE_STRENGTH.md`), bot
> games + eval bar + takeback, the lobby, **live human-vs-human play**
> (WebSocket hub, rating-proximity matchmaking, server clocks, reconnect/resume),
> **bot backfill** (a fill-in bot when no human is found), **accounts**
> (signup/login via session cookies), **per-time-control Glicko-2 ratings**,
> **game persistence** (hub → BaseAPI), **public profiles + game history**,
> **Watch/spectating** (with engine-vs-engine lobby fillers), a full **analysis
> board** (variation tree + per-ply blunder/mistake judgments), a **board/position
> editor**, **right-click arrow/square annotations**, **premoves**, and
> **puzzles** (Lichess-seeded tactics on an isolated rating).
> Live lobby counts at `/stats`. See `docs/COMMANDS.md` to run it, `CLAUDE.md` for
> a fast codebase orientation.

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
| **Ratings** | **Glicko-2, per time-control category** (bullet/blitz/rapid/classical) | For rated games (both accounts). Each category carries rating + RD (uncertainty) + volatility; start 1500/RD 350. RD sets step size (fresh ≈ ±175, settled ≈ ±6), drops as you play, regrows when idle; provisional while RD > 110. Finished games persisted by the hub via `POST /internal/games`; the update applied there. See `docs/ELO_SYSTEM.md`. |
| **Clocks** | **Real server-authoritative clocks** | Bullet/Blitz/Rapid; the hub ticks clocks and flags, applying the FIDE 6.9 timeout-vs-material rule. _Supersedes the earlier "untimed first" call (the lobby commits to timed presets)._ |
| **AI difficulty** | **Levels 0–10** | See §6. Level 10 = max strength + slightly longer thinking; level 0 = short thinking + small blunder probability. Monotonic strength curve. |
| **Database** | **MySQL** | Local dev user `chessgo`@`localhost`. |
| **Cross-platform** | Ubuntu (deploy) + macOS (dev/deploy) | `gomachine` is **pure Go, no cgo** → cross-compiles cleanly. |

### Open / deferred (default = my best judgment, revisit anytime)

These were invited as free-form preferences and are not yet pinned. Current
working defaults:

- **Design vibe:** dark-first, lichess-like clean/minimal board (green or
  neutral wood theme, switchable). Refine later.
- **v1 game features:** resign, move list, board flip, legal-move dots,
  last-move highlight, **premoves** (queue a move during the opponent's turn),
  **right-click arrow/square annotations**, **spectating**, a full **analysis
  board**, and a **board editor** all shipped, plus live-game **draw offers,
  takebacks, and players-only chat** (§8.7) and bot-game **takeback**. **PGN
  export** is deferred.
- **vs-AI UX:** pick **strength by rating** (700–2720, mapped to engine level via
  `levelForRating`) + color before game; eval bar shipped.
- **Matchmaking:** single ranked pool by Elo proximity (wait-widening bracket);
  rematch flow + cross-pool seek graph deferred.
- **Profiles:** **shipped** — public profile by name (`/@/:name`), per-category
  ratings + W/L/D record + paginated game history. PGN export + avatars deferred.
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
                     ▼                  POST /internal/games → BaseAPI (persist + Elo)
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
| Bot-game orchestration, analyze + game-analysis, `/stats` & `/watch` proxies | **Live game state, matchmaking, server clocks (hub)** |
| Per-category Glicko-2 (`Glicko2Service`) + game records | Reconnect/resume + presence (hub, in-memory) |
| Account sessions (cookies), `/internal/games` results sink | Bot backfill (engine-driven fill-in opponent) |
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

> Full research synthesis with sources in §13. This section is the design we'll build.

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

> **Implemented & SPRT-measured:** all of the below, plus **SEE-ordered captures,
> delta pruning, reverse futility pruning, late move pruning, Lazy SMP**
> (multithreading via a lock-free TT), and a later wave of **correction history,
> singular extensions, and frontier futility**. See `docs/ENGINE_STRENGTH.md` §3–4
> for the per-feature Elo and the lock-free TT design, and §13 for the corrhist/
> singular/futility wave (and the cheap long tail that SPRT'd flat on this
> already-pruned baseline). The list here is the original design order.

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

> **Bot-game UI selects by rating, not raw level (shipped).** The `/bot` page and
> the `BotGame` model now store a target **`rating`** (≈700–2720); PHP maps it to
> an engine level via `levelForRating` (the same mapping the hub's rating-matched
> backfill uses). The 0–10 dial above is still the engine's internal contract — the
> rating UI is a thin layer over it, so bot and fill-in opponents advertise a
> coherent strength. (The `POST /bot-games` route comment still says `level: 0..10`
> — stale; the field is `rating`.)

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
(`anon=false`). A human-vs-human game is rated only when **both** players are
accounts; a fill-in bot game is rated (one-sided) when the human is an account.
The ticket carries the account's **per-category ratings** so the hub can show the
opponent's rating in the game's time-control category.

### 8.4 Matchmaking & clocks
- **Pools** keyed by time control (`"3+0"`, `"10+5"`, …). **Rating-proximity
  match**: paired only when both players' category ratings are within an
  acceptable gap that starts tight (`baseRatingGap` 100) and widens with wait time
  (`+ratingGapPerSec`/s) up to a hard ceiling (`maxRatingGap` 400) — so close
  matches form instantly, near matches after a short wait, and wildly mismatched
  players (e.g. 800 vs 2400) never pair as humans (they get a bot instead). The
  widening is re-checked each tick (`matchWaiting`); both sides must consent
  (gap ≤ each player's current tolerance). Anonymous/unrated players are treated
  as 1500 for matching. Colors random.
- **Bot backfill**: if a player waits past a delay (default **15 s**) with no
  human, the hub pairs them with an engine-driven bot that looks like a normal
  player. The bot is **Elo-matched to the human**: displayed rating wobbles ±120
  around the human's category rating (clamped to 600–2600) and the engine level is
  derived from it (`levelForRating`), so the bot plays at roughly the strength it
  advertises (anonymous humans fall back to `-bot-level`). Human-like move pacing.
  Two close humans still match instantly, so only a lone (or unmatched) waiter is
  backfilled. Toggled by hub flags
  (`-bots`, `-bot-level`, `-bot-delay`). Bot search runs off the hub goroutine
  (engine pool) and is applied back via a channel. A bot game is **rated for a
  logged-in human** (one-sided Elo vs the bot's displayed rating); anonymous →
  casual. Explicitly chosen `/bot` games go through BaseAPI, never the hub, so
  they never affect Elo.
- **Clocks are server-authoritative**: the side-to-move's time decreases from a
  per-move timestamp; on a move the mover's clock is debited + incremented. A
  200 ms ticker flags timeouts, applying the FIDE 6.9 timeout-vs-material rule.
- **Lichess-style clock start**: neither clock runs until that side has made its
  first move — the clock is live only once **both** opening moves are played
  (2 plies); both first moves are untimed. A stalled opening ply is handled by a
  **30 s first-move abort** (`firstMoveTimeout`), which ends the game with no
  result (`reason: "aborted"`, not persisted), not by the clock. `finish()`
  snapshots both clocks **before** marking the game over, so a flagged side
  correctly reads 0.
- **Disconnect ≠ abandon**: the hub marks the player offline and keeps the game;
  the clock keeps running (so an absent player still flags). On reconnect (same
  identity) the hub reattaches and sends a full `resume`. Presence is pushed as
  `opponentGone` / `opponentBack`.

### 8.5 WebSocket protocol

```
client → hub:  { type: "queue", pool: "3+0" } | { type: "cancel" }
               { type: "move", move: "e2e4" }  | { type: "resign" }
               { type: "drawOffer" } | { type: "drawAccept" } | { type: "drawDecline" }
               { type: "takebackOffer" } | { type: "takebackAccept" } | { type: "takebackDecline" }
               { type: "chat", text }
               { type: "watch", gameId }       | { type: "unwatch" }   # spectator

hub → client:  hello   { name, anon, rating }
               queued  { pool }              | idle
               matched { gameId, color, rated, pool, fen, timeControl,
                         clock:{w,b}, opponent:{name,rating,anon}, legalMoves }
               state   { gameId, fen, sideToMove, lastMove, san, status, check,
                         clock:{w,b}, ply, legalMoves }
               resume  { …matched fields…, moves:[{uci,san}], opponentOnline }
               end     { gameId, result, reason, status, clock }   # reason "aborted" → result null
               opponentGone | opponentBack | error { message }
               drawOffered { by } | drawDeclined        # players-only; accept → end (reason "agreement")
               takebackOffered { by } | takebackDeclined  # players-only; accept → state (rolled-back ply)
               chat { by, name, text }                  # players-only relay (incl. echo to sender)
               watching { gameId, players, fen, clock, moves, lastMove, ply, status }  # spectator snapshot
               watchEnd                                                                 # game gone/over
```

`opponent.rating` in `matched`/`resume` is the opponent's rating **in that game's
time-control category** (the ticket carries all four; the hub picks by pool).
Separately, the hub exposes `GET /stats → { playersOnline, activeGames }` (live
counts via atomics), proxied by BaseAPI's `GET /stats` for the homepage.

Frontend: a singleton WS store (`src/lib/socket.ts`, via `useSyncExternalStore`)
survives navigation; the lobby queues and routes to `/game/:id` on `matched`; the
homepage shows a "resume" banner whenever an unfinished game exists. A second
singleton store (`src/lib/auth.ts`) holds the session/user (session-cookie auth);
sounds (`src/lib/sounds.ts`) are gesture-unlocked Web Audio. A board-interaction
controller (`src/lib/useBoardInteraction.ts`) is the single home for the local
player's move lifecycle — optimistic board overlay, move sound, submit, and the
**premove** queue (capture during the opponent's turn, then on your turn replay it
if it's legal in the new position, else discard) — behind a small `BoardControl`
contract `{ fen, myTurn, legalMoves, submit, canPremove }`. Each board page (live,
bot) feeds it that contract and renders its output onto `<Board>`, so
board-interaction features are written once rather than per page.

### 8.6 Watch / spectating (shipped)

Read-only spectating of live games, separate from the playing socket.

- **Browse:** the hub exposes `GET /games` — a top-N lobby snapshot (`lobbyMax` 5,
  pre-marshaled, sorted real-games-first then by combined rating). BaseAPI proxies
  it as `GET /watch`. The frontend `/watch` page (`pages/Watch.tsx`) polls it and
  renders each game as a `MiniBoard` preview. Each poll also stamps the hub's
  "someone is watching" signal (`WatchPing`, `watchWindow` 12 s).
- **Spectate one game:** clicking a preview opens `/watch/:id` (`pages/Spectate.tsx`)
  on a **dedicated** read-only socket (`lib/spectate.ts`, `?spectate=1`, distinct
  from `lib/socket.ts` so it never clobbers your own game). It sends `watch {gameId}`
  and receives a full `watching` snapshot, then live `state`/`end` fan-out; `unwatch`
  (or socket close) detaches. A spectator holds no seat — `move`/`resign` are ignored
  — and is not counted as online. Each `game` carries a `spectators` set the hub
  broadcasts to alongside the players.
- **Engine-vs-engine fillers (`filler.go`):** to keep the Watch lobby populated, the
  hub runs just-in-time self-play games on a **dedicated** small engine pool (so they
  can't starve human bot-fill), padding up to `-watch-target` (5) **and only while
  someone is watching** (`watchersActive()`). They're `filler:true`: **never
  persisted, never Elo'd** (`finish()` gates on `filler`, not `rated`), created with
  `rated:true` purely for display, and their bot-ness is never sent to the client.
  In-flight fillers always finish naturally; replenishment stops once watchers leave.
  They DO count toward `activeGames`. CLI: `-watch-fillers`, `-watch-target`,
  `-watch-filler-workers`.

### 8.7 Draw offers, takebacks & in-game chat (shipped)

Three human-vs-human niceties on the live game, all mutated on the hub goroutine
and **private to the two players** (spectators never see them; chat is players-only).

- **Draw offers:** `drawOffer` records a pending offer (`drawBy` color) and relays
  `drawOffered {by}` to the opponent. `drawAccept` ends the game `1/2-1/2`
  reason **`agreement`** (normal `end` flow); `drawDecline` (from either side —
  decline or withdraw) clears it and relays `drawDeclined`. Offering into a
  standing opposite offer is an accept. **Any committed move auto-declines a
  pending offer** (Lichess convention) — handled in `game.applyMove`.
- **Takebacks:** `takebackOffer` → `takebackOffered {by}`; on `takebackAccept` the
  hub **rolls the game back to the requester's most recent turn** (1–2 plies) by
  `rebuildTo` — reconstructing the position + repetition history from `startFen`
  and replaying the kept moves — then broadcasts a normal `state` (the client
  truncates its move list when `ply` drops). Clocks are left as-is (consensual)
  with the turn timer restarted. A bot reply is rescheduled if the rolled-back
  turn is a bot's.
- **Chat:** `chat {text}` is sanitized (control chars stripped, trimmed, capped at
  `maxChatLen` 280 runes) and relayed as `chat {by, name, text}` to **both**
  players (echo to sender included, so one event feeds every bubble). Rendered as
  React text (auto-escaped).
- **Vs a fill-in bot (by design):** the bot side has no client, so offers/chat are
  simply **never answered** — the bot ignores them and keeps playing, and the
  frontend never learns the opponent is a bot (buttons always show). A pending
  offer is cleared when the bot's next move lands. On a player **disconnect** any
  pending offer is dropped so the remaining player isn't stuck.

Frontend: the socket store (`lib/socket.ts`) tracks `messages`, `drawOffer` and
`takebackOffer` (`'mine' | 'theirs' | null`) and exposes `offerDraw`/`respondDraw`/
`cancelDraw` (+ takeback equivalents) and `sendChat`. `LiveGame.tsx` renders the
Draw/Takeback/Resign buttons + incoming-offer banners and a `ChatPanel` (left
column). Chat is carried across a same-game reconnect; offers reset.

---

## 9. Puzzles (training)

Lichess-style tactical training on a **separate, isolated rating**. Solving
puzzles never touches the bullet/blitz/rapid/classical ratings — `rating_puzzle`
is a fifth category that happens not to be a time control.

### 9.1 Decisions (locked)
- **Source:** seed from the **Lichess open puzzle database (CC0)** — millions of
  pre-rated, pre-tagged puzzles, zero engine compute. A gomachine game-mining
  generator is a later phase; per the research we **avoid synthetic/random mate
  generation** (low realism) in favour of mining real games.
- **Rating:** puzzle ratings are **fixed** (Lichess values treated as ground
  truth); only the solver's `rating_puzzle` moves, via the shared `Glicko2Service`
  (one-game Glicko-2, RD-scaled step) against the puzzle's rating as a fixed,
  established "opponent". **No time component, no hints** (Lichess-pure).
- **v1 scope:** rated training stream + theme filter (incl. mate-in-N). Daily
  puzzle, Puzzle Rush, and alternate-mate acceptance are deferred.
- **Access:** anonymous solvers play casually (unrated); rating requires an
  account. The solution line is **never sent to the client** — moves are
  validated server-side by index.

### 9.2 Data model (BaseAPI, singular snake_case)
- **`puzzle`** — `ext_id` (Lichess id, plain index), `fen`, `moves` (TEXT JSON
  solution line), `rating` (indexed), `rating_deviation`, `popularity`,
  `nb_plays`, `themes` (TEXT JSON), `game_url`. JSON via the array-cast-footgun
  pattern (TEXT + manual `json_encode/decode`), mirroring `BotGame`.
- **`puzzle_theme`** — denormalized `(puzzle_id, theme, rating)` with a composite
  **(theme, rating)** index, so theme-filtered serving is an index range scan,
  not a JSON `LIKE`. Unique `(puzzle_id, theme)` for idempotent import.
- **`puzzle_attempt`** — unique `(user_id, puzzle_id)`, `solved`,
  `rating_before/after`. One (first) rated attempt per puzzle; drives both
  de-duplication and rating idempotency. Anonymous solvers are not recorded.
- **`user`** gains the isolated puzzle triple `rating_puzzle` (1500) /
  `rd_puzzle` (350) / `vol_puzzle` (0.06) + `rated_at_puzzle` + `games_puzzle` (0).

> **Case-sensitivity gotcha (don't break):** Lichess PuzzleIds are
> **case-sensitive** (`0QCaI` ≠ `0qcai`) but MySQL's default collation is **not**,
> and BaseAPI only sets collation at the table level. So `ext_id` must **never**
> be a unique or join key — distinct ids would collide, dropping puzzles on import
> and bleeding themes across them. All internal links use the puzzle's **UUID `id`**
> (lowercase hex → collision-free), which the importer derives **deterministically
> from `ext_id` (UUIDv5)** so distinct ids get distinct keys and re-import stays
> idempotent. The served/solved puzzle id is the UUID, not `ext_id`.

### 9.3 Solution convention
Lichess convention: `puzzle.fen` is the position **before** the opponent's setup
move; `moves[0]` is that move (auto-played), then the line alternates. The player
answers the **odd indices**. "White to move, mate in 3" is just a theme filter
(`mateIn3`) over this same model.

### 9.4 Endpoints (optional session, like `/ws-ticket`)
- **`GET /puzzles/next?theme=`** — picks an unseen puzzle near the solver's
  rating via a **random rating pivot + indexed range scan** (never
  `ORDER BY RAND()`, which is O(n) at millions of rows), widening the window
  until something unseen turns up. Auto-applies the opponent move and returns
  `{id, rating, start_fen, opponent_move, fen, color, legal_moves, ply}` —
  **solution withheld**.
- **`POST /puzzles/{id}/move`** — `{move, fen, ply}`. Validates the move against
  the stored line **by index** (the solution stays on the server). Correct +
  more → returns the scripted reply + next legal moves; correct + done → solved;
  wrong → reveals the remaining solution. On a terminal event a logged-in
  solver's `rating_puzzle` updates **once** (idempotent on the attempt record).

The engine is used only to compute display FENs + legal moves per ply (as it
already does for every board); correctness itself is a string-index compare
against the hidden line — so puzzles add **no chess logic to PHP**.

### 9.5 Seeding
The Lichess CSV is large and **not committed**. `scripts/import_puzzles.php` (a
standalone bootstrap script — BaseAPI has no app-command mechanism) bulk-
`INSERT IGNORE`s in batches and is re-run safe (filters: `--limit`,
`--min/max-rating`, `--min-popularity`, `--themes`). See `docs/COMMANDS.md`.

### 9.6 Frontend
`/puzzles` (`pages/Puzzles.tsx`) reuses the controlled `Board`: it animates the
opponent's setup move, validates each player move server-side, and reveals the
puzzle rating + rating delta + themes on completion. A theme `Select` filters by
type; the header user menu shows `rating_puzzle` as a separate row.

---

## 10. Analysis, profiles & board tools

A cluster of shipped, mostly client-driven features. The division of labour is the
same everywhere: **`chess.js` (client) owns legality/SAN/FEN, the Go engine owns
evaluation only** — PHP gains no new chess logic.

### 10.1 Analysis board (`/analysis`, `/analysis/:id`)
A full analysis surface (`pages/Analysis.tsx`):
- **Eval bar + engine lines** via `POST /analyze` (`AnalyzeController` → `GomachineClient`):
  a stateless full-strength `(FEN, movetime?) → {eval, bestmove, pv, depth}`.
- **Branching variation tree** (`components/MoveTree.tsx`, `lib/analysisTree.ts`):
  selectable nodes, indented inline sub-lines, per-move **judgments**
  (`best | good | inaccuracy | mistake | blunder`). The tree is a pure client
  structure; the engine only scores positions.
- **Replay / flip / import:** board flip, ply navigation, copy-FEN, "Paste FEN…",
  and a **Chess960** randomize (`components/AnalysisAside.tsx`), plus "Edit this
  board" / "Play vs bot" hand-offs.
- **Saved-game analysis (`/analysis/:id`):** loads `GET /games/{id}/analysis`
  (`GameAnalysisController` + `GameAnalysisService`) — a **cached, per-ply**
  full-game pass (White-relative evals, best move, centipawn-loss → blunder/mistake
  tags) computed once per `Game` and reused.

### 10.2 Board / position editor (`/editor`)
`pages/Editor.tsx` + `components/BoardEditor.tsx` + `lib/fenEdit.ts` (pure,
immutable FEN edits — `START_FEN`/`EMPTY_FEN`/place/move, `chess.js` only for final
validation). Stamp/erase pieces with a brush, drag to move, right-click to clear a
square; emits FENs to copy, analyze, or launch a bot game from.

### 10.3 Profiles & game history (`/@/:name`)
`pages/Profile.tsx` over two read endpoints:
- **`GET /users/{name}`** (`ProfileController`) — public profile **by display
  name**: per-category Glicko-2 ratings (bullet/blitz/rapid/classical + puzzle),
  W/L/D record, and the first page of games. Never exposes email/password.
- **`GET /users/{name}/games?offset=`** (`ProfileGamesController`) — paginated
  history ("load more"); each row carries outcome + rating-before/after swing.

Backed by the `Game` model (the same records the hub persists via
`POST /internal/games`). **PGN export is still not implemented** anywhere —
interchange is FEN-only.

### 10.4 Right-click annotations
`components/Board.tsx`: Lichess-style **arrows** (right-click drag) and **square-ring
highlights** (right-click in place), with modifier keys varying the colour. Cleared
on left-click and on any position change. Separately, a single programmatic
best-move `arrow` prop is used by the analysis/eval surfaces. Annotations are
**client-only** — no hub/protocol or backend involvement.

### 10.5 Admin engine-vs-engine (`/admin/engine-vs`)
`pages/EngineVsEngine.tsx` + `POST /admin/engine-vs/move` (`EngineMatchController`,
admin-role-gated): two engines auto-play one ply at a time with a speed slider,
pause/step, eval bar, and sound — an internal strength/behaviour inspection tool.

---

## 11. Repository layout

```
chessgo/
  app/            # BaseAPI PHP: Models, Controllers, Services, Providers, Auth
                  #   Models: User (per-category + puzzle ratings), BotGame, Game,
                  #             Puzzle, PuzzleAttempt, PuzzleTheme, ApiToken
                  #   Services: GomachineClient, BotGameService, GameAnalysisService,
                  #             WsTicketService, HubClient (stats/watch proxy),
                  #             Glicko2Service (categories + ratings)
                  #   Controllers: BotGame, BotMove, BotUndo, Analyze, GameAnalysis,
                  #             Game, WsTicket, Stats, Watch, Profile, ProfileGames,
                  #             Puzzle, EngineMatch (admin), GameResult (/internal/games),
                  #             Login/Signup/Logout/Me, ApiToken
  routes/         # api.php
  config/         # app.php, i18n.php
  storage/        # migrations.json, logs, cache
  gomachine/      # Go module …/gomachine — engine + hub + CLI (one binary)
    cmd/gomachine/      # subcommands: serve, hub, uci, bestmove, perft, play,
                        #   selfplay, verifyticket, bench, tune, loadtest, engineload
    internal/chess/     # rules core: bitboards, magic sliders, mailbox, FEN,
                        #   Zobrist, movegen, make/unmake, SAN, material/draw, perft
    internal/eval/      # material + tapered PeSTO PSQT + tempo + tuned_tables.go (on)
    internal/search/    # negamax, αβ, ID, quiescence, ordering, TT (lock-free, Lazy
                        #   SMP), null-move, LMR, SEE, delta/RFP/LMP, aspiration
    internal/tune/      # Texel tuner (joint Adam on WDL; tunes the PSQT itself)
    internal/engine/    # orchestration: level 0–10 mapping, status adjudication
    internal/server/    # stateless engine HTTP/JSON handlers (§7.3) + /analyze-game
    internal/hub/       # realtime: matchmaking, live games, clocks, WS protocol,
                        #   /stats, persistence POST (hub.go), bot backfill (bot.go),
                        #   spectating (spectate.go), engine-vs-engine fillers (filler.go)
    internal/auth/      # HMAC ticket verification; Identity carries per-cat ratings
    internal/uci/       # UCI protocol loop (for chess GUIs / test tools)
    Makefile            # build, test, perft, cross-compile (CGO_ENABLED=0)
  frontend/       # React + Vite + TS + MUI + Bun
    src/pages/          # Home (lobby), BotGame (/bot), LiveGame (/game/:id),
                        #   Watch + Spectate (/watch, /watch/:id), Analysis
                        #   (/analysis[/:id]), Editor (/editor), Profile (/@/:name),
                        #   Puzzles (/puzzles), EngineVsEngine (/admin/engine-vs)
    src/components/      # Board (+ arrows/annotations), BoardEditor, EvalBar, Clock,
                        #   MoveList, MoveTree, AnalysisAside, MiniBoard, Layout,
                        #   AuthDialog, PanelUI, LiveModeCard, GameModeCard, Logo
    src/lib/            # socket (WS store), spectate (read-only WS store), auth
                        #   (session/user store), sounds (gesture-unlocked Web Audio),
                        #   chess (FEN/board helpers), fenEdit (editor), analysisTree
                        #   (variation tree + judgments), useBoardInteraction
                        #   (optimistic moves + premoves controller)
    src/api/            # client (REST + ws-ticket + auth; credentials: 'include')
    public/piece/cburnett/   # SVG piece set (Lichess cburnett, GPL)
  docs/           # SPEC.md (this file), COMMANDS.md (run/deploy)
  CLAUDE.md       # codebase orientation for Claude Code
```

---

## 12. Roadmap

- [x] **gomachine engine** — perft-verified rules, search, eval, CLI, HTTP service.
- [x] **Bot games** — BaseAPI `BotGame` + frontend `/bot`, eval bar, **takeback**
      (`/bot-games/{id}/undo`). Strength picked **by rating** (mapped to engine level
      via `levelForRating`); the engine's 0–10 dial is the internal contract (§6).
- [x] **Lobby** — quick-pairing grid, action buttons, optimistic presentation.
- [x] **Live multiplayer (queue)** — Go hub, WebSocket, server clocks, ticket auth,
      reconnect/resume + presence, frontend live game view. Lichess-style clock
      start (untimed first moves) + 30 s first-move abort.
- [x] **Bot backfill** — fill-in engine opponent when no human is found in ~15 s;
      random identity, human-like pacing; rated (one-sided) for logged-in players.
- [x] **Persistence + ratings + accounts** — `game` table + per-category `User`
      Glicko-2 (rating/RD/volatility); hub persists finished games via `POST
      /internal/games` (secret-gated) and applies the update for rated games;
      frontend signup/login (session cookies), header user menu with per-category
      ratings (provisional "?"), rated/casual badge.
- [x] **Live lobby counts** — hub `/stats` (atomics) proxied by BaseAPI `/stats`;
      homepage shows real counts + optional smooth `STATS_PADDING` filler.
- [x] **Puzzles (training)** — Lichess-seeded tactical trainer on an **isolated**
      puzzle rating (§9); `puzzle`/`puzzle_theme`/`puzzle_attempt` tables + CSV
      importer; rating-matched + de-duped serving, theme filter (incl. mate-in-N),
      server-side index validation with the solution withheld; `/puzzles` page.
- [ ] **Puzzle generation pipeline** — mine real games with gomachine (blunder
      detection + uniqueness check) to grow the set beyond the Lichess seed; plus
      alternate-mate acceptance, Daily puzzle, Puzzle Rush.
- [ ] **Hub-restart durability** — persist live games so resume survives a restart.
- [x] **Engine strength harness + first wave of improvements** — see
      **`docs/ENGINE_STRENGTH.md`** for the full writeup. Native in-process self-play
      **SPRT** (`gomachine bench sprt`, `internal/bench`): two `search.Params` configs
      of the same binary play game pairs (reversed colors, shared opening), arbitrated
      by our perft-verified rules + `Adjudicate` — no UCI/subprocess, fixed-nodes
      reproducible, pentanomial GSPRT. Plus an absolute-Elo Stockfish anchor
      (`bench vs-stockfish`), a single-game viewer (`bench game`), and a Texel tuner
      (`gomachine tune`, game-result + Stockfish-distillation targets).
      **Shipped (SPRT-gated, ~+250 Elo @ movetime, now defaults):** SEE (+66),
      delta pruning (+22), aspiration windows (+22), reverse futility pruning (+67),
      late move pruning (+95). **Lazy SMP** (lock-free atomic TT; +97 Elo @ 4
      threads) — **live in prod** at the balanced 2-thread setting (`serve
      -search-threads 2`, `hub -bot-search-threads 2`) on the shared 4-core box.
      **The Texel-tuned eval is now ON by default** (tuned PSQT + knowledge terms,
      `internal/eval/tuned_tables.go`): **+128 Elo @ fixed nodes, +101 Elo @ 100 ms/
      move**, SPRT-gated. This *replaced* the earlier −148 Elo result, which was a
      broken **method** (coordinate descent on MSE, distilled CP target, frozen PSQT),
      not a verdict on HCE — the rebuilt tuner (joint Adam on WDL, **tuning the PSQT
      itself**, quiet Lichess positions; `internal/tune`) wins. Then **Syzygy 5-piece
      tablebases** (+18.8 @ movetime) and an **endgame push** (WDL-in-search +32.7,
      KingProx +30.5, PawnRace +17.4 — all default-on, SPRT-gated). Then **NNUE
      replaced HCE as the default eval**: a `(768→256)×2→1` SCReLU net (bullet on the
      M3's Metal GPU, ~40 GB SF data), made movetime-viable by an incremental int16
      accumulator — **+212 Elo @ movetime** (v4) — then **v6 (512-wide) + AVX2/NEON
      SIMD**, **+124 @ fixed nodes / +101 @ movetime** over v4, live in prod. Then a
      **search-feature wave** (§13): **correction history +66.9**, **singular extensions
      +22.2**, **frontier futility +21.3** (@ 40k nodes, all default-on; bundle owes a
      movetime re-anchor) — and a rejected cheap long tail (conthist/IIR/capthist/probcut/
      razor flat-or-negative; aggressive-LMR-on-singular −67 anti-synergy), which is why
      the cheap-search-patch well is now mostly dry on this baseline. Current
      strength **~2880-class** — **anchored ≈2882** (band 2847–2935 vs SF-2700/2800/2900,
      30 games @ 100ms, 2026-06-22). Next: NNUE width → **1024** (cheap behind SIMD),
      reworked-selective versions of the rejected search patches, **SPSA**.
- [x] **Match bot strength to its rating** — fill-in bot displayed rating is now
      anchored to the human's Elo (±120) and the engine level is derived from it
      (`levelForRating`), so rated bot games are fair. Remaining: precise
      level↔Elo *calibration* (the mapping is currently a monotonic heuristic).
- [x] **Rating-proximity matchmaking** — human pairing now matches within a
      wait-widening Elo bracket (100→400 cap), never pairing wildly mismatched
      players. Remaining: a true cross-pool ranked queue / seek graph.
- [x] **Watch / spectating** — read-only spectating (§8.6): hub `GET /games`
      snapshot proxied as BaseAPI `GET /watch`, `/watch` mini-board grid +
      `/watch/:id` on a dedicated spectate socket (`watch`/`unwatch` → `watching`
      fan-out); plus **engine-vs-engine fillers** that pad the lobby only while
      watched (never persisted/Elo'd).
- [x] **Analysis board** — `/analysis` (+ `/analysis/:id`): eval bar via `POST
      /analyze`, branching variation tree with per-move judgments, replay/flip/FEN
      import + Chess960 (§10.1); cached per-ply **full-game analysis** (`GET
      /games/{id}/analysis`, `GameAnalysisService`) with blunder/mistake tags.
- [x] **Board editor + annotations** — `/editor` position editor (§10.2) and
      Lichess-style **right-click arrows / square highlights** on the board (§10.4),
      both client-only.
- [x] **Profiles + game history** — public `/@/:name` profile by display name
      (§10.3): per-category ratings + W/L/D record + paginated history
      (`GET /users/{name}` + `/users/{name}/games`). PGN export still TODO.
- [x] **Challenge a friend (private games)** — the lobby's "Challenge a friend"
      card opens a dialog to create a private invite (time control incl. **custom**
      base+inc, color preference W/B/random, rated toggle gated on being logged in)
      or **join by 6-char code**. The hub holds the invite in-memory keyed by an
      unambiguous code (`internal/hub/challenge.go`), pairs exactly the two players
      with `startGameWith` (no rating bracket — any gap is fine), and is rated only
      if the creator asked AND both sides are accounts. Share via copyable
      code **or** link (`/challenge/:code` → `ChallengeJoin` page). Ephemeral like
      the queue: a creator disconnect or a 30-min TTL drops it. Protocol:
      `createChallenge`/`joinChallenge`/`cancelChallenge` →
      `challengeCreated`/`challengeExpired`/`matched`.
- [ ] **More lobby features** — Custom games beyond private invites,
      correspondence; **PGN export** (history is shipped, PGN is not).
- [x] **Premoves** — queue a move during the opponent's turn; the shared board
      controller (`src/lib/useBoardInteraction.ts`) holds it across the opponent's
      reply, then validates it against the next legal-move list and either plays it
      (optimistic + sound + submit) or discards it. Live + bot games; pseudo-legal
      premove targets (`premoveTargets` in `src/lib/chess.ts`), auto-queen promotion.
- [x] **Live-game social** — **draw offers** (accept → draw by agreement),
      **takebacks** (consensual position rollback to the requester's turn), and
      **players-only chat** (§8.7). Hub-side, spectator-private; offers vs a
      fill-in bot go unanswered by design (the client never learns it's a bot).
- [ ] **Polish** — richer eval terms / opening book; draw-offer rate-limiting.

---

## 13. Sources (research)

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
