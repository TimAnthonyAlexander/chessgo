# chessgo

A chess website and a chess engine, both in this repo. The website runs in production at [chessgo.timanthonyalexander.de](https://chessgo.timanthonyalexander.de). The engine, `gomachine`, is a standalone Go program that plays in the ~3500 CCRL Blitz range and speaks UCI.

Every rule, the move generator, the evaluation, and the search are written from scratch in Go. No external chess library. The website calls the engine over HTTP and a WebSocket; the engine has no dependency on the website and runs on its own.

## gomachine

One self-contained binary. Evaluation network and opening book are compiled in, so it runs from any directory with nothing else to download.

### Strength

**~3500 CCRL Blitz**, tested at full strength against a range of CCRL-rated engines.

Development uses self-play **SPRT** (sequential probability ratio test): a change plays the previous version until the test decides it is an improvement or it is rejected. Nothing ships on a hunch. Full method and every result with confidence intervals: [docs/ENGINE_STRENGTH.md](docs/ENGINE_STRENGTH.md).

### What's in it

- **Move generation**: bitboards + magic bitboards, verified against known perft node counts.
- **Evaluation**: `(768→512)×2→1` SCReLU NNUE trained on Stockfish-labelled positions, int16 incremental accumulator, hand-written AVX2/NEON SIMD inference. Falls back to a Texel-tuned hand-crafted eval if no net is loaded.
- **Search**: alpha-beta with SEE, null-move pruning, late move reductions, reverse futility and late-move pruning, aspiration windows, singular extensions, correction history, futility pruning.
- **Parallelism**: Lazy SMP over a lock-free transposition table, byte-identical to the serial search at one thread.
- **Endgames**: 5-piece Syzygy tablebases, probed at the root and inside the search (optional, not bundled).

Strength was built in SPRT-gated layers: search patches (~+250 Elo), Lazy SMP (~+97), Texel-tuned eval replacing the piece-square baseline (+101), Syzygy (+18 to +33 on endgame books), NNUE replacing the hand-crafted eval (+212), a wider net with SIMD (+101), then correction history / singular / futility (~+110 at fixed nodes).

Top engines (~3700+ CCRL) are still ahead. Remaining levers, a wider network, more training data, SPSA tuning, are in the strength doc.

### Build

Go 1.25+:

```sh
git clone https://github.com/TimAnthonyAlexander/gomachine
cd gomachine
go build -o gomachine ./cmd/gomachine
```

Or `go install github.com/timanthonyalexander/gomachine/cmd/gomachine@latest`. Prebuilt binaries for macOS, Linux, Windows are on [Releases](https://github.com/TimAnthonyAlexander/gomachine/releases), and `brew install timanthonyalexander/tap/gomachine`.

### Use

UCI, for any GUI (Arena, Cute Chess, BanksiaGUI) or lichess-bot:

```sh
gomachine uci
```

Other subcommands:

```sh
gomachine bestmove -fen "<FEN>" -depth 12      # one-shot best move
gomachine perft -depth 5                        # movegen self-check
gomachine bench sprt --new "..." --old "..."    # self-play strength test
gomachine help                                  # everything else
```

Tablebases are optional. Point at a Syzygy set with `SYZYGY_PATH=/path/to/syzygy` or `-tb-path`. Without them the engine is full strength except in the deepest endgames.

## Website

No account needed to play. Bot games, puzzles, and casual live games all work as a guest. An account adds ratings, which are required for rated games (both players logged in).

- **Live games**: rating-proximity matchmaking (the acceptable gap widens the longer you wait, capped at 400). Server-side clocks that start Lichess-style: neither clock runs until both players have moved, and a stalled first move aborts. Chat, draw and takeback offers, resign, premoves, opponent-disconnected status, reconnect and resume after closing the tab. If no human turns up, a rating-matched bot fills in and that game is rated one-sided.
- **Ratings**: Glicko-2 tracked separately for bullet, blitz, rapid, and classical. Provisional until the deviation tightens; regrows when you sit out. A separate puzzle rating.
- **Play the computer**: pick an opponent strength on a 700–2900 Elo slider (labelled Beginner through Master), choose White, Black, or random, and play untimed. Undo, resign, live eval bar, premoves. Unrated.
- **Puzzles**: Puzzle-Rush-style sessions. Pick a theme (mate-in-1/2/3, fork, pin, skewer, discovered attack, sacrifice, endgame, and more) and a timed format (1:00 Sprint, 3:00 Blitz, 5:00 Marathon, or untimed), then solve as many as you can while a streak strip tracks hits and misses. Positions are Lichess-seeded and matched to your puzzle rating; solutions are validated server-side and never sent to the browser. Includes a deterministic daily puzzle.
- **Analysis board**: load a finished game or start from any position. Streams engine eval to depth ~22, draws the best-move arrow, shows the principal variation and a move tree of the lines you explore, and reviews a whole game with per-player accuracy and inaccuracy/mistake/blunder counts. Opening explorer with book moves; auto-play and auto-best replay.
- **Editor**: set up any position (place pieces, side to move, castling rights), watch a live eval bar update as you edit, copy the FEN, then jump straight into analysis or a bot game from that position.
- **Watch and spectate**: a grid of the strongest live games with names, ratings, clocks, and a mini board; click to watch one move by move without disturbing your own game.
- **Also**: challenge a friend by 6-character code or link (any time control, rated or casual), player profiles with record and rating history, per-category leaderboards, move sounds.

### Run locally

Four services plus MySQL: PHP backend (BaseAPI), React frontend (Vite, Bun), the engine (`gomachine serve`), and the realtime hub for live games (`gomachine hub`). Engine and hub are the same binary under different subcommands.

```sh
./mason serve --screen                      # PHP API on :6464
gomachine serve                             # engine on :6466
WS_TICKET_SECRET=… gomachine hub            # hub on :6467
cd frontend && bun run dev                  # frontend on :6465
```

Open <http://127.0.0.1:6465>. Full setup and deployment: [docs/COMMANDS.md](docs/COMMANDS.md). Design: [docs/SPEC.md](docs/SPEC.md).

## Layout

- `app/` — PHP backend (BaseAPI), routes in `routes/api.php`
- `frontend/` — React + Vite + TypeScript + MUI
- `gomachine/` — the engine; rules core in `internal/chess` (single source of truth for chess), eval and search in `internal/{eval,search,nnue}`, realtime hub in `internal/hub`
- [CLAUDE.md](CLAUDE.md) — fast orientation for the whole codebase

## License

GPLv3. See [LICENSE](LICENSE). Derivative work stays open under the same terms.
