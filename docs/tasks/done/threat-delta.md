# Move-aware threat delta

> **DONE (cut-1, 2026-07-15).** Shipped default-on (`THREATDELTA=0` kill-switch).
> Movetime SPRT on coalla (amd64, 100 ms, 1T): **+43.4 ±11.7 Elo, LLR 2.95, 966
> games** — far above the tempered band below. The doc's own premise that
> enumeration "is not the bottleneck" was **wrong on prod**: it was a real cost
> (local arm64 NPS +20–29%, and the amd64 SPRT confirms it materialized). Implemented
> as the **correct-by-construction enumerate variant** (gomachine `pushMoveAwareEnumerate`
> port): `D` = per-piece bitboard XOR; `affected` = D ∪ attackers of D under old AND
> new occ; subtract each affected attacker's full old edge set, add its full new set
> (unchanged cancel in `apply_diff`); per-perspective king bucket/mirror refresh; a
> ~136 B `BoardSnapshot` in `do_move` supplies the old board. Validated `make ASSERT=1`
> int16-exact (zero drift @d14), perft-exact, golden 37/38 (pre-existing kingless FEN).
> Code in `nnue_features.{h,cpp}` (`changed_edges_delta`), `nnue_accumulator.{h,cpp}`
> (`push_delta`), `position.{h,cpp}`. **Follow-ons still open:** the faster
> `appendChangedEdges` masked-line slider diff (fewer `threatIndex` calls than the
> enumerate variant), split king-refresh Finny 32-key cache.

**What.** Emit only the threat feature **edges that change** per move instead of
re-enumerating all threats at each node (mirrors gomachine's `computeDelta` /
`enriched_delta.go`).

**Why.** Removes per-node threat-feature enumeration entirely — ~+14% NPS on top
of the incremental accumulator.

**Where.** `zugzwang/src/nnue_*` — reuses the shipped `AccStack`/applyDiff/assert
machinery; `LineBB`/`BetweenBB` tables already exist (`bitboard.cpp`), as does
`attackers_to(sq, occ)` (`position.h`). Start with the correct-by-construction
enumerate variant, gate with a perft-style int16-exact walk (`make ASSERT=1`).
**Hard** — this is the accumulator-bug minefield. Follow-ons: split king-bucket/
mirror refresh trigger, Finny 32-key refresh cache.

**References (two independent, high-quality ports of this exact idea):**
- **gomachine `internal/nnue/enriched_delta.go`** — the closest 1:1 structural
  match: single flat feature list (base+threat) + one multiset diff, same as
  zugzwang's `AccStack`. `computeDelta` + `appendChangedEdges` are the code to port.
- **Official Stockfish 18** (`~/sf18-arm`, tag `sf_18` — SHIPPED, not a fork):
  move-aware full-threats deltas are in SF18's default big-net eval. Its
  `Features::FullThreats` uses the **same 79,856-dim threat space as zugzwang's
  `ThreatBlock`**. Use it for the *hard cases*: discovered/retracted slider threats
  through vacated rays (`src/position.cpp:1059-1213`, `RayPassBB`/`BetweenBB`), the
  king-mirror refresh trigger `(ksq&4)!=(prevKsq&4)`, fused two-ply capture handling,
  and the per-move feature-count bound (≤80 non-castling, ≤36 castling — validates
  `MaxActive` headroom). Structural caveat: SF keeps threats in a *separate*
  accumulator (dual, big-net only), so it's a geometry reference, not the template.

**Elo expectation (temper).** This is a PURE speed opt — eval is byte-identical, so
it can only win via movetime (NPS → depth). zugzwang already computes the threat
features, and `nnue_accumulator.h` states enumeration "is not the bottleneck," so the
gomachine "~+14% NPS" is suspect on prod. Our speed opts routinely wash on amd64
(batchApply +50% arm64 / −6% amd64; float-tail SIMD movetime-neutral). Honest band:
**~0 (washes) to ~+5–12 Elo movetime**, and only if the NPS materializes on coalla —
measure there, never ship on an M3/arm64 NPS number. SF18 shipping this earns Elo from
threats-as-a-new-*signal*; that lever is already banked here, so it does NOT raise our
ceiling — it only de-risks the port. Lower priority than `spsa-margin-polish.md`.
