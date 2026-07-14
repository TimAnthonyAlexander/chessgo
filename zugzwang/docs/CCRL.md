# zugzwang — CCRL-scale Elo log

A running log of zugzwang's estimated strength on a CCRL-like Elo scale.

**Method:** round-robin on coalla (1 thread, 64 MB hash, `book.epd` openings),
anchored to **Stockfish = 3660 Elo** at the same time control. This is an
SF-anchored triangulation, i.e. a proxy for a CCRL-list rating — not an official
CCRL entry. Both engines run the shared ft_final net.

| Date | Elo @ 100ms | Elo @ 400ms | Notes |
|---|---|---|---|
| 2026-07-14 | **3343** | **3577** | After the SF-selectivity campaign (ProbCut/depth−2/cutoffCnt, hindsight, ttPv, double-extension; +16.8 Elo movetime vs pre-campaign). SF anchor 3660 @ 100ms. |

_Update this table as the engine improves._
