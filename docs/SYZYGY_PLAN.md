# Syzygy Tablebase — context & status

## What this project is

`gomachine` — a Go chess engine (**≈3260 "dirty" CCRL Blitz**: NNUE v6 + SIMD, default
eval; two-NNUE-anchor agreement 2026-06-29, ENGINE_STRENGTH.md §15 — ≈2882 on the older
SF-UCI_Elo scale). Engine core in
`internal/{chess,eval,search,engine}`. Strength improvements go behind a
`search.Params` flag (default off), then SPRT-gated via `gomachine bench sprt`.
See `docs/ENGINE_STRENGTH.md` for the full picture.

## Status: SHIPPED — SPRT-accepted, default ON (2026-06-20)

**SPRT result** (`bench sprt --new "tb=on" --old "tb=off" --tb-path <5-piece> \
--movetime 100 --elo0 0 --elo1 6`, pentanomial GSPRT): **accepted H1, +18.8 ±
11.1 Elo @ 100ms/move** over 109 pairs in 50s — pentanomial `[0 0 97 12 0]`, i.e.
**zero lost pairs** (the TB side never lost a game pair; the one-directional signal
is why it converged so fast). Stockfish anchor with `tb=on`: **≈2782 ± 84** (100
games vs SF-2500, 83.5%), consistent with the ~2720 pre-TB band (the anchor's
noise exceeds the +19, so the SPRT is the real figure). `UseTablebase` is now the
default in `search.DefaultParams` — **inert until a tablebase is attached**
(`Engine.SetTablebase`), so the prod serve/hub paths are still no-ops until
`--tb-path` is plumbed in + files shipped.

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

## Where the tables live

**`gomachine/data/syzygy/`** — in-repo, next to the committed opening book
(`gomachine/data/book.bin`), but **gitignored** (`gomachine/.gitignore` has
`data/syzygy/`) because the set is ~939 MB. In-repo (not `~/`) is deliberate: the
files share the repo's ownership + gitignore and sit with the engine's other data
assets, and the path is cwd-relative (the working dir is `gomachine/` in both the
dev screen and the systemd unit, exactly like `data/book.bin`), so it auto-loads
with no env/flag/deploy change.

## Download the tables (dev AND prod — same command)

The full 5-piece set is ~939 MB (145 WDL + 145 DTZ files). Idempotent, curl-only
(re-run to resume). Run it **from the repo root** on each box:

```sh
mkdir -p gomachine/data/syzygy && cd gomachine/data/syzygy
for d in 3-4-5-wdl 3-4-5-dtz; do
  base="https://tablebase.lichess.ovh/tables/standard/$d"
  curl -fsS "$base/" | grep -oE 'href="[^"]+\.rtb[wz]"' | sed -E 's/href="(.+)"/\1/' \
    | xargs -P 16 -I{} sh -c '[ -s "{}" ] || curl -fsS --retry 5 -o "{}" "'"$base"'/{}"'
done
```

(`-P 16` parallelizes — the download is latency-bound, so fan-out is a big speedup.)
On **prod**: `cd /var/www/chessgo && ` the same, then restart the services. The
files land at `/var/www/chessgo/gomachine/data/syzygy/`, owned by the deploy user.

## Prod auto-load (DONE — no deploy change)

`serve` and `hub` **auto-discover** a tablebase at startup via
`loadTablebaseDefault` — no flag, env, or systemd change needed. It tries, in
order: `SYZYGY_PATH` (env override) then `data/syzygy` (cwd-relative, in-repo, next
to `data/book.bin`). First that opens wins; none → silent no-op. The tablebase is
attached to every pooled engine (`Server.SetTablebase` / `Hub.SetTablebase`), and
`NewWithThreads` enables probing, so **full-strength bot moves + `/analyze` probe
it** (weakened bots stay at their level — only the no-noise branch probes).
Verified: a rating-2400 `/bestmove` on a KQvK win returns `nodes:0` (instant hit),
loading from `data/syzygy` with no env/flag.

Prod: after the files are in `gomachine/data/syzygy/` (download command above),
just restart `chessgo-engine` + `chessgo-hub` — the cwd-relative path resolves the
same as the book, no `$HOME` or unit change involved.

### Probe misses — investigated, current approach is the right one

The root probe uses Fathom's simple `tb_probe_root`, which returns FAILED for some
positions (the DTZ table is stored from the other side). The obvious idea — switch
to **`tb_probe_root_dtz`** ("check from the other side": rank every root move by
probing the resulting positions) — was tried and **reverted**. Why: `tb_probe_root_dtz`'s
`tbRank` is a **filter for a search**, not a standalone move-picker. It **caps at
1000** for every "comfortably winning" move (`dtz + cnt50 ≤ 99`), and `tbScore` is
derived from the capped rank, so the true DTZ distance among winning moves is not
exposed. Picking max-rank directly made the **winning** side shuffle among tied
rank-1000 moves and **draw a won KBN-vs-K by fivefold repetition** (caught in
`TestTablebaseMatesKBNvK` — a thrown win). Stockfish avoids this by using the rank
only to *restrict* the root move list, then letting its search choose among them.

Key insight from this: the simple `tb_probe_root` reliably hits the side that
**matters** — the *winning* side (which needs the exact DTZ move to converge) — and
returns the true DTZ-optimal move there. Its misses fall mostly on the *losing*
side, where the move can't change the outcome, and the search fallback handles
those **safely** (search, unlike max-rank, won't shuffle a win into a repetition).
So the validated simple-probe + search-fallback is both correct and already
captures the Elo (the +18.8 was measured with it). A fully-correct *instant* picker
for the miss case is possible (re-probe each child for the true DTZ and rank), but
it's real complexity + edge cases for marginal Elo (losing-side move quality), and
must not regress the thrown-win safety. Left as-is deliberately.

## What NOT to do

- Don't add endgame positions from the puzzle DB to the opening book — puzzle
  positions are unique per-game, hit rate in actual play is ~zero.
- Don't disable `DECOMP64` or chase alignment/file-corruption theories for a probe
  crash — see the legality gotcha above; it's the position, not the decoder.
