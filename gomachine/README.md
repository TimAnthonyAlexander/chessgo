# gomachine

A strong NNUE chess engine in Go — the rules authority **and** the AI for the
chessgo platform. Bitboards + fancy magic sliders; a Lazy-SMP negamax + alpha-beta
search with iterative deepening, aspiration windows, a lock-free transposition
table, quiescence search, SEE-filtered captures, null-move pruning, late move
reductions, reverse-futility / late-move pruning, singular extensions, and
correction history; over an **NNUE evaluation** (default since v4) — the current
net is a king-buckets + Stockfish-style full-threats net with an incremental
int16 accumulator and archsimd AVX2/NEON kernels. A Texel-tuned hand-crafted eval
is the fallback when no net is loaded. See [`../docs/SPEC.md`](../docs/SPEC.md)
for the full design.

The default build links Fathom (Syzygy tablebases) via CGo. `CGO_ENABLED=0`
compiles an inert-tablebase stub path that still cross-compiles to Linux and
macOS from one toolchain.

## Build

```sh
make build        # → bin/gomachine
make test         # full suite incl. perft (6 positions) + search tactics
make cross        # release binaries for linux/macos amd64/arm64 → dist/
```

## CLI

```sh
gomachine uci                                   # UCI loop (for chess GUIs)
gomachine serve -addr 127.0.0.1:6466 -workers 4 # internal HTTP/JSON service
gomachine bestmove -fen "<FEN>" -level 7        # one move at difficulty 0..10
gomachine bestmove -depth 12                    # fixed-depth, full strength
gomachine perft -depth 6                         # movegen node counts
gomachine play -level 5 -color white            # play in the terminal
gomachine selfplay -level 10 -movetime 100       # watch it play itself
```

## Difficulty

Levels **0–10** (SPEC §6): level 10 is full strength (NNUE + full search) with the longest think time;
level 0 thinks briefly, adds eval noise, and occasionally blunders. Weakening is
always by noise / sub-optimal selection — the engine is never rules-incorrect.

## HTTP service (PHP boundary)

Stateless, FEN-in JSON on localhost. `POST /move`, `/legal-moves`, `/bestmove`,
`/status`, `/perft`, and `GET /healthz`. The engine is a pure function of the
position; PHP/BaseAPI stays the source of truth for game state. Contract in
SPEC §7.3.

## Correctness

`make test` runs perft against the six standard positions (startpos, Kiwipete,
and positions 3–6) — every castling / en-passant / promotion / pin / check-evasion
edge case is exercised. Movegen is verified to `startpos perft(6) = 119,060,324`
and `Kiwipete perft(5) = 193,690,690`.
