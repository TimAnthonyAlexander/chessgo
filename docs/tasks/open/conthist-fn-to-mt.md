# Reclaim ContHist FN→MT Elo

**What.** Continuation history scores **+19.6 Elo @ fixed nodes but only +8.0 @
movetime** — the ~+12 delta is eaten by table-read cost on the hot path.

**Why.** That +12 is trapped Elo already proven to exist; a speedup converts it
straight to movetime strength.

**Where.** Speed up the 1-ply/2-ply ContHist table reads in `zugzwang/src/search.cpp`
(the lookups feeding move ordering + LMR). Cache-friendlier layout / fewer
indirections. Gate with a movetime SPRT (fixed-node result already banked).

## Attempt log
- **2026-07-15 — `__builtin_prefetch` on the ContHist rows: WASHED** (−16 ± 29 @
  148 games, byte-identical tree, killed early). Prefetch alone on coalla's cache
  didn't convert.
- **2026-07-15 — base-pointer hoist: ALREADY DONE.** SF18 cross-ref (`~/sf18-arm`,
  `search.cpp:551-567,991-993`) confirmed SF hoists the continuation base pointer at
  `do_move` time onto the stack; zugzwang already does the equivalent once per node
  (`cont_hist_planes`, `search.cpp:819-832`, explicit "hoist ONCE" comment). The 4-D→
  plane index is NOT recomputed per move in either engine. So the remaining redundancy
  is only the *per-move* `off`+2 table reads duplicated between the ordering pass and
  the LMR read.
- **2026-07-15 — reuse ordering hist in LMR (`LMRHIST`): SPRT'd, MEASURED WORSE →
  default-off dormant opt-in (kept, not deleted).** Cached the ordering-time
  `butterfly+conthist` per general quiet (`ExtMove.histScore`) and reused it in the LMR
  reduction read (`Tune::lmrHistCache`, env `LMRHIST`). Two facts:
  1. **NOT byte-identical** — sibling subtree cutoffs mutate the history tables mid-loop,
     so the current LMR read is deliberately *fresh*; the cache feeds it *stale*
     (ordering-time) values, reshaping the tree (fixed-d19: startpos 577k→390k nodes, a
     middlegame 1037k→2449k — mixed, not uniformly worse).
  2. **Zero per-node speedup** — local nps flat-to-worse (588k→580k, 553k→541k): the LMR
     re-reads HIT L1 (the ordering pass warmed those 1.5 KB planes microseconds earlier),
     so there was no cache-miss to remove. Same root cause as the prefetch wash.

  Because it's not a pure-speed opt, node counts don't tell us the Elo — so we **played
  it** (movetime SPRT, coalla, 100 ms, `LMRHIST=1` vs `0`, same binary): **~−17 Elo,
  rejecting.** That is a real result, not an inference: it **confirms SF's design
  rationale** for recomputing `ss->statScore` fresh per move — *fresh, sibling-updated
  history makes better LMR reductions than ordering-time history*. (Note SF also has a
  structural reason we don't: its movepick ordering score and its `statScore` are
  different weightings, so SF *can't* reuse one for the other anyway; our two happen to
  be the same quantity, which is why the cache was even possible. The part that bites us
  is purely the freshness loss.)

  **Kept default-off (dormant), NOT removed.** This is worse for our **current** baseline
  (2-ply conthist, current tree dynamics). RE-SPRT if the baseline shifts the
  freshness/read-cost tradeoff — e.g. moving to more conthist plies like SF's 5 (heavier
  per-move reads may then outweigh the freshness loss), or a table relayout that makes
  the ordering-pass cold-read dominant. Code + rationale in `search.cpp` (`lmrHistCache`).

**Verdict on this task:** the "table-read cost" is the **cold first-touch of each
node's conthist plane in the ordering pass** (unavoidable — every quiet must be scored
to sort), NOT the LMR re-reads (warm). Prefetch and LMR-reuse both target the warm reads:
one washed, one measured negative. A real reclaim would need to cut the *ordering-pass*
plane touches (e.g. score only a top slice before searching — changes ordering, not
byte-identical) or shrink/relayout the 2×2.36 MB tables for better first-touch locality.
Lower priority until a concrete cold-read idea exists; both cheap warm-read levers are
now exhausted (one washed, one −17).
