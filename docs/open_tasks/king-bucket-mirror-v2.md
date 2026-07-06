# King-bucket NNUE v2 — horizontal mirror (hm)

**Status:** open. **Owner lever:** eval density. **Prereq:** none (v1 KB is shipped/live).

## What

Add a **horizontal file-mirror** to the king-bucket enriched net, keeping **16 buckets**
and the **factoriser on**. Train 320-sb fully annealed, SPRT vs the current prod net.
This is the v2 promised in `internal/nnue/kingbucket.go` header ("A future v2 adds the
file-mirror").

## Why (field evidence + our numbers)

- **Mirroring is universal at the top; nobody runs a large non-mirrored king-bucket net.**
  SF18 `HalfKAv2_hm` (per-king-square + hm), Viridithas 14+ (**16** buckets + merged king
  planes, hm), Renegade (`768x14hm`), Stormphrax 8 (bucketed + threats, hm). All mirror.
- **16 buckets is the strong-engine norm, not aggressive.** Viridithas runs **16** (doubled
  to 16 in v14, PR #173); Renegade 14; SF finer still. So **keep our 16** — do NOT cut to 8.
  The earlier "drop to 8 to save params" instinct was wrong: the field keeps resolution and
  gets density back by mirroring.
- **We are epoch-poor, not reuse-bound (measured).** test80-2024 Jan–Apr pool = 42.63 GB,
  `TOTAL_ENTRIES 16,291,530,125`, `KEPT_AFTER_FILTER 7,968,335,566` (filter keeps 48.9%),
  density 2.62 B/pos. At 320-sb (32.0 B presentations) that's **4.0 epochs**. The 16
  no-mirror buckets each see ~1/16 of that. **hm halves the king-square param space → ~2×
  effective data per bucket** — the exact density lever at 4 epochs, and it's parameter-
  efficient (what SF/Viri/Renegade actually do). See [[nnue-data-pipeline-recipe]],
  count in this file.
- **Baseline to beat:** the shipped **no-mirror factorised `kbfact_320`** is
  **+3.38 ± 4.73 vs v12** (marginal, live in prod — see [[kb-net-prod-default]]). v2's bar
  is to clear that decisively.

## Design — the canonicalization (Go and Rust MUST match byte-for-byte)

Per perspective `P` (compute independently for White and Black):

```
orient = (P == Black) ? 56 : 0            // vertical perspective flip (unchanged from v1)
ksqO   = kingSq(P) ^ orient               // king oriented to P's view
mir    = file(ksqO) >= 4 ? 7 : 0          // NEW: horizontal mirror if king on e–h half
// apply to EVERY feature square for this perspective — base piece squares AND threat
// target squares (attacker/target both):   s_final = s ^ orient ^ mir
bucket = mirrorBucketTable[ ksqO ^ mir ]  // ksqO^mir has file 0–3 (32 half-squares)
baseFeature = bucket*768 + (relColor*6 + type)*64 + (s ^ orient ^ mir)
```

- **`mirrorBucketTable`**: 32 half-board squares (file 0–3, rank 0–7) → 16 buckets.
  Proposed: `bucket = rank*2 + (file>>1)` (8 rank-levels × 2 file-bands = 16), which keeps
  king-safety rank resolution. Tunable later; match Viridithas's table if we want parity.
  Define it once in Go and duplicate verbatim in Rust (as v1 does).
- **Threats**: the threat block still starts at `PsqSize` (12288). Threat internals are
  UNCHANGED except the **target/attacker squares get the same `^orient^mir` flip**. Verify
  the threat set is flip-consistent (existing dense-threat parity test, extended).

## Refresh predicate (incremental accumulator correctness)

Extend `kingMoveNeedsRefresh` (kingbucket.go:63) to trigger a full from-scratch refresh when
**either** changes across the king move:
1. **bucket** changes (v1 already does this), OR
2. **mirror half flips** — king crosses the d/e file boundary (`mir(from) != mir(to)`), which
   flips EVERY feature square for that perspective, so the incremental delta is invalid.

`needsRefresh = bucket(fromMirrored) != bucket(toMirrored) || mir(from) != mir(to)`
(compute `from`/`to` oriented to the moving side, as v1 does).

## Factoriser interaction (the one real cost)

The factoriser's shared feature is `derive_feature(feat) = feat % 768` (drops the bucket).
For that coalesce to stay correct, **the shared Chess768 base must ALSO mirror** — i.e. its
psqIdx must be computed on the same `s ^ orient ^ mir` square as the bucketed feature.
- If bullet's stock `Chess768` does **not** mirror, add a **custom mirrored base**
  `SparseInputType` (mirror of the v1 pattern that made `ThreatInputs` custom) and wrap it in
  `Factorised::from_parts(ThreatInputs_or_base, MirroredChess768)`; keep the FT sized
  `INPUT_SIZE + 768` and the `merge_factoriser` transform on `l0w`.
- **Do NOT** leave `derive_feature = feat % 768` against an un-mirrored Chess768 — it would
  coalesce to the wrong shared feature and silently poison training.

## Files to change

- **Go** (`internal/nnue/`): `kingbucket.go` (mirror table + `mir` in `kingBucketOffset`/
  `appendBucketedBase` + extended `kingMoveNeedsRefresh`); `enriched.go` /
  `enriched_delta.go` (apply `^orient^mir` to base AND threat squares in the from-scratch
  and delta paths; the delta path must refresh on mirror-flip). Keep `PsqSize=12288`,
  `NumKingBuckets=16` unchanged.
- **Rust** (`~/nnue-training/bullet/examples/chessgo_lean_threats.rs`): mirror in
  `map_features` (base + threats), mirrored factoriser base, verbatim `mirrorBucketTable`.

## Verification (before trusting any train) — reuse `kb_verify_test.go` tooling

Extend the existing independent-replica battery (`internal/nnue/kb_verify_test.go`,
`kb_verify2_test.go`) with mirror cases. ALL must pass on **scalar and the prod SIMD build**
(`GOEXPERIMENT=simd ~/go/bin/go1.27rc1 test ./internal/nnue/`):
1. **Mirror-table parity**: Go `mirrorBucketTable` == Rust, all 64 real king squares (via the
   `^orient^mir` path), 0 mismatches.
2. **Cross-mirror eval parity**: Go feature set == independent Rust replica (sorted set-eq,
   both perspectives) on positions with the king on the **e–h half** (mir=7) and on both
   halves in the same position (White king d-side, Black king h-side).
3. **Mirror-flip refresh (the key new case)**: a king move that **crosses the a–h axis**
   (e.g. white Ke1→? no — pick Kd1→Ke1 so `mir` flips 0→7): incremental (`Push`) ==
   from-scratch `buildAcc(child)`, **byte-exact on all 1024 int16 halves**, and
   `kingMoveNeedsRefresh` returns true. Plus a within-half control (no flip → incremental
   used, still byte-exact).
4. **Threat flip-consistency**: dense-threat set-eq Go vs Rust on a mirrored position.
5. **Factoriser coalesce**: confirm the merged `quantised.bin` (21504-shape) evals sane +
   stm-symmetric, and that a mirror-pair position (king on d-file vs its e-file mirror image)
   evaluates identically (the whole point of hm).

## Train + SPRT

- **net_id: distinct** per [[nnue-distinct-net-ids]] — e.g. `kbmirror_t80_320` (NOT the shared
  default). Copy the export to a distinctly-named scratch file at run end.
- **SB=320, full cosine anneal** (`final_superbatch = superbatches`), factoriser on, same
  test80-2024 Jan–Apr pool. **Ship the annealed `-320` final**, NOT a mid-anneal min-loss
  checkpoint ([[nnue-ship-annealed-final]] — mid-anneal `-192` was −22 vs v12).
- **SPRT** (cross-net → fastchess, not in-process; [[coalla-sprt-workflow]]): `kbmirror_320`
  vs current prod net, `tc=8+0.08`, quiet-midgame book, color-swapped pairs, `elo0=0 elo1=5`.
- **Acceptance:** clears the shipped no-mirror `kbfact_320` (+3.4) decisively / accepts H1. If
  it does, it becomes the new prod `lean.bin` (deploy per [[kb-net-prod-default]] — 44 MB KB
  net + `chessgo-deploy`, verify the `lean threats net loaded` journal line, no v6 fallback).
- **One change per SPRT:** mirror only. Do not also change buckets/data/pipeline in the same run.

## Notes

- GPU (vast.ai) is stopped between sessions; first 2 min of the next session re-provision the
  binpack into `/dev/shm` (`/root/fetch2024.sh` — 4 months, ~42.6 GB) before training.
- Follow-ups after mirror lands: pipeline quality (early-fen-skip 16→28 + lambda anneal,
  `data-retrain-640sb.md` / `DATA_RECIPE_SF_2026.md`), then possibly width. Mirror first —
  it's the field-favored density lever and the cheapest structural win left.
