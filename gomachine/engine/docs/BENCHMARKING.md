# Benchmarking & load testing — how fast are the engine and hub?

> The **measured** companion to `docs/PERFORMANCE.md` (which is architectural
> design notes). This doc covers the tooling we use to put real numbers on the Go
> engine and hub, the baselines those tools produced, and what they say about
> scaling to many simultaneous players.
>
> **Philosophy:** don't guess at throughput — measure it. Every number below came
> from a tool in this repo that you can re-run. Numbers are from an **11-core
> arm64** dev box (Apple M3 Pro, Go 1.25); treat them as a baseline to
> regression-track and a *shape* to reason about, not absolutes. Re-run on the
> target hardware for capacity planning.

---

## 1. The performance shape (the one thing to internalize)

The architecture has a sharp split, and it matters more than any single number:

| Work | Where it runs | Cost | Scales with |
|---|---|---|---|
| Human-vs-human moves, clocks, matchmaking, lobby | hub's **single** Run goroutine (`internal/hub/hub.go`) | microseconds/move | ~free |
| WebSocket I/O | 2 goroutines/client (read + write pump) | memory + fds | # connections |
| **AI search** (bot moves, fillers, `/bestmove`, `/analyze`) | bounded engine pool (`internal/server`, hub bot pool) | 10ms–1900ms/move, **pegs a core** | # *concurrent AI moves* |

The intuition people get wrong: "thousands of live games" sounds expensive but is
the **cheap** column — a move is just a legality check. The **expensive** column
is AI search, and it's bounded by a worker pool, not by player count. So the two
halves scale completely differently and must be measured separately.

---

## 2. The four tools

All live in `gomachine`. Full flags + copy-paste commands are in
`docs/COMMANDS.md` → *Performance & load testing*. Summary:

| Tool | Command | Measures |
|---|---|---|
| Hot-path microbenchmarks | `go test -bench` in `internal/{chess,eval,search}` | movegen / eval / search NPS in isolation |
| Live profiling | `serve -pprof` / `hub -pprof` | CPU / heap / goroutines of a running service |
| Hub WS load | `gomachine loadtest` | hub Run-goroutine throughput + move→echo latency |
| Engine search load | `gomachine engineload` | engine pool search-rate + per-search latency |

`-pprof` is the only one that touches the live binaries, and it's **opt-in, off by
default, on its own listener** — never on the service port. The benchmarks are
test files; the two load generators are separate subcommands. None of them change
engine or hub runtime behavior.

### Why fixed-work, not wall-clock, in the microbenchmarks

`BenchmarkSearch` searches to a **fixed depth** (not a time budget) and clears the
TT each iteration, so the NPS reflects a fresh position and is comparable across
runs and machines — the same discipline the SPRT strength harness uses
(`docs/ENGINE_STRENGTH.md`). `engineload` uses a **time budget** instead, because
there the question is "how many bot moves/sec at a realistic per-move budget."

---

## 3. Baselines — raw speed (microbenchmarks)

`go test -run '^$' -bench . ./internal/chess/ ./internal/eval/` and
`-bench BenchmarkSearch ./internal/search/`:

| What | Result |
|---|---|
| Full legal movegen (`GenerateLegal`) | 0.34µs (endgame) → 1.14µs (kiwipete) per position |
| Make/unmake round-trip | ~7–11 ns per move |
| Bulk movegen (`perft`) | **~55 Mnps** (also via `gomachine perft -depth 6`) |
| Static eval (`Evaluate`, default config) | 31–62 ns/op |
| Single-thread search @ depth 9 | **1.7–4.5 Mnps** (kiwipete depth-9 ≈ 129 ms) |

These set the per-operation floor everything else is built on: a move-legality
check is sub-microsecond, which is *why* the hub can serialize all game logic on
one core (§4).

---

## 4. Hub concurrency — human-vs-human (`gomachine loadtest`)

Synthetic clients queue, get paired human-vs-human, and play random legal moves —
exercising exactly the hub's single Run goroutine + broadcast fan-out, **no engine
search involved** (paired humans never trigger bot-fill). Max stress
(`-move-delay 0`, zero think time), 8s per level:

| clients | live games | moves/sec | p50 | p95 | p99 |
|--:|--:|--:|--:|--:|--:|
| 10  | ~5   | 34k | 128µs | 512µs | 512µs |
| 50  | ~25  | 45k | 512µs | 2.0ms | 2.0ms |
| 100 | ~50  | 54k | 1.0ms | 2.0ms | 4.1ms |
| 200 | ~100 | 59k | 2.0ms | 4.1ms | 8.2ms |
| 400 | ~200 | 62k | 4.1ms | 8.2ms | 8.2ms |
| 800 | ~400 | 63k | 8.2ms | 16ms  | 16ms  |

**Reading it:** throughput plateaus at **~62k moves/sec** — one core saturating.
Past that, added load becomes **latency, not lost moves** (zero errors, zero
drops): graceful degradation. Latency stays sub-ms (p50) up to ~50 games and
single-digit-ms (p95) through 400 games.

**This is the worst case.** Real humans move every few seconds, so 800 real
players generate a few hundred moves/sec — order ~1% of what one core sustained
here. Human-vs-human to thousands of concurrent games is comfortable on a single
modest box.

**First thing that would bend at extreme scale:** the per-tick (200ms) sweep in
`Run` — `checkClocks` / `matchWaiting` / `publishLobby` are `O(games)` and run
5×/sec. At tens of thousands of games that sweep, not move volume, is the cost to
profile (point `hub -pprof` at a heavy `loadtest`).

---

## 5. Engine concurrency — the AI wall (`gomachine engineload`)

Concurrent `/bestmove` requests at a running `serve`. The engine answers from a
bounded pool of `-workers` engines (default 4), so this is the limit bot moves and
`/analyze` actually hit. 4-worker engine, `-movetime 100`:

| in-flight | searches/sec | mean lat | p50 |
|--:|--:|--:|--:|
| 1  | 11 | 88ms  | 131ms |
| 2  | 23 | 88ms  | 131ms |
| 4  | 44 | 89ms  | 131ms |
| 8  | 45 | 176ms | 262ms |
| 16 | 45 | 348ms | 524ms |

**Reading it:** throughput scales **linearly up to `-workers`, then flat.** Beyond
the pool size, extra requests block on `acquire` and become latency (still zero
lost). This is the mirror image of the hub curve — and it's the *real* scaling
wall for AI traffic.

**The lever is `-workers`** (cores permitting; keep `workers × search-threads ≤
cores`). Driving each engine at exactly its pool size:

| engine config | searches/sec | latency |
|---|--:|--:|
| `-workers 4`  | 44  | ~88ms |
| `-workers 8`  | 90  | ~88ms |
| `-workers 10` | 112 | ~88ms |

Same latency, linear throughput — capacity is bought with workers (and, past one
box, more boxes). On the 11-core box, ~10 concurrent searches → ~110 bot
moves/sec at sub-100ms.

---

## 6. Why this lives in Go (the PHP question)

The original prompt: how much slower would a PHP engine be? Large — roughly
**50–150× per move** — for three compounding reasons:

1. **Interpreter overhead on a bitwise-heavy loop.** Movegen/eval is millions of
   64-bit AND/OR/shift/popcount ops. Go compiles these to single instructions; PHP
   (even 8.4 + JIT) pays dispatch per op. A naive PHP movegen is plausibly
   ~0.3–1M nps vs. the **55 Mnps** measured here — 50–100× on the rules core alone.
2. **No threads → no Lazy SMP.** PHP-FPM is shared-nothing per request; the entire
   parallel-search win is gone.
3. **Cold state every request.** The Go pool keeps magic tables resident and a
   search's TT warming as it deepens; a PHP worker can't carry that the same way.

Net: a move the engine resolves in ~300ms would take PHP ~15–30s at the same
depth, making higher levels and `/analyze` infeasible. The stateless FEN-in
boundary (`internal/server`) is the right PHP-friendly *contract* — but the
compute behind it has to be native. That's the whole reason rules + AI are one Go
binary the hub imports directly.

---

## 7. Scaling conclusions

- **Human-vs-human:** one core, ~62k moves/sec measured, ~free per game. Thousands
  of concurrent games on a single box. Watch the `O(games)` per-tick sweep, not
  move throughput, at extreme scale.
- **AI search:** bounded by `workers × search-threads ≤ cores`. ~10 concurrent
  searches → ~110 moves/sec at sub-100ms on this box. **This** is what to scale
  (more workers, then more boxes) as bot/analyze traffic grows.
- **Capacity knobs:** `serve -workers N` (raise toward cores — the default 4
  underutilizes an 11-core box), `serve -tt` (RAM vs. strength; see
  `docs/PERFORMANCE.md` §2), hub bot pool sizing in `cmd/gomachine/hub.go`.

---

## 8. Methodology notes & gotchas

- **Isolate the hub for clean numbers:** run with `-bots=false -watch-fillers=false`
  and point `BASEAPI_URL` at a dead address so finished-game POSTs (fire-and-forget)
  don't add noise.
- **`loadtest` identities carry a per-run nonce** and **resign on exit.** This was
  a real lesson: an early sweep showed errors scaling with concurrency, which
  turned out to be the harness reusing UserIDs across runs against a long-lived
  hub — the hub *correctly* preserved abandoned games for reconnect and reattached
  the next run's clients to them. The fix was in the harness; the episode
  **validated** the hub's reconnect/resume rather than finding a bug in it.
- **Warm-TT bias:** `engineload` cycles 8 positions across game phases so a
  worker's reused engine isn't handed an identical position repeatedly (which the
  warm TT would short-circuit). `BenchmarkSearch` clears the TT per iteration.
- **Latency percentiles are power-of-two bucket upper bounds** (shared `latHist`,
  `cmd/gomachine/latency.go`) — approximate to within a factor of two, which is
  adequate for sizing and keeps memory bounded at any throughput.
- **fd limits:** high client counts need many sockets; raise `ulimit -n` if you
  push `loadtest -clients` into the thousands.
