# Abitur — gomachine's "fishtest"

Abitur is a minimal, self-contained **multi-engine gauntlet** ("the final exam" of
gomachine): a round-robin / gauntlet that pits UCI engines against each other using
gomachine's own perft-verified rules as the arbiter. It is how we get an **honest
absolute-strength read** against real, strong external engines — the thing self-play
SPRT structurally cannot give (self-play only measures strength *relative to your
sparring partner*, which a +N patch can game by overfitting to that one opponent).

## Why it exists / design principles

- **Every participant is a UCI subprocess** — Stockfish, Stormphrax, Reckless, and
  gomachine itself (run as `gomachine uci`, its net chosen via the `KB_NET_PATH`
  env). One uniform code path. Old-net vs new-net is just two gomachine processes
  with different `KB_NET_PATH` — no in-process net-swapping.
- **Our rules are the arbiter.** No engine is trusted on legality; an illegal move
  (per `engine.Adjudicate`) loses the game. Threefold/fifty are auto-claimed draws.
- **Per-participant time budgets ⇒ time odds are free.** Give gomachine 150ms vs an
  opponent's 100ms. Rationale: once you are ~100 Elo below an opponent you basically
  *never win*, and a 0%-win score makes the Elo estimate garbage. Start with a
  time-odds advantage to land in a band where you actually win games (so the estimate
  is meaningful), then dial the odds down toward parity.
- **Pentanomial (game-pair) statistics** — color-swapped pairs from an opening book,
  scored as pairs {0…2}, for lower-variance Elo error bars (the fishtest standard).

## Run it

```sh
# 1. Provision opponents (prebuilt AVX-512 release binaries; no compiler needed):
bash scripts/abitur/setup-engines.sh          # → ~/abitur/engines/{stockfish,stormphrax,reckless}

# 2. Round-robin the three opponents to calibrate them against each other:
cd ~/abitur && gomachine bench abitur --config rr3.json

# 3. Gauntlet a gomachine net vs the field (add a gomachine participant to the
#    config with an env KB_NET_PATH, then):
gomachine bench abitur --config abitur.json --gauntlet gomachine-640
```

## Config (JSON)

```json
{
  "games": 100,           // per pair, rounded up to whole color-swapped pairs
  "concurrency": 10,      // concurrent games per match (keep ≤ cores)
  "book": "",             // opening EPD/FEN/UCI-line file; empty → 16 embedded openings
  "gauntlet": "",         // if set, only play matches involving this participant name
  "participants": [
    {"name": "stockfish", "path": "engines/stockfish", "movetime_ms": 100,
     "elo": 3630, "options": {"Hash": "128", "Threads": "1"}},
    {"name": "gomachine-640", "path": "bin/gomachine", "args": ["uci"], "dir": ".",
     "env": {"KB_NET_PATH": "data/nnue/kb-mirror.bin"}, "movetime_ms": 150, "elo": 0}
  ]
}
```

Per participant: `path` (+ optional `args`, `env`, `dir` — gomachine needs all
three), `options` (UCI setoption pairs), one of `movetime_ms`/`nodes`/`depth`, and a
nominal `elo` anchor (`0` = unknown; a participant with unknown Elo gets an absolute
estimate from its head-to-head diff vs known-Elo opponents, averaged).

## Output

- Per match: `A vs B  N games  W/D/L  score%  Elo(A−B) ± 95%`.
- Standings crosstable: each participant's total W/D/L, score%, and anchored Elo.

## Caveats (read before quoting a number)

- The `elo` anchors are **reference frames**, typically CCRL long-TC/many-thread
  ratings. At 100ms single-thread the *absolute* numbers compress; trust the
  **relative** ordering and diffs first. Do not publish an absolute gomachine Elo off
  a single anchor — triangulate across all three opponents and multiple TCs.
- Opponents run **without Syzygy**; a gomachine tablebase edge here overstates
  real-world strength.
- Zen4/AVX-512 box: opponents use their `vnni512`/`avx512` release builds; gomachine
  must be the SIMD (`GOAMD64=v4`) build when it is a *participant* (as launcher/arbiter
  only, a scalar build is fine).
