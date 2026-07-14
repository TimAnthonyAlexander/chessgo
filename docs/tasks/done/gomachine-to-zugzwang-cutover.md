# DONE — gomachine → zugzwang engine cutover

The whole site's engine work moved from the Go gomachine engine to the C++
zugzwang engine, keeping the gomachine hub as realtime infra.

**HTTP serve mode.** zugzwang gained `zugzwang serve -addr 127.0.0.1:6476`
(`src/serve.cpp`, `src/serve_handlers.cpp`) — a stateless `(FEN, limit) → result`
API that mirrors gomachine's old internal engine API as a byte-compatible
superset: `/bestmove /candidates /move /legal-moves /perft /status /analyze-game
/sf-bestmove /duck/* /crazyhouse/*` (+ `/healthz`). Runs on 6476 so both engines
can run side by side.

**PHP wiring.** `config/app.php` gained a `zugzwang` block (`ZUGZWANG_URL`) and an
`engine` block (`ENGINE_PRIMARY`, default `zugzwang`). `AppServiceProvider` binds
`ZugzwangClient` + `EngineSelector`. `EngineSelector` (decorator over
`GomachineClient` + `ZugzwangClient`) routes every standard-chess + variant +
Stockfish call to the primary — **zugzwang-primary, no automatic fallback** (a
primary error propagates). `ENGINE_PRIMARY=gomachine` reverts the whole site with
zero code change.

**Hub wiring.** The gomachine hub (`internal/hub`, `cmd/gomachine/hub.go`) now
calls zugzwang's `/bestmove` for bot moves + watch fillers (`-zugzwang-url`,
default `:6476`); an `-emergency-inproc` (default on) in-process gomachine
fallback catches a zugzwang outage so a live game never freezes.

**Stockfish decouple.** Stockfish is now proxied through zugzwang's `/sf-bestmove`
(`src/sf_uci.cpp` spawns a real SF UCI subprocess), not a separate service. The
admin Engine-vs-Engine page injects `ZugzwangClient` directly for explicit
per-side choice.

**Concurrent search pool.** `serve` runs N independent `Search::Context`s (default
`min(cores,6)`), each with its own TT + mutable search tables, leased per request
— lock-free concurrent searches. Rules-only handlers never lease a Context.

**Three variants shipped in zugzwang** (each self-contained, own eval/search,
not the shared NNUE): **Chess960** (castling generalized in core movegen),
**Crazyhouse** (`src/crazyhouse.cpp`, pockets/drops + pocket-aware eval),
**Duck Chess** (`src/duck.cpp`, king-capture win, no check model).

Full cutover map: `../../../gomachine/engine/docs/WIRING_RECON.md`.
