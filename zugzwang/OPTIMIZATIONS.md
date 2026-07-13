# Zugzwang — portable optimizations from gomachine

> Backlog of optimizations that **gomachine (Go)** has and **Zugzwang (C++)** does not
> yet, harvested by comparing the two source trees + the gomachine strength docs.
> Written 2026-07-13. Companion to `HANDOFF.md`.

## Why this list exists (read first)

Zugzwang shares gomachine's **exact NNUE net** — eval output is bit-identical. In the
tax match (fixed **100 ms/move**, **no clock / no time management**, **single-threaded**,
same net, both bookless) the two are **statistically even** (Zugzwang +14 ± 24 Elo, 318
games, CI ≈ [−11, +39] → a lean, not an established edge).

Because eval is identical, the match measures exactly two things:

1. **Search efficiency** (strength per node) — move ordering, pruning, extensions, history.
2. **NPS within 100 ms** — how many nodes fit in the budget → depth reached.

So every item below is either a *strength-per-node* win or an *NPS* win. **Time-management
work is out of scope** (there is no clock). SMP/lockless is out of scope (single-threaded).

Two important framings that came out of the comparison:

- **Most of gomachine's celebrated search stack is NOT a gap** — Zugzwang already has it
  (RFP, NMP + eval-scaled R, razoring, IIR, singular+multicut, LMP,
  futility, SEE pruning, aspiration, log·log LMR, check ext, delta pruning, killers,
  countermoves, history gravity, improving, TT-eval reuse). See the parity list at the end.
  The real search gaps are **four features + one constants transplant**.
- **The "+20% pin-aware movegen" win is NOT a gap either** — that number was measured
  replacing a make/unmake legality filter, which Zugzwang never had (it uses lazy incremental
  `legal()`). Don't chase it.

**Elo caveat:** many gomachine numbers below are **fixed-node** SPRTs, not movetime, and
none were measured on the C++ side. Treat them as *priority signal*, not promises;
re-measure on the `~/zug_tax.log` 400-game match after each landed item.

---

## Master priority list (deduplicated, ranked by Elo × ease)

| # | Item | Domain | Expected | Effort | Status |
|---|------|--------|----------|--------|--------|
| 1 | **SF-cache opening book port** | Infra | **+160 Elo vs external** (see note) | Moderate | TODO |
| 2 | **Tuned margin/constant transplant + re-SPRT** | Search | +38.7-class (movetime, bundled) | Trivial | TODO |
| 3 | **Correction history (CorrHist)** | Search | +66.9 @ 40k nodes | Moderate | TODO |
| 4 | **History pruning (HistPrune)** | Search | +86.8 @ 40k nodes | Trivial | TODO |
| 5 | **Incremental int16 accumulator** | NNUE speed | **+21–30% NPS arm64** (bit-exact) | Moderate–hard | **✅ DONE** (multiset-diff; coalla+tax pending) |
| 6 | **Move-aware threat delta** | NNUE speed | ~+14% more NPS | Hard | TODO (unblocked; infra ready) |
| 7 | **TT: kill modulo division** | Infra | cheapest real NPS win | Trivial | TODO |
| 8 | **LMRDoDeeper + ContHist (bundled)** | Search | +19.7 (movetime, bundled) | Moderate | TODO |
| 9 | **int8 VNNI / NEON dot kernel** | NNUE speed | modest; closes NEON gap | Trivial | TODO |
| 10 | **Both-perspectives single sweep** | NNUE speed | halves from-scratch enum | Trivial | TODO |
| 11 | **TT huge pages (madvise)** | Infra | +2.4% NPS | Trivial | TODO |
| 12 | **TT prefetch before probe** | Infra | ~1–3% NPS | Trivial | TODO |
| 13 | **King-bucket/mirror refresh trigger** | NNUE speed | correctness guard for #5 | Moderate | Part of #5 |
| 14 | **TT cluster cache-line alignment** | Infra | minor NPS | Trivial | TODO |
| 15 | **Finny 32-key refresh cache** | NNUE speed | 2nd-order | Moderate | TODO (after #5/#13) |
| 16 | **PEXT slider backend (amd64)** | Infra | small movegen NPS | Moderate | TODO |
| 17 | **Score only legal moves** | Infra | minor | Moderate | TODO |
| 18 | **Syzygy tablebases** | Infra | +18.8 (must be symmetric) | Moderate | Low prio |

---

## The opening book — highest-value single port (#1)

**It is not a normal opening book.** `gomachine/data/book.bin` (594 KB) is a **lookup cache
of Stockfish answers**: each stored position was searched by full Stockfish for ~30 min, so a
probe returns an SF-grade best move for free. In cached lines the engine plays at *Stockfish's*
level regardless of its own search depth.

- **Value:** **+160 Elo vs Stockfish** on gomachine (value of *having* the cache vs a bookless
  opponent).
- **The expensive part already exists** — the SF compute is baked into `book.bin`. Porting is
  just a **loader + a root probe**, reusing the identical asset. Cheap effort, high value.
- **Caveats to not misread the number:**
  - It **washes in a Zugzwang-vs-gomachine match** (both would load the same book) — but it is
    real Elo **vs external engines** (Stockfish, the Abitur gauntlet), which is what matters for
    the sister engine's absolute strength.
  - It only helps in games where the opponent is bookless or has a weaker book.
  - gomachine loads it on `serve`/`hub` only — **its `uci` path is bookless** (`internal/uci/
    uci.go`), which is why it was off for *both* sides in the 100 ms tax match. To use it as a
    fair efficiency signal it must be on for both, or stay off for both (as now).
- **Port:** new self-contained TU — parse gomachine's compiled book format (`gomachine/internal/
  book`), key on position hash, probe at the root before search. Format + asset exist; no recompute.

---

## Search-algorithm gaps (agent 1)

Zugzwang `src/search.cpp`. gomachine `internal/search/{search.go,params.go,ordering.go,
corrhist.go,conthist.go}`.

### #2 — Tuned constant transplant (PARTIAL — different values). Trivial, do first.
Eval is bit-identical, so gomachine's net-tuned constants should largely transplant onto
Zugzwang's generic untuned ones. A/B + re-SPRT each (Zugzwang's tree shape differs, so not all will
carry). Concrete diffs (gomachine → Zugzwang current):

| Constant | gomachine | Zugzwang | Note |
|---|---|---|---|
| Null-move R | `3 + depth/4` (`params.go:225`) | `3 + depth/4 + min((eval-β)/200,3)` (`search.cpp:284`) | gomachine re-tuned 4→3 (part of +38.7) |
| LMR table | `0.7844 + ln·ln/2.4696` (`params.go:545`) | `0.85 + ln·ln/2.6` (`search.cpp:476`) | finer reductions |
| SEE-quiet margin | `-75·depth, d≤6` (`params.go:478`) | `-25·d², d≤8` (`search.cpp:345`) | Zugzwang far more aggressive |
| CaptSEE margin | `-23·depth, d≤4` (`params.go:490`) | `-90·depth, d≤6` (`search.cpp:348`) | |
| RFP | `75·depth, d≤8` (`params.go:548`) | `80·(depth-improving), d≤8` (`search.cpp:278`) | |
| Singular | margin `2·depth`, **min-depth 5** (`params.go:411`) | `2·depth`, **min-depth 8** (`search.cpp:353`) | Zugzwang fires far less often |
| Delta margin (qs) | 200 (`params.go:522`) | 130 (`search.cpp:160`) | |
| History gravity | `MaxHistory 8192`, bonus `32·d²` cap 1536 (`params.go:549`) | clamp ±400, `32·b − h·|b|/512` (`search.cpp:114`) | different gravity law |

Shipped bundle (nullr 4→3, seequietmargin, captseemaxdepth): **+38.7 ± 5.5 movetime**.

### #3 — Correction history (CorrHist). ABSENT. Moderate. Best single-feature ROI.
Learns per-pattern (pawn-key + per-color non-pawn-key) static-eval-vs-search bias and shifts
the static eval by it, sharpening *every* eval-gated decision (RFP, NMP, improving, qsearch
stand-pat). gomachine `search.go:483` (`raw += s.correction(pos)`), tables `corrhist.go`,
weights `CorrWPawn:2 / CorrWNP:1`. Zugzwang uses `eval` raw (`search.cpp:260`).
**+66.9 ± 22.9 @ 40k nodes.** Needs pawn/non-pawn Zobrist sub-keys + two int tables + an update
on non-cutoff nodes + the eval shift. No interaction with the shared net.

### #4 — History pruning (HistPrune). ABSENT. Trivial.
At a shallow non-PV node, skip a late quiet whose butterfly+cont history `< -1000·depth`
(`d≤6`, `params.go:470`). Orthogonal to LMP (move-count) and SEE-quiet, both of which Zugzwang
already has. **+86.8 ± 26.8 @ 40k nodes.** One `if (history[...] < margin*depth) continue;` in
the quiet-pruning block (`search.cpp:336`).

### #8 — LMRDoDeeper + ContHist (bundle). ABSENT. Moderate. Port together.
- **LMRDoDeeper:** after a reduced scout beats alpha, adapt the re-search depth ±1 by how far
  it beat bestScore (gomachine `search.go:1907`). Zugzwang does a plain full re-search at
  unadjusted depth (`search.cpp:385`).
- **ContHist:** 1-ply + 2-ply history tables feeding both quiet ordering *and* the LMR reduction
  (gomachine `ordering.go:77`, `conthist.go`). Zugzwang has only a single `counterMoves[piece]
  [to]` move (`search.cpp:53`), not a table, and it doesn't feed LMR.
- **⚠️ Co-dependency:** gomachine measured ContHist **alone = −54**; it only pays *bundled* with
  LMRDoDeeper + cutnode-LMR (`params.go:358`). Zugzwang has cutnode-LMR (`search.cpp:380`) but
  not doDeeper — so **port doDeeper first/with it**, else ContHist likely regresses.
  Bundle value **+19.7 movetime**.

### Zugzwang is already AHEAD here
Its qsearch has a TT probe+store (`search.cpp:132`) that gomachine keeps OFF (`QSearchTT:false`).
Leave it.

---

## NNUE eval-speed gaps (agent 2)

Zugzwang `src/nnue_*`. gomachine `internal/nnue/*`. Correctness gate for all: **bit-exact vs
gomachine** (37/38 golden, `test/golden_check.sh`) — the int16 accumulator has defined
wraparound, so incremental must reproduce the from-scratch sum *exactly*, not within tolerance.

Today Zugzwang rebuilds both 512-wide int16 halves from scratch every eval (two full attack
sweeps + ~90k int16 adds per leaf, `nnue_eval.cpp:131`). No accumulator across do/undo, no delta,
no Finny cache.

### #5 — Incremental int16 accumulator. ✅ **DONE (2026-07-13). +21–30% NPS arm64, bit-exact.**
Shipped the **plain multiset-diff** — gomachine's correct-by-construction DEFAULT path
(`enriched_acc.go:9-25`), which turned out **better than the base-only first pass suggested here**:
it makes **both base AND threats incremental** with zero slider/king special-casing. Per push it
re-enumerates the child's full feature set (cheap — attack-gen is not the bottleneck) and applies
only the **multiset symmetric difference** vs the parent's stored set; int16 columns commute, so a
king move that changes bucket/mirror just re-buckets the whole base block through the diff — **so
#13 (refresh trigger) is NOT needed for this path** (it only matters for #6's move-aware delta).

**Approach differs from the StateInfo sketch above** (kept for #6's reference): a ply-indexed
`NNUE::AccStack` (`nnue_accumulator.{h,cpp}`) attached to the `Position` for the search's duration
(`Position::set_nnue_acc`), NOT carried in the copied `StateInfo`. `do_move`/`undo_move`/`do_null_
move`/`undo_null_move` drive `push`/`pushNull`/`pop` in lockstep, so the top slot always matches the
current board; `Eval::evaluate` reads the top half in-search and falls back to the from-scratch net
off-search. The forward was refactored into a shared `NNUE::eval_from_halves` (`nnue_internal.h`) so
the from-scratch path and the stack call identical arithmetic → bit-exactness reduces to "incremental
halves == scratch halves" (int16).

- **Files:** new `nnue_internal.h`, `nnue_accumulator.{h,cpp}`; edited `nnue_eval.cpp` (extract
  `eval_from_halves`), `position.{h,cpp}` (optional `nnueAcc` + hooks), `eval.cpp` (dispatch),
  `search.cpp` (attach/reset/detach), `Makefile` (+TU, `ASSERT=1` gate).
- **Gate:** `make ASSERT=1` compiles a from-scratch rebuild + int16-exact compare on **every**
  in-search eval (port of `enriched_acc.go:396`). Verified no drift across ep / castling / promotion
  / pins / tactics at d12; golden still 37/38; identical node counts before/after (same tree).
- **Result (arm64/M3, Kiwipete):** d12 +21%, d13 +26%, d14 +30% NPS — growing with depth (deeper =
  higher eval density). Matches the ~47%-of-CPU / 63%-accumulator-bound arm64 profile.
- **Pending:** coalla (amd64/AVX-512) NPS re-measure + the `~/zug_tax.log` 400-game tax re-run.
- **Next NPS levers on top of this:** #10 (both-persp single sweep — the push enumerates twice per
  node now, so halving it compounds) and #6 (move-aware delta — removes per-node enumeration
  entirely, ~+14%).

### #6 — Move-aware threat delta. ABSENT. Hard. Unblocked (#5 done; reuses its AccStack/applyDiff/assert).
Emit only the threat **edges that change** instead of recomputing all threats. gomachine
`computeDelta` (`enriched_delta.go:300`): changed-square set `D`, affected-attacker set
`S = D ∪ AttackersTo(oldOcc) ∪ AttackersTo(newOcc)`, masked-line diff for discovered/blocked
slider edges. Zugzwang already has `attackers_to` (`position.h:52`) and the bit-exact
`threatIndex` (`nnue_features.cpp:154`); needs a `LineBB` table. **This is the accumulator-bug
minefield** — start with the correct-by-construction *enumerate* variant (subtract every affected
attacker's full edges, add child's, let cancellation work — `pushMoveAwareEnumerate`,
`enriched_delta.go:476`) before the fast changed-edges path. Gate with a perft-style int16-exact
walk (port `TestEnrichedMoveAwareBitExact`).

### #9 — int8 VNNI / NEON dot kernel. ABSENT (scalar). Trivial. Independent of #5.
Zugzwang's L1 dot is a scalar per-pair int16-saturating loop (`nnue_eval.cpp:75`). gomachine
uses `VPDPBUSD` on AVX-512-VNNI (`dotu8i8_vnni_amd64.s`) + NEON. **Bit-exact & safe:** `int8QA=127`
caps activations so any pair ≤ 127·127·2 = 32258 < 32767 → the int16 saturation never triggers →
`VPDPBUSD` is bit-identical here. Drop in `_mm512_dpbusd_epi32` / NEON `vdotq_s32` behind
`#ifdef __AVX512VNNI__` / `__ARM_FEATURE_DOTPROD`, keep scalar fallback. Closes the documented
NEON-vs-AVX512 gap (`HANDOFF.md:99`). Modest (the tail is small) but zero-risk — do it now.

### #10 — Both-perspectives single sweep. ABSENT. Trivial. Independent of #5.
`evaluate` calls `active_features` twice (`nnue_eval.cpp:137`), each doing its own full attack
sweep. Compute the attack geometry once and emit *both* perspectives' indices (geometry is
perspective-independent; only orient/mirror differ). gomachine `appendEnrichedFeaturesBoth`
(`enriched_delta.go:82`). Halves the from-scratch enumeration cost even without incremental.

### #13 — King-bucket/mirror full-refresh trigger. NOT needed for #5; required for #6.
(#5's multiset-diff re-buckets naturally — it re-enumerates the full child set, so a bucket/mirror
cross is just a large-but-automatic diff. This trigger only matters once #6 stops re-enumerating.)
A king move that changes bucket **or** flips the mirror half (crosses d/e file) needs a
from-scratch refresh of the mover's half (bucket/mirror math already ported correctly for
from-scratch, `nnue_features.cpp:198`). gomachine `kingMoveNeedsRefresh` (`kingbucket.go:117`).
Simple-correct first version: **refresh both halves on any king move**, optimize to split-refresh
later. Forgetting the mirror flip (not just the bucket) is a silent-corruption source.

### #15 — Finny 32-key refresh cache. ABSENT. Moderate. After #5/#13.
`finny[2][32]` (perspective × bucket·mirror-half) reuses the last finalized half at a key on
refresh (exact hit → copy; changed → feature-diff; cold → scratch). gomachine `finnyRefreshHalf`
(`enriched_delta.go:238`), Stockfish `AccumulatorRefreshTable` pattern. Second-order (king moves
are a node minority) — do last.

---

## Infrastructure gaps (agent 3)

Zugzwang `src/{tt.cpp,tt.h,bitboard.cpp,movegen.cpp}`. gomachine `internal/search/tt.go`,
`internal/chess/*`.

### #7 — TT: kill the modulo division. ABSENT. Trivial. Cheapest real NPS win.
Zugzwang indexes `table[key % clusterCount]` on **every probe and store** (`tt.cpp:37`);
`clusterCount` is not a power of two → a genuine 64-bit **division** (~20–40 cycles) on the
hottest path. gomachine masks a power-of-two table (`tt.go:143`). Fix: round `clusterCount` down
to a power of two + `key & (n-1)`, or Stockfish's `((key * clusterCount) >> 64)` via
`__uint128_t`. **Rank #1 on ease×value.**

### #11 — TT huge pages. ABSENT. Trivial. **+2.4% NPS.**
Zugzwang uses plain `malloc` (`tt.cpp:14`). gomachine `madvise(MADV_HUGEPAGE)` (`tt.go:117`).
In C++: `posix_memalign` to 2 MiB then `madvise(ptr,bytes,MADV_HUGEPAGE)`, or `mmap(MAP_HUGETLB)`.

### #12 — TT prefetch before probe. ABSENT. Trivial. ~1–3% NPS.
No prefetch anywhere in Zugzwang. gomachine prefetches the bucket line before the probe
(`tt.go:141`). Add `__builtin_prefetch(&TT.table[index])` after computing the child key (couples
with #7's addressing).

### #14 — TT cluster cache-line alignment. ABSENT. Trivial. Minor.
Zugzwang `Cluster` = 4 × 10 B = 40 B, unaligned `malloc` → a cluster scan can straddle two cache
lines (`tt.h:38`). Pad to 16 B/entry × 4 = 64 B and `alignas(64)` (combine with #11's aligned
alloc). gomachine packs exactly one 64 B line per bucket.

### #16 — PEXT slider backend (amd64). ABSENT. Moderate. Small.
Zugzwang is magic-only (`bitboard.cpp:29`). gomachine has a BMI2 PEXT backend on amd64
(`slideratt_pext_amd64.go`), gated (beware pre-Zen3 microcoded PEXT). Add a `_pext_u64`-indexed
table behind `-mbmi2`. Backend choice, not a headline.

### #17 — Score only legal moves. PARTIAL. Moderate. Minor.
`score_moves` runs SEE/MVV-LVA over the full pseudo-legal list, including moves later dropped by
`legal()` (`search.cpp:169`). Reorder to filter/defer. Illegal fraction is low.

### #18 — Syzygy tablebases. ABSENT. Low priority.
gomachine `internal/syzygy` (+18.8 Elo movetime) — **off on the uci path**, so off for both in
the match. Only worth it if enabled for **both** engines (else unfair asymmetry).

---

## NOT gaps — parity, do not waste effort

- **Pin-aware legal movegen** — Zugzwang uses lazy incremental `legal()` (`position.cpp:381`),
  never a make/unmake filter. The gomachine "+20% NPS" was vs a make/unmake filter Zugzwang never had.
- **Qsearch captures-only** (gomachine +20 Elo) — Zugzwang `generate<CAPTURES>` (`search.cpp:166`).
- **TT depth-preferred + generation aging** — Zugzwang 4-entry clusters, argmin(depth − age)
  (`tt.cpp:47`), `generation += 4`.
- **Incremental zobrist, ep-normalized-before-hash** — parity (`position.cpp:273`).
- **BetweenBB/LineBB, magic init, leaper tables** — parity (`bitboard.cpp:168`).
- **NMP eval-scaled R, NMP-nonPV-only, RFP, razoring, IIR, singular+multicut, LMP, futility,
  SEE pruning, aspiration, log·log LMR + cutnode term, check ext, delta pruning, killers,
  countermoves, history gravity, improving, TT-eval reuse** — all already present in Zugzwang; only
  the *constants* differ (see #2).

## Default-OFF in gomachine — do NOT port (reverted / unproven)
LMR2, DoubleExt, ProbCut (−77.7 in movetime stack), CorrHistMinor, CorrHistCont, ContHist2, PCM
bonus/malus, NegExt, DeferredQuiets, RFPSoft, NmpMargin, QSearchTT. Scaffolding under SPRT, no
shipped Elo.

---

## Suggested execution order

1. **#9 int8 VNNI/NEON + #10 both-persp sweep** — trivial, zero-risk, independent of the WIP
   accumulator; NPS now.
2. **#7 TT division + #11 huge pages + #12 prefetch + #14 align** — trivial TT batch, a few % NPS,
   independent of everything.
3. **#2 constant transplant** — trivial, A/B + re-SPRT each; likely +38.7-class.
4. **#4 HistPrune** (trivial, +86.8) then **#3 CorrHist** (moderate, +66.9) — top search ROI.
5. **#1 book port** — moderate, +160 vs external (measure vs Stockfish / Abitur, not vs gomachine).
6. **#8 LMRDoDeeper + ContHist** together (moderate, +19.7).
7. Land **#5 incremental accumulator** (other instance) → then **#6 threat delta** (hard) →
   **#13 split-refresh** → **#15 Finny cache**.
8. Low prio: **#16 PEXT**, **#17 legal-only scoring**, **#18 Syzygy** (symmetric only).

Re-run the coalla `~/zug_tax.log` 400-game match (movetime 100 ms) after each meaningful item to
attribute the gain — self-play-even today means small per-item swings; watch the trend.
