# chessgo — Run & Deploy Commands

How to build, run, and deploy every part of chessgo. See `docs/SPEC.md` for the
architecture.

## Services & ports

| Service | What | Dev bind | Prod |
|---|---|---|---|
| **MySQL** | durable data (users, games, ratings) | `127.0.0.1:3306` | `127.0.0.1:3306` |
| **BaseAPI** (PHP) | REST API: auth, games, matchmaking ticket, persistence | `127.0.0.1:6464` | nginx + PHP-FPM |
| **gomachine engine** (Go) | internal HTTP: rules + AI (`/bot`, `/analyze`) | `127.0.0.1:6466` | internal only (PHP calls it) |
| **gomachine hub** (Go) | realtime WebSocket: matchmaking + live games + spectating | `127.0.0.1:6467` | nginx `wss://…/ws` proxy |
| **Frontend** (React/Vite) | the web app | `127.0.0.1:6465` | nginx static (`dist/`) |

> The engine (6466) and hub (6467) are the **same binary** (`gomachine`) with
> different subcommands (`serve` and `hub`). Both are needed: the engine powers
> bot games + the eval bar; the hub powers human-vs-human play.

Paths below are relative to the repo root (`/Users/tim.alexander/chessgo`).

---

## Prerequisites

- PHP 8.4+, Composer
- Go 1.25+
- Bun 1.3+
- MySQL 8+ — assumed always running on `127.0.0.1:3306` on both dev and prod
  (chessgo never starts or manages it; user `chessgo` already provisioned, see `.env`)

One-time installs:

```sh
composer install                       # backend deps
( cd frontend && bun install )         # frontend deps
( cd gomachine && go build -o bin/gomachine ./cmd/gomachine )   # build the Go binary
```

---

## Dev — start everything

Each service runs in its own detached `screen`. The hub needs `WS_TICKET_SECRET`
to **match the backend's `.env`** — the commands below read it straight from
`.env` so they can never drift.

```sh
# 1. Backend (creates screen "chessgo-api") → 127.0.0.1:6464
./mason serve --screen

# 2. Engine HTTP service (rules + AI) → 127.0.0.1:6466
screen -dmS chessgo-engine bash -c 'cd gomachine && ./bin/gomachine serve'

# 3. Realtime hub (WebSocket) → 127.0.0.1:6467
#    Secret is pulled from .env so it matches the API's minter.
screen -dmS chessgo-hub bash -c \
  'cd gomachine && WS_TICKET_SECRET="$(grep ^WS_TICKET_SECRET= ../.env | cut -d= -f2-)" ./bin/gomachine hub'

# 4. Frontend (Vite dev server) → 127.0.0.1:6465
screen -dmS chessgo-web bash -c 'cd frontend && bun run dev'
```

Then open <http://127.0.0.1:6465>.

> After changing Go code, rebuild (`cd gomachine && go build -o bin/gomachine ./cmd/gomachine`)
> and restart the `chessgo-engine` / `chessgo-hub` screens.
> After changing `.env`, restart `chessgo-api` (it reads `.env` at boot) — and
> the hub if you changed `WS_TICKET_SECRET`.

### Bot backfill (matchmaking fallback)

If a player waits in a pool with no human opponent, the hub pairs them with an
engine-driven bot that looks like a normal player (random username + rating).
It is **on by default**; tune or disable it with hub flags:

```sh
./bin/gomachine hub                        # default: bots on, level 6, after 15s
./bin/gomachine hub -bot-level 8 -bot-delay 20s
./bin/gomachine hub -bots=false            # humans only (no backfill)
```

| Flag | Default | Meaning |
|---|---|---|
| `-bots` | `true` | offer a bot once a player has waited past `-bot-delay` |
| `-bot-level` | `6` | bot difficulty (0..10) |
| `-bot-delay` | `15s` | how long a lone player waits before a bot is offered |

Bot games are always **casual (unrated)**. Two humans in the same pool still
pair instantly — the bot only fills in for a lone, long-waiting player. Bot
moves are searched off the hub's main goroutine and paced to feel human (the
think time comes off the bot's clock).

### Watch page fillers (spectator self-play)

The Watch page (`/watch`) shows the top live games. To keep it from looking
empty, the hub runs **engine-vs-engine** games with believable fake players that
pad the list up to `-watch-target`. They are **JIT**: they spawn only while
someone is actually watching (the `GET /games` poll is the signal) and run on a
**dedicated** engine pool so they can never starve human bot-fill. On by default:

```sh
./bin/gomachine hub                          # default: fillers on, up to 5 shown, 2 workers
./bin/gomachine hub -watch-target 6
./bin/gomachine hub -watch-fillers=false     # real games only (Watch can be empty)
```

| Flag | Default | Meaning |
|---|---|---|
| `-watch-fillers` | `true` | keep self-play games running to populate the Watch page |
| `-watch-target` | `5` | number of live games shown (real games padded with fillers up to this) |
| `-watch-filler-workers` | `2` | dedicated engine workers for fillers (small, so they can't starve bot-fill) |

Filler games are **never persisted and never Elo'd** (no `/internal/games` POST)
— `finish()` gates that on the `filler` flag, not on `rated`. They're shown as
**Rated** in the lobby/spectate view purely for display (a single `rated` field
is the source of truth both views read). Real games always sort ahead of fillers,
and in-flight fillers
**finish naturally** — when the lobby gets busy (or watchers leave) they're just
not replenished. They DO count toward the hub's `activeGames`, so the homepage
"games in play" ticks up a few while someone is on the Watch page.

### Managing the screens

The `chessgo-*` aliases (in `~/.customrc`) are the convenient path:

```sh
chessgo-up                         # start all four (api, engine, hub, web)
chessgo-restart                    # rebuild Go binary + restart ONLY engine+hub (api & web keep running)
chessgo-stop engine hub            # stop specific services cleanly
chessgo-down                       # stop all four
chessgo-ls                         # status by listening port
```

Raw screen commands still work:

```sh
screen -ls                         # list sessions
screen -r chessgo-hub              # attach (detach again with Ctrl-a d)
screen -S chessgo-hub -X quit      # stop one  ⚠ see the orphan gotcha below
```

> **Orphan gotcha:** `screen -S <name> -X quit` kills the screen wrapper but can
> leave the `gomachine` child **still running and holding its port** (6466/6467).
> A follow-up start then silently fails ("address already in use") because the
> orphan owns the port. The `chessgo-stop`/`chessgo-restart` aliases avoid this by
> killing whatever **listens on the port** (not just the screen) and waiting for
> the port to free. If you used raw `screen -X quit` and a restart won't bind:
> `lsof -nP -iTCP:6466 -iTCP:6467 -sTCP:LISTEN` to find the orphan, then `kill` its PID.

### Health checks

```sh
curl -s 127.0.0.1:6464/health           # BaseAPI
curl -s 127.0.0.1:6466/healthz          # engine
curl -s 127.0.0.1:6467/healthz          # hub
curl -s 127.0.0.1:6467/stats            # hub live counts {playersOnline, activeGames}
curl -s 127.0.0.1:6464/stats            # same, via the BaseAPI proxy (homepage uses this)
curl -s 127.0.0.1:6467/games            # hub Watch lobby {games:[…], max} — polling this spawns fillers
curl -s 127.0.0.1:6464/watch            # same, via the BaseAPI proxy (Watch page uses this)
# verify API↔hub share the ticket secret:
T=$(curl -s 127.0.0.1:6464/ws-ticket | sed -E 's/.*"ticket":"([^"]+)".*/\1/')
( cd gomachine && ./bin/gomachine verifyticket \
    -secret "$(grep ^WS_TICKET_SECRET= ../.env | cut -d= -f2-)" "$T" )   # → "OK …"
```

---

## Build

```sh
# Go binary (engine + hub + CLI)
cd gomachine && go build -o bin/gomachine ./cmd/gomachine
make build            # same thing
make test             # full suite (perft, search, hub, auth)
make cross            # release binaries → gomachine/dist/ (linux+darwin, amd64+arm64)

# Frontend production bundle → frontend/dist/
cd frontend && bun run build
bun run preview       # locally preview the built bundle
```

## Performance & load testing

> See **`docs/BENCHMARKING.md`** for the measured baselines, the full concurrency
> curves, and analysis. This section is the command reference.

Four tools measure **speed** (distinct from `bench sprt`, which measures
**strength**). Numbers below are from an 11-core arm64 box — treat them as a
baseline to regression-track, not absolutes.

**1. Hot-path microbenchmarks** (`go test -bench`) — movegen, make/unmake, eval,
and fixed-depth search NPS:

```sh
cd gomachine
go test -run '^$' -bench . ./internal/chess/ ./internal/eval/   # movegen, eval, perft NPS
go test -run '^$' -bench BenchmarkSearch -benchtime 3x ./internal/search/   # search Mnps @ depth 9
./bin/gomachine perft -depth 6                                   # quick movegen NPS (~56M nps)
```

Baselines: full legal movegen ~0.3–1.1µs/pos, static eval ~30–60ns, perft
~55 Mnps, single-thread search ~1.7–4.5 Mnps. Search is depth-fixed (not time)
so results are hardware-comparable across machines, like the SPRT harness.

**2. Live CPU/heap/goroutine profiling** (`-pprof` on either Go service):

```sh
./bin/gomachine serve -pprof 127.0.0.1:6480       # engine
./bin/gomachine hub   -pprof 127.0.0.1:6481        # hub (profile the Run goroutine)
go tool pprof http://127.0.0.1:6481/debug/pprof/profile?seconds=30   # CPU
go tool pprof http://127.0.0.1:6481/debug/pprof/heap                 # heap
curl 'http://127.0.0.1:6481/debug/pprof/goroutine?debug=1' | head    # goroutine count
```

pprof serves on its **own** listener/mux — off by default, never on the service
port. Pair it with the load test below to see where the hub spends time under load.

**3. Hub WebSocket load generator** (`gomachine loadtest`) — synthetic clients
that queue, get paired human-vs-human, and play random legal moves, isolating the
hub's single Run goroutine + broadcast fan-out (no engine/bot search involved):

```sh
# Stress an isolated hub (bots/fillers off; point BASEAPI at nothing so finished
# games don't spam a real API — the persist POST is fire-and-forget either way).
WS_TICKET_SECRET=dev-insecure-secret BASEAPI_URL=http://127.0.0.1:1 \
  ./bin/gomachine hub -addr 127.0.0.1:6499 -bots=false -watch-fillers=false &
WS_TICKET_SECRET=dev-insecure-secret \
  ./bin/gomachine loadtest -url ws://127.0.0.1:6499/ws -clients 100 -duration 30s

# -move-delay 0 = max stress (default); set e.g. -move-delay 2s to simulate humans.
```

It mints its own tickets with `WS_TICKET_SECRET` (must match the hub), so it needs
only the hub — not BaseAPI. UserIDs carry a per-run nonce (so a prior run's
reconnect-preserved games aren't reattached) and clients resign on exit (so runs
don't leave ghost games). Reports move throughput (the Run-goroutine rate) and
move→echo latency percentiles. Flags: `-clients -pool -duration -ramp -move-delay
-secret -url`.

Concurrency sweep on an 11-core box (max stress, `-move-delay 0`, 8s each):

| clients | live games | moves/sec | p50 | p95 | p99 |
|--:|--:|--:|--:|--:|--:|
| 10  | ~5   | 34k | 128µs | 512µs | 512µs |
| 50  | ~25  | 45k | 512µs | 2.0ms | 2.0ms |
| 100 | ~50  | 54k | 1.0ms | 2.0ms | 4.1ms |
| 200 | ~100 | 59k | 2.0ms | 4.1ms | 8.2ms |
| 400 | ~200 | 62k | 4.1ms | 8.2ms | 8.2ms |
| 800 | ~400 | 63k | 8.2ms | 16ms  | 16ms  |

Throughput plateaus ~**62k moves/sec** (the single Run goroutine saturating one
core); past that, added load shows up as latency, not lost moves — and these are
worst-case (zero think time). Real games at human pace are a tiny fraction of this.

**4. Engine search load** (`gomachine engineload`) — concurrent `/bestmove`
requests at a running `serve`, measuring the **AI scaling wall**: the engine
answers from a bounded pool of `-workers` engines, so this is the limit bot moves
and `/analyze` actually hit (and the path a PHP engine would replace).

```sh
./bin/gomachine serve -addr 127.0.0.1:6477 -workers 4 &
./bin/gomachine engineload -url http://127.0.0.1:6477 -concurrency 8 -movetime 100 -duration 15s
# limit per search: -movetime ms (default 100) | -depth N | -level 0..10
```

Concurrency sweep, 4-worker engine, `-movetime 100`:

| in-flight | searches/sec | mean lat | p50 |
|--:|--:|--:|--:|
| 1  | 11  | 88ms  | 131ms |
| 2  | 23  | 88ms  | 131ms |
| 4  | 44  | 89ms  | 131ms |
| 8  | 45  | 176ms | 262ms |
| 16 | 45  | 348ms | 524ms |

Throughput scales **linearly up to `-workers`**, then flat — excess requests queue
on the pool and become latency (0 lost). The wall moves with workers (cores
permitting): 4/8/10 workers → 44/90/112 searches/sec at the same ~88ms latency.
This is the real capacity knob for bot games at scale — `serve -workers N`
(keep `workers × search-threads ≤ cores`). Human-vs-human (tool #3) needs none
of it; only bot/analyze load touches the search pool.

## Engine strength testing — in-process self-play SPRT

The strength feedback loop is `gomachine bench sprt`: two configurations of the
**same binary** play game pairs against each other (reversed colors from a shared
opening) until an SPRT accepts H1 (the patch is an improvement) or H0 (it isn't).
The arbiter is our own perft-verified `internal/chess` + `engine.Adjudicate` —
**no UCI, no Stockfish, no subprocesses**. Games run at **fixed nodes** so results
are reproducible and hardware-independent. Stats are the pentanomial GSPRT.

A patch is a `search.Params` diff. `--old` is the baseline, `--new` is the patch;
each is a comma-separated spec applied on top of the full-strength default:

```
tt=on|off   nullmove=on|off   nullr=<int>   lmr=on|off   checkext=on|off
```

```sh
cd gomachine && go build -o bin/gomachine ./cmd/gomachine

# Validate the harness: full strength vs a deliberately weakened engine
# should read as clearly +Elo and accept H1.
./bin/gomachine bench sprt --new "" --old "tt=off,nullmove=off,lmr=off" \
  --nodes 10000 --elo0 0 --elo1 30

# Gate a real patch (once it's wired behind a Params flag), the standard loop:
./bin/gomachine bench sprt --new "see=on" --old "see=off" --elo0 0 --elo1 5
```

Key flags (see `bench sprt -h`): `--nodes` (fixed nodes/move, primary),
`--movetime` (use instead of nodes for time-dependent features), `--elo0/--elo1`
(SPRT bounds), `--alpha/--beta` (error rates, default 0.05), `--concurrency`
(default = NCPU), `--maxpairs` (hard cap), `--tt` (MB/engine), `--book`
(`.epd`/`.fen` or UCI move-lines; default: a built-in balanced book),
`--new-threads`/`--old-threads` (Lazy SMP — use with `--movetime`). Ctrl-C ends
early and prints the result so far.

Param spec keys: `tt nullmove nullr lmr checkext see delta asp rfp lmp mobility
pawns kingsafety bishoppair eval` (`eval` toggles all knowledge terms at once).

**Workflow:** implement an improvement behind a new `search.Params` flag, SPRT-gate
`flag=on` vs `flag=off`; if H1, make it the default and re-baseline.

### Absolute Elo anchor & watching games

```sh
# Anchor our strength against Stockfish (handicapped via UCI_Elo). NOISY — a band,
# not a number; gate patches on the SPRT, not this. Latest: ≈2720 ± 79 vs SF-2500
# (100 games, 78%, 2026-06-19, post-tuned-eval).
./bin/gomachine bench vs-stockfish --sf /opt/homebrew/bin/stockfish \
  --sf-elo 2500 --movetime 100 --games 60 --threads 4

# Watch a single game vs full-strength Stockfish.
./bin/gomachine bench game --sf-skill 20 --movetime 300 --color white --threads 4
```

### Texel tuning (`gomachine tune`) — SHIPPED, +101 Elo

Fits the **whole eval as one linear model** (PSQT/material + knowledge terms,
jointly) by Adam gradient descent on WDL-labelled quiet positions, and writes
`internal/eval/tuned_tables.go`. The tuned eval is **on by default**
(`search.DefaultParams`).

```sh
# tune on a quiet-labelled EPD dataset (Lichess), write tuned tables, then SPRT:
./bin/gomachine tune --epd quiet-labeled.epd --out internal/eval/tuned_tables.go
go build -o bin/gomachine ./cmd/gomachine
./bin/gomachine bench sprt --new "tuned=on" --old "" --movetime 100 --elo0 0 --elo1 6

# or self-play instead of a dataset (slower); --lambda blends in our own eval:
./bin/gomachine tune --games 5000 --lambda 0.7
```

> **Result:** tuned eval = **+128 ± 35 @ 40k nodes, +101 ± 29 @ 100ms/move**
> (SPRT-accepted), lifting the Stockfish anchor ~2600 → **~2720**. This *replaced*
> the old −148 Elo failure, which was a broken **method** (coordinate-descent MSE,
> distilled-cp target, frozen PSQT), not a verdict on HCE. Full story, techniques,
> and the dataset in **`docs/ENGINE_STRENGTH.md`**.

## Database / migrations

Schema is driven by the models — **never** hand-write SQL/DDL.

```sh
php mason migrate:generate     # diff models → storage/migrations.json
php mason migrate:apply -y     # apply ALL pending migrations (never --safe)
```

---

## Seeding puzzles (SPEC §9)

Puzzles are seeded from the **Lichess open puzzle database (CC0)** — large, and
**not committed**. Run the migrations first (creates `puzzle` / `puzzle_theme` /
`puzzle_attempt`), then download + import:

```sh
# 1. Download + decompress the CC0 puzzle CSV (~1 GB uncompressed, ~6M puzzles)
curl -L https://database.lichess.org/lichess_db_puzzle.csv.zst -o puzzles.csv.zst
zstd -d puzzles.csv.zst -o lichess_db_puzzle.csv

# 2. Bulk import (batched INSERT IGNORE — re-run safe). Filters are optional:
php scripts/import_puzzles.php lichess_db_puzzle.csv \
    --limit=200000 --min-popularity=50            # a healthy starter subset
# php scripts/import_puzzles.php lichess_db_puzzle.csv   # everything
# flags: --limit=N --min-rating=N --max-rating=N --min-popularity=N --themes=a,b
```

A tiny `scripts/sample_puzzles.csv` (legal-but-synthetic) exists only for
smoke-testing the importer + endpoints without the multi-GB download.

---

## Production

Live at **https://chessgo.timanthonyalexander.de** (SPA) +
**https://chessgo-api.timanthonyalexander.de** (API + `/ws`), behind Cloudflare
(proxied, Full/strict TLS). Prod runs the two Go binaries as systemd services,
PHP behind PHP-FPM (pool user **`www-data`**), and nginx serves the static
frontend build + reverse-proxies the API and the WebSocket. The engine (6466) and
hub (6467) bind to `127.0.0.1` only; nginx exposes just the hub's `/ws`.

> The nginx vhost is committed at **`config/nginx/chessgo.conf`** (two server
> blocks) and symlinked into `sites-enabled`. Read the **Critical prod gotchas**
> below before deploying — every one of them cost real debugging.

### Server tooling

- **Go 1.25+** is required by `go.mod`. The system `go` may be older and the
  auto-toolchain download can be blocked (`toolchain not available`). Install a
  local toolchain once and build with it:
  ```sh
  VER=$(curl -s 'https://go.dev/dl/?mode=json' | grep -oE 'go1\.25\.[0-9]+' | sort -uV | tail -1)
  mkdir -p ~/go1.25 && curl -fsSL "https://go.dev/dl/${VER}.linux-amd64.tar.gz" \
    | tar -C ~/go1.25 --strip-components=1 -xz
  ( cd gomachine && GOTOOLCHAIN=local ~/go1.25/bin/go build -o bin/gomachine ./cmd/gomachine )
  ```
- **bun** is at `~/.bun/bin` (not on the non-interactive `PATH` —
  `export PATH="$HOME/.bun/bin:$PATH"`).

### Go services (systemd)

Run as **`tim`** (owns the binary; the services need no DB and write nothing).

`/etc/systemd/system/chessgo-engine.service`:

```ini
[Unit]
Description=chessgo engine (rules + AI)
After=network.target

[Service]
WorkingDirectory=/var/www/chessgo/gomachine
ExecStart=/var/www/chessgo/gomachine/bin/gomachine serve -addr 127.0.0.1:6466 -workers 2 -search-threads 2
Restart=always
RestartSec=3
User=tim
Group=tim
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/chessgo-hub.service`:

```ini
[Unit]
Description=chessgo realtime hub (websocket)
After=network.target

[Service]
WorkingDirectory=/var/www/chessgo/gomachine
EnvironmentFile=/var/www/chessgo/.env.hub          # contains WS_TICKET_SECRET=...
ExecStart=/var/www/chessgo/gomachine/bin/gomachine hub -addr 127.0.0.1:6467 -bot-search-threads 2
Restart=always
RestartSec=3
User=tim
Group=tim
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

`/var/www/chessgo/.env.hub` (mode 600), read by the hub via Go `os.Getenv`:

```sh
WS_TICKET_SECRET=<same value as the PHP .env>
BASEAPI_URL=https://chessgo-api.timanthonyalexander.de
```

- `WS_TICKET_SECRET` **must equal** the PHP `.env` value, or the hub rejects every
  ticket (it's also the `X-Hub-Secret` the hub sends to `/internal/games`).
- `BASEAPI_URL` is where the hub POSTs finished games. In prod it's the **public
  API URL**, NOT `127.0.0.1:6464` — PHP runs under FPM with no local HTTP port.
  `/internal/games` is secret-gated, so the public round-trip is fine.

> **Lazy SMP is on in prod via those `ExecStart` flags.** The box is **4 cores
> shared by `serve`+`hub`**, so the balanced config is `serve -workers 2
> -search-threads 2` (2 concurrent searches, each 2-thread SMP) and `hub
> -bot-search-threads 2` (the hub bot pool auto-sizes workers to `NumCPU()/2 = 2`,
> so 2×2 = 4). Keep `workers × search-threads ≤ cores`. These live in the systemd
> units (above), **not** in `chessgo-deploy` — the deploy only `git pull`s, builds,
> and `systemctl restart`s, so it never re-reads the units. To change the thread
> balance: edit the `ExecStart` line, then `sudo systemctl daemon-reload &&
> sudo systemctl restart chessgo-engine chessgo-hub`. Confirm via
> `journalctl -u chessgo-engine -n5` (`… N SMP threads/search`). Watch fillers are
> always serial (cosmetic, no flag).

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now chessgo-engine chessgo-hub
sudo systemctl restart chessgo-engine chessgo-hub   # after rebuilding the Go binary
```

### nginx + TLS

The vhost is committed at **`config/nginx/chessgo.conf`** — a frontend block on
the root domain and an API block on `chessgo-api…` carrying the `/ws` proxy. It
reuses the box's shared `include global;` (listen 443 + ssl params) and
`include php;` (FPM fastcgi) snippets, so it has no `listen`/`fastcgi` lines of
its own.

```sh
sudo ln -s /var/www/chessgo/config/nginx/chessgo.conf /etc/nginx/sites-enabled/chessgo.conf
sudo certbot --nginx -d chessgo.timanthonyalexander.de -d chessgo-api.timanthonyalexander.de
sudo nginx -t && sudo systemctl reload nginx
```

The committed config points at the **real** `chessgo.timanthonyalexander.de` LE
cert (one SAN cert covers both domains). The `/ws` location is an **exact match**
(`location = /ws`) — see the gotchas below.

### Critical prod gotchas (each cost real debugging)

- **`.env` MUST be readable by the FPM pool (`www-data`) — never `600`.**
  ```sh
  sudo chgrp www-data /var/www/chessgo/.env && sudo chmod 640 /var/www/chessgo/.env
  ```
  If FPM can't read `.env`, Dotenv loads nothing and **every** value silently
  falls back to framework defaults (DB→`baseapi`, CORS→localhost, ws secret→
  insecure) — the app "boots" but is wrong everywhere. CLI (run as `tim`) hides
  this because it can read the file.
- **Read custom env via `App::config()`, never `$_ENV` directly.** Under PHP-FPM
  `variables_order` has no `E`, so `$_ENV` is empty on a worker's 2nd+ request
  (`App::boot()`'s Dotenv load is guarded by a static flag that persists in the
  long-lived worker). Resolve env in a `config/app.php` block (e.g. `gomachine`)
  at boot and read it via `App::config('gomachine.*')` — that value is captured
  into a static and survives. (Mirrors how brandinio exposes its custom env.)
- **After changing `.env` or `config/app.php`, `restart` php-fpm — not `reload`.**
  Workers cache the booted config in a static for their lifetime; a graceful
  reload won't re-read it. `sudo systemctl restart php8.4-fpm` (shared across
  sites — a sub-second blip, doesn't break them).
- **nginx `/ws` must be an EXACT match (`location = /ws`).** A prefix match
  (`^~ /ws`) also captures `/ws-ticket` (a PHP route) and proxies it to the hub,
  breaking ticket minting.
- **Cloudflare 526 = wrong/placeholder origin cert.** With Full/strict the origin
  must present a valid cert for the hostname. Keep the real cert path committed in
  `chessgo.conf`; a `git reset`/redeploy that reverts it to a placeholder triggers
  526. Check the origin directly:
  ```sh
  echo | openssl s_client -connect 127.0.0.1:443 -servername chessgo-api.timanthonyalexander.de 2>/dev/null | openssl x509 -noout -subject
  ```

### Deploy checklist

```sh
cd /var/www/chessgo
# pull (the server's GitHub key isn't in the agent for non-interactive shells)
GIT_SSH_COMMAND='ssh -i ~/.ssh/id_ed25519_github -o IdentitiesOnly=yes' git pull
composer install --no-dev
php mason migrate:apply -y                                  # never --safe
( cd gomachine && GOTOOLCHAIN=local ~/go1.25/bin/go build -o bin/gomachine ./cmd/gomachine )
( cd frontend && export PATH="$HOME/.bun/bin:$PATH" && bun install \
    && VITE_API_URL=https://chessgo-api.timanthonyalexander.de bun run build )
sudo systemctl restart chessgo-engine chessgo-hub          # Go binary changed
sudo systemctl restart php8.4-fpm                          # pick up code/.env/config (restart, not reload)
sudo nginx -t && sudo systemctl reload nginx
```

> `frontend/dist` and `.env.hub` are gitignored — `dist` is rebuilt on deploy,
> `.env.hub` is host-local. The frontend build needs `VITE_API_URL` set to the
> prod API origin (it's baked into the bundle).

---

## Environment (`.env`) — keys that matter here

| Key | Used by | Dev | Prod |
|---|---|---|---|
| `APP_ENV` / `APP_DEBUG` | BaseAPI | `local` / `true` | `production` / `false` |
| `APP_URL` | BaseAPI | `http://127.0.0.1:6464` | `https://chessgo-api.timanthonyalexander.de` |
| `CORS_ALLOWLIST` | BaseAPI | `…:6465` | `https://chessgo.timanthonyalexander.de` |
| `DB_*` | BaseAPI | `chessgo` user | same (prod password) |
| `ENGINE_URL` | BaseAPI (`gomachine.engine_url`) | `http://127.0.0.1:6466` | same (internal) |
| `HUB_URL` | BaseAPI `/stats` proxy (`gomachine.hub_url`) | `http://127.0.0.1:6467` | same (internal) |
| `WS_TICKET_SECRET` | BaseAPI **and** hub `.env.hub` | dev secret | **must match** both sides |
| `WS_TICKET_TTL` | BaseAPI | `60` | `60` |
| `WS_PUBLIC_URL` | BaseAPI → client | `ws://127.0.0.1:6467/ws` | `wss://chessgo-api.timanthonyalexander.de/ws` |
| `BASEAPI_URL` | **hub** (`.env.hub`) → PHP | `http://127.0.0.1:6464` | `https://chessgo-api.timanthonyalexander.de` |

> All `ENGINE_URL` / `HUB_URL` / `WS_*` keys are resolved in `config/app.php`
> (the `gomachine` block) and read via `App::config('gomachine.*')`. Reading
> `$_ENV` directly fails under FPM — see the prod gotcha above. The internal
> service URLs stay on `127.0.0.1`; only `WS_PUBLIC_URL` (browser→hub) and
> `BASEAPI_URL` (hub→PHP) use the public hostname.
