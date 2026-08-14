# CLAUDE.md — zugzwang

**zugzwang** is the chessgo platform's **primary chess engine**: a strong C++17
NNUE engine (rules + search + eval) that serves standard chess, three variants,
and Stockfish proxying to the whole website. It replaced gomachine's engine as
the AI. It initially beat gomachine **+24.6 Elo on the same net**; search
improvements since the cutover have widened that to **~200 Elo**
(**~3500 CCRL**). gomachine's
engine is now a deletable legacy reference (see `../gomachine/CLAUDE.md`).

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
- `./zugzwang ratingtest <curve|probe|gauntlet>` — bot-ladder calibration
  (see §Bot strength ladder).

`main.cpp` dispatches: `serve` → `serve_main`, `zhperft` → `zh_perft_main`,
`ratingtest` → `ratingtest_main`, else → `uci_main`.

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
- **Antichess** (`src/antichess.{h,cpp}`): `POST /antichess/{legal-moves,move,bestmove,analyze-game}` — own rules/eval + its own real iterative-deepening negamax.

**Secret Queen** (`src/secretqueen.{h,cpp}` + `src/secretqueen_bot.{h,cpp}`):
`POST /secretqueen/{designate,legal-moves,move,bestmove}`. Two things make it
unlike the four above, both deliberate:

- **It DOES lease a `Search::Context`.** Its board is an ordinary chess board (a
  hidden queen is a pawn on it), so the bot reuses the real NNUE search instead
  of a hand eval — it searches the position with its OWN hidden queen swapped to
  a queen and the opponent's left as a pawn, which is exactly its information
  set. `secretqueen_bot.h` explains why standard chess search models a variant
  with no check almost exactly, and documents the concealment veto.
- **It is the only HIDDEN-INFORMATION variant, so responses are per-viewer.**
  Every handler returns the canonical `newFen` (which names BOTH secrets)
  alongside `fenWhite`, `fenBlack` and `boardFen`. Callers forward one view per
  recipient and never the canonical one. Redaction lives here, in the engine that
  owns the rules, so there is exactly one implementation of it.

Rules gate: `make secretqueen_test && ./test/secretqueen_test` — cross-checks
movegen AND apply against Duck's independent implementation of the same
no-check/king-capture ruleset out to perft(4), then asserts the hidden-queen
rules Duck cannot see. Net-free (stubs the accumulator), so it runs without
`net.nnue`. Integration gate: `python3 test/secretqueen_selfplay.py [games]`
against a running `serve` — bot-vs-bot games asserting the redaction and
reveal invariants on every ply. Design + rules: `../docs/tasks/open/secret-queen.md`.

The eval `{type,value}` object is converted to gomachine's shape so response
schemas match the old engine.

**A tablebase verdict is not an evaluation, and the JSON says so.** A Syzygy win
is `VALUE_TB_WIN` = 31497 internally, and every consumer divides cp by 100 — so a
won 5-man ending rendered as "+314.97" on the eval bar while the engine shuffled.
`eval_json`/`eval_json_parts` (`src/serve_json.h`) emit
`{"type":"cp","value":±1000,"tb":"win"|"loss"}` instead: `type` and `value` stay
valid for a client that predates `tb` (there is a shipped iOS build in the wild),
`tb` carries the truth, and 1000 is the frontend eval bar's existing ±1000 clamp.
The same normalization is applied to the Stockfish proxy, whose UCI reports a
verdict as `cp 20000 - plies`. **UCI output is deliberately untouched** — CCRL and
external GUIs expect the large cp there, exactly as SF prints it. Gate:
`./test/tb_eval_wire.sh` (no eval from any endpoint may carry `|cp| >= 31000`).
PHP mirrors the band in `App\Services\EngineEval`, the browser in
`frontend/src/lib/engineEval.ts`, iOS in `ios/chessgo/Models/EngineEval.swift`.

**A CURSED win reports 0.00, not the band value.** `reported_score`
(`src/search.cpp`) substitutes the root's `tbScore` for the search's own number
on a DTZ-ranked root, and `tbScore` is three different kinds of number: in the
certain bands (`±VALUE_TB_WIN`) and the draw band it is the position's true
rule50-aware value, but in the cursed-win / blessed-loss band it is SF's 1..49cp
"keep pressing" *ordering incentive* (`tbprobe.cpp:1669`), and under the 50-move
rule a cursed win is a draw. Reporting the incentive printed −47 above a PV that
walked into the 50-move draw, so `TB::RootRank::cursed` marks that band and it
reports `VALUE_DRAW` instead. `tbRank` — the ordering, which is what keeps the
attacker pressing and the defender holding — is untouched in every band.
Reporting the *search's* number there instead is not an option: a DTZ-ranked root
zeroes `C.tbCardinality`, so inside it the search has no tablebase knowledge at
all (measured −109/−64 across two runs of the same dead-drawn position, and +696
on a drawn KQvKR). Gate: assertion (e) of `./test/tb_eval_wire.sh`, whose cursed
cases are generated from `tools/tbdefend` at clock `101 − dtz`.

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

**Retrain-free accumulator NPS levers (2026-07, all byte-identical, env kill-switches):**
`LAZYACC`/`LAZYACC2` (deferred-apply, default-on), `THREATGATE` (same-mirror bucket-cross keeps
threats on the delta path, default-on, +1.9%), `THREATDELTA_SF` (SF18 touch-only-D delta,
default-on, +2.82%), `APPLYPREFETCH` (prefetch next FT column, **amd64-default-on** / arm64-off,
+1.44%), `Finny` (base-refresh cache, **arm64-default-on** / amd64-off, arch-gated like `ACCFUSE`).
~+6% amd64 NPS combined. Authoritative profile: `docs/PROFILING/amd/24Jul2026.md`; campaign +
verdicts: `docs/tasks/open/pretrain-posttrain-campaign.md`. The dominant `apply_diff` threat-
column bandwidth (19.3%) is the remaining prize — needs **int8-QAT (August retrain)**.

## Bot strength ladder (`src/rating.cpp`, `src/weakening.cpp`)

Every below-full-strength bot on the site — the `/bot` picker, hub matchmaking
backfill, Watch fillers, arena bots, UCI `UCI_Elo` — passes ONE target rating and
the **engine** decides how to play at that strength. No caller does strength math.

- **Ranking.** `Rating::root_scores` scores every legal move with a *single
  MultiPV search* at a rating-scaled `rankDepth` (1..8). MultiPV is required, not
  an optimisation: selection compares moves in centipawns, which is only
  meaningful if every move comes from the same completed iteration. An explicit
  `depth`/`movetime` from the caller (Watch fillers pass 8 / 250ms) is a **cost
  cap** — it can only make the ranking shallower, never stronger than the rating.
- **Selection.** `Weakening::pick` drops any move losing more than `capCp`
  outright (absolute, the "no free queen" guarantee) and samples the rest from
  `exp(−(cpLoss/windowCp)^consistency)`.
- **One curve, shared.** `Weakening::curve_for_rating` is the single ladder;
  standard chess, Duck, Crazyhouse and Antichess all read it. Each engine used to
  clone the formula, which is how one defect lived in four places.
- **Selection is centipawn-based on purpose.** It previously measured error as a
  *win-probability* gap, which saturates: past ~1200cp of advantage every legal
  move mapped to within 1e-4 of the best, so the cap and the softmax became
  no-ops together and bots played uniformly random moves (a "2488" ignoring a
  free rook for six moves, then hanging a bishop). The collapse was symmetric, so
  endgames — usually decided — showed **zero** rating separation. Retunes could
  never fix it: the coefficients multiplied a quantity that was already ~0.
  `weakening.h` carries the full post-mortem. **Do not reintroduce win-prob
  selection**, and keep the severity cap absolute.
- **No phase/endgame scaling.** A previous revision widened the window ×3 and the
  cap ×2 and cut 3 ply in endgames; it only deepened the collapse. See the note
  in `rating.cpp`.
- **A Syzygy-ranked root selects on DTZ, not on the reported score.** Reporting
  and ranking want different numbers there: `reported_score` collapses every
  certain win onto one `VALUE_TB_WIN` (right — a verdict is one number), which
  made `pick`'s cpLoss exactly 0 for every winning move, so the cap filtered
  nothing and the softmax sampled them uniformly *at every rung*. That is the
  saturation failure above in a second place, and it was live: conversion of a
  won ≤5-man ending measured 0.33/0.27/0.34/0.28/0.37/0.38 across ratings
  800…2800 (n=120 each) — flat. `Search::Line` now carries `tbRank/tbDtz/
  tbCursed` out of the search and `tb_selection_score` (`rating.cpp`) turns them
  into a selection cp: a band step of 5000cp (certain win > cursed > draw >
  blessed loss > certain loss — larger than any rung's cap, so no bot may ever
  trade a band) plus **25cp per wasted DTZ ply** inside it, clamped to ±3000.
  DTZ plies are the unit because the thing that loses a won ending is not
  choosing a losing move — the band makes that impossible — it is spending the
  halfmove clock: a move Δ plies off the DTZ optimum costs exactly Δ of a ~100-ply
  budget (traced at rating 2000: every move a genuine TB_WIN, `rule50+dtz`
  climbing 46→48→50→…→100). A real mate the search found overrides all of it.
  Same numbers after: 0.29/0.39/0.48/0.52/0.88/0.98.

**A third gate — `./test/tb_rating.sh` — is mandatory alongside `probe`/`gauntlet`
after touching `rating.cpp` or `weakening.cpp`.** It plays won ≤5-man endings with
White = `/bestmove` + `limits.rating` and Black = `tools/tbdefend` (perfect DTZ
defence), and asserts the top rung converts, the curve rises with rating, and —
the one that catches this class of bug — that the curve is **not flat**. A weak
rung failing to convert is expected and allowed; a ladder where every rung
converts the same is the defect.

**Test it — `./zugzwang ratingtest`:**

| mode | what it measures |
|---|---|
| `curve` | prints rating → (rankDepth, window, cap, consistency) |
| `probe` | avg centipawn loss per move **bucketed by how decided the position is**, plus worst single giveaway and blunder rate. ~13s. The regression test for the saturation bug — a suite of balanced positions would have called the broken model flawless. |
| `gauntlet` | round-robin self-play between rungs; every rung must beat every weaker rung. ~4min at `-games 20`. |

Both take `-threads N`; `probe` takes `-samples N -truth-depth D`, `gauntlet`
takes `-games N -max-plies P`. Both run with the Watch filler's cost caps.
Re-run both after touching either file — a ladder can look right per-move and
still fail to separate in games, and vice versa.

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
