# NPS / infra batch (bit-exact speed → movetime Elo)

Lowest-risk lever: byte-identical speedups that convert straight to movetime Elo.
All in `zugzwang/src/`.

## SHIPPED — 2026-07-14 (commits `e2581d1` + fix `d43d489`, on main)

Batch of 4 landed together, **movetime SPRT ACCEPTED**: **+36.9 Elo ±11.1**, LLR
2.95 (accept), 1098 games @ 100 ms/move, 55.3%, Ptnml `[3,75,299,145,26]`
(cand vs prod base, coalla). Eval is bit-exact (proof, not sample) and the
fixed-depth search tree is identical to base — so the entire gain is raw speed
(~+25–38% NPS on coalla) buying extra depth at fixed movetime.

- **TT modulo → multiply-high index** (`tt.cpp`/`tt.h`): `key % clusterCount`
  replaced by Stockfish `((u128)key * clusterCount) >> 64` — no 64-bit division on
  the hot path, uses full clusterCount (no power-of-two rounding).
- **TT prefetch** (`tt.h`/`search.cpp`): `__builtin_prefetch` of the child cluster
  right after each `do_move` (both search sites).
- **TT cache-line align** (`tt.h`/`tt.cpp`): `alignas(64) Cluster` (one per line) +
  `aligned_alloc(64, …)`. (Did NOT add madvise/hugepages.)
- **VNNI / NEON L1 dot** (`nnue_eval.cpp`): scalar `dot_u8i8` kept as fallback;
  dispatches to `_mm512_dpbusd_epi32` (`__AVX512VNNI__`) / `vdotq_s32`
  (`__ARM_FEATURE_DOTPROD`). Provably bit-exact: activation ∈ [0,127], weights ∈
  [−127,127] ⇒ every pair-sum stays inside int16 so the scalar model's saturation
  never fires ⇒ the widening dot gives the identical int32; verified `max_abs eval
  diff = 0` vs base over the golden FENs with the net loaded on **both** arm64 (NEON)
  and amd64 (VPDPBUSD, 8 `vpdpbusd` in the binary).

> ⚠️ **Bug caught during this batch (why fixed-depth + SPRT gating is non-negotiable).**
> The mul-high index is driven by the HIGH bits of the key, but `TTEntry.key16` was
> also the high bits (`key>>48`). So every key in a cluster shared the same key16, the
> `entry.key16 == key16` verify passed for unrelated positions, and the TT returned
> garbage moves → thousands of illegal ttMoves → **−370 Elo** — even though eval stayed
> bit-exact and the golden gate passed. Fix (`d43d489`): key16 from the LOW bits
> (`uint16_t(key)`), independent of the index (this is why Stockfish keys its verify on
> the low bits). Lesson: bit-exact eval does NOT imply strength-neutral search; a TT
> change must clear a fixed-depth tree diff + a movetime SPRT.

## REMAINING

- **Both-perspective single sweep** (`nnue_eval.cpp` / `nnue_features.cpp`):
  `evaluate` runs the full attack sweep twice (once per perspective). Compute the
  geometry once, emit both. LOW priority — this only speeds the from-scratch
  `evaluate()`, which is rare inside search (the incremental AccStack handles
  in-search eval), so little movetime impact.
- **Fix `make perft` link** (`Makefile`): the `perft` target omits
  `nnue_accumulator.cpp`, so `make perft` fails to link (pre-existing, unrelated to
  the batch; found while gating it). Movegen currently verifiable via the UCI
  `perft` command instead.

**Why.** The remaining ~150–200 Elo gap to Stockfish is eval/net, but these are free
depth. Each is bit-exact / behavior-identical, so gate with the golden-eval check +
a fixed-depth tree diff + a movetime SPRT — no strength re-measure of the eval needed.
