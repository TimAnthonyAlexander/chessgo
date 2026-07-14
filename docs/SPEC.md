# chessgo — Product Spec

The product design: what chessgo does and how the pieces fit for a user. For how
the services are wired see [ARCHITECTURE.md](ARCHITECTURE.md); to run it see
[COMMANDS.md](COMMANDS.md); for the engine internals see
[../zugzwang/CLAUDE.md](../zugzwang/CLAUDE.md).

## Guiding principle

The engine (**zugzwang**) is the centerpiece and the single authority on chess
rules and AI, exposed as a stateless HTTP service. The website is the front door
to it. Anyone can play as a guest; an account only adds ratings.

## Accounts & auth

- Anonymous play works for everything casual: a stable per-browser id backs bot
  games, puzzles, and casual live games.
- Email/password accounts (session cookies) unlock **rated** play. API tokens are
  supported for programmatic access.
- Rated requires accounts on both sides (a logged-in human vs a fill-in bot is
  rated one-sided).

## Play

### Live human-vs-human (`/game/:id`)

WebSocket hub with rating-proximity matchmaking (the acceptable gap widens with
wait time, capped at 400; anonymous treated as 1500). Server-authoritative clocks
start Lichess-style — neither clock runs until both players have made their first
move, and a stalled first move aborts after 30s (not persisted). In-game: resign,
draw offers (accept → draw by agreement), consensual takebacks, players-only chat,
premoves, opponent-disconnected status, reconnect and resume (in-memory — survives
tab close/refresh, not a hub restart), move list, board flip, legal-move dots,
last-move highlight, right-click arrows/squares, sounds.

**Bot backfill.** If no human arrives in ~15s, a rating-matched engine bot fills in
(displayed rating ±120 of the user; looks like a real player). Rated one-sided for
a logged-in human. When the opponent is a fill-in bot, chat is OpenAI-voiced.

### Vs the computer (`/bot`)

Pick strength on a **700–2900 Elo slider** (Beginner → Master), choose White,
Black, or random, play untimed. Undo, resign, a live eval bar, premoves. Always
**unrated**; never touches the hub (goes straight to the engine via PHP).

### Challenge a friend (`/challenge/:code`)

Private invite by 6-character code or link; custom time control, color preference,
rated toggle (needs both accounts). Hub-held and ephemeral (~30-min TTL).

### Variants

Each is a self-contained engine module in zugzwang (own eval + search, not the
shared NNUE):

- **Chess960** — random back-rank start; castling generalized in the core rules.
- **Crazyhouse** — captured pieces go to your pocket and can be dropped; pocket-
  aware evaluation.
- **Duck Chess** — a duck blocks a square each turn; king-capture wins, no check.

### Guess-the-Elo (`/guess-the-elo`)

The engine plays a full self-play game at a secret target Elo; you see only the
moves and guess the rating.

## Puzzles (`/puzzles`)

Lichess-seeded, rating-matched, with the solution validated server-side and never
sent to the browser. **Puzzle-Rush-style timed sessions** — 1:00 Sprint, 3:00
Blitz, 5:00 Marathon, or untimed — with a streak strip tracking hits and misses.
Theme filter (mate-in-1/2/3, fork, pin, skewer, discovered attack, sacrifice,
endgame, …). A deterministic **daily puzzle** (`/puzzles/daily`).

## Analysis & tools

- **Analysis board** (`/analysis`, `/analysis/:id`) — eval bar streaming to ~depth
  22, best-move arrow, principal variation, a branching move tree, per-move
  judgments (best/good/inaccuracy/mistake/blunder), full-game review with
  per-player accuracy (cached), replay/flip/FEN import, Chess960 randomize, an
  opening explorer with book moves, and an optional Stockfish second-opinion arrow.
- **Position editor** (`/editor`) — place pieces, set side-to-move and castling
  rights, watch a live eval bar, copy the FEN, then hand off to analysis or a bot
  game.
- **Watch / spectate** (`/watch`, `/watch/:id`) — a grid of the strongest live
  games (mini-boards, names, ratings, clocks); click to spectate one on a dedicated
  read-only socket that never disturbs your own game. Engine-vs-engine fillers pad
  the lobby only while someone is watching (never persisted, never rated).

## Ratings

Per-time-control **Glicko-2** — bullet, blitz, rapid, classical (category derived
from the time control) — plus a fifth **isolated puzzle** rating. Each carries a
rating (start 1500), deviation (RD, start 350), and volatility. RD sets step size
and regrows when you sit out; the rating is provisional while RD is high (cosmetic,
doesn't gate matchmaking). Rated one game at a time — no rating periods. See
[../gomachine/docs/ELO_SYSTEM.md](../gomachine/docs/ELO_SYSTEM.md) for the full
rules (still accurate).

## Social & admin

- **Profiles** (`/@/:name`) — per-category ratings + W/L/D + paginated game history.
- **Leaderboards** (`/leaderboard`) — per category.
- **The Flame** (`/streak`) — a daily-activity streak widget.
- **Homepage** — quick pairing across the four time controls + a Duck tile,
  shortcuts (computer, puzzles, analysis, challenge-a-friend), daily puzzle, recent
  games, a live game preview, a leaderboard, and players-online + games-in-play
  counts.
- **Admin** (`/admin/*`, role-gated) — dashboard, user directory, persisted-game
  log, anti-cheat review (advisory flags only — detection flags, an admin decides),
  and an Engine-vs-Engine board (engine vs Stockfish, one ply at a time).

## Persistence model

Durable data lives in MySQL, written only by PHP. Models (singular snake_case
tables): `User` (per-category + puzzle rating triples), `Game`, `BotGame`,
`GuessGame`, `Puzzle`, `PuzzleAttempt`, `PuzzleTheme`, `ApiToken`, `FlaggedUser`,
`UserFlag`. Live game state lives only in the hub's memory until the game ends,
when it's persisted via `POST /internal/games`.

## Deferred / roadmap

PGN export (game history exists, PGN not); hub-restart-durable resume; a puzzle
generation pipeline; more lobby/time-control types; precise level↔Elo calibration;
draw-offer rate-limiting; a Glicko-2 color-advantage term. Engine backlog is under
[tasks/open/](tasks/open/).
