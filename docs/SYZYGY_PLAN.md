# Syzygy Tablebase — context & status

## What this project is

`gomachine` — a Go chess engine (~2720 Elo vs SF-2500 anchor). Engine core in
`internal/{chess,eval,search,engine}`. Strength improvements go behind a
`search.Params` flag (default off), then SPRT-gated via `gomachine bench sprt`.
See `docs/ENGINE_STRENGTH.md` for the full picture.

## Status: IMPLEMENTED (default off), ready to SPRT

Syzygy probing is wired end-to-end behind `search.Params.UseTablebase` (default
off). What's done:

- **`internal/syzygy/`** — CGo wrapper around **Fathom** (`tbprobe.c`/`tbprobe.h`,
  the reference probing library used by Stockfish/LC0; vendored pristine from
  jdart1/Fathom master). `tbchess.c` is renamed to `tbchess.h` because `tbprobe.c`
  `#include`s it textually — that keeps cgo from compiling it as a second
  translation unit (duplicate symbols). The Go API: `Open(path)`, `Close()`,
  `MaxPieces()`, `ProbeRoot(Position) (Result, bool)`. All Fathom calls are
  serialized by a package mutex (its root/DTZ probing is **not** thread-safe and
  the SPRT harness runs games concurrently).
- **`syzygy_stub.go`** (`//go:build !cgo`) mirrors the API so `CGO_ENABLED=0`
  builds (e.g. `make cross` portable artifacts) still compile — tablebase support
  is just inert there. The default native build (dev + prod, both have a C
  compiler) compiles the real cgo path, so **the deploy process is unchanged**.
- **Engine hook** (`internal/engine/tablebase.go`) — `SetTablebase()` + a root
  probe at the top of `PlayThreads`/`SearchDirect`, same pattern as the opening
  book. A hit returns the DTZ-optimal move at zero search cost (`Nodes==0`
  marks it). Guards: ≤`MaxPieces` pieces, no castling rights, and **`pos.Legal()`**
  (see the gotcha below). WDL→score: win/loss → ±20000, draw/cursed/blessed → 0.
- **Params + bench** — `tb=on|off` in `ParseParams`/`DiffParams`; `--tb-path`
  wired into both `bench sprt` and `bench vs-stockfish`; the tablebase is attached
  to every bench engine like the book. A missing/empty path is a warning, not
  fatal (so `tb=on` is then inert).
- **Tests** (`internal/engine/tablebase_test.go`) — pure decode unit tests always
  run; integration tests gated on `SYZYGY_TEST_PATH` (a Syzygy dir). They verify
  win/loss scores for both sides and play out a full **KBN-vs-K mate** driven by
  the engine with the tablebase on.

### The probing model (root-only)

Probe `tb_probe_root` (DTZ) at the search root only — not at every node. Gets the
big cases (K+B+N vs K, K+Q vs K+R, wrong-bishop fortresses) for ~80% of the value
at a fraction of the complexity. On a probe miss the engine just searches.

## Critical gotcha discovered (read before debugging a "crash")

**Fathom assumes LEGAL positions.** Its capture-resolution generates captures of
the enemy king for an illegal position (the side *not* to move in check), then
probes a king-less position → `lsb(0)` → assert at `-O0`, **SIGBUS** with
`-DNDEBUG`. This looks exactly like a table-decode/alignment bug and will send you
down a long rabbit hole (it did here). It is **not** a Fathom bug, not a file
corruption, not an arch/alignment issue, not a clang miscompile. The fix is the
`pos.Legal()` guard in `tablebaseMove` — real game positions are always legal, so
this only ever fires on a malformed caller. (`tb_probe_root`, what the engine
calls, returns FAILED rather than crashing on illegal input anyway; the crash was
only ever reproducible via a direct `tb_probe_wdl` probe of an illegal position.)

Also note: `tb_probe_root` (DTZ) **legitimately returns FAILED for some positions**
(it needs the opposite side's table perspective) — most often on the *losing*
side. The engine falls back to search there; that's expected, not a bug. So a test
must not assert "every winning move is a TB hit," only the outcome.

## Next steps

1. **Download the 5-piece set** (~938 MB WDL+DTZ) to a dir, e.g. `~/syzygy/3-4-5`.
   (Smoke-tested here against the 3-4-5 subset KQvK/KRvK/KPvK/KBNvK from
   tablebase.lichess.ovh.)
2. **SPRT** (the honest gate — use `--movetime`, the gain is real-time, invisible
   at fixed nodes):
   ```sh
   gomachine bench sprt --new "tb=on" --old "tb=off" --tb-path ~/syzygy/3-4-5 \
     --movetime 100 --elo0 0 --elo1 6
   ```
   Expect a real but modest gain (**~+15–30 Elo @ 100ms**) over **many** pairs
   (≤5-piece positions hit less often than the search patches did, so it converges
   slowly).
3. **Anchor** vs Stockfish (NOTE: our SF runs WITHOUT `SyzygyPath`, so this
   *overstates* the gain — an opponent with its own tablebases wouldn't give up
   these endings; report the SPRT as the real number):
   ```sh
   gomachine bench vs-stockfish --sf-elo 2500 --movetime 100 --games 100 \
     --tb-path ~/syzygy/3-4-5
   ```
4. If H1: flip `UseTablebase` default on in `DefaultParams`, then wire `--tb-path`
   into the prod `serve`/hub bot paths (same remaining-step as Lazy SMP) and ship
   the table files to the box.

## What NOT to do

- Don't add endgame positions from the puzzle DB to the opening book — puzzle
  positions are unique per-game, hit rate in actual play is ~zero.
- Don't disable `DECOMP64` or chase alignment/file-corruption theories for a probe
  crash — see the legality gotcha above; it's the position, not the decoder.
