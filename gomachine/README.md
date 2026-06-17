# gomachine

A classical chess engine in pure Go — the rules authority **and** the AI for the
chessgo platform. No Stockfish, no neural nets. Bitboards + fancy magic sliders,
negamax + alpha-beta with iterative deepening, a transposition table, quiescence
search, move ordering, null-move pruning, and late move reductions over a tapered
PeSTO evaluation. See [`../docs/SPEC.md`](../docs/SPEC.md) for the full design.

Pure Go (`CGO_ENABLED=0`) so it cross-compiles to Linux and macOS from one
toolchain.

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

Levels **0–10** (SPEC §6): level 10 is full strength with the longest think time;
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
