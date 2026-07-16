# zugzwang vs gomachine — same-net search-only A/B

A running log of direct head-to-head matches between zugzwang and the retired
gomachine engine. Both sides run the **same NNUE net** (`kb-mirror.bin`, the prod
full-threats king-bucket net), so the entire measured difference is **pure
search** — move ordering, pruning/LMR selectivity, extensions, Lazy SMP, TT, and
time management. Eval is held constant.

| Date | Result (zugzwang POV) | ± | Games | Score | TC | Threads | Hash (zug/gom) | Openings |
|---|---|---|---|---|---|---|---|---|
| 2026-07-15 | **+150 Elo** | 29 | 258 | 70.4% (W126 D111 L21) | 100 ms/move | 4 | 128 MB / 64 MB | opening_suite.epd (1129, random) |

**2026-07-15 — zugzwang +150 ± 29 Elo, LOS 100%.** fastchess, both engines over
UCI with their internal GMBK opening book enabled (`OwnBook=true`; the external
EPD only seeds varied start positions). Estimate was stable across the run
(107→137→154→171→160→150 as games accumulated); stopped at 258/500 games with the
number settled. **This is a pure-search delta at equal net** — zugzwang, written
from scratch in ~two days around the same net, beats the mature-but-stale
gomachine search by a full search generation.

Notes on fairness:
- Each engine ran near its **own** hash optimum, not a forced-equal one:
  gomachine measures best at **64 MB** (64 > 128 > 32 @ 100 ms — a cache-working-set
  effect at low TC), so 64 MB is gomachine's peak, not a handicap. Forcing it to
  128 to "match" zugzwang would have made gomachine *weaker*.
- Beating gomachine only establishes that zugzwang cleared a **stale baseline**
  (gomachine's search had gone stale against its own hand-set constants), not the
  distance to the frontier. The real ruler is zugzwang vs Stockfish/Stormphrax at
  equal net and matched TC — see `CCRL.md`.
