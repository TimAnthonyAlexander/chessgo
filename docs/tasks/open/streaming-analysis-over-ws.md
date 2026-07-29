# Streaming analysis over the WebSocket hub (kill the polling ladder)

**What.** Replace the analysis board's ladder of discrete `/analyze` requests with ONE
continuous search per position whose per-depth results are pushed to the client over the
existing hub WebSocket — the Lichess model.

**Status.** Not started. Sizeable: new hub message types, a streaming search path in
zugzwang, and `Analysis.tsx` switching from polling to subscribing.

---

## Why

The board can't stream today. `Analysis.tsx` says so directly ("We can't stream over the
wire (no SSE behind Cloudflare), so we emulate it by…") and emulates it with
`ANALYSIS_LADDER` — 11 depth targets, each a separate HTTP round trip. That works, but it
is the entire perceptual gap with Lichess, which runs Stockfish as WASM **in the browser**
under one continuous `go infinite` and just re-renders each `info` line in place. Nothing
is ever pending there, so nothing ever feels slow.

Measured on `r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w`:

| | wall clock to depth 30 |
|---|---|
| one continuous search | **29.3s** |
| the 11-rung ladder, warm TT | **36.9s** |

So the restart tax is ~26% — real but not the main cost; the rest is the search genuinely
working. **The win here is perceptual, not throughput.** Do not sell it as a speedup.

The second win is that MultiPV stops needing to be rationed. `ANALYSIS_LADDER` currently
drops to `multipv: 1` past `LINES_MAX_DEPTH = 16` purely because a 5-line rung at depth 22+
makes the user *wait* 8+ seconds for a response (5 lines costs ~4.4x one line; SF18 pays
~4.6x for the same, so this is inherent to alpha-beta, not our port — see
`real-multipv-root-search.md`). When results stream, nobody waits for a rung, so the deep
tail can keep all 5 lines and `LINES_MAX_DEPTH` goes away.

## Shape

Today: hub (Go, `:6467`) terminates the WebSocket and owns ws-ticket auth; zugzwang
(`:6476`) is stateless request/response HTTP. Neither streams.

**Option A — streaming engine endpoint, hub proxies it (recommended).**
zugzwang gains e.g. `POST /analyze-stream` that emits one chunk per completed ID iteration
(depth, score, all MultiPV lines) until the client disconnects or a bound is hit. The hub
subscribes on the client's behalf and relays each chunk as a WS frame. This is still
`(FEN, limit) → result` — the engine stays stateless per the `CLAUDE.md` boundary rule; only
the response becomes long-lived. Gets true per-depth granularity and drops the restart tax.

**Option B — zugzwang speaks WebSocket directly to the browser.** Bypasses the hub, so it
also bypasses ws-ticket auth, CORS and the Cloudflare edge. Not worth it.

**Option C — hub runs the existing ladder server-side and pushes each rung.** Cheapest to
build, removes the *perceived* wait, keeps the 26% restart tax and gives per-rung rather
than per-depth granularity. Reasonable as a first increment if A looks too big.

## The hard part: search-pool capacity

**This is the thing that takes the site down if it's built naively.** `serve` runs
`-search-pool N` groups (default `min(cores, 6)`), and a handler leases one group for the
duration of a search. Today an analysis request holds a group for a bounded rung. Under
streaming, **every user parked on a position holds a group for as long as they sit there** —
six idle analysis boards would starve live bot moves and the hub's own `/bestmove` calls.

Non-negotiable requirements:
- a concurrency cap for streaming analyses that is **separate from and smaller than** the
  pool used by game-serving traffic, so analysis can never starve play;
- a max duration and an idle timeout per stream (the ladder's implicit bound today is that
  it stops climbing at depth 30 — keep an equivalent);
- prompt cancellation: navigating to another node must abort the search and release the
  group immediately, not at the next depth boundary. `Search::Context` already has a `stop`
  flag; wire it to client disconnect and to an explicit `analyzeCancel` message;
- one stream per connection — a new `analyze` supersedes the previous one.

Load-test this before it ships anywhere near prod.

## Other things not to miss

- **Anticheat.** `AnalyzeController::post` calls
  `AnticheatService::checkAnalysisDuringGame` — analysing while you have a live game is a
  strong engine-use tell. A WS path bypasses PHP entirely, so this hook must be
  reimplemented hub-side (or the hub must report to BaseAPI). Losing it silently is the
  easiest mistake in this task.
- **Protocol.** `inMsg` (`gomachine/internal/hub/protocol.go`) is a flat struct with a
  `Type` switch in `hub.go:279`. Add `analyze` / `analyzeCancel` inbound and an
  `analysisUpdate` outbound; `frontend/src/lib/socket.ts` is the client store.
- **The ladder isn't only used by Analysis.tsx.** `BotGame`, `EngineVsEngine`, `Spectate`,
  `Watch`, `Editor` and `Puzzles` all call `analyze()` as plain request/response. Keep
  `/analyze` intact — this task adds a streaming path, it does not replace the endpoint.
- **Guests.** Analysis is free and anonymous (`free-analysis-no-paywall.md`); a ws-ticket
  is currently obtained per session. Make sure an anonymous analysis subscription is
  possible without inventing a login requirement.
- Once this lands, delete `ANALYSIS_LADDER` / `LINES_MAX_DEPTH` and the per-node
  `linesCache` in `Analysis.tsx` (the cache exists only because a revisited node otherwise
  re-runs discrete rungs).

## Verification

1. Depth counter visibly ticks up in place with no request/response stutter; time-to-first
   eval no worse than the current first rung.
2. Navigating away releases the search group immediately — assert pool occupancy returns to
   zero, and that a bot game's `/bestmove` latency is unaffected with N boards parked.
3. Anticheat flag still raised for a logged-in user analysing during a live game.
4. 5 lines maintained all the way to the deep tail without any perceived wait.
5. Reconnect: dropping and restoring the socket resumes/restarts the stream cleanly.
