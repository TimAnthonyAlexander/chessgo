# Threat-delta follow-ons (masked-line slider diff + split refresh)

Follow-ons to the **shipped** move-aware threat delta (`docs/tasks/done/threat-delta.md`,
banked +43 Elo movetime 2026-07-15, default-on via `THREATDELTA`). Cut-1 shipped the
**correct-by-construction enumerate variant**; these squeeze more NPS on top of it.

## 1. `appendChangedEdges` masked-line slider diff (primary) — ✅ SHIPPED 2026-07-16

> **DONE (commit pending, default-on via `THREATDELTA_FAST`, `=0` kill-switch).** Movetime
> SPRT on coalla (100 ms, `THREATDELTA_FAST=1` vs `=0`, both `THREATDELTA=1`, same binary):
> **+16.73 ±8.95 Elo, LB +7.78, LLR 1.93 @1600g (trend-accept, LB>0)**, 52.41%, Ptnml
> `[13,119,473,168,27]`. Implemented exactly as below: leaper diff `attacks&D` under old/new
> occ; slider diff `attacks&occ&mask`, `mask = ⋃ LineBB(s,d)` over changed sqs; Group-1
> (attacker identity changed, `s∈D`) keeps full emission, Group-2 (unchanged attacker) uses
> the masked diff. **ASSERT=1 zero drift** on 10 FENs, A/B eval byte-identical, default path
> byte-identical (perft5=4865609, d14=63075), +7.3% local arm64 NPS. `emit_changed_edges` in
> `nnue_features.cpp`. SF geometry cross-checked at `~/sf18-arm/src/position.cpp:1170`
> (`RayPassBB & ~BetweenBB`). §2 (split king-refresh Finny cache) still open.

**What.** Cut-1's `changed_edges_delta` (`zugzwang/src/nnue_features.cpp`) re-enumerates
the **full** edge set of every affected attacker (old occ → sub, new occ → add) and lets
`apply_diff`'s count array cancel the unchanged edges. That's correct but wasteful: an
affected slider whose edge to ONE target shifted still recomputes `threatIndex` for all
its targets. gomachine's faster `appendChangedEdges` (`internal/nnue/enriched_delta.go`)
instead emits **only the edges that actually differ**:
- **Leaper** (knight/king/pawn): attack set is occupancy-independent, so edges change only
  at the changed squares — diff `PseudoAttacks(pc,s) & D` under old vs new occ.
- **Slider** (bishop/rook/queen): restrict to `mask = ⋃ LineBB(s, d)` over `d ∈ D` (the
  full lines through the slider and each changed square), then diff
  `attacks(s,oldOcc)&oldOcc&mask` vs `attacks(s,newOcc)&newOcc&mask`. Captures blocked /
  discovered / retracted uniformly; unshifted targets cancel.

**Why.** Fewer `threatIndex` calls and fewer `apply_diff` count touches per node → more NPS
on top of the +43. SF18 `Position::update_piece_threats` (`~/sf18-arm/src/position.cpp`
1111-1213, `RayPassBB & ~BetweenBB`) is the geometry cross-check for the discovered/retracted
ray cases.

**Where.** `changed_edges_delta` in `nnue_features.cpp` — replace the "full old/new edge set
per affected attacker" inner loops with the leaper/slider masked diff. `LineBB`/`BetweenBB`
already exist (`bitboard.cpp`). Keep the enumerate variant reachable (env or compile flag) as
the A/B oracle — cross-check the two produce byte-identical halves.

**Gate.** `make ASSERT=1` int16-exact perft-walk (zero drift) FIRST — this is the
accumulator-bug minefield — then movetime SPRT on coalla (`~/sprt_mt.sh`, same env-wrapper
one-binary trick used for cut-1: `THREATDELTA` vs a new `THREATDELTA_FAST` toggle, or two
commits). Pure speed opt (eval byte-identical) → movetime-only. Ceiling is a second-order
shave on an already-won path — temper expectations, measure on coalla.

## 2. Split king-refresh Finny cache (secondary, lower priority)

Cut-1 refreshes a perspective's WHOLE half from scratch when its king crosses a bucket/mirror
boundary. gomachine's `buildSlotRefreshSplit` + `finnyRefreshHalf` (32-key refresh cache)
rebuild only the moving side's half and serve it from a Finny table keyed on king
bucket+occupancy. King crossings are a minority of nodes, so the win is smaller; do this only
if profiling shows refresh cost is material after #1.

**Est.** Both are pure NPS→depth; magnitude unknown (cut-1 itself beat its estimate ~4×).
Don't ship on an arm64 NPS number — coalla movetime SPRT is the verdict.
