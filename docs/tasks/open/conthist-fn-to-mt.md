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
- **2026-07-15 — reuse ordering hist in LMR (`LMRHIST`): ABANDONED pre-SPRT (local
  NPS gate).** Cached the ordering-time `butterfly+conthist` per general quiet
  (ExtMove field) and reused it in the LMR reduction read. Two problems: (1) **NOT
  byte-identical** — sibling subtree cutoffs mutate the history tables mid-loop, so the
  LMR read is deliberately *fresh*; the cache feeds it *stale* values, and the tree
  changed wildly (startpos 577k→390k nodes @d19, a middlegame 1037k→**2449k**, i.e.
  worse LMR decisions → likely Elo LOSS). (2) **Zero per-node speedup** — local nps was
  flat-to-worse (588k→580k, 553k→541k): the LMR re-reads HIT L1 (the ordering pass
  touched those 1.5 KB planes microseconds earlier), so there was never a cache-miss to
  eliminate. Same root cause as the prefetch wash. SF likewise does NOT share
  ordering↔LMR — it recomputes `ss->statScore` fresh per move (`search.cpp`), fresh
  reads by design.

**Verdict on this task:** the "table-read cost" is the **cold first-touch of each
node's conthist plane in the ordering pass** (unavoidable — every quiet must be scored
to sort), NOT the LMR re-reads (warm). The prefetch and the LMR-reuse both target the
warm reads and both wash. A real reclaim would need to cut the *ordering-pass* plane
touches (e.g. score only a top slice before searching, changing ordering — not
byte-identical) or shrink/relayout the 2×2.36 MB tables for better first-touch locality.
Lower priority until a concrete cold-read idea exists; both cheap levers are exhausted.
