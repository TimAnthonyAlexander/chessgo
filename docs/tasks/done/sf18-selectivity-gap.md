# zugzwang vs Stockfish 18: closing the search-selectivity gap

## OUTCOME (2026-07-14 campaign — DONE, branch `feat/sf-selectivity`)

Worked the ranked techniques below in 5 movetime-SPRT waves on coalla. **Honest
cumulative (settled endpoint SPRTs): +16.8 Elo @ movetime (746 games, LB +3.9) /
+20.0 @ fixed-nodes (1600 games, LB +11.1) vs pre-campaign main (353024b)** — the
per-wave sum was +61, sub-additive because the waves overlap on the depth/
selectivity axis. (FN read +30 early and converged to +20 — early SPRT reads run
high; trust the settled number.)

**Shipped (default-on):**
- Wave 1 (264a964): cheap TT-only ProbCut (#2a) · depth−=2 after alpha-raise (#11)
  · cutoffCnt→LMR bump (#6). +12 vs main.
- Wave 2 (b1ed30d): hindsight priorReduction (#8). +10. *(ttCapR #3a + mcLinR #3b
  bisected out as a −13 drag; env-kept.)*
- Wave 4 (c82b3f9): **ttPv (#5)** — persist a former-PV bit in the TT (genBound
  gen(5)|pv(1)|bound(2)); gates RFP + de-reduces LMR. +11. **Unlocked #4.**
- Wave 5 (d788f19): **double singular extension (#4)**, conservative (non-PV,
  `s<singularBeta−64`, no triple). **+28 — biggest wave; ttPv made it possible.**
- Plus a search-neutral **PV fix** (aee65db): reset `ss->pvLen` before qsearch
  dispatch — killed stale illegal-PV lines (2847→0 in fastchess; also fixes the
  website `/candidates`+`/analyze-game` PV arrows).

**Dropped — SATURATED (washed at movetime AND fixed-nodes):** threat-aware quiet
ordering (#10) + eval-diff quiet-history (#12). zug's existing history+contHist
ordering already captures the signal. Env-kept (`THREATORDER=1`/`EVALHIST=1`) for
a future fixed-nodes re-eval.

**Deferred / untested:** triple extension (Wave 6, `TRIPLEEXT=1`, off, commit
724f0c3 — margin wants SPSA, not a fixed −200); #7 ttMoveHistory (feeds #4's
margin); #9 aspiration-relative reduction (poor fit for zug's integer `r`);
remaining #3 LMR terms (need ttPv wiring, now present).

**KEY FINDING → next work:** FN(+20) ≥ MT(+16.8) — the selectivity is genuinely
smart (fixed-nodes *rose*, so NOT bad-roads over-pruning; NPS only ~1-4% off).
The modest ~+3 FN>MT gap is **tree cost** (extensions inflate the tree → slightly
less depth realised at movetime), same shape as ContHist's FN→MT gap but smaller.
Recovery lever = **SPSA re-tune the extension/reduction margins to keep the
per-node quality while shrinking the tree** — see `open/spsa-margin-polish.md`.

Method that worked: every technique behind a default-valued `Tune` flag with an
env kill-switch, **byte-identical-off verified** each wave; movetime SPRT
(`sprt.sh`) + fixed-nodes SPRT (`sprt_fn.sh`, `nodes=50000`) on coalla;
accept on LB>0 after 400+ games. Deploy: merge `feat/sf-selectivity` → main.

---

## Problem statement

On identical positions/net, SF18 reaches depth 16 in ~71k nodes and depth ~35
in its bench; zugzwang needs ~90–500k nodes for depth 16 and tops out around
depth 21 at 1800ms — despite zugzwang having *higher* raw NPS than SF. The gap
is therefore not throughput but **effective branching factor (EBF)**: SF spends
its nodes on fewer, better-chosen subtrees per ply because its move ordering
puts the cutoff move first far more often and its pruning/extension decisions
are keyed on much richer signals (learned capture quality, hindsight on how
much a parent was reduced, aspiration-window-relative reduction scaling,
ttPv/cutoffCnt tracking). Closing this gap means importing SF's *selectivity*
machinery — not more speed — into zugzwang's `search.cpp`.

Sources: zugzwang `src/search.cpp` (1130 lines) / `search.h`; SF18
`search.cpp` (2211 lines) / `movepick.cpp` / `history.h` (paths under the
scratchpad given in the task).

---

## Per-technique analysis

### 1. Capture history table (learned capture ordering)

- **SF**: `CapturePieceToHistory` (`history.h:142`, `[piece][to][capturedPieceType]`,
  D=10692), populated in `movepick.cpp:154-156` (`m.value = captureHistory[pc][to][victimType]
  + 7*PieceValue[victim]`), updated in `update_all_stats` (search.cpp:1856,
  1869: `+bonus*1395/1024` on the winning capture, `-malus*1448/1024` on
  every other capture searched at that node) and in the fail-low countermove
  path (search.cpp:1452: `captureHistory[...] << 1012`). Also drives SEE
  margins (`captHist/29`, `captHist/1024` in futility, `search.cpp:1063-1079`).
- **zugzwang status**: **absent**. `score_moves_impl` (search.cpp:338-369)
  orders captures purely by static MVV-LVA (`PieceVal[victim]*16 -
  PieceVal[attacker]`) plus a binary good/bad SEE split (`pos.see_ge(mv,-50)`).
  No learning signal distinguishes two captures with the same victim/attacker
  pair but very different historical success (e.g. a capture that walks into
  a recapture vs. one that doesn't, at otherwise-equal MVV-LVA).
- **Why it helps selectivity**: captures are searched first and most captures
  cause the actual cutoff in real games; a learned tiebreak inside each
  MVV-LVA bucket (and a real number to blend with SEE-goodness) moves the true
  best capture earlier within its bucket, raising first-move cutoff rate —
  directly lowers EBF without touching pruning at all.
- **Implementation sketch**: add `int captHist[CONT_PIECE_NB][64][7]` (piece
  moved (dense) × to-square × captured piece type) to `Context`, sized like
  `history[][][]`. In `score_moves_impl`, for the capture branch replace/augment
  `mvvlva` with `mvvlva + captHist[piece_dense(mover)][to_sq(mv)][victim]`
  (scale so ordering doesn't invert the good/bad SEE split — SF keeps
  captHist as a *tiebreak within* good/bad buckets, not a bucket override).
  Update on cutoff in the same block that updates `history`/`contHist`
  (search.cpp:840-865): add a capture-specific branch mirroring
  `update_history`'s gravity formula (`corrhist_update_entry`-style clamp),
  crediting the winning capture and penalizing every other capture tried at
  that node (need a `capturesSearched[]` array parallel to `quietsSearched[]`,
  currently not collected at all — zug's move loop only tracks quiets in
  `quietsSearched`, search.cpp:669-670,833).
- **Expected impact / effort**: **M** effort (new table + new tracking array +
  update-site plumbing); Elo band **+5 to +15** (capture ordering matters a
  lot, but zug's existing SEE split already captures most of the big wins).
  Gate: movetime SPRT vs current build, **and** a fixed-depth node-count/EBF
  check on a tactical suite (captures dominate tactical positions) since Elo
  SPRT alone is noisy for pure-ordering changes.
- **Risk/interaction**: none with contHist (orthogonal — contHist is
  quiet-only in zug and SF both). Must NOT let captHist flip a good-SEE
  capture behind a bad-SEE one in ordering — keep the good/bad SEE split as
  the primary bucket, captHist strictly a same-bucket tiebreak (as SF does:
  captHist is part of `m.value` but SEE gating happens later in `GOOD_CAPTURE`
  stage, i.e. ordering-within-stage, not stage selection).

### 2. ProbCut (both variants)

- **SF main ProbCut** (`search.cpp:935-981`): at `depth>=3`, not near-decisive
  beta, `probCutBeta = beta + 235 - 63*improving`; generates captures with
  `MovePicker(pos, ttMove, probCutBeta - staticEval, &captureHistory)`
  (SEE-threshold move picker), does a **qsearch** verification then, if it
  holds, a **reduced full search** at `depth - 5 - (staticEval-beta)/315`; a
  hit stores a TT lower bound and returns `value - (probCutBeta - beta)`.
- **SF "small ProbCut idea"** (`search.cpp:985-989`, at `moves_loop:` for both
  in-check and not): pure TT lookup gate — if `ttData.bound & LOWER`,
  `ttData.depth >= depth-4`, `ttData.value >= beta+418`, and neither bound is
  decisive, return `beta+418` immediately. Free (no move loop).
- **zugzwang status**: **absent entirely** — no ProbCut of either kind.
- **Why it helps selectivity**: ProbCut is a whole-subtree prune keyed on
  "is there already a big-margin capture that beats beta" — it skips entire
  non-PV subtrees that ordinary alpha-beta would still have to walk through
  the move loop for. This is one of the highest-leverage EBF techniques in
  modern engines specifically because it fires **before** the main move loop.
- **Implementation sketch**: in `negamax` (search.cpp), add before the main
  `MoveList list; generate<ALL>` block (i.e. right after IIR, ~line 644):
  the cheap variant first (a few lines, reuses `tte`/`ttValue` already
  probed) — `if ((tte->bound() & BOUND_LOWER) && tte->depth >= depth-4 &&
  ttValue >= beta+418 && !mate-ish(beta) && !mate-ish(ttValue)) return
  beta+418;`. The full ProbCut needs a capture-only move loop with an SEE
  threshold — reuse `generate<CAPTURES>` + `score_moves` (MVV-LVA is enough
  initially; captHist from #1 if landed first) filtered by `pos.see_ge(mv,
  probCutBeta - eval)`, `do_move` → `qsearch(..., -probCutBeta, -probCutBeta+1)`
  → on hold, `negamax<false>(..., depth-5-ish, !cutNode)`.
- **Expected impact / effort**: cheap variant is **S** (10-15 lines, TT-only,
  no new move loop) — do this first. Full ProbCut is **M** (needs its own
  qsearch-then-search verification loop, new depth-reduction constant to
  SPSA). Elo band: **+15 to +30** combined — this is usually one of the
  larger single-technique wins in this list, matching its LOWER position
  cost (SF gets both variants for a handful of lines total).
  Gate: movetime SPRT + node-count/EBF check (ProbCut's whole point is fewer
  nodes at equal depth, so the node-count check is the primary signal, Elo
  SPRT is confirmatory).
- **Risk/interaction**: needs `is_mate_score`-style guards (zug has
  `VALUE_MATE_IN_MAX_PLY` already, see RFP code at search.cpp:607) to avoid
  polluting mate scores. Interacts with singular extension only in that both
  read `tte`/`ttValue` — no double-counting risk since ProbCut returns early
  before the move loop where singular ext lives.

### 3. History-informed LMR reduction (SF's full statScore path)

- **SF** (search.cpp:1190-1228): the reduction `r` for the move about to be
  searched accumulates from **six** independent signals before the LMR depth
  formula is even applied: `ss->ttPv` bonus (+946 at the top, then a *second*
  ttPv-based decrease later mixing PvNode/ttData.value/ttData.depth/cutNode —
  net effect is context-dependent, not a flat add); a flat `+714` base offset;
  `-moveCount*73` (linear de-reduction as move count grows, on top of the
  log-log table); `-|correctionValue|/30370` (reduce less when corrhist is
  unsure); `+3372+997*!ttData.move` for cutNode; `+1119` if ttCapture;
  `+256..+2304` if `(ss+1)->cutoffCnt` shows the child node fail-high a lot
  (a **grandchild-fail-high-rate** signal, see #6); `-2151` if this is the
  ttMove itself; then `statScore` (`2*mainHistory + contHist[0] + contHist[1]`
  for quiets, or a capture-history-based score for captures) contributes
  `-statScore*850/8192`; finally `if (allNode) r += r/(depth+1)` scales
  reductions up for expected-fail-low nodes.
- **zugzwang status**: **present but much thinner**
  (search.cpp:769-782). Zug's `r` = table lookup + `!PvNode` (+1) +
  `!improving` (+1) + `cutNode` (+1) + `givesCheck` (−1) + `hist/8000` where
  `hist = history[us][from][to] + ch1[...] + ch2[...]`. Missing: ttPv signal
  entirely (zug has no ttPv concept at all — see #5), the `moveCount`-linear
  term, the corrhist-uncertainty term, the ttCapture bonus, the cutoffCnt
  signal, the ttMove-specific de-reduction, and the allNode-scaling term.
  Zug's own `hist` divisor (8000) is also unvalidated against SF's tuned
  850/8192 (≈0.104) vs zug's 1/8000 (0.000125) — these aren't directly
  comparable since SF's statScore includes a `2×` mainHistory weight and captures
  ~30000-range PieceToHistory vs zug's tighter ±400-clamped tables, but it's
  a sign zug's history contribution to `r` was never independently retuned
  after contHist landed.
- **Why it helps selectivity**: every one of these terms is a *free* (already
  computed) signal being left on the table — cutoffCnt and ttCapture in
  particular directly predict "this subtree is likely to fail high on move 1
  anyway, reduce everything else harder," which is exactly an EBF lever: more
  aggressive reduction where it's statistically safe = fewer nodes at that
  depth, not fewer plies of search.
- **Implementation sketch**: in `negamax`'s LMR block (search.cpp:769-786):
  add a `cutoffCnt` counter to `Stack` (new field, incremented on beta-cutoff
  at each node, read one ply down as `(ss+1)->cutoffCnt`); add `r++` (or a
  SPSA-tunable `cutoffCntBonus`) when `(ss+1)->cutoffCnt > 1`; add `r++` when
  `ttCapture`; add `r -= moveCount/N` linear de-reduction (currently zug only
  has the table's own moveCount log term); add a ttMove de-reduction (zug
  currently applies `r` uniformly since ttMove is move 1 and `moveCount >
  lmrMinMoves` gates it out anyway at low move counts — check this doesn't
  already implicitly happen). Land these incrementally, each its own SPSA
  flag under `Tune`, in the same style as `nmpCutGate`/`lmrDepthPrune`.
- **Expected impact / effort**: **M** (several small independent additions,
  each cheap, but plumbing `cutoffCnt` into `Stack` and wiring correctly is
  the bulk of the work). Elo band **+10 to +25** cumulative across the
  sub-terms — land and SPRT the cutoffCnt term first (highest-confidence
  single addition, cheapest to implement: one new `Stack` field + one `r++`).
- **Risk/interaction**: cutoffCnt/ttCapture terms interact with `doDeeper`
  (D.3, already shipped) — a more aggressive base reduction changes the
  distribution of `wasLMRReduced` re-searches; re-run doDeeper's SPRT after
  landing this, don't assume it's still tuned correctly.

### 4. Double/triple extensions

- **SF** (search.cpp:1140-1152): when singular verification confirms
  singularity (`value < singularBeta`), SF doesn't stop at `extension=1` —
  it computes `doubleMargin`/`tripleMargin` (functions of PvNode, ttCapture,
  ss->ttPv, ttMoveHistory, ply-vs-rootDepth) and sets
  `extension = 1 + (value < singularBeta - doubleMargin) + (value < singularBeta
  - tripleMargin)`, i.e. **up to +3** depth for an extremely singular move,
  reusing the exact same verification search already run (no extra cost).
- **zugzwang status**: **present but capped at 1** (search.cpp:736: `if (s <
  singularBeta) extension = 1;` — no double/triple tier). Negative extension
  side is present and reasonably close to SF's (`-1`/`-2` vs SF's `-2`/`-3`,
  search.cpp:738-743 vs SF search.cpp:1174-1180 — SF's magnitudes are larger).
- **Why it helps selectivity**: this is a *free* refinement of an existing
  extension — the singular verification search already ran; checking its
  margin against two more thresholds costs nothing extra and correctly
  extends the genuinely-forced lines deeper (which is where zugzwang's
  shallower-search-quality is most visible — missed tactics in forced lines)
  while not over-extending merely-singular-by-a-hair moves.
- **Implementation sketch**: in the singular-extension block
  (search.cpp:729-744), after `if (s < singularBeta) extension = 1;` add the
  tiered check using `s` (zug's verification score, equivalent to SF's
  `value`) against `singularBeta - doubleMargin` / `- tripleMargin`. Start
  with fixed constants (SF's own tuned values, adapted: e.g. doubleMargin ≈
  depth-independent ~0-100, tripleMargin ≈ ~50-150) rather than porting SF's
  full ttMoveHistory-dependent formula (zug has no `ttMoveHistory` — see #7,
  optional prerequisite). Also widen zug's negative-extension magnitudes to
  match SF's `-2`/`-3` (currently `-1`/`-2`) as an independent one-line SPRT.
- **Expected impact / effort**: **S** (a handful of lines, reuses existing
  verification search, no new tables needed for a first cut without
  ttMoveHistory). Elo band **+5 to +10**.
  Gate: movetime SPRT; also worth a forced-tactics test suite check since
  the effect is concentrated in sharp/forced positions that a general Elo
  SPRT may under-sample.
- **Risk/interaction**: extension stacks with `doDeeper` (D.3) similarly to
  #3 — a deeper newDepth changes the LMR-reduced-scout/full-search delta
  distribution; low risk since it's the *first* move's extension amount
  (ttMove), doDeeper reads a different move's rd computation, so interaction
  is indirect (both push overall tree depth up).

### 5. ttPv tracking (persistent "this line was once a PV" bit)

- **SF**: `ss->ttPv` (search.cpp:709: `ss->ttPv = excludedMove ? ss->ttPv :
  PvNode || (ttHit && ttData.is_pv)`) is threaded through TT entries
  (`tt.write(..., ss->ttPv, ...)`) and propagated forward even after a node
  fails low (search.cpp:1461: `if (bestValue <= alpha) ss->ttPv = ss->ttPv ||
  (ss-1)->ttPv`). It feeds: RFP gate (`!ss->ttPv` required, search.cpp:887),
  LMR increase (`+946` flat, search.cpp:1046-1047, then a second decrease
  mixing ttPv with PvNode/ttData at search.cpp:1191-1193), singular margin
  (`53 + 75*(ss->ttPv && !PvNode)`, search.cpp:1133), and the TT-cutoff depth
  condition indirectly through `is_pv` bookkeeping in `tt.probe`.
- **zugzwang status**: **absent** — zug has no ttPv concept; TT entries don't
  carry a "was this ever on a PV" bit distinguishing "this subtree used to
  matter" from an ordinary non-PV node. RFP, LMR, and singular margin in zug
  never distinguish "former-PV" positions from throwaway non-PV nodes.
- **Why it helps selectivity**: ttPv is SF's mechanism for **not** over-pruning
  positions that are only non-PV *this* iteration but were PV in a shallower
  iteration (or a sibling PV line in MultiPV/aspiration re-search) — it's a
  targeted safety valve that lets aggressive pruning (RFP, LMR) stay
  aggressive everywhere *except* where the search has independent evidence
  the position is tactically live. This is a selectivity-quality lever, not
  a raw prune/extend count lever: it changes *which* nodes get the aggressive
  treatment.
- **Implementation sketch**: add `bool ttPv` to `Stack`; add `bool ttPv` to
  `TTEntry` (check `tt.h` — need to confirm a spare bit exists or add one,
  packing budget permitting); set `ss->ttPv = PvNode || (ttHit &&
  tte->wasPv())` near the TT probe (search.cpp:567-579); propagate on fail-low
  as SF does; gate RFP (`!ss->ttPv`, search.cpp:606-608) and add the LMR/
  singular margin adjustments. This is the highest-effort item on this list
  because it's the only one requiring a TT layout change — check
  `TranspositionTable`/`TTEntry` in `tt.h` for available bits before scoping.
- **Expected impact / effort**: **L** (TT format change, threading through
  every negamax call site, careful fail-low propagation semantics). Elo band
  **+10 to +20** — real but back-loaded (needs #3's ttPv-in-LMR wiring to pay
  off fully). Recommend doing this *after* #1-#4 land and SPRT clean, since
  it touches the TT and is the riskiest single change here to get subtly
  wrong (e.g. forgetting the fail-low propagation silently degrades it to a
  no-op-with-overhead).
- **Risk/interaction**: touches `TTEntry` layout — verify `tt.cpp`'s packing
  has a spare bit or bump entry size; a wrong bit-width silently corrupts
  bound/depth on collision. Must confirm zug's TT probe/store (`tt.h`) can
  carry the extra bit before scoping this as anything less than L.

### 6. cutoffCnt (grandchild fail-high-rate signal)

Already covered as part of #3's reduction formula, but called out
separately because it's cheap and freestanding: `(ss+2)->cutoffCnt = 0;` at
node entry (search.cpp:699 SF) and `ss->cutoffCnt += (extension<2) ||
PvNode;` on every beta cutoff (search.cpp:1374 SF), read one ply down. Zug
has **no `cutoffCnt` field on `Stack` at all**. This is the single cheapest
item in this document to add mechanically (one `Stack` field, one increment
site, one read site) and is a prerequisite for the cutoffCnt term in #3.

### 7. ttMoveHistory (global TT-move reliability signal)

- **SF**: `TTMoveHistory` (`history.h:216`, a single `StatsEntry`, not
  per-position) updated at every node exit (`ttMoveHistory << (bestMove ==
  ttData.move ? 809 : -865)`, search.cpp:1420) and multi-cut fail
  (`ttMoveHistory << max(-400-100*depth, -4000)`, search.cpp:1162), read in
  the singular-extension doubleMargin/tripleMargin formula (search.cpp:1144)
  and the null-move/other margins in some SF builds.
- **zugzwang status**: **absent**.
- **Why it helps selectivity**: a single global running estimate of "how
  often does trusting the TT move pay off right now" — feeds into how
  aggressively to extend/trust ttMove-adjacent decisions. Lower priority
  than the others; it's a refinement input to #4, not independently
  actionable without #4 landing first.
- **Implementation sketch/impact**: **S** effort once #4 lands (single
  `int` in `Context`, two update sites, one read site in the double/triple
  margin formula). Elo band **+2 to +5**, bundle with #4's SPRT rather than
  gating separately.

### 8. Hindsight hi/depth adjustment from priorReduction

- **SF** (search.cpp:696-697, 754-757): `priorReduction = (ss-1)->reduction`
  (how much the *parent* move was LMR-reduced when it recursed into this
  node) drives: `if (priorReduction>=3 && !opponentWorsening) depth++;` and
  `if (priorReduction>=2 && depth>=2 && ss->staticEval+(ss-1)->staticEval >
  173) depth--;`. This corrects for the fact that a heavily-reduced parent
  move may have under-searched, so its child gets compensated (extended) if
  the position doesn't look like it's getting worse for the side that just
  reduced, or further reduced if the eval swing suggests the reduction was
  fine.
- **zugzwang status**: **absent** — zug's `Stack` has no `reduction` field
  recording how much the move that led to this node was reduced by its
  parent, so no hindsight adjustment exists at all. This directly interacts
  with zug's own D.3 (`doDeeper`), which does something adjacent but at the
  wrong "end" — doDeeper adjusts the **re-search depth of the current move**
  based on the LMR scout's own result; SF's hindsight mechanism instead
  adjusts the **child node's depth** based on **how the parent was reduced**,
  a ply later and using a different signal (opponentWorsening / stacked
  staticEval swing rather than score-vs-bestValue).
- **Why it helps selectivity**: this is a correction for LMR's own blind
  spot — reduced searches see a shallower tree and can misjudge; hindsight
  lets the *next* node compensate cheaply (a depth++/-- decided from two
  already-computed evals, no extra search) rather than only correcting via
  the parent's own doDeeper re-search.
- **Implementation sketch**: add `int reduction` to `Stack` (set at
  search.cpp:770-786 wherever zug computes `d`/`r` for the LMR scout — store
  `newDepth - d` the way SF does at search.cpp:1240); add `opponentWorsening`
  next to zug's existing `improving` computation (search.cpp:598-600: `bool
  opponentWorsening = !ss->inCheck && ss->staticEval > -(ss-1)->staticEval;`
  matching SF's simpler one-line version, search.cpp:751, since zug doesn't
  need the ply>=2 guard SF's `improving` has — `opponentWorsening` only looks
  one ply back); add the two hindsight lines right after zug's own
  `improving` computation (search.cpp:598-601).
- **Expected impact / effort**: **S/M** (two new `Stack` fields, ~6 lines of
  logic, but must correctly thread `ss->reduction` through every recursive
  call site including the LMR-scout call at search.cpp:783 and the
  full-search call at search.cpp:803 — SF sets it only around the LMR scout
  call, search.cpp:1240-1242). Elo band **+5 to +15**.
- **Risk/interaction**: directly adjacent to D.3/doDeeper — implement and
  SPRT this ply-later hindsight *separately* from doDeeper to isolate which
  one is carrying the Elo; they read different signals (doDeeper: score vs
  bestValue at the same node; hindsight: eval swing one ply down) so they
  shouldn't double-count, but both mutate depth near the same LMR call site
  and should be validated together once both are in.

### 9. Aspiration-window-relative reduction scaling (`delta`/`rootDelta`)

- **SF** (search.cpp:1040-1042, 1735-1738): `reduction()` computes
  `reductionScale = reductions[d]*reductions[mn]` then returns
  `reductionScale - delta*608/rootDelta + !improving*reductionScale*238/512 +
  1182`, where `delta = beta - alpha` at this node and `rootDelta` is the
  root's aspiration window width for this iteration (`search.cpp:374:
  rootDelta = beta - alpha` at root). A node reached inside a **narrow**
  aspiration re-search window (small `delta` relative to `rootDelta`) gets
  reduced **more**; a node in a wide window gets reduced less.
- **zugzwang status**: **absent** — zug's `Reductions[d][m]` table
  (search.cpp:200-205) is a pure function of depth/moveCount, built once per
  `start()` call and never adjusted per-node for the local alpha-beta window
  width. Zug's own aspiration loop (search.cpp:1064-1083) computes `delta`
  but only uses it to widen alpha/beta, never threads it into the reduction
  formula.
- **Why it helps selectivity**: when the aspiration window is narrow (a
  normal, un-failed iteration), the search is essentially just confirming/
  refuting a known-good score — safe to reduce more since there's less at
  stake in each node's exact value; when it's failed and re-searching with a
  wide window, the search doesn't have a trustworthy target, so less
  reduction (more accurate node values) is warranted. It's the same
  underlying signal-quality idea as ttPv (#5) but keyed on the aspiration
  state rather than TT PV history.
- **Implementation sketch**: thread `rootDelta` (compute at the top of each
  iteration in `start()`, `search.cpp:1069-1071`, store on `Context` or pass
  down) and the node-local `delta = beta - alpha` into `negamax`, then in the
  LMR block (search.cpp:769-786) subtract a `delta*K/rootDelta` term from `r`
  before the `hist/8000` term, tuned as a new SPSA constant.
- **Expected impand effort**: **S/M** (one new Context field for rootDelta,
  one local computation per node, one line in the LMR formula). Elo band
  **+3 to +8** — smaller than #1-4 but very cheap once #3's reduction-formula
  refactor is already being touched, so bundle with #3's work rather than
  landing standalone.
- **Risk/interaction**: only meaningful once aspiration windows are
  reasonably tight to begin with — verify zug's `aspInitDelta=25` and
  widening schedule (search.cpp:1076-1082: `delta += delta/2`) produce a
  `rootDelta` range comparable to SF's before expecting the same magnitude
  of effect; SF's widening is `delta += delta/3` (search.cpp:418), slightly
  gentler.

### 10. Movepicker staged generation vs. zug's single-pass score+select-sort

- **SF**: `MovePicker` (movepick.cpp) generates captures and quiets in
  **separate stages** (`CAPTURE_INIT`→`GOOD_CAPTURE`→`QUIET_INIT`→
  `GOOD_QUIET`→`BAD_CAPTURE`→`BAD_QUIET`), using `partial_insertion_sort`
  (only guarantees order above a value threshold, not a full sort) and
  **lazily generates quiets at all** (skipped outright if `skip_quiet_moves()`
  was called from LMP, avoiding move generation cost, not just search cost,
  for pruned quiets) — plus quiet scoring folds in **threat-awareness**
  (`threatByLesser[pt]`, movepick.cpp:131-140,174-175: bonus for escaping an
  attack by a lesser piece, penalty for moving into one) and a **checks
  bonus** (`pos.check_squares(pt) & to`, movepick.cpp:170) and **low-ply
  history** (`LowPlyHistory`, near-root-specific ordering signal,
  movepick.cpp:178-179, history.h:139).
- **zugzwang status**: **present but simpler** — single `generate<ALL>` +
  one-pass `score_moves_impl` + full selection-sort per move via `pick_next`
  (search.cpp:382-388, O(n) per move = O(n²) total, same asymptotic cost as
  SF's approach in practice at chess move-list sizes, so this is NOT a
  speed concern). What's missing is the **scoring signal**, not the staging
  mechanism: no threat-awareness, no checks bonus, no low-ply history. LMP
  in zug still *generates* all quiets before pruning them by moveCount
  (`generate<ALL>` up front, search.cpp:647) — SF's `skip_quiet_moves`
  avoids scoring/sorting cost for skipped quiets but that's a throughput
  saving, not a selectivity one; not in scope for this doc.
- **Why it helps selectivity**: threat-awareness and checks-bonus are both
  "free" (already-computed or cheap-to-compute) signals that correlate with
  tactical relevance — a quiet move escaping a hanging piece or delivering
  check is disproportionately likely to be the cutoff move; folding these
  into the ordering score raises first-move cutoff rate the same way
  capture history does for captures (#1).
- **Implementation sketch**: in `score_moves_impl`'s quiet-move branch
  (search.cpp:359-366), add a threat term. Need `pos.attacks_by<PieceType>(~us)`-
  style bitboard queries (check `bitboard.h`/`position.h` for equivalents —
  SF's `attacks_by<PAWN>(~us)` etc.); compute `threatByLesser` once per node
  (like SF, movepick.cpp:131-140) alongside `cont_hist_planes` (search.cpp:310),
  and add `PieceVal[pt] * (threatened_at_to ? -c1 : threatened_at_from ? +c2 :
  0)` to `m.score`. Add a checks-bonus term similarly if zug's movegen exposes
  a cheap "does this land on a check-giving square" test (`pos.gives_check`
  is already computed per-move later in the loop, search.cpp:679, but that's
  post-scoring — would need to hoist or use a cheaper `check_squares`-style
  bitboard precomputed once per node, matching SF's `pos.check_squares(pt)`).
  Low-ply history is lower priority (root-adjacent-only effect); skip
  initially.
- **Expected impact / effort**: **M** (needs bitboard plumbing for threat
  detection zug may not currently expose per-piece-type; check
  `position.h`/`bitboard.h` for `attacks_by`-equivalents before scoping).
  Elo band **+5 to +12** for threat+checks combined.
  Gate: movetime SPRT; also a node-count/EBF check since this is a pure
  ordering change.
- **Risk/interaction**: orthogonal to contHist/history (additive score
  terms); watch for double-counting with SEE-quiet pruning (#existing) since
  "escaping a threat" and "positive SEE" can correlate — shouldn't cause
  logical issues (SF runs both), just be aware ordering deltas will be
  smaller than a naive estimate if SEE-quiet pruning already removes many of
  the moves this would reorder.

### 11. "Skip depth by 2 after finding an improvement" (SF search.cpp:1380-1381)

- **SF**: `if (depth > 2 && depth < 14 && !is_decisive(value)) depth -= 2;`
  fires **inside the move loop**, once alpha is raised by a non-mate score —
  shrinks the *remaining* depth budget for every move searched afterward at
  this node.
- **zugzwang status**: **absent**.
- **Why it helps selectivity**: once a good move is found and alpha rises,
  later moves in the loop are increasingly likely to just fail low against a
  tighter window — searching them at full remaining depth is often wasted
  precision. This is a direct EBF lever local to the node's own move loop.
- **Implementation sketch**: in `negamax`'s move loop, right after `alpha =
  score;` on a PV-improving, non-fail-high update (search.cpp:828 region,
  the `if (PvNode && score < beta) alpha = score;` branch — note SF's version
  isn't PvNode-gated, applies at all node types), add the depth shrink
  gated the same way SF gates it (`depth>2 && depth<14 && !mate-ish(score)`).
- **Expected impact / effort**: **S** (1-2 lines). Elo band **+3 to +8**
  — cheap, worth an isolated SPRT before folding into a larger batch since
  it's easy to misattribute Elo to a neighboring change otherwise.
- **Risk/interaction**: changes `newDepth`/re-search depth math downstream
  in the same iteration (`rd`/`doDeeper` reads `newDepth`, computed *before*
  this point in zug's loop at search.cpp:751 — verify ordering: this must
  shrink the *node's* `depth`, which feeds `newDepth = depth - 1 + extension`
  for the *next* move in the loop, not retroactively change the current
  move's `newDepth`). Double check against `doDeeper`'s `rd` computation
  which also mutates a depth value — these are different depths (node
  `depth` vs. per-move `rd`) so no direct conflict, but re-verify after
  landing both.

### 12. Eval-diff-driven quiet-history bump (SF search.cpp:859-867)

- **SF**: right after static eval, if the parent move wasn't a capture and
  parent wasn't in check, computes `evalDiff = clamp(-(parentStaticEval +
  ourStaticEval), -209, 167) + 59` and bumps `mainHistory[~us][parentMove] <<
  evalDiff*9` (and a pawn-history entry) — i.e., learns "moves that led to a
  static-eval swing in the opponent's favor are good moves for the opponent to
  find/avoid," purely from the eval delta, no search result needed.
- **zugzwang status**: **absent** — zug's only eval-delta-driven learning is
  CorrHist (bias-correction of the static eval itself, not move ordering).
  This is a distinct, additional mechanism: static-eval-only history bump for
  ordering, decoupled from CorrHist's static-eval-only *correction*.
- **Why it helps selectivity**: it's a zero-extra-search-cost history signal
  — every node that computes two static evals (its own and its parent's) can
  bump ordering for free, without waiting for a full search result to know a
  move was good (the way normal history/contHist bonuses require reaching a
  beta cutoff first). This densifies the ordering signal, especially useful
  early in a game/position before enough cutoffs have accumulated real
  history.
- **Implementation sketch**: in `negamax`, right after computing
  `ss->staticEval` (search.cpp:593-600), if `(ss-1)->currentMove` exists,
  isn't null, wasn't a capture, and `!(ss-1)->inCheck`, bump
  `C.history[~us][from((ss-1)->currentMove)][to((ss-1)->currentMove)]` using
  the same `update_history` gravity function already defined
  (search.cpp:390-394), scaled by the eval-diff term.
- **Expected impact / effort**: **S** (reuses existing `update_history`,
  ~5 new lines). Elo band **+3 to +8**.
- **Risk/interaction**: shares the `history` table with contHist/LMR reads —
  purely additive, no structural conflict, but retune `hist/8000` divisor
  (#3) after landing since the table's value distribution shifts.

---

## Ranked table (Elo-per-effort, highest first)

| # | Technique | zug status | Effort | Elo band | Gate |
|---|---|---|---|---|---|
| 2a | ProbCut — cheap TT-only variant | absent | S | +5–10 | movetime SPRT |
| 11 | Depth -=2 after alpha-improving move | absent | S | +3–8 | movetime SPRT (isolated) |
| 6 | `cutoffCnt` field + reduction bump | absent | S | +3–6 | movetime SPRT |
| 12 | Eval-diff quiet-history bump | absent | S | +3–8 | movetime SPRT |
| 4 | Double/triple singular extensions | present, capped @1 | S | +5–10 | movetime SPRT + tactics suite |
| 2b | ProbCut — full capture-loop variant | absent | M | +10–20 | movetime SPRT + node-count/EBF |
| 1 | Capture history table | absent | M | +5–15 | movetime SPRT + node-count/EBF |
| 8 | Hindsight depth (priorReduction) | absent | S/M | +5–15 | movetime SPRT |
| 3 | Full SF-style LMR reduction formula | present, thin | M | +10–25 | movetime SPRT (per sub-term) |
| 10 | Threat/checks-aware quiet ordering | absent | M | +5–12 | movetime SPRT + node-count/EBF |
| 9 | Aspiration-window-relative reduction | absent | S/M | +3–8 | movetime SPRT |
| 7 | ttMoveHistory | absent | S (after #4) | +2–5 | bundle with #4 |
| 5 | ttPv tracking | absent | **L** | +10–20 | movetime SPRT (last, riskiest) |

---

## Recommended first wave (2-3 cheapest high-confidence wins)

1. **ProbCut cheap variant (#2a)** — ~10-15 lines, pure TT-lookup gate before
   the move loop, no new tables, no plumbing changes. Highest confidence:
   SF ships it as basically free, and zugzwang has none of it.
2. **Depth −=2 after alpha-improving move (#11)** — 1-2 lines in the existing
   move loop, isolated and cheap to SPRT on its own before batching with
   anything else.
3. **`cutoffCnt` (#6) + eval-diff history bump (#12)** — both are single new
   `Stack`/history-update additions with no cross-dependencies; land together
   as a small batch since each is individually too small to reliably move an
   SPRT needle alone, but their union is a clean "free signals we weren't
   using" batch.

Do **not** start with #5 (ttPv) or the full #3 reduction-formula rewrite —
both require touching shared state (TT layout, the core LMR call sites) that
the smaller items above should land and stabilize around first.
