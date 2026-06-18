# Performance & Concurrency Notes

> ⚠️ **Moving target.** This codebase changes fast. Every file:line reference,
> struct shape, and default value below was true at the time of writing but is
> **not guaranteed** to still match the code. Treat this as orientation, not
> ground truth — re-verify against the source before acting on any specific fact.

Scope: the chess engine's concurrency model, the cost of pooling, and what to
watch for on a small VPS with multiple simultaneous players. Plus two adjacent
findings (Move→UCI, nil bot client) gathered during the same pass.

---

## 1. Engine is single-search-at-a-time — pool it (true, and correct)

The "not concurrency-safe → pool them" rule is accurate and is the right design,
not a smell.

- `Engine` is a thin wrapper over a `*search.Searcher` (`engine/engine.go:19-21`).
  The real state lives in the `Searcher` (`search/search.go:42-56`): TT,
  `killers`, `history`, `nodes`, `stop`, `rootBest`, and a shared `keyStack`
  slice pushed/popped on **every node** (`search.go:82-83`).
- **No mutex, no atomics, no `sync` import anywhere.** Two concurrent `BestMove`
  calls on the same `Engine` race on essentially all of it. `reset`
  (`search.go:66`) wholesale-overwrites most of that state at the start of each
  search, so a concurrent search mid-flight gets corrupted.
- The engine documents this itself (`engine/engine.go:16-18`): *"safe to reuse
  across positions but NOT safe for concurrent searches — use one Engine per
  worker."*
- **One engine = one search at a time.** This is normal for a chess engine.

### Pooling already exists and is correct

- `search/server.go:18-35` hands engines out of a buffered `chan *engine.Engine`.
- `/bestmove` does `acquire()` / `defer release()` (`server.go:202-225`).
- Reusing a pooled engine across different games is fine: the TT is full-key
  validated on probe (`tt.go:67`) and age-replaced, so cross-game entries can't
  cause wrong results.
- **Pooling costs no per-search performance.** It adds throughput (N concurrent
  searches) and bounds load. The costs are memory and CPU oversubscription
  (below), not slower individual searches.

---

## 2. Small-VPS cost centers

### Memory — one TT per engine

- Default TT is **64 MB nominal**, but `NewTT` rounds entry count down to a power
  of two, so 64 MB actually allocates **~48 MB** (2²¹ × 24-byte entries;
  `tt.go:40-51`).
- Default **4 workers ⇒ ~192 MB just for TTs**, on top of PHP-FPM, MySQL, the
  hub's in-memory games, and the Go runtime. Tight on a 1 GB VPS.
- **Lever:** drop `-tt` to **16–32 MB**. At bot time controls the strength loss
  is small, and you fall to ~30–60 MB total for the pool.

### CPU — don't oversubscribe cores

- Each search is single-threaded and CPU-bound. The pool caps concurrency at
  `workers`.
- Failure mode: `workers > vCPUs` ⇒ searches time-slice, every move's wall-clock
  stretches, clocks feel laggy under load.
- **Lever:** set `-workers ≈ vCPUs` (or **vCPUs − 1** to leave a core for the
  hub / PHP / MySQL). On a 2-vCPU box: 2 workers = 2 bot moves at full speed, a
  3rd queues briefly. That queueing is graceful degradation, not loss of
  per-move quality.

### The single-goroutine trap (only if the hub runs the engine in-process)

- Per `CLAUDE.md`, the hub mutates **all** shared state on one goroutine, no
  locks. A bot search can run up to its MoveTime (~1 s).
- If you call `BestMove` **on the hub goroutine**, you freeze every game's clocks
  and message handling for the whole search — catastrophic under multiple
  players.
- **Rule:** the search must run on a pooled worker goroutine and post the
  resulting move back to the hub via a channel (same discipline as the
  per-client send channel).
- **Simplest path:** PHP bot games already avoid this by calling the engine over
  HTTP in a separate process. Hub bot games can do the same (hub → localhost
  `/bestmove`, async, post move back), reusing the existing pool instead of
  embedding a second one.

---

## 3. Move → UCI is already done

`Move.String()` **is** the UCI converter (`chess/move.go:45-55`): emits `e2e4`,
`e7e8q`, `e1g1` (castling as a king move), `"0000"` for the null move. Inverse is
`ParseUCIMove`. **Don't write a new one.** (`chess/san.go` `SAN()` is separate —
that's PGN notation like `Nf3`, not UCI.)

---

## 4. nil bot client in the hub — landmine for bot-in-hub games

The hub today has **no concept of a bot game** — `startGame` is only called with
two real `*Client`s from matchmaking (`hub.go:156-182`), so `player.client` is
never nil. The moment a bot side has `client == nil`, these unguarded paths
panic:

- **`broadcast` (`hub.go:366-369`)** — `g.white.client.trySend(...)` /
  `g.black.client.trySend(...)`, no nil check. Hit on **every move**
  (`hub.go:223`) and at game end (`hub.go:275`). **Primary hazard.**
- **`finish` (`hub.go:282-283`)** — `g.white.client.game = nil` etc., direct
  write through the pointer.
- **`startGame` (`hub.go:169,175,177-178`)** — reads `client.id`, writes
  `client.game`; assumes two live clients.

Already safe: the two `opp.client != nil` guards (`hub.go:316`, `:361`), and the
pointer *comparisons* in `colorOf` / `opponent` / disconnect (no deref).

**Cleanest fix surface:** nil-guard `trySend` / `broadcast` (skip a side whose
`client == nil`), since `broadcast` + `finish` are the two paths every bot move
traverses.

---

## TODO / next

- [ ] Decide where hub bot search runs: localhost `/bestmove` (reuse PHP's path)
      vs embed the engine package + a worker pool in the hub.
- [ ] If in-process: wire bot search off the hub goroutine, channel the move back.
- [ ] nil-guard `broadcast` and `finish` before introducing a bot side.
- [ ] Tune `-workers` ≈ vCPUs and `-tt` to fit VPS RAM; document chosen values.
