# Anti-cheat: flag-not-ban harness

## What (shipped in this task)

A **flag-only** anti-cheat harness. Detection raises advisory **flags**; it never
auto-bans. An admin reviews and decides. Mirrors Lichess (Irwin/Kaladin → human
mod queue) and Regan/FIDE (IPR + z-score, flag for review) — the load-bearing
principle everywhere is *statistics establish suspicion, a human convicts*.

### Data model
- **`user_flag`** (`app/Models/UserFlag.php`) — append-only flag EVENTS:
  `user_id`, `category`, `severity` (low/medium/high), `detail`, `meta` (JSON-in-TEXT), `reviewed`.
- **`flagged_user`** (`app/Models/FlaggedUser.php`) — per-user ROLLUP (the admin
  queue's primary table): `total_flags`, `counts` (per-category JSON), `status`
  (`open`|`reviewing`|`cleared`|`banned`), `top_severity`, `last_category`,
  `first/last_flagged_at`. Both FK `user.id` ON DELETE CASCADE.

### Orchestration
- **`AnticheatService`** (`app/Services/AnticheatService.php`) — `flag()` writes an
  event + upserts the rollup; every path swallows its own errors (a flag must
  NEVER break or delay the flagged request, nor tip the user off).

### Signal #1 — `analysis_during_game` (the one implemented)
A logged-in, non-admin user hitting an engine-analysis endpoint while they have a
**live game in progress**. Wired into `AnalyzeController` + `SfAnalyzeController`
(both routes gained `SessionStartMiddleware` for optional-auth attribution).
- Liveness comes from the hub: `playerGames` now mirrors into a `livePlayers`
  `sync.Map` (`internal/hub/hub.go`, `markLive`/`refreshLive`/`unmarkLive`),
  exposed via secret-gated **`GET /internal/live-player?sub=`** →
  `{live, fen}`. `HubClient::livePlayer()` probes it (fail-open, 500ms).
- **Severity:** analyzing the EXACT live board (placement + side-to-move match) →
  `high` (near-zero false positive, per the site-analysis agent's recommendation);
  merely analyzing while in *a* game → `medium`.
- Fillers/bots never populate `livePlayers` (no human to flag).

### Admin review + ban
- **`AdminFlagsController`** (`role === 'admin'`): `GET /admin/flags` (list, `?status=`),
  `GET /admin/flags/{userId}` (rollup + recent events), `POST /admin/flags/{userId}`
  (`{status, ban?}`). Banning sets `User.active=false`; **`LoginController` now
  refuses inactive accounts** (vague 401 — no ban tell), so the ban is real.

## Roadmap — researched signals not yet built (share the same `flag()`/rollup plumbing)

Priority order from the two research passes (site feasibility + Lichess/Chess.com/Regan):

1. **`move_time_anomaly`** — *capture now, detect later.* The hub computes each
   move's think-time in `applyMove` (`now.Sub(g.turnStart)`) then **discards it**.
   Persisting per-move times is a tiny hub→BaseAPI change (`FinishedGame` +
   `move_times` TEXT column on `Game`) but the data **can't be back-filled** — every
   day without it is permanently lost telemetry. Then flag: low think-time variance
   + think-time uncorrelated with position difficulty.
2. **`engine_correlation`** — `GameAnalysisService`/`Game.analysis` already yields
   per-move `isBest`/`cpLoss`/ACPL/accuracy per game. Aggregate per user (rolling
   window), normalize against a **per-rating-band, per-time-control** baseline. Use
   ACPL/accuracy percentiles as primary (match-rate vs gomachine biases high),
   **discount forced/only-moves**. Regan-style IPR-vs-Elo z-score is the headline.
3. **`rating_velocity`** — rating gained per game/day + provisional-phase blowouts
   (`RD > 110`, already derived). Cheap SQL over `game` + `user`.
4. **`accuracy_rating_mismatch`** — alerting layer atop #2 (1500 playing at 2600 IPR).
5. **`account_linkage`** (smurf/ban-evasion) — needs new capture (IP/UA at
   signup + `/ws-ticket` + login); none stored today. Lower priority.

### Design lessons to honor when building the above
- **Never auto-ban** — always flag → admin review (even Chess.com human-reviews
  ambiguous + all titled cases).
- **Aggregate over many games** — per-game noise is huge; use a rolling window.
- **Normalize per rating band + time control** — a raw ACPL threshold is meaningless
  without rating context.
- **Discount forced/only-moves** — the main false-positive guard.
- **Combine weak signals** — no single metric convicts.

### Follow-ups
- React admin page for the flag queue (API is done; no UI built — deliberately out
  of scope for the harness task).
- Consider throttling the per-analyze `livePlayer` probe (one hub call + user
  lookup per `/analyze`, which the eval bar polls) if it shows up under load —
  correctness-first for now, fail-open already bounds the downside.
