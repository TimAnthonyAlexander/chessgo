# Anti-cheat: flag-not-ban harness

## What (shipped)

A **flag-only** anti-cheat harness. Detection raises advisory **flags**; it never
auto-bans. An admin reviews and decides. Mirrors Lichess (Irwin/Kaladin → human
mod queue) and Regan/FIDE (IPR + z-score, flag for review) — everywhere the
principle is *statistics establish suspicion, a human convicts*. Per-game noise is
large by design, so flags **accumulate** in the rollup; a sustained pattern is
what an admin acts on.

### Data model
- **`user_flag`** (`app/Models/UserFlag.php`) — append-only flag EVENTS:
  `user_id`, `category`, `severity` (low/medium/high), `detail`, `meta` (JSON), `reviewed`.
- **`flagged_user`** (`app/Models/FlaggedUser.php`) — per-user ROLLUP (admin queue's
  primary table): `total_flags`, per-category `counts` (JSON), `status`
  (`open`|`reviewing`|`cleared`|`banned`), `top_severity`, `last_category`, stamps.
- **`game.move_times`** + **`game.ac_scanned`** — per-move think-times (telemetry,
  can't be back-filled) and the engine-scan bookmark.

### Orchestration — `app/Services/AnticheatService.php`
`flag()` writes an event + upserts the rollup (per-category counts, max severity);
every path swallows its own errors (a flag must never break/delay the request or
tip the user off).

## The five signals (all implemented)

| Category | When it runs | Cost | Data |
|---|---|---|---|
| `analysis_during_game` | real-time, on the analyze call | cheap (1 hub probe) | live | 
| `rating_velocity` | on game finish (GameResultController) | cheap (no engine) | live |
| `move_time_anomaly` | on game finish | cheap | live (needs `move_times`) |
| `engine_correlation` | out-of-band scan | **engine pass/game** | batch |
| `accuracy_rating_mismatch` | out-of-band scan | shares the pass | batch |

1. **`analysis_during_game`** — logged-in non-admin hits `/analyze` or `/sf-analyze`
   while the hub reports them in a live game. Liveness via the hub's `livePlayers`
   `sync.Map` → secret-gated `GET /internal/live-player?sub=` → `{live, fen}`
   (`HubClient::livePlayer`, fail-open). **Exact live-board match → `high`** (near-zero
   FP), in *a* game → `medium`.
2. **`rating_velocity`** — winning against materially stronger opposition, especially
   while provisional (`RD > 110`). Provisional +150 → low/medium; established +400 → low.
3. **`move_time_anomaly`** — coefficient of variation of the side's own move times
   `< 0.35` over ≥15 moves with mean ≥1s (gated so fast/bullet uniform play doesn't
   fire). Weak/corroborating → low/medium. Drops the opening move.
4. **`engine_correlation`** — from `GameAnalysisService`: ACPL ≤ ~½ the rating-band
   expectation **AND** top-1 engine-match ≥ 60% over ≥20 own moves (both, not either —
   strong players post low ACPL; forced lines inflate match). Extreme → `high`.
5. **`accuracy_rating_mismatch`** — game accuracy ≥ band expectation + 12 (the
   "1500 playing like 2600" tell); +20 → `high`.

Rating-band expectations (`expectedAcpl`/`expectedAccuracy`) are **heuristic and
tunable** — a human reviews every flag they help raise.

### Out-of-band scanner — `scripts/anticheat_scan.php`
Engine-correlation is too slow for the persist request, so it runs here (cron or
manual). Idempotent + resumable via `ac_scanned`. `--limit=N`, `--rescan`, and
**`--dry-run`** (analyze + print would-be flags, write nothing — preview a sweep
before committing). Cron: `*/10 * * * * php scripts/anticheat_scan.php --limit=100`.

### Admin review + real ban — `AdminFlagsController` (`role === 'admin'`)
`GET /admin/flags` (list, `?status=`), `GET /admin/flags/{userId}` (rollup + events),
`POST /admin/flags/{userId}` (`{status, ban?}`). Banning sets `User.active=false`;
`LoginController` now refuses inactive accounts (vague 401 — no ban tell).

## Verification done
- Go build/vet/full suite green; hub tests cover live-index + move-time capture.
- Hub `/internal/live-player` smoke-tested (secret gating + `{live,fen}`).
- Write path (flag → per-category counts → `top_severity` escalation → admin read)
  exercised against a real user, then cleaned up.
- Scanner dry-run ran the real engine over live games, wrote nothing.

## Follow-ups / open
- **Tune thresholds against real data.** The ACPL/accuracy bands + CV cutoff are
  first-pass. Run `--dry-run` over the 1400-game corpus, eyeball the flag rate per
  band, adjust. Consider a rolling-window aggregate (last N games) rather than
  per-game for `engine_correlation` (the research's strongest recommendation).
- **`move_times` only exists going forward** — old games can't be scanned for timing.
- **`account_linkage`** (smurf/ban-evasion) — needs IP/UA capture at signup/`/ws-ticket`/login;
  none stored today. Not built.
- **React admin page** for the flag queue (API is done; no UI built).
- **Throttle** the per-`/analyze` `livePlayer` probe if it shows under load (one hub
  call + user lookup per call; fail-open bounds the downside).
