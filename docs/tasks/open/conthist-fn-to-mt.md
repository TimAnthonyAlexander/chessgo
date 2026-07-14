# Reclaim ContHist FN→MT Elo

**What.** Continuation history scores **+19.6 Elo @ fixed nodes but only +8.0 @
movetime** — the ~+12 delta is eaten by table-read cost on the hot path.

**Why.** That +12 is trapped Elo already proven to exist; a speedup converts it
straight to movetime strength.

**Where.** Speed up the 1-ply/2-ply ContHist table reads in `zugzwang/src/search.cpp`
(the lookups feeding move ordering + LMR). Cache-friendlier layout / fewer
indirections. Gate with a movetime SPRT (fixed-node result already banked).
