# NPS / infra batch (bit-exact speed → movetime Elo)

Lowest-risk next lever: byte-identical speedups that convert straight to
movetime Elo. All in `zugzwang/src/`.

- **TT modulo → mask** (`tt.cpp`): `table[key % clusterCount]` is a real 64-bit
  division on the hottest path. Round `clusterCount` to a power of two and use
  `key & (n-1)` (or Stockfish's `(key * clusterCount) >> 64`). Cheapest real win.
- **TT prefetch** (`tt.cpp`): `__builtin_prefetch(&TT.table[index])` after the
  child key is computed (gomachine `tt.go`). ~1–3% NPS.
- **TT cache-line align** (`tt.h`): pad `Cluster` to 64 B + `alignas(64)`; also
  try `madvise(MADV_HUGEPAGE)` (~+2.4%).
- **VNNI / NEON dot** (`nnue_eval.cpp`): the L1 dot is a scalar int16-saturating
  loop. Drop in `_mm512_dpbusd_epi32` / NEON `vdotq_s32` behind
  `__AVX512VNNI__` / `__ARM_FEATURE_DOTPROD` (bit-exact — int8QA=127 keeps pairs
  < 32767). Closes the NEON-vs-AVX512 gap.
- **Both-perspective single sweep** (`nnue_eval.cpp`): `evaluate` runs the full
  attack sweep twice (once per perspective). Compute the geometry once, emit both.

**Why.** The remaining ~150–200 Elo gap to Stockfish is eval/net, but these are
free depth. Each is bit-exact, so gate with the golden-eval check + a perft-style
int16 walk, no strength re-measure needed beyond a movetime SPRT.
