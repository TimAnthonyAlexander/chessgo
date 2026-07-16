# Continuation history: 2 plies → more (3/4/6)

> **TESTED 2026-07-16 → FN-real but MOVETIME read-cost-bound. Dormant (default-off), NOT dead.**
> Built the full SF read set (plies 1,2,3,4,6) behind `CONTHISTPLIES` (commit 67cec69), then
> completed the port with SF's `[inCheck][capture]` split on all plies (commit 7c9b011).
> **The split is load-bearing** — the exact incomplete-port trap this doc's headwind section
> predicted, but on the *ordering* axis, not the read axis:
> - plies 3/4/6 **without** the split: FN **−1.3** (49.82% @5000g) — deeper plies raw add noise.
> - plies 3/4/6 **with** the `[inCheck][capture]` split: FN **+5.7** (50.83%, LLR +0.51 @1382g) —
>   the split contextualizes them and they become a real ordering gain.
> - complete port at **MOVETIME**: **−8.9 ±8.8, LLR −1.31 reject @1600g** (100 ms, coalla).
>
> So the FN ceiling (+5.7, below the +10–20 hope) is genuine but **does not convert** — the 5
> split tables (`[2][2][12][64][12][64]`, +10 MB/Context) add cold plane touches per node that
> cost ~−14 Elo of NPS at movetime, eating the +5.7 and then some. Same shape as
> [[conthist-fn-to-mt]] but the FN gain is real (unlike LMRHIST). **The remaining work is NOT
> more plies — it's the cold-first-touch fight**: table relayout for first-touch locality, or
> scoring only a top slice of quiets before searching (changes ordering, not byte-identical).
> Kept `CONTHISTPLIES` default-off as a re-test candidate if that read cost is ever cut. Do not
> re-run "more plies" as an Elo lever until the read cost is addressed.

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
So the real problem to solve here is the read cost, not the coding: high FN ceiling, but movetime only
pays if the extra cold plane touches don't eat the gain. The work IS beating that. Levers: read SF's
*selective* ply subset (it skips ply 5 for ordering), and/or gate extra plies to a subset of moves.
Reference impls: SF (`~/sf18-arm`), Stormphrax, Reckless — compare how they bound the per-node cost.

**How.** Add `(ss-3)..(ss-6)` continuation planes + Stack plumbing, new `contHist3..` tables (memory:
each is ~2.4 MB), read/update sites. Gate: FIXED-nodes SPRT first (cheap corroboration), then the
real movetime SPRT — do NOT ship on the FN number, the whole point is whether it survives movetime.

**Effort.** Medium-high. **Priority.** After the build-ons; treat as a "fight the read cost" project,
not a free win — the Elo is there at FN, the job is converting it to movetime.
