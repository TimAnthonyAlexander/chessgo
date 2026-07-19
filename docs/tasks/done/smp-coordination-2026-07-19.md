# SMP thread-coordination (SF vote-weighting + aspiration diversity) — dormant, sub-threshold at 4T/100ms

SF18 gap analysis (3 parallel subagents over `~/sf18-arm`) found zug's Lazy-SMP
best-thread pick is a naive `(depth,score)` where SF uses **vote-weighted consensus**
(`thread.cpp get_best_thread`) plus **per-thread aspiration diversity** (`search.cpp:355`,
`delta = 5 + threadIdx%8 + …`). These are SF's two co-designed SMP pieces. Ported both,
default-off env flags, main byte-identical when off (Threads=1 returns early anyway).

- `SMPVOTE=1` (commit `ab58146`): vote-weighted best-thread — each thread votes for its
  bestMove with weight `(score - minScore + 14)*depth`; proven wins prefer shortest mate,
  losses prefer longest survival. `search.cpp run_lazy_smp`.
- `SMPDIV=1` (commit `baa31d3`): stagger each worker's initial aspiration delta by
  `threadIdx%8` so threads diverge (gives the vote genuinely different results to weigh).
  `Context::threadIdx` set per worker in `run_lazy_smp`; read at the aspiration setup.

## Results (coalla, Threads=4)

| lever | MT 100ms | FN 300k nodes |
|---|---|---|
| SMPVOTE alone | **+6.66 ± 6.37** (LB +0.29, 2400g) | −2.08 ± 6.71 (2000g) |
| SMPVOTE+SMPDIV | **+4.49 ± 6.14** (LB −1.65, 2400g) | −6.68 ± 13 (partial, killed) |

## Verdict: dormant, NOT shipped

Real-but-sub-threshold. Diversity did NOT amplify the vote (bundle < vote-alone). FN never
corroborated (vote is quality-neutral per-node; diversity *costs* nodes → FN penalizes it,
so FN is the wrong test for diversity — it only pays back at movetime). Two independent MT
samples (+6.7, +4.5) of essentially the same lever = a ~+3-5 Elo signal below the ±6 floor,
not reproducible enough to bank. LBs straddle 0.

**Why it's not dead:** SF's SMP coordination pays off at SF's operating point — **many threads,
long TC** — where threads actually diverge and the vote/diversity have signal. zug's prod bot
moves are short (movetime-capped, ~few threads), so it's near-invisible there. The right regime
is the **CCRL track** (real `tc=X+Y`, more threads). Re-test + SPSA the diversity constant and
the vote weight there before discarding. Both flags kept on main default-off for that.

## Method notes (reusable)
- SMP-only code is INVISIBLE to a Threads=1 SPRT — must run `option.Threads=4` both sides
  (`sprt_fn_smp.sh`, and `sprt_mt.sh … 4 4 3`).
- FN (fixed-nodes) is timing-independent → can oversubscribe cores (conc=6 @ 4T) unbiased.
  BUT FN penalizes any lever that changes node cost (aspiration diversity) → use MT for those.
- coalla launch gotcha (cost hours): systemd-logind reaps detached SPRTs when the last ssh
  session closes; run the SPRT in the FOREGROUND of a long-lived connection. screen is broken
  on coalla.
