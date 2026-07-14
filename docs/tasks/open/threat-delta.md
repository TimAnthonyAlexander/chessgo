# Move-aware threat delta

**What.** Emit only the threat feature **edges that change** per move instead of
re-enumerating all threats at each node (mirrors gomachine's `computeDelta` /
`enriched_delta.go`).

**Why.** Removes per-node threat-feature enumeration entirely — ~+14% NPS on top
of the incremental accumulator.

**Where.** `zugzwang/src/nnue_*` — reuses the shipped `AccStack`/applyDiff/assert
machinery; needs a `LineBB` table. Start with the correct-by-construction
enumerate variant, gate with a perft-style int16-exact walk (`make ASSERT=1`).
**Hard** — this is the accumulator-bug minefield. Follow-ons: split king-bucket/
mirror refresh trigger, Finny 32-key refresh cache.
