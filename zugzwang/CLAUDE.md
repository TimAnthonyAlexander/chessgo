# CLAUDE.md — zugzwang

**zugzwang** is the chessgo platform's **primary chess engine**: a strong C++17
NNUE engine (rules + search + eval) that serves standard chess, three variants,
and Stockfish proxying to the whole website. It replaced gomachine's engine as
the AI (it beat gomachine **+24.6 Elo on the same net**); gomachine's engine is
now a deletable legacy reference (see `../gomachine/CLAUDE.md`).

This doc is engine-internals orientation. The engine backlog lives in
`../docs/tasks/`.

## Cross-reference Stockfish 18 before implementing (`~/sf18-arm`)

`~/sf18-arm` is the **official Stockfish 18 release** — HEAD == tag `sf_18` ==
commit `cb3d4ee`, verified byte-identical to `git fetch origin sf_18` from
official-stockfish/Stockfish. It is **NOT an experimental fork and NOT a feature
branch** — it is shipped, production Stockfish. (SF 18 postdates the assistant's
knowledge cutoff, so **verify any "SF does/doesn't have X" claim against this tree
with git + grep, never from memory** — a subagent once fabricated an "experimental
fork" framing that a `git remote`/`git describe` check immediately disproved.)

**Before implementing any search/eval technique SF might already have** (a pruning
rule, an extension, an NNUE feature/accumulator trick, a movepick heuristic), spawn
a subagent to read `~/sf18-arm/src` and report exactly how SF does it — file:line,
constants, edge cases — then port against that ground truth. Two examples already in
play: SF18 ships **move-aware full-threats NNUE deltas** (`FullThreats`, same
79,856-dim threat space as our `ThreatBlock` — reference for
`docs/tasks/open/threat-delta.md`), and the SF-selectivity search stack was ported
this way. Cross-check, don't guess — a "washed" SF technique usually means OUR port
has a bug, not that the technique is bad.

## Build

```sh
cd zugzwang && make            # arch-detected native build → ./zugzwang
make perft                     # standalone perft binary → ./perft_test
make ASSERT=1                  # + incremental-accumulator bit-exactness check (slow, gate only)
make clean
```

`Makefile` auto-detects arch: `-mcpu=native` on Apple Silicon (arm64),
`-march=native` on x86_64. Flags: `-std=c++17 -O3 -flto -DNDEBUG -pthread`.
Prod (amd64, coalla/lairner) builds native-SIMD via direct `g++` with
**`-ffp-contract=off`** (required to match Go's scalar float order → bit-exact
eval): `g++ -std=c++17 -O3 -flto -DNDEBUG -march=native -ffp-contract=off
-pthread -o zugzwang src/*.cpp`. `ASSERT=1`
compiles `-DNNUE_ASSERT`: every in-search eval rebuilds the accumulator halves
from scratch and aborts on any int16 drift — use only for validation, it's slow.

## Run

`./zugzwang` with no args speaks **UCI** on stdin/stdout (SPRTs, fastchess,
Engine-vs-Engine all rely on this). Subcommands:

- `./zugzwang serve [-addr host:port] [-search-pool N] [-tt MB]` — the HTTP
  engine API for the website. Default `-addr 127.0.0.1:6476`. Dev alias:
  `chessgo-zugzwang`.
- `./zugzwang zhperft <fen> <depth> [divide]` — standalone Crazyhouse perft.

`main.cpp` dispatches: `serve` → `serve_main`, `zhperft` → `zh_perft_main`,
else → `uci_main`.

## HTTP serve mode (`src/serve.cpp`, `src/serve_handlers.cpp`)

Stateless `(FEN, limit) → result`, mirroring gomachine's old internal engine API
so PHP/hub wiring is a drop-in swap. httplib server; every search-backed route is
`wrap()`-ed (converts panics to 500, mirrors gomachine's `recoverPanics`).

Standard chess:
| Route | Purpose |
|---|---|
| `GET /healthz` | liveness |
| `POST /move` | apply a move, return new position |
| `POST /legal-moves` | legal moves for a FEN |
| `POST /status` | game status (checkmate/draw/etc.) |
| `POST /perft` | perft node count |
| `POST /bestmove` | search → best move + eval |
| `POST /candidates` | multi-move analysis (eval bar, arrows) |
| `POST /analyze-game` | whole-game review |
| `POST /sf-bestmove` | Stockfish proxy (`src/sf_uci.cpp` drives a real SF UCI process) — the site's Stockfish is now decoupled through zugzwang, not a separate service |

Variants (self-contained modules, no `Search::Context` pool involvement):
- **Duck** (`src/duck.{h,cpp}`): `POST /duck/{legal-moves,move,bestmove,analyze-game}` — own rules/hand-eval/search.
- **Crazyhouse** (`src/crazyhouse.{h,cpp}`): `POST /crazyhouse/{legal-moves,move,bestmove}` — own rules/pockets/drops + pocket-aware hand eval (NOT the shared NNUE).

The eval `{type,value}` object is converted to gomachine's shape so response
schemas match the old engine.

### Concurrent search-context pool

`serve` runs N independent `Search::Context`s (default `min(hardware_concurrency, 6)`;
`-search-pool N` overrides). Everything a search mutates — TT, history/killer/
countermove/corrhist/continuation-history tables, LMR reduction table, node
counter + stop flag, the incremental NNUE accumulator stack, and the tunable
margins — lives in a `Context`. Two searches with **different** Contexts run fully
concurrently with zero shared mutable state; the only shared thing is the
read-only NNUE net weights. `-tt` total is split evenly across the pool (floor
8 MB/context). The UCI path uses `default_context()` (single search at a time,
bound to the global `TT`), so UCI/bench/golden behavior is byte-identical to
pre-pool. Each search-backed HTTP handler leases a pool Context.

## Search (`src/search.cpp`, `src/search.h`)

PVS negamax + alpha-beta, iterative deepening, aspiration windows, over the
**NNUE eval**. The accepted feature stack (defaults baked 2026-07-14, `Tune`
struct): LMP, SEE-filtered quiets + captures, futility + soft RFP, razoring,
null-move pruning, LMR, correction history, singular/negative extensions, IIR,
PV-guard (`!PvNode` on the LMP/futility/SEE-quiet/capture-SEE block, PARITY_GOMACHINE
D.0), gomachine's tuned structural constants (D.1), qsearch futility (`qsFutMargin=300`),
and **continuation history** (D.2, parent/grandparent-keyed). Margin bundle 2
(`nmpCutGate`, `lmrDepthPrune`) is default-off, SPRT independently.

**SF-selectivity stack (2026-07-14 campaign, +16.8 Elo movetime vs pre-campaign;
`docs/tasks/done/sf18-selectivity-gap.md`):** cheap TT-only ProbCut, depth−=2
after an alpha-raising PV move, `cutoffCnt`→LMR bump, **hindsight** priorReduction
depth adjust, **ttPv** (former-PV bit in `TTEntry.genBound`, gates RFP + de-reduces
LMR), and a conservative **double singular extension** (the biggest single win,
unlocked by ttPv). Env kill-switches (`PROBCUT/DEPTHDROP/CUTOFFCNT/HINDSIGHT/TTPV/
DBLEXT=0`). Default-OFF opt-ins kept: `TTCAPR`/`MCLINR` (LMR drag), `EVALHIST`/
`THREATORDER` (ordering — saturated), `TRIPLEEXT` (untested). CCRL-scale result in
`docs/CCRL.md`. Next lever: SPSA re-tune (`docs/tasks/open/spsa-margin-polish.md`).

**8 SPSA-tunable margins** (UCI `setoption`, clamped): `RfpMargin`,
`RazorMargin`, `FutBase`, `FutSlope`, `SeeQuietCoeff`, `CaptSeeCoeff`,
`NmpEvalDiv`, `SingularMargin`. Re-SPSA periodically — hand-set constants go
stale as the engine evolves.

## NNUE (`src/nnue_*.{h,cpp}`)

Perspective-relative net loaded from `net.nnue` (symlink →
`../gomachine/data/nnue/kb-mirror.bin`, the ~180 MB prod full-threats net:
H=512 FT, 16 king-buckets, 79,856 Stockfish full-threats, pairwise 16→32 tail,
NB=8, int16 threat FT). `serve` calls `NNUE::load("net.nnue")` at startup (cwd-
relative); **absent → falls back to HCE** (`src/eval.cpp`, a hand-crafted eval).
Incremental int16 accumulator with native SIMD; `ASSERT=1` bit-checks it.
**Move-aware threat delta (default-on, +43 Elo movetime, 2026-07-15):** `do_move`
snapshots the pre-move board and `AccStack::push_delta` (`nnue_accumulator.cpp`)
folds a move in by diffing only the changed base+threat edges (`changed_edges_delta`,
`nnue_features.cpp`) instead of re-enumerating every node's full threat set — same
`apply_diff` machinery, byte-identical eval. `THREATDELTA=0` is the parity/debug
kill-switch back to the full-enumerate `push()`. Details: `docs/tasks/done/threat-delta.md`.

## Rules / movegen

`src/{position,movegen,bitboard,rules,zobrist}.cpp` — magic-bitboard movegen,
make/unmake, Zobrist, FEN, draw rules. Chess960 castling is generalized in the
core movegen (castling by rook-square, not fixed files). Perft-gated
(`make perft`, `zhperft` for Crazyhouse) and a **golden-eval gate**
(`test/golden_check.sh`: 38 FENs diffed against frozen stm-relative cp, tol 5).

## How it's wired to the site

- **PHP** (`../app/`): `ZugzwangClient` (bound to `:6476`) is composed by
  `EngineSelector` as the **primary, no-fallback** engine — standard chess,
  Duck, Crazyhouse, and Stockfish all route to zugzwang. `ENGINE_PRIMARY=gomachine`
  (or `engine.primary` config) flips back to gomachine with zero code change;
  `gomachineOnly` machinery is retained but unused.
- **Hub** (`../gomachine/internal/hub`): calls zugzwang's `/bestmove` for bot
  moves. A `-emergency-inproc` in-process gomachine fallback still exists (slated
  for removal with the gomachine engine).

See `../gomachine/engine/docs/WIRING_RECON.md` for the full cutover map and
`../gomachine/engine/docs/{PARITY_GOMACHINE,SF_MARGINS,OPTIMIZATIONS}.md` for the
campaign record. Engine backlog: `../docs/tasks/open/`.
