# chessgo

A website to play chess against other people and against a chess engine, with all the rules and the AI written from scratch in Go.

You can play rated games with live clocks against other players, play casual games against the bot at a range of strengths, solve tactical puzzles, watch games in progress, and look back at any finished game with engine analysis. The engine that runs all of this, `gomachine`, is a separate program you can download and use on its own.

Live at [chessgo.timanthonyalexander.de](https://chessgo.timanthonyalexander.de).

## What you can do

**Play other people.** The matchmaker pairs you with someone near your rating and widens the gap the longer you wait, so a 1200 and a 2000 don't end up across the board from each other. Clocks run server-side in the Lichess style: neither clock starts until both players have made a move, and a stalled first move aborts the game instead of flagging you. If you close the tab and come back, the game is still there.

**Play the bot.** Pick a level from 0 to 10 and play without an account. If you're logged in and waiting for a human match, a bot rated close to you will fill in after a short wait and play at a believable pace, so the lobby rarely leaves you hanging. Those fill-in games count toward your rating; explicit practice games against the bot don't.

**Get a rating that means something.** Ratings are Glicko-2, tracked separately for bullet, blitz, rapid, and classical. New accounts start provisional and tighten as you play. Sit out for a while and the system grows less certain about you again, the way it should.

**Solve puzzles.** Tactical positions seeded from the Lichess puzzle set, matched to your puzzle rating and filtered by theme. The puzzle rating is kept apart from your game ratings, so a bad day at tactics won't touch your blitz number. The solution is checked on the server and never sent to the browser, so it can't be peeked at.

**Watch and review.** The Watch page shows the strongest games in progress; click one to spectate live without disturbing your own game. Every finished game can be opened on an analysis board that runs the engine move by move and marks the mistakes. Player profiles show ratings, win/loss record, and game history.

**Premoves, sound, the usual comforts.** Queue a move during your opponent's turn and it plays the instant it becomes legal. Move sounds, board editor, the small things that make it feel like a real board.

## The engine: gomachine

`gomachine` is the whole chess brain in one Go program. It owns the rules (bitboard move generation with magic bitboards, verified against known perft counts), the evaluation, and the search. The website talks to it over HTTP and WebSocket, but the engine has no idea the website exists. You can run it by itself.

### How strong is it

At 100 milliseconds per move it plays around 2780 on Stockfish's UCI_Elo scale. That number comes from playing handicapped Stockfish and reading off the score difference, and it's noisy, so treat it as a band around 2780 rather than a precise figure. The number we actually trust is self-play SPRT: every change to the engine has to win more games than the version before it, measured by a sequential probability ratio test, or it doesn't ship.

The strength came in layers, each one gated by SPRT:

- A stack of search improvements: static exchange evaluation, several pruning methods, aspiration windows (about +250 Elo together at real time controls).
- Lazy SMP multithreading over a lock-free transposition table (about +97 Elo at four threads).
- A Texel-tuned hand-crafted evaluation that replaced the plain piece-square baseline (+101 Elo).
- Five-piece Syzygy endgame tablebases, probed at the root and inside the search (+18 to +33 Elo on endgames).
- An NNUE network, which is now the default evaluation and added another +212 Elo over the tuned hand-crafted eval.

The NNUE is a `(768→256)×2→1` SCReLU network trained on Stockfish-evaluated positions, running an int16 incremental accumulator so it's fast enough to evaluate at every node under a clock. Full strength bot moves and the analysis board use it; weakened bots stay weak on purpose so the rating-to-level mapping holds.

For the long version, the testing harness, and every result with its confidence interval, read [docs/ENGINE_STRENGTH.md](docs/ENGINE_STRENGTH.md).

To be clear about the ceiling: full-strength Stockfish (around 3650) is still several hundred Elo above gomachine. This is a strong engine, not a top engine, and the remaining levers (a more mature net, SIMD, a wider network) are written up in the strength doc.

### Install it

The engine is one self-contained binary. The evaluation network and opening book are compiled into it, so you can run it from any directory with no extra files to download.

Build it from source (you need Go 1.25 or newer):

```sh
git clone https://github.com/TimAnthonyAlexander/gomachine
cd gomachine
go build -o gomachine ./cmd/gomachine
```

Or install straight to your `$GOBIN`:

```sh
go install github.com/timanthonyalexander/gomachine/cmd/gomachine@latest
```

Prebuilt binaries for macOS, Linux, and Windows are on the [Releases](https://github.com/TimAnthonyAlexander/gomachine/releases) page if you'd rather not build. On macOS and Linux you can also use Homebrew:

```sh
brew install timanthonyalexander/tap/gomachine
```

Endgame tablebases are optional and not bundled (the full set is large). If you want them, download a Syzygy set and point the engine at it with `SYZYGY_PATH=/path/to/syzygy` or the `-tb-path` flag. Without tablebases the engine plays at full strength everywhere except the deepest endgames.

### Use it

The engine speaks UCI, so it drops into any chess GUI (Arena, Cute Chess, BanksiaGUI) or a lichess-bot setup:

```sh
gomachine uci
```

For a one-shot best move from a position:

```sh
gomachine bestmove -fen "r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4" -depth 12
```

Other subcommands you might want: `gomachine perft -depth 5` checks move generation against known node counts, and `gomachine bench sprt --new "..." --old "..."` runs the self-play strength test used to develop the engine. Run `gomachine help` for the rest.

## Running the website

The site is four services plus MySQL: a PHP backend (BaseAPI), a React frontend (Vite, Bun), the engine (`gomachine serve`), and a realtime hub for live games (`gomachine hub`). The engine and hub are the same binary under different subcommands.

The full setup, dev commands, and deployment steps live in [docs/COMMANDS.md](docs/COMMANDS.md), and the design is written up in [docs/SPEC.md](docs/SPEC.md). The short version for local development:

```sh
./mason serve --screen                      # PHP API on :6464
gomachine serve                             # engine on :6466
WS_TICKET_SECRET=… gomachine hub            # hub on :6467
cd frontend && bun run dev                  # frontend on :6465
```

Then open <http://127.0.0.1:6465>.

## Layout

The PHP backend is in `app/` with routes in `routes/api.php`. The frontend is in `frontend/`. The engine is in `gomachine/`, with the rules core in `gomachine/internal/chess` (the single source of truth for chess), evaluation and search in `gomachine/internal/{eval,search,nnue}`, and the realtime hub in `gomachine/internal/hub`. [CLAUDE.md](CLAUDE.md) is the fast orientation for the whole thing.

## License

GPLv3. See [LICENSE](LICENSE). If you build on this code, your version has to be open under the same terms.
