# CCRL — gomachine's real-conditions rating tracker

**This document tracks ONE thing: gomachine's estimated CCRL rating, measured under
CCRL-like conditions (multi-thread, seconds-per-move), against real external engines
whose CCRL ratings we know.** It is deliberately **separate** from the 100 ms fast
strength tests (`docs/ENGINE_STRENGTH.md`, `docs/PROFILING/…`). Those run at 100 ms
single-thread for speed and are great for A/B iteration, but their absolute numbers
compress and do **not** map to CCRL (see `ENGINE_STRENGTH §36`, and the Elo-vs-time
note below). Do not mix the two. Numbers here are the only ones to compare against a
CCRL rating.

Measure **after each shipped improvement** (every day or so). Same fixed protocol
every time → the *delta* is clean even if the absolute anchor has error bars.

## Why 100 ms ≠ CCRL (the reconciliation)

- **Elo is relative, per-pool, per-condition.** A "3650 CCRL 40/15" number only means
  something at CCRL's time control (40 moves / 15 min ≈ ~22 s/move) and thread count.
- **Time is worth Elo: ~+40–70 per doubling** (diminishing at long TC). 100 ms → ~22 s
  is ~8 doublings ≈ **+300–500 Elo** in absolute terms. So the same engine is *hundreds*
  of Elo weaker at 100 ms than at CCRL TC — and engines don't all scale equally, so
  gaps **compress at fast TC**.
- Therefore "we beat a 3400-CCRL engine 100-0 at 100 ms" does **NOT** establish a CCRL
  rating: the two facts are at different conditions and can't be chained. This tracker
  fixes that by measuring at CCRL-like conditions against CCRL-rated opponents.

## Reference anchors — CCRL 40/15, 4-CPU (computerchess.org.uk, 2026-07-09)

| Engine | CCRL 40/15 (4CPU) |
|---|---|
| Stockfish 18 64-bit 4CPU | **3650** |
| Reckless 0.9.0 64-bit 4CPU | 3646 |
| Torch v4d 64-bit 4CPU | 3640 |
| Stormphrax 7.0.0 64-bit 4CPU | 3615 |

(Full list: `docs/…` / https://computerchess.org.uk/4040/rating_list_all.html. Mid-list
engines to add later for tighter bracketing when gomachine lands well below the top:
Wasp 6.50 ≈ 3482, Marvin 6.3 ≈ 3468, Stash 37 ≈ 3438, Lc0 0.28 ≈ 3444.)

## The fixed protocol (PROTOCOL v1)

Run on **coalla** (12 cores, AVX-512), newest SIMD binary + current prod net.

- **Harness:** `gomachine bench abitur`, gauntlet mode (gomachine vs each opponent),
  pentanomial (color-swapped game pairs) Elo with 95% bars.
- **Threads:** **4 per engine** (matches the 4-CPU anchor list; gomachine via the new
  UCI `Threads` option). Only the side-to-move computes, so **concurrency 3** ⇒ 3 × 4 =
  **12 cores, no oversubscription.** `Hash 128` for all.
- **Time:** fixed **movetime 2000 ms/move**. NOTE: the Abitur harness has no game clock,
  so this is a fixed-per-move **proxy** for a blitz-ish CCRL TC, not a literal 40/15
  clock. It is intentionally seconds-per-move (not 100 ms) so relative strengths track
  CCRL. Hardware isn't CCRL-scaled either — so trust the **relative diffs** and the
  **tracked delta**, and treat the absolute as a band.
- **Opponents:** Stockfish 18, Reckless 0.9, Stormphrax 7.0 (all on coalla under
  `~/abitur/engines/`), no Syzygy (gomachine also runs Syzygy-free on the UCI path — fair).
- **Games:** ≥30 game-pairs/opponent (first pass; scale up for tighter bars).
- **Estimate:** for each opponent, gomachine_Elo ≈ opp_CCRL + head-to-head Elo diff;
  **triangulate** across all opponents. A single anchor is not a rating.

### Known caveats (read before quoting a number)
1. **Fixed-movetime proxy**, not a real game clock — a documented approximation of CCRL TC.
2. **Hardware not CCRL-normalized** (coalla ≠ the CCRL reference box). Relative diffs hold;
   the absolute floats.
3. **Single-family anchors** (all three opponents are top-4). Until a sub-gomachine
   opponent is added, the estimate is "top engines minus X" — triangulated but one-sided.
4. **SMP nondeterminism** at 4 threads adds a little variance (fine for a rating; it's how
   the 4-CPU list itself is made).

## Results log

| Date | Binary / net | movetime · threads · pairs | vs SF18 (3650) | vs Reckless (3646) | vs Stormphrax (3615) | **CCRL est.** | Notes |
|---|---|---|---|---|---|---|---|
| _pending_ | full-threats `ft_final.bin` @ 36b8839 | 2000ms · 4T · 30 | … | … | … | … | first CCRL-conditions run |

_(Append one row per measurement. Keep the protocol fixed; if you change it, bump to
PROTOCOL v2 and note the break so old/new rows aren't compared directly.)_
