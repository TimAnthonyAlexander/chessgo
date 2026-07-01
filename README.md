# chessgo

**A production-ready chess website, and a strong ~3500 CCRL chess engine written from scratch in Go.**

Live at [chessgo.timanthonyalexander.de](https://chessgo.timanthonyalexander.de).

This is two projects that grew into one. The visible half is a full chess website — you sign up, get a rating, and play real games against real people with real clocks, or against a bot, or solve puzzles, or watch and review. The half that took the most work is underneath it: **`gomachine`**, a chess engine that owns every rule and plays in the ~3500 CCRL range, written in Go with no external chess library doing the hard parts. The website is the front door. The engine is the thing.

---

## The engine

`gomachine` is one self-contained Go binary. It generates moves with bitboards and magic bitboards, evaluates positions with a neural network, and searches with a modern alpha-beta that most strong engines would recognize. Nothing about chess is delegated — the rules, the move generation, the draw detection, the search, the evaluation, all of it lives here and is the single source of truth the rest of the project builds on. The website talks to the engine over HTTP and a WebSocket, but the engine has never heard of the website. You can pull it out and run it on its own.

### How strong

**Around 3500 on the CCRL Blitz scale** — and the honest version of that claim is a bracket, not a point.

gomachine beat a ~3400 CCRL engine **100 games to 0**. It lost to a ~3700 CCRL engine **70–0 with 30 draws, no wins**. So the floor is comfortably above 3400 and the ceiling is below 3700, and nothing yet found scores near 50% against it, which is why we quote the band instead of pretending to a precise number. On the older Stockfish UCI_Elo scale — which sits roughly 390 points below CCRL — the same engine reads about 2882. Same engine, two rulers.

None of this rests on vibes. Every single strength change had to prove itself in a **self-play SPRT** — a sequential probability ratio test that plays the new version against the old until it can say, with statistical confidence, that the change is an improvement. If a change couldn't win that test, it didn't ship, no matter how good the idea sounded. A fair amount of clever-sounding work got rejected that way. The CCRL bracket is the absolute anchor; SPRT is the ratchet that got there.

### How it got strong

The engine climbed in layers, each one SPRT-gated on top of the last:

- **A modern search.** Static exchange evaluation, null-move pruning, late move reductions, reverse futility and late-move pruning, aspiration windows, singular extensions, correction history — the standard toolkit of a strong engine, each piece measured in isolation (roughly +250 Elo of search work at real time controls, plus a later +110 from the correction-history / singular / futility wave).
- **Lazy SMP.** Multi-threaded search over a lock-free transposition table, byte-identical to the serial search at one thread (~+97 Elo at four threads).
- **A tuned hand-crafted evaluation** that replaced the plain piece-square baseline via a Texel tuner running Adam on win/draw/loss-labelled quiet positions (+101 Elo), before the network took over.
- **Syzygy tablebases.** Five-piece endgame tablebases probed at the root and inside the search, so won and drawn endings are played perfectly (+18 to +33 Elo on endgame-heavy books).
- **NNUE.** A `(768→512)×2→1` SCReLU network, trained on tens of gigabytes of Stockfish-evaluated positions, is now the default evaluation. It replaced the hand-crafted eval for +212 Elo, and a wider 512-neuron net with hand-written AVX2/NEON SIMD kernels added +101 on top of that. An incremental int16 accumulator keeps it fast enough to evaluate at every node under a clock.

The full story — the harness, every result with its confidence interval, and the ideas that were tried and rejected — is in [docs/ENGINE_STRENGTH.md](docs/ENGINE_STRENGTH.md).

To be clear about where the ceiling is: the very top engines (~3700+ CCRL) are still above gomachine — it can't take a game off a ~3700 opponent. This is a genuinely strong engine, not the world's best. The levers left on the table (a wider network, more training data, SPSA parameter tuning) are written up in the strength doc.

### Run it yourself

The engine is one binary with the evaluation network and opening book compiled in, so it runs from any directory with nothing extra to download.

Build from source (Go 1.25 or newer):

```sh
git clone https://github.com/TimAnthonyAlexander/gomachine
cd gomachine
go build -o gomachine ./cmd/gomachine
```

Or install straight to your `$GOBIN`:

```sh
go install github.com/timanthonyalexander/gomachine/cmd/gomachine@latest
```

Prebuilt binaries for macOS, Linux, and Windows are on the [Releases](https://github.com/TimAnthonyAlexander/gomachine/releases) page, and there's a Homebrew tap:

```sh
brew install timanthonyalexander/tap/gomachine
```

It speaks UCI, so it drops straight into Arena, Cute Chess, BanksiaGUI, or a lichess-bot setup:

```sh
gomachine uci
```

One-shot best move from a position:

```sh
gomachine bestmove -fen "r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4" -depth 12
```

`gomachine perft -depth 5` checks move generation against known node counts, and `gomachine bench sprt --new "..." --old "..."` runs the same self-play strength test the engine was built with. `gomachine help` lists the rest.

Endgame tablebases are optional and not bundled (the full set is large). Point the engine at a Syzygy set with `SYZYGY_PATH=/path/to/syzygy` or `-tb-path` if you want perfect endgame play; without them the engine is at full strength everywhere except the deepest endings.

---

## The website

Everything the engine makes possible, wrapped in a site that's actually deployed and running — accounts, ratings, matchmaking, live games, puzzles, spectating, analysis.

**Play other people.** The matchmaker pairs you with someone near your rating and widens the acceptable gap the longer you wait, so a 1200 and a 2000 never end up across the board from each other. Clocks run server-side, Lichess-style: neither clock starts until both players have moved, and a stalled first move aborts the game instead of flagging you. Close the tab and come back — the game is still there.

**Play the bot.** Pick a level from 0 to 10 and play with no account. If you're logged in and waiting for a human, a bot rated close to you fills in after a short wait and plays at a believable human pace, so the lobby rarely leaves you hanging. Those fill-in games count toward your rating; explicit practice games against the bot don't.

**A rating that means something.** Glicko-2, tracked separately for bullet, blitz, rapid, and classical. New accounts start provisional and tighten as you play; sit out for a while and the system grows less certain about you again, the way it should.

**Puzzles.** Tactical positions seeded from the Lichess puzzle set, matched to a puzzle rating that's kept apart from your game ratings — a bad day at tactics won't touch your blitz number. The solution is checked on the server and never sent to the browser, so it can't be peeked at.

**Watch and review.** The Watch page shows the strongest games in progress; click one to spectate live without disturbing your own game. Every finished game opens on an analysis board that runs the engine move by move and marks the mistakes. Profiles show ratings, records, and history.

**The small comforts.** Premoves that fire the instant they become legal, move sounds, a board editor — the things that make it feel like a real board and not a form.

### Running it locally

The site is four services plus MySQL: a PHP backend (BaseAPI), a React frontend (Vite, Bun), the engine (`gomachine serve`), and a realtime hub for live games (`gomachine hub`). The engine and hub are the same binary under different subcommands.

```sh
./mason serve --screen                      # PHP API on :6464
gomachine serve                             # engine on :6466
WS_TICKET_SECRET=… gomachine hub            # hub on :6467
cd frontend && bun run dev                  # frontend on :6465
```

Then open <http://127.0.0.1:6465>. The full setup, dev commands, and deployment steps are in [docs/COMMANDS.md](docs/COMMANDS.md), and the design is written up in [docs/SPEC.md](docs/SPEC.md).

### Layout

The PHP backend is in `app/` with routes in `routes/api.php`. The frontend is in `frontend/`. The engine is in `gomachine/`, with the rules core in `gomachine/internal/chess` (the single source of truth for chess), evaluation and search in `gomachine/internal/{eval,search,nnue}`, and the realtime hub in `gomachine/internal/hub`. [CLAUDE.md](CLAUDE.md) is the fast orientation for the whole thing.

---

## License

GPLv3. See [LICENSE](LICENSE). If you build on this code, your version has to be open under the same terms.
