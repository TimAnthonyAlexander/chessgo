# SF18 / Stormphrax search+eval gap backlog (retrain-free, standing worklist)

> **What this is.** A ranked, continuously-worked stream of *retrain-free* (no NNUE
> retrain) search / eval / movepick / pruning / reduction / extension / ordering /
> history / time-management candidates that **Stockfish 18** (`~/sf18-arm/src`, tag
> `sf_18`) and/or **Stormphrax** (`~/stormphrax/src`) have and **zugzwang lacks or
> implements more weakly**. Built 2026-07-20 by reading zug `src/search.cpp` +
> `src/nnue_eval.cpp` in full, the full SF18 + Stormphrax search/eval/movepick/timeman
> source, and the washed-ledger (`gomachine/engine/docs/{OPTIMIZATIONS,SF_MARGINS,
> PARITY_GOMACHINE}.md`) + in-flight tasks (`docs/tasks/open/*`).
>
> **Method reminder.** Each item is a default-OFF env flag, SPRT'd isolated vs the
> accepted base on coalla (movetime 100ms, SIMD build), FN-first only for NPS-costly
> changes. `STATUS: proposed` on each — flip to shipped/washed as I work them.
> Ranked by (expected Elo × portability / effort), most-actionable first.
>
> **Skepticism baked in.** Zug's search is NOT a blank slate — it already has the whole
> SF-selectivity stack (PVS, aspiration, LMR w/ log·log table, LMP, SEE/futility/RFP/
> razor pruning, NMP+eval-R, singular+double-ext+negext, IIR, corrhist pawn+nonpawn,
> conthist 1/2-ply, capthist, TT-only ProbCut, depthDrop, cutoffCnt→LMR, hindsight,
> ttPv, do-deeper, SMP+vote, TT huge-pages/multiply-high/prefetch). The "search well is
> largely dry" per the ledger — so these are **refinements and completeness-of-port**
> items, not headline levers. Expect single-digit Elo each; SF's strength IS a stream of
> these. The washed-ledger is authoritative: items already tried+washed are in the
> **WASHED** appendix and must NOT be re-proposed as fresh; items already in
> `docs/tasks/open/*` are cross-referenced, not duplicated.
>
> Convention: **zug** = `zugzwang/src/search.cpp` unless noted; **SF** = `~/sf18-arm/src`;
> **SP** = `~/stormphrax/src`. Line numbers are as-read 2026-07-20.
>
> **27 items** (Tier 1 §1-7, Tier 2 §8-17, Tier 3 §18-27), 13 cross-referenced already-open
> tasks, 13 washed items. Items #24-27 (major-piece corrhist, LDSE, alpha-raise LMR term,
> three-way history blend split) are Stormphrax-original ideas with **no SF corroboration**
> — treat their Elo estimates as more speculative than the SF-corroborated items above them.

---

## SESSION LOG — 2026-07-20 (implemented + SPRT queue)

All default-off env flags, byte-identical when off (verified: startpos d12 == 34220 nodes
across every addition). Committed to main. SPRT queue drains one-at-a-time on coalla
(movetime 0.1s, conc=5, elo0=0 elo1=5). Verdicts appended here as they land.

| # | flag | env | status |
|---|---|---|---|
| 1 | CAPFUT | `CAPFUT=1` | SPRT +3.8±11 @920g (leaning +, unconfirmed) — SPSA candidate |
| 3 | CUTOFFGRADE | `CUTOFFGRADE=1` | **WASHED** as lmrpair pair (w/ #4): +3.3±13 @760g (early +15.6 was noise, regressed to ~0). Keep default-off. |
| 4 | POSTLMRCH | `POSTLMRCH=1` | **WASHED** (lmrpair pair, see #3) |
| 5 | DRAWJITTER | `DRAWJITTER=1` | bundle5 washed (−7 as part of 4-tweak drag); solo re-SPRT TBD |
| 6 | CHECKORDER | `CHECKORDER=1` | bundle5 washed (in the drag); solo re-SPRT TBD |
| 7 | QSMOVECAP | `QSMOVECAP=1` | **leaning +4.7±11 @902g** (was +14 @462g then regressed; mechanistically sound — speeds search; SF+SP ship it; never-negative). Stream-ship candidate. |
| 8b | HISTTTBONUS | `HISTTTBONUS=1` | **queued** (ttMove-is-best extra bonus) |
| 8c | HISTTAPER | `HISTTAPER=1` | **WASHED** 0.00±14.9 @551g (dead flat; confirms zug ordering/history saturation). Default-off. |
| 10 | PCM | `PCM=1` | **REJECT −8.25±11.6 @811g** (real negative). +36% nodes → less movetime depth; hand-set weights miscalibrated to zug history scale. SPSA of 9 Pcm* knobs might rescue but −8 deep → deprioritized. Default-off. |
| 11 | LMREXT | `LMREXT=1` | **REJECT −10.4±12 @805g** (real negative). zug's negative-r terms over-extend under SF's +2 cap → tree bloat, lost movetime depth. SF r-calibration doesn't transfer. Default-off. |
| 13 | SHUFFLEGUARD | `SHUFFLEGUARD=1` | **queued** — suppress singular ext in rule50 shuffle |
| 2 | HISTDECAY | `HISTDECAY=1` | washed −10.7 @380g; gentler-rate SPSA candidate (dormant) |

**MOVETIME NOISE-FLOOR LESSON (2026-07-20, important):** at conc=5 movetime 0.1s, reads
before ~800g are noise-dominated and REPEATEDLY show a phantom +14/+15 Elo that then
regresses to ~0-5. Observed on lmrpair (+15.6@408 → +3.3@760) AND qsmovecap (+14.4@462
→ +4.7@902). Do NOT trend-accept before ~800g. Confirming a *true* +5 effect to CI-excludes-0
needs ~3000 games (~2h/candidate) — infeasible per-candidate. Consequence: genuine small
wins (mechanistically-sound, SF-faithful, never-negative leaning-positives like CAPFUT
+3.8 / QSMOVECAP +4.7) can't be individually SPRT-confirmed here; they must be shipped
as a *stream* (SF's own model — fishtest uses 10k+ games per patch) or batch-SPSA'd.

Enablers landed this session: `Stack::moveCount` (#10, unblocks #9 statScore later),
`Position::plies_from_null()` (#13). Next fresh to implement when queue drains: #15
cuckoo upcoming-repetition, #16 RFP ttHit-mult, #12 non-LMR fallback reduction, #14
singular ttPv-dependence, #17 SP optimism.

---

## TIER 1 — fresh, cheap, both-engines-carry-it, zug genuinely lacks (do first)

### 1. Capture futility pruning  [SPRT +3.8+-11 @920g — leaning positive, UNCONFIRMED; SPSA-tune capFutBase/Slope/HistCoeff then re-SPRT]
**STATUS: proposed** · Elo ~+4–10 · Effort **S** · fresh
- **SF** `search.cpp:1066-1073`: for a capture, gated `!givesCheck && lmrDepth < 7`,
  `futilityValue = ss->staticEval + 232 + 217*lmrDepth + PieceValue[captured] + 131*captHist/1024`;
  prune (`continue`) if `futilityValue <= alpha`. **SP** has the analogue folded into its
  noisy-history-pruning + SEE at `search.cpp:1049-1060`.
- **zug status: MISSING.** zug's capture pruning is **SEE-only** (`search.cpp:1556`
  `depth <= captSeeMaxDepth && !see_ge(m,-margin)`). There is no eval-based futility test
  for captures at all — a capture that can't possibly raise alpha (small victim, low
  static eval, bad capthist) is still searched. This is the single most clear-cut
  *whole-mechanism* gap in the pruning block: zug prunes quiets by futility but never
  captures.
- **Port:** in the `else` (capture) branch of the pruning block (`search.cpp:1534-1557`),
  add before/after the SEE test: compute `PieceVal[victim]`, reuse the already-hoisted
  `captHist` term, prune on `staticEval + base + slope*lmrDepth + PieceVal[victim] +
  k*captHist/256 <= alpha`. Constants SPSA-tunable, scaled to zug's pawn=100 (SF pawn=208
  → ×0.481: 232→112, 217→104). Needs `lmrDepth` (already computed under `lmrDepthPrune`;
  make it unconditional or reuse `depth`). Gate `!givesCheck`.

### 2. History-update decay across ID iterations
**STATUS: proposed** · Elo ~+2–8 · Effort **S** · fresh
- **SF** `search.cpp:316-319`: before **every** new rootDepth iteration, the *entire*
  main-history table is decayed toward a floor: `mainHistory[c][i] = (mainHistory[c][i] -
  68)*3/4 + 68` (`mainHistoryDefault=68`). `lowPlyHistory.fill(97)` is a hard reset each
  iteration. **SP** `history.h:108-134` + `search.cpp:418`: `age()` runs once per
  `searchRoot`, multiplying butterfly by `977/1024` (~-4.6%/iter); piece-to ageing weight
  is exactly 1.0 (not aged); conthist/noisy not aged.
- **zug status: MISSING.** zug's `history[]`/`contHist`/`captHist` are `memset` to 0 only
  in `reset_tables` (new game) — they accumulate monotonically across the **whole**
  iterative-deepening search with no inter-iteration decay. Early-iteration noise persists
  into deep iterations. Both reference engines decay/age; zug does neither.
- **Port:** in `start()`'s ID loop (`search.cpp:2296`), before each `depth` iteration,
  apply the gravity-toward-floor to `C.history` (and optionally conthist). Two SPSA knobs
  (floor, decay num/den). Cheap; byte-identical off (skip when a flag is 0). Note zug's
  history scale differs (self-ages to ~±16k vs SF's ±7183 clamp) so pick floor/decay in
  zug units, don't copy 68/¾ literally.

### 3. cutoffCnt → graded LMR reduction (finish the shipped port)
**STATUS: proposed** · Elo ~+2–5 · Effort **S** · fresh sub-angle of a shipped feature
- **SF** `search.cpp:1208-1209`: `if ((ss+1)->cutoffCnt > 1) r += 256 + 1024*((ss+1)->cutoffCnt > 2) + 1024*allNode`.
  Graded: fires at **>1**, escalates at **>2**, plus a full ply when `allNode`.
- **zug status: WEAKER.** zug (`search.cpp:1653`) fires a single binary bump:
  `if (cutoffCnt && (ss+1)->cutoffCnt > 3) r += 1024`. Threshold is higher (>3 vs >1) and
  ungraded, and there's no `allNode` term. zug already tracks `(ss+1)->cutoffCnt` and has
  `allNode` computed (`search.cpp:1148`) — the plumbing exists.
- **Port:** replace the single `if` with SF's graded form in ×1024 units. Interacts with
  the LMRCLUSTER `allNodeLmr` term (washed as a bundle — see WASHED §W3) so keep the
  `allNode` sub-term behind its own flag. Cheapest completeness fix on an already-shipped
  mechanism.

### 4. Post-LMR continuation-history bonus
**STATUS: proposed** · Elo ~+2–6 · Effort **S** · fresh
- **SF** `search.cpp:1259`: after the do-deeper/do-shallower re-search decision, a move
  whose reduced search beat alpha gets `update_continuation_histories(ss, movedPiece, to,
  1365)` — a flat conthist bonus rewarding a move that survived reduction. **SP**
  `search.cpp:1209-1223`: symmetric post-LMR conthist **bonus AND penalty** keyed on
  whether the reduced search failed high/low (`postLmrContBonus*`/`postLmrContPenalty*`).
- **zug status: MISSING.** zug updates conthist/history only in the beta-cutoff block at
  node exit (`search.cpp:1835-1844`); nothing credits a move mid-loop for surviving its LMR
  reduction. The `ss->reduction`/`wasLMRReduced` bookkeeping this needs already exists
  (`search.cpp:1729-1733`).
- **Port:** in the `doFullSearch` block (`search.cpp:1738-1752`), when `wasLMRReduced &&
  score > alpha`, call `update_cont_hist(ch1..ch6, mover, to_sq(m), +bonus)` with a flat
  SPSA bonus. Gate default-off.

### 5. Draw-score jitter (anti-blindness / tie-break diversity)
**STATUS: proposed** · Elo ~+1–4 · Effort **S** · fresh
- **SF** `search.cpp:127`: `value_draw = VALUE_DRAW - 1 + (nodes & 0x2)` — draw returns
  cycle {−1, +1} on a node-count parity bit. **SP** `search.cpp:54-56`: `drawScore =
  2 - (nodes % 4)` → cycles {2,1,0,−1}. Both deliberately avoid a *flat* 0 to break
  move-ordering ties around draws and add micro search noise that dodges 3-fold search
  instability.
- **zug status: MISSING.** zug returns a flat `VALUE_DRAW` everywhere (`is_draw` sites at
  `search.cpp:1026,1176`, qsearch `1026`). No jitter.
- **Port:** replace the flat `VALUE_DRAW` returns with `VALUE_DRAW - 1 + (C.nodeCount & 2)`
  (or SP's `2 - nodeCount%4`). Trivial. Watch that mate-distance/`is_draw` interplay stays
  correct (SF's is ±1 around DRAW; keep the magnitude tiny). Byte-identical off.

### 6. givesCheck quiet-ordering bonus
**STATUS: proposed** · Elo ~+1–5 · Effort **S** · fresh
- **SF** `movepick.cpp:170`: quiet score `+= (givesCheck && see_ge(m,-75)) * 16384` — a
  large ordering bump for non-losing quiet checks. **SP** `movepick.cpp:255-260`:
  `+= directCheckBonus(9994) * (givesDirectCheck(move) && see(pos,move,directCheckSeeThreshold=-37))`.
- **zug status: MISSING.** zug's quiet scoring (`score_moves_impl` else-branch,
  `search.cpp:866-917`) orders quiets purely by butterfly + conthist (+ optional
  low-ply/pawn/threat). No check-giving bonus. Both reference engines order safe checks
  early.
- **Port:** in the general-quiet branch, add `if (pos.gives_check(mv) && pos.see_ge(mv,-75))
  h += CHECK_ORDER_BONUS;` before writing `m->score`. `gives_check` is already called per
  move in the search loop but NOT in ordering — measure the added ordering-time
  `gives_check` cost (may want to cache). SPSA the bonus. Ordering-only, no pruning change.

### 7. Qsearch move-count cap
**STATUS: proposed** · Elo ~+1–5 · Effort **S** · fresh (SF+SP both, > gomachine's null)
- **SF** `search.cpp:1638-1640`: in the qsearch loop, `if (moveCount > 2) continue` (once
  past futilityBase gating). **SP** `search.cpp:1579-1581`: `if (legalMoves >= 2) break`
  (unless `isLoss(bestScore)`). Both cap how many captures qsearch explores after the
  first couple.
- **zug status: MISSING.** zug's qsearch (`search.cpp:1092-1126`) searches *every* legal
  capture with no move-count cap. PARITY §49 logged this as "gomachine's own unproven," but
  SF **and** SP both ship it — a stronger prior than gomachine's single null result.
- **Port:** add a `moveCount` cap in the qsearch loop, gated `!inCheck` and after the
  futility test. SPSA the cap (2–3). Cheap NPS + selectivity win; re-eval despite the
  gomachine null.

---

## TIER 2 — fresh, medium effort, meaningful mechanism gaps

### 8. History bonus/malus formula rework (depth-shaped bonus + late-quiet malus taper)
**STATUS: proposed** · Elo ~+5–15 (cluster) · Effort **M** · fresh
- **SF** `search.cpp:1833-1848`: bonus `= min(116*depth - 81, 1515) + 347*(bestMove==ttMove)
  + (ss-1)->statScore/32`; malus `= min(848*depth - 207, 2446) - 17*moveCount`. Quiet
  best-move gets `bonus*910/1024`; non-best quiets get `malus*1085/1024`, then a **taper**
  for late tries: `for i>5: actualMalus -= actualMalus*(i-5)/i` (moves searched much later
  get progressively *less* malus). Capture best gets `bonus*1395/1024`; non-best captures
  `-malus*1448/1024`. **SP** `history.h:63-65`: every bonus is `clamp(depth*scale - offset,
  0, max)` (floored at 0), with distinct scale/offset per table.
- **zug status: WEAKER/DIFFERENT.** zug uses a single crude `bonus = depth*depth`
  (`search.cpp:1810`), applied **identically** as `+bonus` to the best move and `-bonus`
  to *every* non-best quiet (`search.cpp:1816-1819`) with no ttMove term, no move-count
  taper, no per-table scaling, and the gravity clamps to ±400 (`update_history`,
  `search.cpp:946`). This is where a large share of SF's per-patch Elo historically lives.
- **Port (stage it):** (a) swap `depth*depth` for `min(a*depth-b, cap)` shape [SPSA a,b,cap];
  (b) add the `+k*(bestMove==ttMove)` bonus term; (c) add the late-quiet malus taper
  `actualMalus -= actualMalus*(i-5)/i`; (d) later, the `(ss-1)->statScore/32` term (needs a
  new `Stack::statScore` field — see #9). Each sub-part its own flag/SPRT. Medium risk
  (touches every history write) → FN-first then MT.

### 9. Persist `statScore` on the stack; feed it into history bonus + LMR
**STATUS: proposed** · Elo ~+2–6 · Effort **M** · fresh (prerequisite for #8d)
- **SF** `search.cpp:1219-1221` sets `ss->statScore = capture ? 868*PieceValue[captured]/128
  + captureHistory[...] : 2*mainHistory[us][move] + contHist[0..1]`, then reduces LMR by
  `ss->statScore*850/8192` (`search.cpp:1222`), and reads `(ss-1)->statScore` in the
  next-node history bonus (`search.cpp:1833`) and the fail-low bonusScale
  (`search.cpp:1424`).
- **zug status: MISSING.** zug computes an equivalent `hist` value locally inside the LMR
  branch (`search.cpp:1659-1685`) and uses it for the reduction, but never **stores** it on
  the `Stack`, so no other node can read the parent's statScore. `Stack` (`search.cpp:499`)
  has no `statScore` field.
- **Port:** add `int statScore` to `Stack`; write it where zug already computes `hist`;
  read `(ss-1)->statScore` in the cutoff-history bonus (#8d) and, later, a fail-low bonus
  (#10). Standalone value is small; it's the enabler for #8/#10.

### 10. Fail-low history updates (credit the refuted parent move)
**STATUS: proposed** · Elo ~+3–10 · Effort **M** · fresh
- **SF** `search.cpp:1423-1453`: when a node fails **low** (no bestMove), SF still learns —
  an elaborate `bonusScale` (function of `(ss-1)->statScore`, depth, `(ss-1)->moveCount`,
  and static-eval agreement) drives `update_continuation_histories(ss-1, …)`,
  `mainHistory[~us][(ss-1)->move]`, and pawn-history updates crediting/penalizing the
  **parent's** move. Capture case: flat `captureHistory[...] << 1012`. **SP**
  `search.cpp:1398-1425` "Parent Continuation Malus (PCM)" is the richer, more novel
  version: when **every** move at a node fails low (no bestMove) and the parent move was
  quiet, malus the parent's move with a FIVE-term weight: `pcmBaseWeight() +
  min(depth*pcmDepthWeight(), pcmDepthMax())` (depth) `+ (parent->moveCount>=8)*
  pcmParentMoveCountWeight()` (parent was deep in its move loop) `+
  (parent->move==parent->ttMove)*pcmParentTtMoveWeight()` (parent move was the TT move)
  `+ (!inCheck && bestScore<staticEval-pcmStaticEvalThreshold())*pcmStaticEvalWeight()`
  (this side's outcome was a static-eval surprise) `+ (parent->staticEval!=NONE &&
  bestScore<-parent->staticEval-pcmParentStaticEvalThreshold())*pcmParentStaticEvalWeight()`
  (parent's side was surprised too); `scaled=historyBonus(depth,...)*weight/1024` feeds
  `updateMainHistory`+conthist. Noisy-parent case: flat `noisyPcmBonus()` malus, no
  weighting. "Penalize the move that led into a wholly-refuted subtree, scaled by how
  *surprising* the refutation was" has no SF analogue at all — the single most novel
  idea found in either reference engine.
- **zug status: MISSING.** zug updates history **only** on beta cutoff
  (`search.cpp:1802`); a fail-low node teaches nothing. This is a whole class of signal SF
  and SP both exploit ("infrequent updates scale well" per SF's own comment).
- **Port:** after the move loop, in the `!(bestValue >= beta)` / `bestMove == MOVE_NONE`
  case, add a parent-move conthist/butterfly malus with an SPSA-scaled bonusScale.
  Needs #9 (`(ss-1)->statScore`) for the full SF formula; a reduced SP-PCM-style version
  works without it. FN-first (changes tree).

### 11. LMR-as-extension: let very-negative `r` search *deeper* than newDepth
**STATUS: proposed** · Elo ~+3–8 · Effort **M** · fresh
- **SF** `search.cpp:1231`: `d = max(1, min(newDepth - r/1024, newDepth + 2)) + PvNode` —
  the reduced depth is capped at **newDepth+2**, not newDepth, so a move with a strongly
  negative accumulated `r` (good history, ttPv, gives-check, etc.) is searched *deeper*
  than the nominal depth, and PV nodes get an unconditional +1. **SP**
  `search.cpp:1181-1184`: `reduced = min(max(newDepth - r/1024, 1), newDepth) + kPvNode +
  (ttpv && r < lmrTtpvExtThreshold(-886))` — same idea (PV +1, extra +1 for ttpv with very
  negative r).
- **zug status: MISSING.** zug clamps `d = max(1, min(newDepth - red, newDepth))`
  (`search.cpp:1728`) — LMR can only ever *reduce*, never extend past newDepth, and there's
  no PV +1. zug's fine-resolution `r` terms (ttPv −1024, gives-check −1024, history/8000)
  can drive `r` negative, but the clamp throws that信息 away.
- **Port:** change the upper clamp to `newDepth + K` (K=1–2, SPSA) and add `+ PvNode`.
  Interacts with the do-deeper re-search (`search.cpp:1747`) — verify no double-extend.
  Both reference engines rely on this; zug's asymmetric clamp is a real divergence.

### 12. Non-LMR fallback reduction (reduce late moves that skip LMR)
**STATUS: proposed** · Elo ~+2–6 · Effort **M** · fresh
- **SF** `search.cpp:1263-1273`: for moves that DON'T qualify for the LMR search (Step 18
  full-depth path), SF still applies a coarse reduction from the accumulated `r`:
  `newDepth - (r > 3957) - (r > 5654 && newDepth > 2)`, and adds `if (!ttData.move) r +=
  1140` first. So even non-LMR late moves get 0/1/2 plies shaved when their `r` is very
  high.
- **zug status: MISSING.** zug's non-LMR branch (`doFullSearch` from the `else` at
  `search.cpp:1734`) searches at plain `newDepth` — no `r`-based reduction, and zug doesn't
  even compute `r` outside the LMR branch.
- **Port:** hoist the `r` computation above the LMR/else split so it's available on both
  paths; in the non-LMR full search, subtract `(r > t1) + (r > t2 && newDepth > 2)`. SPSA
  the thresholds (in zug's ×1024 scale). Adds a no-TT-move `r` bump too. Medium — restructures
  the move-search dispatch.

### 13. `is_shuffling` guard on the singular extension
**STATUS: proposed** · Elo ~+1–4 · Effort **S–M** · fresh
- **SF** `search.cpp:145-152` (`is_shuffling`) + gate at singular block: singular extension
  is **suppressed** when the position is a rule50 shuffle — `rule50_count() >= 10 &&
  pliesFromNull > 6 && ss->ply >= 20 && move.from == (ss-2)->currentMove.to &&
  (ss-2)->currentMove.from == (ss-4)->currentMove.to` (a 4-ply round-trip). Prevents burning
  singular depth on a dead, repeating position.
- **zug status: MISSING.** zug's singular gate (`search.cpp:1561`) has no shuffle detector —
  it will singular-extend a ttMove in a shuffled drawn position, wasting the extension.
- **Port:** add a `is_shuffling(ss, pos)` predicate (reads `(ss-2)`/`(ss-4)` currentMove +
  `rule50`) and AND `!is_shuffling(...)` into the singular gate. zug already stores
  `currentMove` on the stack. Small; correctness-flavored, tiny-but-real Elo.

### 14. Singular gate/margin ttPv-dependence
**STATUS: proposed** · Elo ~+1–4 · Effort **S** · fresh sub-angle
- **SF** `search.cpp:1119,1127`: singular gate requires `depth >= 6 + ss->ttPv` (deeper on
  former-PV nodes), and `singularBeta = ttData.value - (53 + 75*(ss->ttPv && !PvNode))*depth/60`
  — a ttPv-widened margin. **SP** `search.cpp:1081,1097`: `depth >= 6 + ttpv`, `sBeta =
  ttEntry.score - depth*(143 + 136*(ttpv && !pv))/128`.
- **zug status: WEAKER/DIFFERENT.** zug gates on flat `depth >= singularMinDepth(5)` and
  `singularBeta = ttValue - singularMargin*depth/16` (= exactly `2*depth`,
  `search.cpp:1564`) — no ttPv term in either the min-depth or the margin. zug has
  `ss->ttPv` available.
- **Port:** add `+ ss->ttPv` to the min-depth gate and a `ttPv && !PvNode` term to the
  margin (SPSA the coefficient). NOT covered by `singular-extension-refinements.md` (which
  is negExt magnitude / multicut-return-score / ttMoveHistory — different sub-parts).

### 15. Upcoming-repetition (cuckoo) draw detection
**STATUS: proposed** · Elo ~+3–8 · Effort **M** · fresh
- **SF** `search.cpp:630-635` (main) + `1504-1510` (qsearch): before searching, `if
  (!rootNode && alpha < VALUE_DRAW && pos.upcoming_repetition(ply)) { alpha =
  value_draw(nodes); if (alpha >= beta) return alpha; }` — a cuckoo-hash lookup that
  detects a *forcible* repetition one move ahead and claims the draw immediately. **SP** has
  the same upcoming-repetition short-circuit in `search()`/qsearch.
- **zug status: MISSING.** zug only detects repetition after it happens
  (`pos.is_draw(ss->ply)`); no cuckoo table, no `upcoming_repetition`. Missing the "I can
  force a draw here" early cutoff both reference engines carry.
- **Port:** add SF's cuckoo table init (Position-side infra — `cuckoo[]`, `cuckooMove[]`,
  built from reversible-move Zobrist keys) + `Position::upcoming_repetition(ply)`, then the
  two search short-circuits. Medium (Position infra), but a well-trodden, correct-by-copy
  port. Real Elo in drawish/defensive lines.

### 16. RFP margin: ttHit-scaled multiplier
**STATUS: proposed** · Elo ~+1–4 · Effort **S** · fresh sub-angle
- **SF** `search.cpp:876-884`: `futilityMult = 76 - 23*!ss->ttHit` — the RFP/static-null
  margin is **smaller (prunes more) when there's a TT hit** and larger on a miss (uncertain
  eval). Combined with `-(2474*improving + 331*opponentWorsening)*mult/1024` and
  `|correctionValue|/174665`.
- **zug status: WEAKER.** zug's RFP margin is `rfpMargin*(depth-improving) - rfpOwTerm -
  corrMarginTerm` (`search.cpp:1290`) — has the opponentWorsening fold (shipped, #A) and an
  optional corrMargin term, but **no ttHit-scaled base multiplier**. The margin is the same
  whether or not the eval is TT-corroborated.
- **Port:** scale `rfpMargin` by a `(1 - k*!ttHit)` factor (SPSA k). Cheap. Overlaps
  conceptually with `pruning-margin-shape-vs-sf.md` (which covers RFP *soft-return* + gate)
  but the ttHit multiplier is a distinct term not in that doc.

### 17. Stormphrax-style optimism (single-scalar-net compatible — reopens a washed door)
**STATUS: proposed** · Elo ~+3–10 · Effort **M** · fresh angle inside a partly-washed area
- **SP** `search.cpp:463-468`: `optimism = optimismScale(147)*rootMove.averageScore /
  (|rootMove.averageScore| + optimismStretch(101))`, `+`side-to-move / `−`other. Blended in
  `eval/eval.cpp:32-67`: `eval = (eval*(matBase + npMat) + optimism*(optBase +
  npMat*optMatScale/1024)) / 32768`. **Crucially SP needs NO psqt/positional split** — it's
  a single scalar on top of a single-scalar eval, exactly zug's net shape.
- **zug status: MISSING / previously-blocked-for-the-wrong-reason.** `eval-postproc-
  optimism-rule50.md` shelved optimism because **SF's** version needs a psqt/positional
  split zug's net lacks. But SP proves optimism works as a pure root-score-driven scalar +
  material blend — no split required. The rule50+material-scaling *combo* washed (−7.6);
  SP-optimism-via-root-score is a **different, untested** mechanism.
- **Port:** track a running `averageScore` per root iteration (zug has `prevScore`; a proper
  average needs light new state), compute SP's saturating optimism, add
  `optimism*(optBase + npMat*scale)/denom` into `eval_from_halves`'s tail or in
  `corrected_eval`. Material term reuses `pos.non_pawn_material`. SPSA the constants to zug's
  scale. Medium; measure alongside — do NOT re-bundle with material-output-scaling (washed).

---

## TIER 3 — larger / lower-signal / architectural (do after Tiers 1–2)

### 18. Staged good/bad move ordering (defer bad captures past quiets)
**STATUS: proposed** · Elo ~+2–8 (uncertain) · Effort **L** · fresh but ordering-saturated caveat
- **SF** `movepick.cpp:33-57`: staged `MAIN_TT → GOOD_CAPTURE → GOOD_QUIET → BAD_CAPTURE →
  BAD_QUIET`, with `goodQuietThreshold = -14000` splitting good/bad quiets and bad captures
  deferred **after** good quiets. **SP** `movepick.h:31-50`: `kGoodNoisy → kQuiet →
  kBadNoisy` — bad captures searched after all quiets.
- **zug status: MISSING (architectural).** zug scores the whole movelist in one pass and
  selection-sorts (`pick_next`, `search.cpp:936`) — bad captures (`BAD_CAP_SCORE`) sort
  *below* quiets already by score, so the ordering is *approximately* staged, but there's no
  good/bad **quiet** split and no true lazy staging. 
- **Caveat:** Wave-3 ordering experiments (`evalHist`, `threatOrder`) **washed** — "ordering
  saturated in zug." So expect this to be hard to convert. Lower priority; try only the
  good/bad-quiet split (cheapest sub-part) first, FN-first.
- **Port:** add a `goodQuietThreshold` partition to the quiet scores; keep the single-pass
  scorer but bucket quiets. Full lazy staging is a large rewrite — not worth it given the
  saturation signal.

### 19. Time-management overhaul (bestmove-stability + node-effort + falling-eval)
**STATUS: proposed** · Elo: real in **clocked** games, invisible to movetime SPRT · Effort **M**
- **SF** `search.cpp:485-528`: `optimum * fallingEval * reduction * bestMoveInstability *
  highBestMoveEffort`, where `bestMoveInstability = 1.02 + 2.14*totBestMoveChanges/threads`,
  `nodesEffort = rootMoves[0].effort*100000/nodes` (→ `highBestMoveEffort = 0.76` if effort
  ≥93340), `fallingEval` from score-drop. **SP** `limit.cpp:46-102`: multiplicative
  node-fraction + best-move-stability (power-law) + score-trend (EMA) scaling. **SF's base
  allocation itself** (`timeman.cpp:106-120`, read directly — separate from the
  per-iteration rescaling above) is also far richer than a flat `time/mtg`: sudden-death
  branch computes `optConstant = min(0.0032116+0.000321123*log10(scaledTime/1000), 0.00508017)`,
  `optScale = min(0.0121431 + pow(ply+2.94693, 0.461073)*optConstant, 0.213035*time/timeLeft)
  * originalTimeAdjust` (`originalTimeAdjust = 0.3128*log10(timeLeft)-0.4354`, computed once)
  — i.e. the fraction of remaining time spent on this move **grows with ply** (via the
  `pow(ply+c, 0.46)` term) and shrinks logarithmically as total time-left grows;
  `maxScale = min(6.67704, max(3.3977+3.0395*log10(scaledTime/1000), 2.94761) + ply/11.9847)`
  similarly ply-grows the hard-time multiplier.
- **zug status: WEAKER.** zug's `set_time_limits` (`search.cpp:1907-1938`) is crude:
  `budget = usable/mtg + inc*3/4`, `hard = min(usable/2, budget*3)` — flat fractions with
  **no ply-dependence, no log-time-scaling, and no per-iteration re-scaling at all**; one
  soft/hard budget computed up front, never adapted to best-move stability, node effort,
  score drops, or how deep into the game we are.
- **Caveat:** the whole search campaign is **movetime** SPRT (fixed time/move) so this
  change is **invisible** to the standard harness. It is nonetheless real Elo for the
  **product** (website bot games run on server clocks). Test via TC games (fastchess with
  real clocks), not the movetime SPRT.
- **Port:** add per-iteration soft-time scaling in the ID loop keyed on `rootBestMove`
  stability (count changes) + a falling-eval term (zug has `prevScore`). Medium; gate so the
  movetime path (`limits.movetime`) is untouched.

### 20. RFP quadratic + complexity term (Stormphrax shape)
**STATUS: proposed** · Elo ~+1–4 · Effort **S** · fresh sub-angle
- **SP** `search.cpp:838-853`: `margin = rfpLinear(85)*depth + rfpQuad(7)*depth² -
  rfpImproving(75)*improving + complexity*rfpCorrplexityScale(62)/262144`, `depth <= 12`,
  fail-firm return.
- **zug status: DIFFERENT.** zug's RFP is purely linear in depth (`rfpMargin*(depth-
  improving)`). SP adds a `depth²` term and a corrhist-magnitude ("complexity") term.
- **Port:** add an SPSA `rfpQuad*depth²` term. The complexity term overlaps
  `corrhist-expand-and-into-margins.md` §2 (fold `|correctionValue|` into RFP) — coordinate
  so they're not double-counted. Small.

### 21. Fail-firm (`ilerp`) soft cutoffs beyond RFP
**STATUS: proposed** · Elo ~+1–5 (uncertain) · Effort **M** · fresh, broad
- **SP** (engine-wide idiom): non-decisive fail-highs return `ilerp<1024>(value, beta, T)`
  instead of a hard value — at RFP (`rfpFailFirmT=711`), qsearch stand-pat
  (`standPatFailFirmT=610`), multicut (`multicutFailFirmT=503`), and even the final node's
  `bestScore = (bestScore*depth + beta)/(depth+1)` on **every** fail-high
  (`search.cpp:1427-1429`).
- **zug status: PARTIAL.** zug's RFP already soft-returns `(2*beta+eval)/3` (`rfpSoft`,
  `search.cpp:1292`), but qsearch stand-pat (`search.cpp:1058-1062`) and the main
  beta-cutoff return (`bestValue`) are **hard**. SP blends toward beta on every fail-high.
- **Port:** add a `bestScore→beta` depth-weighted blend on the main fail-high return and a
  qsearch stand-pat fail-firm. Broad (many return sites) → do one site per SPRT. Medium
  risk (changes returned scores → TT contents). FN-first.

### 22. TT-move depth-1 floor before PV re-search
**STATUS: proposed** · Elo ~+0–3 · Effort **S** · fresh, obscure
- **SF** `search.cpp:1282-1287`: before the full-window PV recursion of the ttMove, `newDepth
  = max(newDepth, 1)` when TT data suggests a decisive/deep line — prevents the principal
  move diving straight into qsearch after negative extensions.
- **zug status: MISSING.** zug's PV re-search (`search.cpp:1754-1755`) uses raw `newDepth`,
  which after a `-2`/`-3` negative extension can hit ≤0 and dispatch to qsearch for the
  ttMove.
- **Port:** `newDepth = std::max(newDepth, 1)` guarded on `m == ttMove` + a TT-decisiveness
  check, right before the PV recursion. Trivial; marginal. Bundle with #14.

### 23. Continuation-indexed correction history (Stormphrax corroboration)
**STATUS: proposed (see also docs/tasks/open/corrhist-expand-and-into-margins.md)** · Elo ~+1–4 · Effort **M**
- **SP** `correction.h/.cpp`: beyond static pawn/nonpawn/major corrhist, SP keys **3
  continuation-correction tables** at offsets 1/2/4 plies on `pos.key() XOR keyHistory[-off]`
  (`kContEntries=32768`), weighted `contCorrhist1/2/4Weight = 152/214/144`. **SF**
  `history.h:160-166` has the `Continuation` + `PieceTo` corrhist sources too (weights
  cont=7841 at `search.cpp:80-94`).
- **zug status: PARTIAL / already-tracked.** zug has pawn + nonpawn(W/B); `CORRVARIANTS`
  (default-off) adds minor + own-side continuation (`corrHistCont`, keyed [piece][to], taps
  ss-2/ss-4). The `pieceTo` corrhist source and SP's `key XOR keyHistory` continuation
  keying are NOT present. **Tracked** in `corrhist-expand-and-into-margins.md §1** — this
  entry only adds SP's continuation-keying-by-Zobrist-XOR as an alternative to zug's
  [piece][to] keying, and the `pieceTo` source, for that doc's SPRT set.

### 24. Major-piece (rook/queen) correction history table
**STATUS: proposed** · Elo ~+1–3 (speculative, SP-only precedent) · Effort **S** · fresh
- **SP** `correction.h/.cpp`: alongside pawn/minor/nonpawn(color-split) tables, SP keeps a
  **fifth** table keyed on `pos.majorKey()` (rooks+queens only), read-weighted by
  `majorCorrhistWeight()` and updated with the same uniform bonus as every other table.
  **SF does not have this table** (SF18's corrhist blend, per `search.cpp:80-94`, is only
  pawn + minor + nonpawn(W/B) + continuation(×2) — confirmed via direct read, no major-key
  term) — this is an SP-original addition, not classic-SF, so treat the Elo estimate as
  more speculative than the SF-corroborated items above.
- **zug status: MISSING.** Verified directly: zug has `corrHistMinor` (`search.cpp:400`,
  keyed `pos.minor_key()`, gated `CORRVARIANTS`) plus pawn/nonpawn(W/B), but no
  `corrHistMajor`/`majorKey()`-keyed table anywhere in `search.cpp`.
- **Port:** mirror `corrHistMinor`'s exact plumbing (declare table, `reset_tables` memset,
  read in `correction_raw`/`corrected_eval`, update alongside the other tables in the
  post-search corrhist-update block) but keyed on a new `Position::major_key()` (rooks+
  queens Zobrist subkey — check if zug's `Position` already tracks a rook/queen-only key;
  if not, this needs a small Position-side addition first). New SPSA read-weight. Gate
  behind `CORRVARIANTS` (extends the existing default-off flag) or its own flag.

### 25. LDSE — extend when static eval contradicts a shallow TT lower-bound
**STATUS: proposed** · Elo ~+1–4 (speculative, SP-only, isolated novel trigger) · Effort **M** · fresh
- **SP** `search.cpp:1120-1128` ("Limited-Depth Singular Extension"): a separate extension
  path, entirely distinct from the main singular-extension block, that fires when the main
  singular gate does NOT apply (e.g. `depth` too low for the `depth>=6+ttpv` singular test)
  but `depth<=7 && !inCheck && staticEval<=alpha-ldseMargin() && ttEntry.flag==LowerBound`:
  extend by 1 (a further +1 if `staticEval<=alpha-ldseDoubleExtMargin()` too). Logic: "a
  low-depth TT entry claims a lower bound here, but the static eval looks much worse than
  that bound suggests — dig deeper before trusting it." No SF analogue; isolated code path,
  doesn't touch the main singular machinery.
- **zug status: MISSING.** zug's only extension trigger is the ttMove-based singular test
  (`search.cpp:1561`, gated `depth >= singularMinDepth`); there is no separate low-depth
  static-eval-vs-TT-bound extension path.
- **Port:** add a new `else if` branch after the main singular-extension `if` (which only
  fires when `m == ttMove && depth >= singularMinDepth`), independent of ttMove, testing
  `depth <= K1 (SPSA) && !ss->inCheck && ss->staticEval <= alpha - ldseMargin (SPSA) &&
  ttHit && (tte->bound() & BOUND_LOWER)`, `extension = 1 (+1 more under the double-margin
  test)`. Self-contained, no interaction with the existing dblExt/tripleExt code paths.
  FN-first (adds tree nodes at low depth broadly).

### 26. Alpha-raise-count folded into LMR reduction
**STATUS: proposed** · Elo ~+1–4 (speculative, SP-only) · Effort **S** · fresh
- **SP** `search.cpp:1175`-ish: LMR's `r` gets `+= alphaRaises * lmrAlphaRaiseReductionScale()`,
  where `alphaRaises` is a running count of how many moves already searched at *this* node
  have raised alpha. Distinct signal from `moveCount` (total moves tried) — a node that has
  already found several improving quiets/captures is increasingly likely to be "done," so
  later moves get reduced harder, independent of how many moves were merely *tried*.
- **zug status: MISSING.** Verified via grep: zug's `r`-assembly (`search.cpp:1640-1660`)
  has no alpha-raise counter at all; `Stack` has no such field.
- **Port:** add an `int alphaRaisesThisNode` local (or `Stack` field if needed across
  re-entrant calls — it doesn't need to persist past this node's move loop, so a local
  incremented on every `score > alpha` before the LMR read suffices) and fold
  `alphaRaisesThisNode * k / 1024` (SPSA k) into `r`. Cheap, single new local + one add.

### 27. Three independently-tunable history blends (search-pruning vs LMR vs ordering)
**STATUS: proposed** · Elo unclear (architectural, not a single lever) · Effort **L** · fresh, low priority
- **SP**: maintains THREE separately-SPSA'd weighted blends of the same underlying
  butterfly/pieceTo/conthist tables — one used for search-time pruning-margin lookups
  (`search*Weight` terms), one specifically for LMR magnitude (`lmr*Weight` terms,
  `search.cpp` LMR block), and a third for raw move-ordering score
  (`movepick*Weight` terms, `movepick.cpp:235-261`) — rather than computing one blended
  "history score" and reusing it in all three roles.
- **zug status: WEAKER/DIFFERENT (structural).** zug computes a single `hist` value per
  move (`search.cpp:1659-1685` area) and reuses it for both the LMR reduction read and
  (partially, via `LMRHIST`) the ordering-time score. Splitting these into three
  independently-tunable weighted sums is a real structural divergence, but it's a large,
  invasive refactor (every history read site changes) for an unproven, likely-small,
  hard-to-isolate gain — SPSA can't easily explore 3x the weight-space without a much
  bigger tuning budget.
- **Port (if ever taken):** lowest priority in this backlog. Would mean: (1) introduce a
  distinct weight set for the LMR-magnitude history read vs the existing ordering-time
  read, SPSA each independently; (2) only then consider a third split for pruning-margin
  reads (overlaps `capthist-in-pruning-reduction.md`). Do NOT attempt as one PR — split
  into the smallest sub-step (LMR-only weight split first) and SPRT that alone.

---

## Cross-references — already tracked in `docs/tasks/open/*` (do NOT duplicate)

These SF/SP gaps are real but already have an open task; work them there, not as new items:

- **NMP full SF rewrite** (cutNode gate + `R=7+depth/3` + verification/`nmpMinPly`) — SF
  `search.cpp:892-925`. zug has `NMPSF` flag (default-off), the cutNode-gate-alone washed
  −27. → `nmp-sf-rewrite.md`.
- **Adaptive aspiration delta (meanSquaredScore) + missing LMR terms** — SF
  `search.cpp:355,1735-1738`. zug `aspAdapt` flag. SP corroborates (`averageSquaredScore`).
  → `aspiration-and-lmr-terms.md`.
- **Capture history into pruning + LMR statScore** — SF `search.cpp:1077,1216`. zug
  `captHistPrune`/`captHistMargin` flags (default-off). → `capthist-in-pruning-reduction.md`.
- **Continuation history 3/4/6 plies + [inCheck][capture] split** — SF ordering read set;
  SP uses plies 1/2/4/6. zug `CONTHISTPLIES` — **tested, MOVETIME −8.9 reject** (dormant).
  → `conthist-more-plies.md`. (Note: FN-real +5.7, MT read-cost-bound.)
- **ContHist FN→MT read-cost reclaim** (~+12 trapped) — → `conthist-fn-to-mt.md`.
- **Corrhist variants (minor/pieceTo/cont) + fold |corrValue| into futility/LMR** — SF
  `search.cpp:80-94,876,1197`. → `corrhist-expand-and-into-margins.md`.
- **Eval optimism + rule50 damping** — SF `evaluate.cpp:43-84` / `search.cpp:360-362`.
  rule50+material combo **washed −7.6**; rule50-alone untested. (See #17 for the *SP*
  single-scalar optimism angle, which that doc predates.) → `eval-postproc-optimism-rule50.md`.
- **Low-ply history + pawn-structure ordering history** — SF `movepick.cpp:179` +
  PawnHistory. zug `lowPlyHist`/`pawnOrderHist` flags (default-off). → `new-ordering-history-tables.md`.
- **RFP soft return + gate; razoring quadratic curve** — SF `search.cpp:870-889`. zug
  `rfpSoft` (shipped) + `RAZORQUAD` flag. → `pruning-margin-shape-vs-sf.md`.
- **Singular: negExt −3/−2, multicut-returns-score, ttMoveHistory→margin** — SF
  `search.cpp:1144-1180`. zug `negExt3`/`singRetScore`/`ttMoveHist` flags. →
  `singular-extension-refinements.md` + `spsa-margin-polish.md`.
- **Stalemate-sac guards (capture-SEE + qsearch)** — SF `search.cpp:1077,1708-1721`. →
  `stalemate-sac-guards.md`.
- **SPSA margin re-tune / LMRCLUSTER** — → `spsa-margin-polish.md` (last run WASHED, reverted).
- **Threat-delta follow-ons (NPS)** — → `threat-delta-followon.md`; **NPS infra batch**
  (shipped +36.9) → `nps-infra-batch.md`.

---

## WASHED — do NOT re-propose (from the ledger)

- **W1. NMP cutNode-gate alone** — `beta - 18*depth + 350` gate bolted onto zug's NMP:
  **−27 Elo REJECT** (`OPTIMIZATIONS.md:72`). Only the *complete* SF rewrite (#tracked NMPSF)
  is viable — the gate needs SF's depth-only R + verification.
- **W2. History pruning (hard-prune quiets on `hist < -k*depth`)** — **+1.9 ±17 WASH**
  (`OPTIMIZATIONS.md:104`). "More pruning is the wrong medicine for an over-pruner." (Note:
  zug's `histMargin` flag reintroduces the *bidirectional* SF version — that's the untested
  complete form, not this washed hard-prune-only one.)
- **W3. LMRCLUSTER (corrMargin + allNodeLmr + rootDeltaLmr) bundle + joint SPSA** — bundle at
  default consts beat base +3.9 @1600g but final SPSA theta **did NOT confirm** (+8.0 LB−0.66);
  reverted (`spsa-margin-polish.md`). "SPSA found a basin, not an edge." Each term also washed
  SOLO. (My #3 keeps the `allNode` cutoffCnt sub-term behind its own flag, distinct from this.)
- **W4. lmrDepth-keyed futility (margin bundle 2)** — **+0.5 WASH** (`OPTIMIZATIONS.md:73`).
- **W5. SEE-quiet linear shape (−75*depth, d≤6)** — **−4.3 REJECT** (D.5). zug keeps quadratic.
- **W6. gomachine node-entry check-ext mechanism** — **+4.3 WASH** (D.7, `GMCHECKEXT` flag).
- **W7. doDeeper ALONE** — **−5.7 WASH**; ships only bundled with ContHist (both now default-on).
- **W8. ttCapR (+1 LMR when ttMove is a capture) / mcLinR (linear moveCount de-reduction)** —
  Wave-2 SPRT drag (combined batch washed ~−5, hindsight-alone was the +10); kept opt-in only.
- **W9. evalHist (#12 eval-diff quiet-history bump) / threatOrder (#10)** — Wave-3 MT+FN WASH,
  "ordering saturated in zug." (My #6 givesCheck-bonus and #18 good/bad-quiet split are
  different ordering angles, but heed the saturation signal — measure, expect resistance.)
- **W10. Razoring-off / IIR-off disable-SPRTs** — −0.6 / +3.8 WASH (C.2); both kept ON.
- **W11. ProbCut (full capture-based)** — gomachine reverted (part of a −77.7 stack, never
  isolated positive). zug ships only the cheap **TT-only** ProbCut variant (default-on).
  Full ProbCut is NOT recommended by the ledger.
- **W12. rule50 + material-output-scaling combo** — **−7.6 REJECT** (`eval-postproc`); SF's
  eval-blend constants don't transfer to zug's net scale. (rule50-alone + #17 SP-optimism
  remain untested — different mechanisms.)
- **W13. SPSA of 6 clamp-safe margins (350 iters)** — validation +5 WASH; base already on
  gomachine's SPSA-tuned values.

---

## Notes on what is ALREADY-HAVE (parity — skip)

zug already matches SF/SP on: PVS + aspiration windows, log·log LMR base table (SPSA-tuned
0.7844/2.4696), LMP move-count `(3+depth²)/(2-improving)`, RFP w/ improving+opponentWorsening
fold + soft return, NMP w/ eval-scaled R + non-pawn-material guard, razoring, IIR (`depth≥4,
!ttMove`), singular + double-ext + negative-ext + multicut, TT-only ProbCut (#2a), depthDrop
(#11 — SF `search.cpp:1379`), cutoffCnt tracking (#6), hindsight priorReduction adjust (#8, SF
`search.cpp:753`), ttPv persist + RFP-gate + LMR-de-reduce (#5), do-deeper/do-shallower re-search
(#D.3), corrhist (pawn+nonpawn, SF-exact weights/gravity, corrected eval feeds all margins),
conthist 1/2-ply w/ [inCheck][capture] split, capture history (ordering), improving flag +
improvingRelax, killers + countermoves (SF actually **dropped** killers — zug keeps them, fine),
TT clustered depth+age replacement + PV bit + static-eval cache + generation aging + huge-pages +
multiply-high index + prefetch, qsearch TT probe/store (zug **ahead** — SF/gomachine parity),
Lazy-SMP + SF vote (`SMPVOTE`) + window diversity (`SMPDIV`), mate-distance pruning, delta/futility
qsearch pruning. Eval postproc: zug has a material-**bucket** (8 buckets) in the net itself —
different from SF's post-hoc material *scaling*, so SF's material-blend term is architecturally
redundant with zug's bucketing (another reason W12 washed).

**Biggest structural gaps zug will NOT close retrain-free:** SF's psqt/positional split (enables
its optimism+complexity blend cleanly — but see #17 for SP's split-free optimism), and the
small-net/big-net two-tier eval. Those are net-architecture, out of scope here.
