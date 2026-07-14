# Task: eliminate computeDelta's duplicated DoMove (needs a search.go change)

**Status:** DEFERRED from the NNUE eval-delta perf pass (2026-07-12). Target 1
(appendAttackerEdges per-perspective geometry merge) shipped byte-identical.
Target 2 (this) could NOT be done inside `internal/nnue/` alone — it requires a
`search.go` change, which was off-limits during that pass (concurrent edit).

## The redundancy

For every evaluated node the accumulator delta path does a **second** make-move:

- `internal/nnue/enriched_delta.go:255-257` — `computeDelta` does
  `child := *pos; var u chess.Undo; child.DoMove(m, &u)` purely to obtain the
  child *board* (`newOcc`, `child.PieceOn`, `child.PieceBB`, `child.AttackersTo`).
  (`buildSlotFrom` and `buildSlotRefreshSplit` also each do their own
  `child := *pos; child.DoMove` for the king-refresh path — same duplication.)
- Immediately after the push, **search** does its OWN make-move on the same move:
  every `s.accPush(pos, m)` call site in `internal/search/search.go` is directly
  followed by `pos.DoMove(m, &u)` (search.go:1001/1003, 1077/1079, 1155/1157,
  1562/1564, 1691/1693, 1774/1776, 1830/1832, 2019/2021, 2161/2163, 2261/2263,
  2486/2488, 2916/2926 — ~12 sites, all funnelled through `s.accPush`,
  search.go:528).

So each node pays **two** `*Position` struct copies (~272 B each) + two
make-moves, when one child board would serve both.

## Why it can't be fixed inside internal/nnue/

`computeDelta` needs, from the child board:

1. `child.Occupied()` and `child.PieceBB(p)` — for `newOcc` and the changed-square
   set `D`. These ARE cheaply derivable from `pos + m` (occupancy delta is usually
   `(1<<from)|(1<<to)`, plus rook squares for castling, plus the ep-captured square).
2. `child.PieceOn(s)` for arbitrary squares `s` — attacker squares AND victim
   squares span the whole board (any occupied square a slider reaches), not just
   `D`. Outside `D` the child board equals `pos`, so this is *derivable*
   (`s∈D ? knownNewPiece(s) : pos.PieceOn(s)`).
3. **`child.AttackersTo(s, newOcc)`** (enriched_delta.go:304) — the blocker. It
   reads `pos.pieces[...]` (all 12 piece bitboards) through magic-bitboard slider
   probes (`internal/chess/see.go:17 attackersTo`). To compute it we need the
   child's 12 piece bitboards behind a real `*chess.Position`, because
   `attackersTo` is an **unexported method over unexported fields**. Package `nnue`
   cannot construct or mutate a `Position`'s `pieces/occupied/board`, and
   re-implementing `attackersTo` in `nnue` would duplicate chess rules (magic
   tables, `pawnAttacks`, etc.) — a hard project invariant violation ("engine owns
   rules").

So the only exported way for `nnue` to obtain a child `*chess.Position` is
`copy + DoMove`. There is no lighter board-only apply, and no field access. Hence
the fix must live where the child already exists: **search**.

## The fix (search.go — do this without the collision)

The child board search needs already exists one line below every push: search
mutates `pos` in place into the child via `pos.DoMove(m, &u)`. Reorder so the
**push consumes that child** instead of rebuilding it.

Two viable shapes:

### Option A — push AFTER DoMove, pass both boards (preferred)
Change `EnrichedStack.Push` (and the internal `buildSlotFrom` / `computeDelta` /
`buildSlotRefreshSplit`) to accept the **already-made child** alongside the
pre-move `pos` and `m`:

```
// before:  accPush(pos, m); pos.DoMove(m, &u)
// after:   pos.DoMove(m, &u); accPush(preMovePos, child, m)
```

- Problem: after `pos.DoMove`, `pos` IS the child — the pre-move board is gone.
  computeDelta reads BOTH (old edges from `pos`, new edges from `child`). So the
  caller must retain a pre-move snapshot. That reintroduces a copy — no win.

### Option B — keep push BEFORE DoMove, but make search hand its scratch child in (preferred, real win)
computeDelta already builds `child := *pos` and returns nothing about it. Instead:

1. Give `Searcher` a reusable `var child chess.Position` scratch (or reuse the
   `u chess.Undo` pattern with an explicit child).
2. At each site do `child = *pos; child.DoMove(m, &u2)` ONCE, then
   `s.accPush(pos, &child, m)`, then `pos.DoMove(m, &u)` — **no**, still two moves.

The genuine dedup is: **search does the make-move once, into `pos`, and the push
reads the OLD board from a cheap pre-move snapshot the push itself owns.** But
computeDelta's old-board reads (`pos.PieceOn(op)`, `pos.AttackersTo(s,oldOcc)`,
old attacker edges) need the FULL pre-move board too — so *something* must hold
both boards simultaneously. The copy is intrinsic to needing old+new at once.

### The actual win: drop computeDelta's copy, reuse search's undo
The one copy that is provably redundant: search's `pos.DoMove(m,&u)` already
produces the child in `pos` and can restore the parent via `u`. Restructure so:

1. `s.accPush(pos, m)` computes the OLD-board contributions it needs while `pos`
   is still the parent (base subs, old attacker edges, `AttackersTo(·,oldOcc)`),
   stashing the partial delta + the affected-square set.
2. search does `pos.DoMove(m, &u)` (its existing move — now the ONLY make-move).
3. a second call `s.accPushFinish(pos /*=child*/, m)` computes the NEW-board
   contributions (base adds, new attacker edges, `AttackersTo(·,newOcc)`) and
   applies the diff.

This splits the push around search's existing DoMove and **removes computeDelta's
`child := *pos; child.DoMove` entirely** (−1 copy, −1 make-move per node). Cost:
computeDelta's scratch must carry `D`, `affected`, `oldOcc`, the mirror/offset
constants, and the partial sub/add lists between the two calls (all already in
`EnrichedStack` scratch fields). The king-refresh split path (`buildSlotFrom`,
`buildSlotRefreshSplit`) needs the same two-phase treatment.

Estimated saving: one `*Position` copy (~272 B, though most is the constant
`castleMask[64]`+`castleRook` that a board-only copy could skip) + one make-move
per evaluated node. Profiling (`docs/PROFILING/`) put the push at ~47% of engine
CPU with the make-move/copy a measurable slice of it.

## Gates (identical to the Target-1 pass — byte-identity is everything)

1. `go build ./...`
2. `go test ./internal/nnue/` — esp. `TestEnrichedMoveAwareBitExact` (int16-exact
   perft walk = the byte-identity proof), NNUE_ASSERT, Go↔Rust crosscheck.
3. `go test ./internal/chess/ -run Perft`
4. Regenerate Go↔Rust dump + `cross_check_dump` → "1500 positions Go==Rust
   byte-exact".
5. `go test -race ./internal/search/` after touching the parallel driver (note:
   `-race` is red on clean `main` — gate on non-race + perft).
6. `bench nps-ft` before/after for the movetime NPS delta.

Do NOT ship unless fully byte-identical and node-identical. A reverted attempt is
a fine outcome; a broken accumulator is not.
