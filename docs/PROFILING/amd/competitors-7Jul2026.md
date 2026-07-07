# Competitor CPU profiles — 7 Jul 2026 (amd64 / coalla, AVX-512)

Symbolized single-thread CPU profiles of **Stockfish 18** (current release) and
**Stormphrax**, both built for **AVX-512** on coalla, for comparison against
gomachine's own amd64/AVX-512 profile (`amd/6Jul2026.md`). The **Stockfish 17.1**
profile is retained below as a last-gen datapoint, because 17.1→18 is an
architecture change directly relevant to chessgo: **SF 18 added threat input
features** to its NNUE net. Profiler: Linux `perf record -F 999 --call-graph fp`,
then `perf report`. Uniform workload for every engine: `setoption Threads 1`,
`Hash 256`, `position startpos`, `go movetime 20000`. perf reports both **Self%**
(flat) and **Child%** (cumulative).

All engines built from source with symbols (`-g -fno-omit-frame-pointer`) — the
official/apt release binaries are stripped and useless for a function-level
profile. Coalla snags cleared (no `make`/`clang`/`sudo`): GNU make 4.4.1 was
bootstrapped from source to compile SF; Stormphrax's AVX-512 path uses a clang-ism
(`_mm512_insertf64x4` on integer vectors) that g++ rejects — **that is why the
prior coalla Stormphrax was forced to `-mno-avx512f`** (AVX2). Patched the one site
to the bit-identical `_mm512_inserti64x4`; AVX-512 confirmed engaged (bench NPS
483k→505k).

## Stockfish 18 (amd64 / x86-64-avx512) — current

`sf_18`, GIT_SHA `cb3d4ee9`, `-DUSE_AVX512 -mavx512f -mavx512bw -mavx512dq
-mavx512vl -mbmi2 -DUSE_PEXT -flto`, not stripped. **678,497 nps @ depth 35** this
run.

**Net architecture changed vs 17.1 — threats added.** The big net is now driven by
**two feature sets into one 1024-wide accumulator** (arch string `(102384, 1024,
15, 32, 1)` = 79856 threat + 22528 PSQ inputs → FT 1024 → L2 15 → L3 32 → 1):
- **`FullThreats`** (`Name="Full_Threats(Friend)"`, `Dimensions=79856`, up to 128
  active, `DirtyThreats` incremental path; `src/nnue/features/full_threats.{h,cpp}`)
  — **new in 18**.
- **`HalfKAv2_hm`** as the PSQ feature set (`Dimensions=22528`) — 17.1's net was
  HalfKAv2_hm *alone* at `(…, 3072, …)`.

SF **narrowed the FT 3072 → 1024** and spent the budget on a separate threat
accumulator + threat bookkeeping. Big net grew 66 MB → 108 MB.

| Function | Self% | Child% | What |
|---|---|---|---|
| `update_accumulator_incremental<FullThreats,1024>` | 18.3 | 23.1 | threat FT incremental add/sub — hottest |
| `Search::Worker::search<NonPV>` | 9.6 | 98.7 | α-β recursion self-time |
| `Network<1024>::evaluate` | 9.2 | 52.3 | NNUE forward pass (FT fuse → affine L1/L2 → output) |
| `MovePicker::next_move` | 9.0 | 13.5 | staged move selection |
| `update_accumulator_incremental<HalfKAv2_hm,1024>` | 8.0 | 10.1 | PSQ FT incremental add/sub |
| `FullThreats::append_changed_indices` | 4.5 | 4.5 | threat dirty-feature index diff (new) |
| `Position::do_move` | 3.9 | 10.9 | make-move (now carries `DirtyThreats`) |
| `partial_insertion_sort` | 3.1 | — | move-ordering sort |
| `Position::update_piece_threats<false,true>` | 2.4 | — | per-move threat board delta (new) |
| `HalfKAv2_hm::append_changed_indices` | 2.4 | — | PSQ dirty-index diff |
| `AccumulatorStack::evaluate_side<HalfKAv2_hm>` | 2.3 | 14.7 | PSQ per-side eval / refresh umbrella |
| `double_inc_update<FullThreats>` | 1.8 | 2.9 | fused two-square threat update |
| `update_accumulator_refresh_cache<HalfKAv2_hm>` | 1.5 | — | finny-style PSQ refresh |
| `Position::update_piece_threats<true,true>` | 1.5 | — | threat board delta (new) |
| `Position::swap_piece` | 1.5 | — | board update w/ `DirtyThreats` |
| `AccumulatorStack::evaluate_side<FullThreats>` | 1.4 | 28.1 | threat per-side eval / refresh umbrella |
| `correction_value` | 1.2 | — | corrhist eval correction |
| `TranspositionTable::probe` | 1.2 | — | TT lookup |
| `Position::see_ge` | 1.1 | — | SEE |

**~54% eval / ~46% search** (`Eval::evaluate` cum 53.9%). Within eval the
composition **shifted decisively toward threats**: the threat-accumulator
maintenance umbrella (`evaluate_side<FullThreats>`) is **28% cum** — bigger than
the PSQ/HalfKA umbrella (~15% cum) — and `update_accumulator_incremental<FullThreats>`
(18.3% self) is now **the hottest function in the whole engine**, ahead of even
`search`. The forward pass (`Network::evaluate` ~9% self) **roughly halved vs
17.1's ~17% flat**, exactly because the FT narrowed 3072→1024. Entirely new vs
17.1: **~10% of the process is threat bookkeeping** — `append_changed_indices`
(4.5%+2.4%), `update_piece_threats` (2.4%+1.5%), and `DirtyThreats` threading
through `do_move`/`swap_piece`. SF traded raw FT-width for a second threats
accumulator at a modest ~5% NPS cost (718k→678k) that buys the strength gain.

## Stockfish 17.1 (amd64 / x86-64-avx512) — last-gen, for comparison

`sf_17.1`, GIT_SHA `03e27488`, `-DUSE_AVX512 -mavx512f -mavx512bw -mbmi2 -flto`.
**717,760 nps @ depth 34.** Net = HalfKAv2_hm **3072-wide alone, no threat
inputs**. Retained to show the generational shift.

| Function | Self% | Child% | What |
|---|---|---|---|
| `Network<3072,15,32>::evaluate` | 17.2 | 53.8 | NNUE forward pass (FT → affine L1/L2 → output) |
| `update_accumulator_incremental<White>` | 15.2 | — | incremental FT accumulator add/sub (white persp) |
| `update_accumulator_incremental<Black>` | 13.5 | — | incremental FT accumulator (black persp) |
| `Worker::search<NonPV>` | 12.9 | 97.3 | α-β search self-time |
| `MovePicker::next_move` | 9.9 | 14.5 | staged move selection |
| `Position::do_move` | 4.1 | 5.8 | make-move |
| `partial_insertion_sort` | 3.2 | — | move-ordering sort |
| `update_accumulator_refresh_cache<Black>` | 2.5 | — | finny-style refresh cache |
| `update_accumulator_refresh_cache<White>` | 2.3 | — | finny-style refresh cache |
| `HalfKAv2_hm::append_changed_indices<White>` | 1.7 | — | changed feature indices per move |
| `qsearch` | 1.4 | 26.3 | quiescence |
| `Position::see_ge` | 1.1 | — | SEE |
| `Network(small)::evaluate` | 1.1 | — | small-net forward pass |

**~55% eval / ~40% search.** With one 3072-wide HalfKA net, eval split ~2:1
maintenance:forward — accumulator maintenance (incremental 28.7% + refresh-cache
4.8% + append-indices 2.6% ≈ 36% flat) vs the forward pass (~18% flat). The
forward pass was heavy purely because the net was so wide. 18 keeps eval's *share*
(~54–55%) but redistributes it: FT-width forward tax halved, a threats accumulator
added on top.

## Stormphrax (amd64 / AVX-512)

Source via patched `gbuild-avx512.sh` (g++, `-march=native -O3 -DSP_NATIVE
-DSP_FAST_PEXT -g`). **418,556 nps @ depth 28.** Net `undertown` = 640-wide,
threats + king-buckets (`KingBucketsMergedMirrored`), pairwise multilayer
CReLU→SCReLU→CReLU, MaterialCount output.

| Function | Self% | Child% | What |
|---|---|---|---|
| `updatePsq` | 25.0 | — | incremental PSQ / king-bucket FT accumulator update — hottest |
| `applyThreatUpdates` | 15.9 | — | incremental threat-feature input update |
| `refreshPsqAccumulator` | 15.4 | — | full king-bucket accumulator refresh |
| `PairwiseMultilayer CReLU/SCReLU/CReLU` | 8.1 | — | NNUE forward pass (pairwise-mul multilayer) |
| `Searcher::search<false,false>` | 4.9 | 98.6 | α-β search self-time |
| `MoveGenerator::scoreQuiets` | 2.9 | — | quiet-move ordering scores |
| `NnueState::push` | 2.3 | — | accumulator-stack push |
| `generateSliders` | 1.3 | — | slider movegen |
| `MoveGenerator::findNext` | 1.2 | — | staged move selection |
| `CorrectionHistoryTable::correction` | 0.9 | — | corrhist eval correction |
| `threatFeatureIndex` / `updatePieceThreatsOnMove` / `calcThreats` | ~2.1 | — | threat-feature index / edge bookkeeping |
| `see` / `calcCheckersAndPins` / `applyMove` | ~2.6 | — | SEE + check/pin + make-move |

**~72% eval / ~20% search** — far more eval-bound than SF. Eval is overwhelmingly
accumulator **maintenance**: `updatePsq` + `applyThreatUpdates` +
`refreshPsqAccumulator` ≈ **56% flat** vs an 8% forward pass — a **~7:1
maintenance:forward** ratio, like gomachine's profile. Stormphrax runs the same
enriched-threats + king-bucket design gomachine explored; its big
`refreshPsqAccumulator` (15.4%) shows the king-bucket refresh is a real cost with
no finny-style cache absorbing it — contrast SF, whose refresh cache keeps PSQ
refresh to ~1.5–4.8%.

## Cross-engine takeaway (AVX-512)

The headline update: **all three engines now use threat input features and all
three are dominated by threat/accumulator maintenance.** SF 18's move into threats
(HalfKA-only in 17.1) is direct external validation of the enriched-threats
direction gomachine and Stormphrax already took — its hottest single function is
now `update_accumulator_incremental<FullThreats>`, exactly like Stormphrax's
`applyThreatUpdates` and gomachine's `applyDiff` / `addColI8SIMD`.

The remaining divergence is the **forward pass**, and it tracks **net shape**:

- **gomachine** (narrow current net): forward ~7% cum — negligible.
- **Stormphrax** (640-wide pairwise multilayer + threats): forward ~8% flat, ~7:1
  maintenance:forward.
- **SF 17.1** (3072-wide single HalfKA): forward ~17% flat, ~2:1 — heavy purely
  from FT width.
- **SF 18** (1024-wide + threats): forward ~9% flat — SF *narrowed* the transformer
  to fund threats, halving the forward tax while adding ~10% new threat
  bookkeeping; eval's overall share held at ~54%.

The lesson for chessgo's width/multilayer/threats decisions: threats are where the
strong engines are spending, and the cheapest way to fund them (per SF 18) is to
**narrow the transformer rather than add width on top** — keep maintenance the
bottleneck, don't let the forward pass climb toward co-dominant. On AVX-512, SF
also spends far more in real search machinery (~40–46%) than Stormphrax (~20%) — it
searches a wider/deeper tree per node (higher NPS, deeper) rather than pouring
everything into eval.

## Notes

- All SF/Stormphrax builds: `-g` + frame pointers; perf `--call-graph fp`, `-F 999`.
- **Method caveat (SF net-load):** the big net is 108 MB; a naive capture can be
  dominated by a ~750 ms net-load if `quit`/stdin-EOF aborts the async search. The
  SF 18 run held stdin open (`sleep`) and used `perf record -D 5000` to skip the
  load — clean 25s window. Use the perf **Self** column; `-g none --no-children`
  mis-folds the LTO `<FullThreats>` clone.
- Raw artifacts on coalla: `/home/tim/prof-avx512/{sf18,stockfish,stormphrax}.data`
  (`stockfish.data` = the SF 17.1 run) + `*_run.out`. Binaries:
  `/home/tim/sf18/src/stockfish`, `/home/tim/sf171/src/stockfish`,
  `/home/tim/stormphrax/stormphrax-avx512`. Reproduce:
  `perf report -i /home/tim/prof-avx512/sf18.data --stdio --percent-limit 1`.
- The prior coalla Stormphrax (`/home/tim/stormphrax/stormphrax`) is an AVX2 build
  (`-mno-avx512f`); this profile used the newly-built AVX-512 variant.
- NEON counterparts: `arm/competitors-7Jul2026.md`.
