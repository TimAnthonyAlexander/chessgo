# Continuation history: 2 plies → more (3/4/6)

**What.** Extend continuation history from zug's 1-ply + 2-ply to SF's deeper set.

**Where.** SF reads plies 1,2,3,4,6 for ordering and updates plies 1–6
(`search.cpp:992-993`, `update_continuation_histories`), with the table split by `[inCheck][capture]`
(`history.h:150`) — a dimension zug lacks entirely. Zug has only `contHist1`/`contHist2`
(`search.cpp:220-221`), read in `cont_hist_planes`, updated in `update_cont_hist`.

**Why.** Deeper continuation patterns (plies 3/4/6) catch "the opponent's plan" that 1/2-ply can't —
one of the highest-value ordering features in modern engines. **~+10–20 ceiling at FIXED nodes.**

**⚠️ The headwind (read this first).** Zug is already borderline on continuation-history *read cost*:
2-ply banked +19.6 FN but only +8.0 movetime (`conthist-fn-to-mt.md`), and the LMRHIST experiment
confirmed the cost is the **cold first-touch of each node's conthist plane in the ordering pass**.
More plies = more cold plane touches per node → the FN gain likely **does not convert to movetime**.
So temper expectations: this is high FN ceiling but a real movetime risk. Mitigations: read SF's
*selective* ply subset (it skips ply 5 for ordering), and/or gate extra plies to a subset of moves.

**How.** Add `(ss-3)..(ss-6)` continuation planes + Stack plumbing, new `contHist3..` tables (memory:
each is ~2.4 MB), read/update sites. Gate: FIXED-nodes SPRT first (cheap corroboration), then the
real movetime SPRT — do NOT ship on the FN number, the whole point is whether it survives movetime.

**Effort.** Medium-high. **Priority.** After the low-risk build-ons; treat as a "fight the read cost"
project, not a free win.
