# Commands — run, build, deploy

Everything to run chessgo locally and in prod. Architecture is in
[ARCHITECTURE.md](ARCHITECTURE.md); engine internals in
[../zugzwang/CLAUDE.md](../zugzwang/CLAUDE.md).

## Prerequisites

- PHP 8.4+ and Composer
- Go 1.25+ (the hub, and the legacy engine)
- A C++17 toolchain (clang++/g++) for zugzwang
- Bun 1.3+ (frontend)
- MySQL 8+ on `:3306`, always running (user `chessgo`, provisioned separately —
  chessgo never manages MySQL)

## One-time setup

```sh
composer install
( cd frontend && bun install )
( cd gomachine && go build -o bin/gomachine ./cmd/gomachine )   # hub + legacy engine
( cd zugzwang && make )                                          # → zugzwang/zugzwang
```

zugzwang needs an NNUE net at `zugzwang/net.nnue` (a symlink to the prod net in
this repo; without it the engine uses its hand-crafted eval).

## Run — dev

The five services each run in their own `screen`. The convenience aliases in
`~/.customrc` are the easy path:

| Alias | Does |
|---|---|
| `chessgo-up` | start all five (api 6464, engine 6466, zugzwang 6476, hub 6467, web 6465) |
| `chessgo-down` | stop all (kills by listening port — no orphans) |
| `chessgo-restart` | rebuild gomachine + zugzwang, restart engine/zugzwang/hub (api & web untouched) |
| `chessgo-stop <name…>` | stop specific services |
| `chessgo-ls` | status by port |

Manual equivalent:

```sh
./mason serve --screen                                   # BaseAPI → 6464
( cd zugzwang && ./zugzwang serve )                      # PRIMARY engine → 6476
( cd gomachine && ./bin/gomachine serve )                # legacy engine → 6466 (optional)
( cd gomachine && WS_TICKET_SECRET="$(grep ^WS_TICKET_SECRET= ../.env | cut -d= -f2-)" ./bin/gomachine hub )  # hub → 6467
( cd frontend && bun run dev )                           # frontend → 6465
```

Open <http://127.0.0.1:6465>. With the default `ENGINE_PRIMARY=zugzwang`, the site
needs `:6476` up — start the legacy engine only if you set `ENGINE_PRIMARY=gomachine`.

Hub flags: `-bots` (on), `-bot-level`, `-bot-delay`, `-bot-search-threads`;
`-watch-fillers` (on), `-watch-target` (5); `-zugzwang-url` (default `:6476`),
`-emergency-inproc` (on — falls back to the in-process gomachine engine if
zugzwang is unreachable). zugzwang serve flags: `-addr`, `-search-pool`, `-tt`,
`-sf-path`.

## Build & test

```sh
cd zugzwang && make                       # arch-detected native build
cd zugzwang && make perft                 # standalone perft binary
cd zugzwang && make ASSERT=1              # + accumulator bit-exactness check (gate only, slow)
bash zugzwang/test/golden_check.sh        # 38-FEN golden-eval gate (tol 5)

cd gomachine && go build -o bin/gomachine ./cmd/gomachine && go test ./...
cd frontend && bun run typecheck && bun run build   # → frontend/dist/
```

Migrations (schema = models; never hand-write DDL, never `--safe`):

```sh
php mason migrate:generate
php mason migrate:apply -y
```

Puzzle seeding: download the Lichess CC0 CSV (`lichess_db_puzzle.csv.zst`, not
committed), then `php scripts/import_puzzles.php lichess_db_puzzle.csv [--limit=N
--min-rating --max-rating --themes=a,b]` (batched `INSERT IGNORE`, re-run safe).

## Tutor — peer baselines and report debugging

Full design in [tasks/open/tutor.md](tasks/open/tutor.md); metric definitions
live in `App\Services\Tutor\TutorMetrics`.

Build the baseline corpus from a public Lichess PGN dump (`.pgn`/`.pgn.zst`),
end to end:

```sh
# 1. Transcode the %eval-annotated dump into normalized JSONL (needs the venv
#    from the script's own docblock: python3 -m venv ~/tutor-data/venv; pip
#    install chess zstandard)
~/tutor-data/venv/bin/python3 scripts/tutor/pgn_to_jsonl.py \
    --in ~/tutor-data/eval_games_2026-06.pgn.zst \
    --out ~/tutor-data/games_2026-06.jsonl.zst
    # [--limit N] [--progress-every N]  (stdin/stdout also work)

# 2. Stream the RAW unfiltered dump for outcome-only games (win/loss/flag —
#    no evals needed, so the whole population is affordable, not just the
#    annotated ~11%)
curl -s https://database.lichess.org/standard/lichess_db_standard_rated_2026-06.pgn.zst \
    | zstdcat | ~/tutor-data/venv/bin/python3 scripts/tutor/outcome_games.py \
    --in - --out ~/tutor-data/outcomes_2026-06.jsonl.zst

# 3. Import engine-derived metrics from the annotated corpus, EXCLUDING the
#    outcome metrics it would otherwise get wrong (see bias_check.py below)
php scripts/import_tutor_baselines.php ~/tutor-data/games_2026-06.jsonl.zst \
    --source=lichess-2026-06 --exclude=win_rate,flagging_loss

# 4. Import win_rate/flagging_loss from the full-population corpus instead —
#    ONLY those two, so the annotated-corpus values aren't overwritten
php scripts/import_tutor_baselines.php ~/tutor-data/outcomes_2026-06.jsonl.zst \
    --source=lichess-2026-06 --only=win_rate,flagging_loss
```

Both importer runs target the same `--source`; rows upsert on
`TutorBaseline::cellKey()`, so re-running either step is safe. `--exclude` and
`--only` exist because each corpus is authoritative for a different set of
metrics — the annotated subset owns everything eval-derived, the full
population owns the two outcome metrics it was measured to get wrong (see
`bias_check.py`). Other importer flags: `--limit=N`, `--dry-run`,
`--families=N` (top-N opening families kept, default 80).

```sh
# Verify the annotated subset is representative before trusting it (win/draw/
# flag rate, analyzed vs unannotated, at matched rating bands)
~/tutor-data/venv/bin/python3 scripts/tutor/bias_check.py \
    --in ~/tutor-data/raw_sample.pgn --limit 400000

# Re-fit the engine eval-scale correction whenever zugzwang's eval scale
# moves (net retrain, eval rework). Needs a small paired-game set from
# scripts/tutor/calibration_set.py first. Result goes into
# App\Services\Tutor\TutorMetrics::SF_SCALE.
php scripts/calibrate_tutor_evals.php ~/tutor-data/calibration.jsonl \
    [--limit=N] [--movetime=100] [--out=storage/tutor-calibration.json]

# Build one report synchronously, for debugging — writes a real tutor_report
# row exactly as a user request would, but runs inline so a failure lands in
# your terminal instead of a worker log
php scripts/build_tutor_report.php <username> [--range=6m] [--summary]
```

Report building (`TutorReportJob`) needs `QUEUE_DRIVER=database` plus a
running `php mason queue:work` in production (the existing
`chessgo-queue@.service` worker, shared with game-analysis precompute). Under
the `sync` dev default it runs inline on the request instead.

## Tournaments — recurring schedule

**There must always be tournaments running.** `scripts/schedule_tournaments.php`
keeps the calendar populated: it asks {@see App\Services\TournamentSchedule}
(a pure function of time — no DB, no side effects) what should exist between
now and now+horizon, and inserts whatever `schedule_key` isn't already a row.
It never updates or deletes an existing tournament (someone may have joined
it already), so it's safe to run as often as you like — a re-run with an
unchanged window creates nothing.

```sh
php scripts/schedule_tournaments.php                    # populate the next 48h
php scripts/schedule_tournaments.php --dry-run           # preview only, writes nothing
php scripts/schedule_tournaments.php --horizon-hours=72  # wider window
```

The rota (all times UTC, all rated, ~37 tournaments/day, overlap is expected):

| Series | When | Name | Pool | Duration | Restriction |
|---|---|---|---|---|---|
| `hourly` | every hour, rotating by `hour % 4` | Hourly Bullet/Blitz/Blitz/Rapid Arena | 1+0 / 3+0 / 5+0 / 10+0 | 27 / 57 / 57 / 117 min | — |
| `variant-hourly` | every 3rd hour, rotating by `(hour/3) % 4` | Hourly Chess960/Crazyhouse/Duck/Antichess Arena | 3+0 / 3+0 / 5+0 / 3+0 | 57 min | — |
| `daily` | 05:00 | Eastern Blitz Arena | 3+0 | 120 min | — |
| `daily` | 17:00 | Daily Bullet Arena | 1+0 | 60 min | — |
| `daily` | 18:00 | Daily Blitz Arena | 5+0 | 120 min | — |
| `daily` | 19:00 | Daily Rapid Arena | 10+0 | 150 min | — |
| `weekly` | Mon 17:00 | Weekly Bullet Arena | 1+0 | 180 min | — |
| `weekly` | Tue 17:00 | Titled Tuesday Warm-up | 3+0 | 60 min | open to everyone |
| `titled-tuesday` | Tue 18:00 | Titled Tuesday | 5+0 | 120 min | titled players only |
| `weekly` | Wed 17:00 | Weekly Rapid Arena | 10+0 | 240 min | — |
| `weekly` | Thu 19:00 | Thursday Thunder | 1+0 | 90 min | — |
| `weekly` | Fri 17:00 | Weekly Chess960 Arena | 3+0 | 180 min | — |
| `weekly` | Sat 17:00 | Elite Weekend Arena | 3+0 | 120 min | rating ≥ 2000 |
| `weekly` | Sun 17:00 | Weekly Blitz Arena | 5+0 | 180 min | — |
| `monthly` | last Sunday, 16:00 | Monthly Championship | 5+0 | 240 min | — |

Entry restrictions (`min_rating`/`max_rating`/`titled_only` on {@see App\Models\Tournament})
are enforced in {@see App\Controllers\TournamentJoinController} against the
tournament's own rating category — a Duck/Crazyhouse/Antichess arena checks
that isolated pool's rating, everything else checks the duration-derived
bullet/blitz/rapid/classical category (same mapping `GameResultController`
uses for Elo).

To change the rota, edit the match arms in `TournamentSchedule` — it's a pure
function, no migration or backfill needed; the next scheduler run picks up
the new shape going forward (existing rows are never touched).

**Deploy (systemd timer, every 10 min, mirrors `chessgo-queue@.service`'s
`www-data`/`/var/www/chessgo` conventions):**

```sh
sudo cp deploy/chessgo-schedule-tournaments.service deploy/chessgo-schedule-tournaments.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now chessgo-schedule-tournaments.timer
systemctl list-timers chessgo-schedule-tournaments.timer   # confirm next run
journalctl -u chessgo-schedule-tournaments.service -f      # tail output
```

## Health checks

```sh
curl -s 127.0.0.1:6464/health      # BaseAPI
curl -s 127.0.0.1:6476/healthz     # zugzwang (primary engine)
curl -s 127.0.0.1:6466/healthz     # gomachine engine (legacy)
curl -s 127.0.0.1:6467/healthz     # hub
curl -s 127.0.0.1:6467/stats       # live counts (also proxied at 6464/stats)
```

## Strength testing (zugzwang)

Self-play SPRT via `zugzwang/sprt.sh`; SPSA margin tuning via `zugzwang/spsa/`.
Run these on the amd64 box (coalla) for a real SIMD build. The overnight campaign
that crossed gomachine is recorded in
[tasks/done/zugzwang-beats-gomachine.md](tasks/done/zugzwang-beats-gomachine.md).

## Environment (`.env`)

Custom env is resolved in `config/app.php` and read via `App::config('…')` —
**never** `$_ENV` directly (under PHP-FPM `$_ENV` is empty on a worker's 2nd+
request). Key blocks:

- **zugzwang:** `ZUGZWANG_URL` (default `http://127.0.0.1:6476`), `ZUGZWANG_TIMEOUT_MS`.
- **engine:** `ENGINE_PRIMARY` (`zugzwang` | `gomachine`).
- **gomachine:** `ENGINE_URL` (`:6466`), `HUB_URL` (`:6467`), `WS_PUBLIC_URL`,
  `WS_TICKET_SECRET`, `WS_TICKET_TTL`.
- **openai:** `OPENAI_API_KEY`, `OPENAI_DEFAULT_MODEL` (fill-in-bot chat).
- Standard: `APP_ENV/DEBUG/URL`, `CORS_ALLOWLIST` (include `:6465`), `DB_*`,
  `BASEAPI_URL` (hub → PHP, in `.env.hub`).

`WS_TICKET_SECRET` **must match** between BaseAPI's `.env` and the hub's env, or
every WebSocket is rejected — it's also the `X-Hub-Secret` the hub sends on
`POST /internal/games`.

## Production

Live at `chessgo.timanthonyalexander.de` (SPA) + `chessgo-api.timanthonyalexander.de`
(API + `/ws`), behind Cloudflare (Full/strict). nginx serves static `dist/` and
reverse-proxies the API and `/ws`; PHP under PHP-FPM (`www-data`); the Go hub +
engine as systemd units run as `tim`. **zugzwang needs its own service on `:6476`**
(a `chessgo-zugzwang` unit) or set `ENGINE_PRIMARY=gomachine`.

**Prod amd64 build (zugzwang):** build with `-ffp-contract=off` to match Go's
scalar float order (bit-exact eval):
`g++ -std=c++17 -O3 -flto -DNDEBUG -march=native -ffp-contract=off -pthread -o zugzwang src/*.cpp`.

Deploy: `git pull` → `composer install --no-dev` → `php mason migrate:apply -y` →
rebuild Go + zugzwang → `bun run build` (with `VITE_API_URL`) → restart the
systemd units + php-fpm → `nginx -s reload`.

### Critical prod gotchas

- **`.env` must be group-readable by `www-data`** (`chmod 640`, not 600) or every
  custom value silently falls back to framework defaults.
- Read custom env via `App::config()`, **not** `$_ENV` (FPM `variables_order` has
  no `E`).
- After a `.env`/config change **restart** php-fpm (`systemctl restart php8.4-fpm`)
  — reload won't re-read it.
- nginx `/ws` must be an **exact match** (`location = /ws`) — a prefix match also
  captures `/ws-ticket` and breaks ticket minting.
- Cloudflare 526 = wrong/placeholder origin cert.
- After Go/C++ changes, rebuild the binary and restart the engine/hub units (no
  hot reload). The frontend has Vite HMR; PHP re-reads code per request.
