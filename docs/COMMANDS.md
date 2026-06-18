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

Prod runs the two Go binaries as long-lived services, PHP behind PHP-FPM, and
nginx serves the static frontend build + reverse-proxies the API and the
WebSocket. The engine (6466) stays internal (only PHP reaches it).

### Go services (systemd)

`/etc/systemd/system/chessgo-engine.service`:

```ini
[Unit]
Description=chessgo engine (rules + AI)
After=network.target

[Service]
WorkingDirectory=/var/www/chessgo/gomachine
ExecStart=/var/www/chessgo/gomachine/bin/gomachine serve -addr 127.0.0.1:6466
Restart=always
User=chessgo

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
User=chessgo

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now chessgo-engine chessgo-hub
sudo systemctl restart chessgo-hub          # after a redeploy
```

> `/var/www/chessgo/.env.hub` must hold the **same** `WS_TICKET_SECRET` as the PHP
> app's `.env`, or every WebSocket connection will be rejected.

### nginx

```nginx
# --- Frontend (static SPA) ---
server {
    server_name chessgo.example.com;
    root /var/www/chessgo/frontend/dist;

    location / {
        try_files $uri /index.html;        # SPA fallback
    }
}

# --- API + WebSocket (api.chessgo.example.com) ---
server {
    server_name api.chessgo.example.com;
    root /var/www/chessgo/public;              # BaseAPI front controller
    index index.php;

    # Realtime hub: WebSocket upgrade → Go hub on 6467
    location /ws {
        proxy_pass http://127.0.0.1:6467/ws;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 3600s;          # long-lived connections
        proxy_send_timeout 3600s;
    }

    # REST API → PHP-FPM
    location / {
        try_files $uri /index.php$is_args$args;
    }
    location ~ \.php$ {
        fastcgi_pass unix:/run/php/php8.4-fpm.sock;
        include fastcgi_params;
        fastcgi_param SCRIPT_FILENAME $document_root/index.php;
    }
}
```

Put both behind TLS (certbot). The hub is reached as `wss://api.chessgo.example.com/ws`.

### Deploy checklist

```sh
git pull
composer install --no-dev
php mason migrate:apply -y
( cd gomachine && go build -o bin/gomachine ./cmd/gomachine )
( cd frontend && bun install && bun run build )
sudo systemctl restart chessgo-engine chessgo-hub
sudo systemctl reload php8.4-fpm nginx
```

---

## Environment (`.env`) — keys that matter here

| Key | Used by | Notes |
|---|---|---|
| `APP_PORT` / `APP_URL` | BaseAPI | API bind (dev `6464`) |
| `CORS_ALLOWLIST` | BaseAPI | must include the frontend origin |
| `DB_*` | BaseAPI | MySQL connection (`chessgo` user) |
| `ENGINE_URL` | BaseAPI | where PHP reaches the engine (`http://127.0.0.1:6466`) |
| `WS_TICKET_SECRET` | BaseAPI **and** hub | **must match** on both sides |
| `WS_TICKET_TTL` | BaseAPI | ticket lifetime (seconds) |
| `WS_PUBLIC_URL` | BaseAPI → frontend | ws URL the client dials (dev `ws://127.0.0.1:6467/ws`; prod `wss://…/ws`) |

Prod: set `APP_URL`, `CORS_ALLOWLIST` to the real frontend origin, and
`WS_PUBLIC_URL=wss://api.chessgo.example.com/ws`.
