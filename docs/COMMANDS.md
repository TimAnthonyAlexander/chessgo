# chessgo — Run & Deploy Commands

How to build, run, and deploy every part of chessgo. See `docs/SPEC.md` for the
architecture.

## Services & ports

| Service | What | Dev bind | Prod |
|---|---|---|---|
| **MySQL** | durable data (users, games, ratings) | `127.0.0.1:3306` | `127.0.0.1:3306` |
| **BaseAPI** (PHP) | REST API: auth, games, matchmaking ticket, persistence | `127.0.0.1:6464` | nginx + PHP-FPM |
| **gomachine engine** (Go) | internal HTTP: rules + AI (`/bot`, `/analyze`) | `127.0.0.1:6466` | internal only (PHP calls it) |
| **gomachine hub** (Go) | realtime WebSocket: matchmaking + live games | `127.0.0.1:6467` | nginx `wss://…/ws` proxy |
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

### Managing the screens

```sh
screen -ls                         # list sessions
screen -r chessgo-hub              # attach (detach again with Ctrl-a d)
screen -S chessgo-hub -X quit      # stop one
# restart = quit, then re-run its start command above
```

### Health checks

```sh
curl -s 127.0.0.1:6464/health           # BaseAPI
curl -s 127.0.0.1:6466/healthz          # engine
curl -s 127.0.0.1:6467/healthz          # hub
curl -s 127.0.0.1:6467/stats            # hub live counts {playersOnline, activeGames}
curl -s 127.0.0.1:6464/stats            # same, via the BaseAPI proxy (homepage uses this)
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
`--elo0/--elo1` (SPRT bounds), `--alpha/--beta` (error rates, default 0.05),
`--concurrency` (default = NCPU), `--maxpairs` (hard cap), `--tt` (MB/engine),
`--book` (`.epd`/`.fen` or UCI move-lines; default: a built-in balanced book).
Ctrl-C ends early and prints the result so far.

**Workflow:** implement one improvement behind a new `search.Params` flag,
SPRT-gate `flag=on` vs `flag=off`; if H1, make it the default and re-baseline.
Absolute Elo vs Stockfish (a thin UCI adapter) is a later, decoupled add-on —
self-play SPRT only says "new beats old", not the absolute number.

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
ExecStart=/var/www/chessgo/gomachine/bin/gomachine serve -addr 127.0.0.1:6466
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
ExecStart=/var/www/chessgo/gomachine/bin/gomachine hub -addr 127.0.0.1:6467
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
