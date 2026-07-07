# Competitor CPU profiles — 7 Jul 2026 (arm64 / M3, NEON)

Symbolized single-thread CPU profiles of **Stockfish 18** (current release) and
**Stormphrax 8.0.0** on this M3, for comparison against gomachine's own arm64/NEON
profile (`arm/7Jul2026.md`, current; see `arm/6Jul2026.md` for the previous baseline). The **Stockfish 17.1** profile is retained below as a
last-gen datapoint, because 17.1→18 is an architecture change directly relevant to
chessgo: **SF 18 added threat input features** to its NNUE net. Profiler: macOS
`sample`, 18s. Uniform workload for every engine: `setoption Threads 1`, `Hash
256`, `position startpos`, `go movetime 20000`. Both engines run search on a
worker thread; the idle main thread (`__read_nocancel` on stdin) is excluded, so
**Self% is normalized over work samples** (total − idle).

## Stockfish 18 (arm64/NEON) — current

Built from source, `ARCH=apple-silicon`, symbols present. **1,111,659 nps @ depth
36** this run (22.2M nodes).

**Net architecture changed vs 17.1 — threats added.** The big net is now driven by
**two feature sets** feeding one accumulator:
- **`FullThreats`** ("Full_Threats(Friend)"), `Dimensions = 79856`, up to **128
  active** features, with a `DirtyThreats` incremental-diff path
  (`src/nnue/features/full_threats.{h,cpp}` — new in 18).
- **`HalfKAv2_hm`** as the PSQ feature set (17.1's net was HalfKAv2_hm *alone*).

The big-net FT width **dropped 3072 → 1024** (`TransformedFeatureDimensionsBig =
1024`; L2=15, L3=32, 8 PSQT buckets / 8 layer stacks; small net 128-wide). SF
narrowed the transformer and spent the budget on **threat input features** — the
same enriched-threats direction gomachine and Stormphrax already use.

| Function | Self% | What |
|---|---|---|
| `AccumulatorUpdateContext<FullThreats,1024>::apply` | 23.2 | threat-feature accumulator incremental add/sub — hottest |
| `AccumulatorStack::evaluate_side<HalfKAv2_hm,1024>` | 19.3 | per-side HalfKA accumulator eval / refresh |
| `MovePicker::next_move` | 10.6 | staged move selection |
| `NetworkArchitecture<1024,15,32>::propagate` | 7.7 | NNUE forward pass (affine L1/L2 → output) |
| `AccumulatorStack::evaluate_side<FullThreats,1024>` | 6.6 | per-side threat accumulator eval / refresh |
| `Search::Worker::search<NonPV>` | 6.1 | α-β recursion self-time |
| `Network::evaluate` | 5.6 | forward-pass driver |
| `Position::update_piece_threats<…>` (4 variants) | 4.5 | per-move dirty-threat tracking (new) |
| `TranspositionTable::probe` | 2.8 | TT lookup |
| `Position::see_ge` | 2.7 | SEE for ordering/pruning |
| `Position::do_move` | 1.7 | make-move |
| `qsearch<NonPV>` | 1.1 | quiescence |
| `FullThreats::append_changed_indices` | 1.1 | threat dirty-feature index diff (new) |
| `Position::set_check_info` | 0.9 | check / pin info |
| `AffineTransform<30,32>::propagate` | 0.8 | output affine layer |

**~71% eval / ~28% search.** The single 40%-flat `FeatureTransformer<3072>::transform`
monster of 17.1 is **gone**: FT accumulator work now splits across the **threat**
apply (23.2%) + the HalfKA / threat `evaluate_side` refresh paths (19.3% + 6.6%),
and the forward pass shrank to ~14% (propagate 7.7% + driver 5.6%) because the net
narrowed 3072→1024. New this version: **~6% of total is pure threat bookkeeping**
(`update_piece_threats` 4.5% + `append_changed_indices` 1.1%) that didn't exist in
17.1 — the cost of maintaining which threats changed per move. The upshot: the
**threat-feature accumulator is now SF's hottest single function**, and SF paid for
threats by *narrowing* the transformer rather than widening, keeping total eval
cost in check.

## Stockfish 17.1 (arm64/NEON) — last-gen, for comparison

Homebrew arm64 binary, `id name Stockfish 17.1`. Net = HalfKAv2_hm, **3072-wide**
single big net, **no threat inputs**. Retained to show the generational shift.

| Function | Self% | What |
|---|---|---|
| `FeatureTransformer<3072>::transform` | 40.5 | NNUE accumulator update / feature transform — hottest |
| `NetworkArchitecture<3072,15,32>::propagate` | 27.7 | NNUE forward pass (L1 affine → output) |
| `Search::Worker::search<PV>` | 4.9 | α-β recursion self-time |
| `MovePicker::next_move` | 4.8 | staged move selection |
| `update_accumulator_refresh_cache<BLACK>` | 3.5 | king-bucket refresh (finny cache) |
| `update_accumulator_refresh_cache<WHITE>` | 3.1 | king-bucket refresh |
| `partial_insertion_sort` | 2.2 | move-ordering sort |
| `TranspositionTable::probe` | 2.1 | TT lookup |
| `Position::see_ge` | 1.9 | SEE for ordering/pruning |
| `Eval::evaluate` | 1.1 | eval entry / dispatch |
| `Position::do_move` | 0.9 | make-move |
| `qsearch<NonPV>` | 0.9 | quiescence |
| `update_slider_blockers` | 0.8 | pin / blocker calc |
| `HalfKAv2_hm::append_changed_indices` | 0.4 | dirty-feature index diff |

**~77% eval / ~20% search.** With one big 3072-wide HalfKA net, eval was the
feature transform (40.5%) + forward `propagate` (27.7%) — the *forward pass* was a
first-class cost purely because the net was so wide. 18 keeps a heavy forward-ish
share but redistributes eval toward threat maintenance and cuts the raw FT-width
tax roughly in half.

## Stormphrax 8.0.0 (arm64/NEON)

Built from source: the Makefile's `native`/`armv8-4` targets need LLD (absent on
stock macOS), so we replicated `gbuild.sh` with Apple `clang++`
(`-march=native -DSP_NATIVE`, dropping the x86 `-mno-avx512f` / `-DSP_FAST_PEXT`
→ NEON+dotprod path via `arch.h`; net re-permuted for the NEON layout). Symbols
present, ~1.0–2.5M NPS on bench. Net `undertown` = **640-wide, king-buckets +
mirroring, pawn-threat inputs, pairwise multilayer CReLU→SCReLU→CReLU with a
MaterialCount output**.

| Function | Self% | What |
|---|---|---|
| `applyThreatUpdates` | 21.9 | threat-feature accumulator update — hottest |
| `PairwiseMultilayer::propagateL2` | 16.0 | forward pass layer 2 (64→64) |
| `PairwiseMultilayer::propagateL1` | 7.5 | forward pass layer 1 (sparse 640→64) |
| `updatePsq` | 6.9 | PSQ / king-bucket accumulator update |
| `PairwiseMultilayer::propagate` | 4.6 | forward pass driver (FT → output) |
| `refreshPsqAccumulator` | 4.6 | king-bucket full refresh |
| `search::Searcher::search` | 4.0 | α-β recursion self-time |
| `_platform_memmove` | 2.6 | struct / list copies |
| `MoveGenerator::next` | 2.6 | staged movegen |
| `updatePieceThreatsOnMove` | 2.4 | incremental threat delta |
| `see::see` | 2.2 | SEE |
| `threatFeatureIndex` | 2.1 | threat feature indexing |
| `Position::movePiece` | 2.0 | make-move (board) |
| `generateSliders` | 1.8 | slider movegen |
| `MoveGenerator::scoreQuiets` | 1.8 | quiet-move ordering |
| `givesDirectCheck` | 1.3 | check detection |
| `ensureUpToDate` | 1.2 | lazy accumulator sync |

**~68% eval / ~28% search.** Hottest is `applyThreatUpdates` (threat-accumulator
maintenance, 21.9%) — the direct analogue of gomachine's `applyDiff` /
`addColI8SIMD`, and now of SF 18's `AccumulatorUpdateContext<FullThreats>::apply`.
The forward pass is very heavy here: `propagateL2` (16%) + `propagateL1` (7.5%) +
`propagate` (4.6%) ≈ **28% of work in the multilayer forward alone** — a concrete
cost data-point for the multilayer / threats / king-bucket architecture chessgo has
been evaluating. On NEON the pairwise-multilayer forward is *not* cheap; it rivals
accumulator maintenance.

## Cross-engine takeaway (NEON)

The headline update: **all three engines now use threat input features and all
three are dominated by threat/accumulator maintenance.** SF 18's move into threats
(previously HalfKA-only in 17.1) is direct external validation of the
enriched-threats direction gomachine and Stormphrax already took — and its hottest
single function is now the threat-accumulator apply, exactly like Stormphrax's
`applyThreatUpdates` and gomachine's `applyDiff`.

The remaining divergence is the **forward pass**, and it tracks **net shape**:

- **gomachine** (narrow current net): forward ~7% cum — negligible.
- **Stormphrax** (640-wide pairwise multilayer + threats): forward ~28% — the
  multilayer affine chain is a real cost even on NEON.
- **SF 17.1** (3072-wide single HalfKA): forward ~28% purely from FT width.
- **SF 18** (1024-wide + threats): forward ~14% — SF *narrowed* the transformer to
  fund threats, cutting the forward-pass tax roughly in half while adding ~6% of
  new threat-bookkeeping cost.

The lesson for chessgo's width/multilayer/threats decisions: threats are where the
strong engines are spending, and the cheapest way to fund them (per SF 18) is to
*narrow* the transformer rather than add width on top — keep maintenance the
bottleneck, don't let the forward pass climb toward co-dominant. Search machinery
is a long thin tail in every case (~20–28%).

## Notes

- `sample` self% is derived from top-of-stack (leaf) counts in the "Sort by top of
  stack, same collapsed" section; cumulative comes from the call tree.
- SF 18 NEON scope note: the `quit` after `go` can EOF-kill the search — hold stdin
  open (trailing `sleep`) so the 20s search actually runs.
- Raw sample dumps: `scratchpad/sf18_neon.sample.txt`,
  `scratchpad/sf171_neon.sample.txt`, `scratchpad/stormphrax_neon.sample.txt`.
- amd64/AVX-512 counterparts: `amd/competitors-7Jul2026.md`.
