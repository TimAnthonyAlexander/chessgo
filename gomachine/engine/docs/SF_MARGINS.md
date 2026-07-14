# Zugzwang vs Modern Stockfish — Search Constants Reference

**Purpose:** Phase-3 transplant prep. Compares Zugzwang's current search constants
(`src/search.cpp`, believed AI-written from ~2020-era SF HCE knowledge) against a
**current** Stockfish checkout, to find which constants/heuristics are stale.

**These are hypotheses to SPRT-test, not promises.** SF's numbers are tuned by SPSA
against SF's own eval/move-ordering/history scale — they are NOT guaranteed to
transfer as-is to Zugzwang. Scale mismatches are flagged explicitly below; treat
every row as "try this direction, then let SPRT decide the actual constant."

## Source read

- **Stockfish version:** tag `sf_18`, commit `cb3d4ee9b47d0c5aae855b12379378ea1439675c`
  ("Stockfish 18"), dated 2026-01-16. Local checkout: `/Users/tim.alexander/sf18-arm`.
- Files read in full: `src/search.cpp` (2210 lines), `src/history.h` (header/limits).
  Skimmed: `src/movepick.cpp` (SEE ordering thresholds).
- Zugzwang file read in full: `/Users/tim.alexander/chessgo/zugzwang/src/search.cpp` (590 lines).

**Important architecture note:** modern SF's search has drifted structurally, not just
numerically, from the ~2020 codebase Zugzwang's constants likely came from:
- All margins are now **int-scaled to 1024** (`r`, reductions) or **large fixed-point
  denominators** (e.g. `/1024`, `/8192`, `/131072`) rather than the old float/simple-int
  style. Any transplanted constant must be re-derived through Zugzwang's own (simpler,
  un-scaled) formula shape — don't paste SF's raw literals into differently-scaled formulas.
  Direction and rough proportion (e.g. "make RFP margin depend more on `!ttHit`") is what
  transfers; the literal integer usually does not.
- SF's LMR `r` is in **1/1024ths of a ply** now (`reduction()` returns a scaled int,
  divided by 1024 at each use site), not integer plies like Zugzwang's. This alone
  explains most of the "SF numbers look huge" reaction — e.g. `r += 714` is ~0.7 ply.
- SF now has **correction history** (4 kinds: pawn/minor/nonpawn×2/continuation) feeding
  into a corrected static eval used everywhere pruning reads `eval`. Zugzwang has none of
  this — noted below as the single highest-value missing heuristic.

---

## A. Constant-by-constant comparison

| Constant | Zugzwang now | Modern SF (sf_18) | Scale-adjusted suggestion | Notes |
|---|---|---|---|---|
| **RFP (reverse futility)** | `eval - 80*(depth-improving) >= beta`, depth≤8 | `futility_margin(d) = (76 - 23*!ttHit) * d - (2474*improving + 331*opponentWorsening) * futilityMult/1024 + |correctionValue|/174665`; applies when `depth<14`, `!ttPv`, `(!ttMove\|\|ttCapture)`, returns `(2*beta+eval)/3` not `eval` (search.cpp:879-889) | Slope per depth is similar order (SF ≈53-76 cp/ply vs Zugzwang 80 cp/ply) but SF (1) scales down improving/opponentWorsening as a *fraction* of the per-depth margin rather than a flat `-80` subtraction, (2) is TT-move-gated (`!ttData.move \|\| ttCapture`) — Zugzwang has no such gate, (3) returns a **softened** value `(2β+eval)/3` instead of raw `eval` — less risk of returning an inflated fail-high. (4) SF also adds an **`opponentWorsening`** term Zugzwang lacks entirely. | Cheap wins: try softened return value; try gating RFP off when ttMove exists and is quiet (an ~SF heuristic: don't RFP-prune positions with a good non-capture TT move, since that suggests real tactics). Depth window 14 vs 8 — SF prunes deeper; worth widening Zugzwang's `depth<=8` cautiously. |
| **Null-move R** | `3 + depth/4 + min((eval-beta)/200, 3)`, minDepth 3, gated on `eval>=beta` | `R = 7 + depth/3` (fixed-point in 1024ths of a ply internally, but effectively ~2.3 plies at depth 6 scaling to `7+depth/3` — search.cpp:899); gate is now `cutNode && ss->staticEval >= beta - 18*depth + 350` (NOT just `eval>=beta` — much stricter, cutNode-only!), `ss->ply>=nmpMinPly`, no `(eval-beta)` term at all, includes a **verification search** at high depth (`depth<16` guard + re-search when `nmpMinPly` unset) | This is the single biggest structural change: **SF only null-moves at expected cut-nodes**, with a *relaxed* eval margin (`beta - 18*depth + 350`, i.e. can null-move even somewhat below beta) rather than requiring `eval>=beta` outright. Zugzwang's `(eval-beta)/200` bonus-R term is gone in SF; instead SF's R depends only on depth. SF also verifies null-move cutoffs at depth≥16 to avoid zugzwang-blindness (ironic naming coincidence) via `nmpMinPly` re-search. | High-value, medium-risk: (1) add the cutNode gate — currently Zugzwang null-moves at *all* non-PV nodes, which is more prune-happy than SF and can hide zugzwangs; (2) SF's relaxed `beta - 18*depth + 350` margin is worth testing in place of strict `eval>=beta`; (3) the `depth<16` verification-search guard is a correctness safety net Zugzwang lacks — relevant since Zugzwang is a small engine that may have less accurate NNUE staticEval reads reducing self-correction elsewhere. |
| **Razoring** | `eval + 200*depth <= alpha`, depth≤3, single qsearch probe | `eval < alpha - 485 - 281*depth*depth` (search.cpp:873) — note **quadratic in depth**, not linear, and no explicit depth cap (naturally self-limits since the margin grows quadratically) | SF's margin is quadratic (`281*d²`) vs Zugzwang's linear (`200*d`) — at d=3 SF requires eval to be `485+281*9=3014` below alpha vs Zugzwang's `600`. SF razors far less aggressively per-depth once d>2, but the flat `485` offset means SF can razor even at d=0-1 more readily than Zugzwang's `200*1=200`. | Try quadratic depth term (`k*depth*depth` shape) instead of linear; direction: less aggressive razoring at depth 3 than Zugzwang currently does, more nuanced at depth 1-2. Needs its own SPRT — the two curves cross. |
| **IIR (no TT move)** | `depth>=4` → `depth--` | `!allNode && depth>=6 && !ttData.move && priorReduction<=3` → `depth--` (search.cpp:932) | SF restricts IIR to **PV/cut nodes only** (`!allNode`, i.e. not all-nodes/fail-low-expected), raises the depth floor to 6, and gates on `priorReduction<=3` (a hindsight signal Zugzwang has no equivalent of, since Zugzwang has no `ss->reduction` bookkeeping). | Zugzwang's IIR currently fires at ALL non-PV/PV nodes ≥ depth 4, which is broader/more aggressive than SF. Restricting to non-all-nodes and raising the depth floor to 6 is a plausible +Elo cheap change, but requires Zugzwang to track `cutNode` at the reduce site (it does have `cutNode` as a template param already) — feasible without new state. |
| **LMP (late move pruning)** | `(3 + depth*depth) / (2 - improving)` | **Identical formula**, byte-for-byte: `(3 + depth*depth) / (2 - improving)` (search.cpp:1054) | No change — this one constant has not moved since ~2020 and Zugzwang already matches SF exactly. | Confirms Zugzwang's author copied this correctly; no action. |
| **Futility (quiets, parent node)** | `eval + 120 + 90*depth <= alpha`, depth≤6 | `futilityValue = staticEval + 42 + 161*!bestMove + 127*lmrDepth + 85*(staticEval>alpha)`, compared against `alpha`, gated `lmrDepth<13` (search.cpp:1097-1109) — uses **`lmrDepth`** (the LMR-reduced depth, i.e. `newDepth - r/1024`, further adjusted by continuation-history/`3208`), NOT raw `depth` | Structurally different: SF futility-prunes based on the *post-reduction* depth estimate, not the actual remaining depth — meaning SF's effective prune window is far wider (13 vs 6) because `lmrDepth` is usually smaller than `depth`. Also SF's constant term is much smaller (42 vs 120) but multiplies a smaller depth proxy, and adds a `161` bonus specifically for "no best move yet" (early futility is safer once *something* is found) and an `85` term when staticEval already beats alpha. | This is a good target: computing an lmrDepth-style reduced-depth-adjusted futility (using Zugzwang's own LMR table/history term) instead of raw `depth` should let Zugzwang prune quiets much later in the move loop (matches SF's depth<13 vs current depth≤6) while using smaller per-depth margins. Needs lmrDepth plumbed to the pruning block (compute `r` before the futility check, not just at LMR time — reorder needed). |
| **SEE-quiet pruning** | `-25*depth*depth`, depth≤8 | `-25 * lmrDepth * lmrDepth` (search.cpp:1114) — **identical coefficient**, but again keyed on `lmrDepth` not raw `depth`, and `lmrDepth` is clamped `max(lmrDepth,0)` first, no explicit outer depth cap (naturally bounded since lmrDepth≤depth) | Coefficient (25) unchanged since ~2020 — matches. Only the depth term differs (lmrDepth vs depth), same story as futility above. | Low-risk: once lmrDepth is computed for the futility block above, reuse it here too — free consistency win, same formula either way in the common case where reductions are small. |
| **Capture-SEE pruning** | `-90*depth`, depth≤6 | `margin = max(166*depth + captHist/29, 0)`, gated `alpha>=VALUE_DRAW \|\| non_pawn_material(us)!=PieceValue[movedPiece]` (avoid pruning sac-for-stalemate), no explicit depth cap (search.cpp:1077-1080) | SF's per-depth coefficient (166) is **~1.8× Zugzwang's (90)** — SF is *more permissive* about pruning bad captures at a given depth, but adds a captureHistory term (`captHist/29`) that can push the margin further negative for historically-good captures, and — notably — adds a **stalemate-sac guard** Zugzwang completely lacks (don't SEE-prune giving away your last piece when it could be a stalemate trick). | Two independent changes: (1) bump coefficient toward 150-170/depth range and validate via SPRT (Zugzwang currently prunes captures more conservatively than SF); (2) add the stalemate-sac guard — cheap, purely a correctness/tactical-safety win, near-zero Elo risk either way, should just be added. |
| **Singular extension** | minDepth 8, `singularBeta = ttValue - 2*depth`, tt-depth margin 3, no negative extension, no multi-cut beyond binary | minDepth `6 + ttPv`, `singularBeta = ttValue - (53 + 75*(ttPv && !PvNode)) * depth/60` (≈ `0.88*depth` to `2.13*depth` depending on ttPv/PvNode — narrower margin than Zugzwang's flat `2*depth`), tt-depth margin still 3, **double/triple extension** tiers (`extension = 1 + (value<singularBeta-doubleMargin) + (value<singularBeta-tripleMargin)`), **multi-cut** returns raw `value` (not `singularBeta`) when `value>=beta`, PLUS **negative extension** (`-3` if ttValue≥beta, `-2` if cutNode) when neither singular nor multi-cut fires (search.cpp:1129-1181) | Three concrete misses: (1) SF extends by up to **+3** (double/triple margins), Zugzwang only ever extends by 1; (2) SF has **negative extension** (reduce the ttMove) when it's provably NOT singular and we're on a cutNode — Zugzwang has no such case, meaning it never actively de-prioritizes a non-singular ttMove; (3) SF's singular margin is roughly `depth` (not `2*depth`) at the loose end — narrower band, extends less liberally per-node but the double/triple tiers compensate at depth. | Highest-value single item in this table for a small engine: negative extensions are cheap (no extra search — just an `extension = -2/-3` on an *existing* branch that already ran a reduced search) and SF calls them out as one of the more robust modern gains. Double-extension tiers are next; both are additive to Zugzwang's existing singular-search infrastructure, no new search calls needed beyond the singular verification already done. |
| **Check extension** | `givesCheck && extension==0 && depth<12` → +1 | **Not a separate case in modern SF at all** — no explicit "give check → extend" rule exists in sf_18's `search()`. Checks are handled implicitly via LMR reduction discounts and the qsearch evasion path, not a flat check-extension. | Zugzwang has a heuristic (flat check extension) that **modern SF removed years ago** — SF found check extensions largely redundant with LMR/QS handling once other heuristics matured. | This is a candidate for **removal or narrowing**, not enhancement — flag as "stale heuristic no longer in SF," worth an SPRT to see if Zugzwang's version is now net-negative or neutral given its other pruning has also evolved. Do not blindly remove without testing; Zugzwang's overall search maturity differs from SF's, so a heuristic SF dropped isn't automatically dead weight here — but it is a documented divergence worth testing. |
| **LMR base table** | `0.85 + ln(d)*ln(m)/2.6`, applied as integer plies, adjustments: `!PvNode +1`, `!improving +1`, `cutNode +1`, `givesCheck -1`, `history/8000` | `reductions[i] = int(2747/128.0 * ln(i))` (≈`21.46*ln(i)`) per index, then combined as `reductionScale = reductions[d]*reductions[mn]`, and `reduction() = reductionScale - delta*608/rootDelta + !improving*reductionScale*238/512 + 1182`, all in **1/1024-ply units** (search.cpp:1735-1737), further adjusted in the move loop: `ttPv: +946`, then later at the move-loop site: `ttPv -= (2719 + PvNode*983 + (ttValue>alpha)*922 + (ttDepth>=depth)*(934+cutNode*1011))`, `+714` base offset, `-moveCount*73`, `-|correctionValue|/30370`, `cutNode: +3372+997*!ttMove`, `ttCapture: +1119`, `(ss+1)->cutoffCnt>1: +256..+2304`, `move==ttMove: -2151`, `statScore*850/8192` (history-based), `allNode: r += r/(depth+1)` | Structurally the same *idea* (log(d)·log(m) base + additive adjustments) but SF's table is **not** Zugzwang's `ln(d)*ln(m)/2.6` — it's a **product of two independently-scaled per-index logs** (`reductions[d]*reductions[mn]`), and crucially SF's reduction is now driven mostly by the *huge* list of post-multiply adjustments (ttPv, cutNode, ttCapture, cutoffCnt, statScore/history, allNode-scaling) rather than the base table alone. Zugzwang has roughly 5 adjustment terms; SF has ~10, several of which Zugzwang lacks entirely: **`delta/rootDelta`** (aspiration-window-relative — reduce less when window is narrow), **`ttCapture`** bump, **`cutoffCnt` neighbor fail-high signal**, **`allNode` self-scaling** (`r += r/(depth+1)`), and **`move==ttMove` discount**. | Highest structural-complexity item — not a single-constant swap. Cheapest sub-wins to try independently: (a) `move==ttMove` reduction discount (Zugzwang currently doesn't special-case the TT move's own reduction — but TT move by construction skips LMR at moveCount==1 in Zugzwang already, so check whether this is already implicitly covered); (b) `ttCapture` bump — cheap add; (c) `(ss+1)->cutoffCnt` sibling-fail-high signal — needs a new `cutoffCnt` field on Stack, moderate effort, SF calls this out as a real (if scaled-down) win. Full table-formula replacement should wait until sub-pieces are validated individually. |
| **Aspiration window** | initial delta 18, flat re-widen `delta += delta/2` | `delta = 5 + threadIdx%8 + |meanSquaredScore|/9000` (search.cpp:355) — i.e. **much smaller base (5, not 18)**, scaled by a thread-id spread term (irrelevant for a single-threaded/simple Zugzwang) and by the position's own score volatility (`meanSquaredScore`), re-widen is `delta += delta/3` (not `/2`) | SF's aspiration window is far narrower to start (5 vs 18) but adapts to score volatility — Zugzwang's flat 18 is a blunt, generic instrument. `delta+=delta/3` widens slower than Zugzwang's `delta+=delta/2`. | Try lowering initial delta toward 8-12 (skip the threadIdx term, Zugzwang is presumably single-threaded here) and/or widen slower (`delta/3` not `delta/2`) — both are classic "SF got narrower over the years as eval got more accurate" trends; narrower start = more re-searches on instability but tighter windows overall are a net win once eval is trustworthy (NNUE). Needs its own SPRT since Zugzwang's eval accuracy/NNUE maturity may differ from SF's. |
| **History bonus scale** | `bonus = depth*depth` (cutoff bonus), clamp ±400 per update, gravity `h += 32*b - h*|b|/512` (saturates ~±16384 given max b=400: `32*400 - h*400/512=0` → h≈16384*32/... ~ converges near `32*400*512/400=16384`) | `bonus = min(116*depth - 81, 1515) + 347*(bestMove==ttMove) + statScore/32` (linear-capped, NOT quadratic!), `malus = min(848*depth-207, 2446) - 17*moveCount`, applied via SF's own gravity `val + clampedBonus - val*|clampedBonus|/D` where **D=7183 for mainHistory** (ButterflyHistory), **D=30000 for continuation history**, **D=10692 for capture history** (history.h:135-145) | **Major scale mismatch, flag clearly**: SF's mainHistory saturates at **±7183**, its continuation history at **±30000** — both far from Zugzwang's single ±16384-ish saturation for one undifferentiated `history[color][from][to]` table. SF's bonus formula is **linear-capped** (`116*depth-81`, capped 1515) not **quadratic** (`depth*depth`) — Zugzwang's `depth*depth` grows unbounded relative to its own clamp of ±400 per update (at depth~20, `depth*depth=400`, already saturating the per-update clamp) whereas SF's linear-capped formula reaches its 1515 cap around depth 13-14. Do NOT copy SF's raw `116*depth-81` into Zugzwang's differently-scaled table without first working out what depth range makes it saturate similarly. | Concrete, scale-corrected suggestion: Zugzwang's `bonus=depth*depth` clamped to ±400 already effectively become linear-capped in practice (saturates at depth≥20, i.e. `20²=400`) so the *shape* mismatch is smaller than it first looks — but Zugzwang has **no separate malus formula** (it just negates the same bonus for other quiets, `-bonus`), whereas SF uses an **asymmetric bonus/malus** (`malus` formula has its own coefficients, decays for the 6th+ quiet via `actualMalus -= actualMalus*(i-5)/i`). Adding an asymmetric, count-decaying malus for the "not the best move but tried" quiets is a concrete, well-isolated, cheap transplant candidate. Also: SF separates **capture history** from **quiet history** entirely (`captureHistory[piece][to][capturedType]`) with its own D=10692 saturation — Zugzwang's `score_moves` already uses MVV-LVA + SEE-good/bad buckets for captures and does NOT feed captures into the `history[]` table at all, so this is less of a gap than it appears; worth double-checking Zugzwang never captures-updates the quiet history table by accident. |
| **Qsearch delta/futility margin** | `130` (`futilityBase = bestValue + 130`) | `futilityBase = staticEval + 351` in `qsearch` (search.cpp:1604); capture-SEE floor in qsearch `-80` (vs Zugzwang's `-50` in both qsearch and main search's `see_ge(mv,-50)` ordering bucket) | SF's qsearch futility margin (351) is **~2.7× Zugzwang's (130)** — SF gives captures much more benefit of the doubt in qsearch before pruning. SF's qsearch bad-capture SEE floor is `-80` vs Zugzwang's `-50` (both main-search ordering and qsearch use the same `-50` in Zugzwang; SF's qsearch floor `-80` is distinct from and looser than its *main-search* per-depth-scaled floor). | Try widening qsearch futilityBase from 130 toward 250-350 — with NNUE eval (much less noisy than old HCE), a larger futility base in qsearch is a well-documented modern trend (values crept up as NNUE eval got more trustworthy at low depth). Also try SEE floor -80 in qsearch specifically (leave main-search ordering's -50 alone, or test in tandem — these interact). |

---

## B. Prioritized transplant list

Ranked by (expected Elo × implementation ease) for a small single/lightly-threaded engine.
"Ease" assumes Zugzwang's existing struct (`Stack`, `Tune`, `history[]`) as the base —
items requiring new per-node state (`cutoffCnt`, `ttMoveHistory`, correction history) cost more.

1. **Negative singular extension (reduce non-singular ttMove on cutNode / when ttValue≥beta).**
   Cheapest high-value item: reuses the singular-search result Zugzwang already computes,
   just adds an `else if` branch setting `extension = -2` or `-3`. No new search calls.
   Direction: should recover some of the Elo SF gained from this exact feature. Try first.

2. **Capture-SEE pruning coefficient bump (90 → ~150-170/depth) + stalemate-sac guard.**
   One-line coefficient change plus a cheap guard condition
   (`non_pawn_material(us) != PieceValue[movedPiece]` before SEE-pruning a capture).
   Low risk, cheap to implement, direct SF parity.

3. **Double/triple singular extension tiers.**
   Adds two more `abs`/threshold checks after the existing singular verification search —
   no new search, just richer use of the `value` already computed. Moderate implementation
   (need `doubleMargin`/`tripleMargin` constants tuned/guessed for Zugzwang's scale, since
   SF's `-4+199*PvNode-...` depends on features Zugzwang doesn't track like `ttMoveHistory`;
   start with a flat depth-scaled margin, e.g. `singularBeta - 50` / `singularBeta - 120`).

4. **lmrDepth-based futility + SEE-quiet pruning (replace raw `depth` with a reduced-depth
   proxy in both the futility-for-quiets and SEE-quiet-pruning checks).**
   Requires computing `r` (or a cheap proxy: `depth - Reductions[depth][moveCount]`) BEFORE
   the pruning block instead of only at the LMR call site — a real reorder, moderate effort,
   but touches two of Zugzwang's existing formulas at once and should let it prune later/more
   precisely (matches SF's `depth<13` window vs current `depth<=6`).

5. **Null-move cutNode gate + relaxed eval margin.**
   `depth>=3 && eval>=beta` → `cutNode && ss->staticEval >= beta - 18*depth + 350`.
   Needs `cutNode` (already a template/param in Zugzwang's `negamax`) threaded to the NMP
   check — should be nearly free since it's already passed down. Meaningful behavior change
   (fewer, more targeted null-moves) — moderate risk, test both directions since Zugzwang's
   NMP today is more aggressive/broad than SF's.

6. **Aspiration window: lower initial delta (18→~10-14), slower widen (`delta/2`→`delta/3`).**
   One-line constant tweaks, cheap to test, but interacts with time management — test with
   fixed-depth/fixed-node SPRT first to isolate from time-loss noise.

7. **RFP softened return value `(2*beta+eval)/3` instead of raw `eval`, + gate off when
   ttMove exists and is quiet.**
   Cheap, mechanical change to an existing branch. Low risk (softening a fail-high return
   value is close to a strict improvement in theory, but must be SPRT-confirmed).

8. **Qsearch futility base bump (130 → ~250-350).**
   One-constant change, but qsearch is the hottest loop in the tree — re-measure NPS impact
   is irrelevant (same node shape) but tactical accuracy could shift either way; test.

9. **Asymmetric malus for non-best quiets (currently Zugzwang just negates the winning
   bonus).** Needs a distinct `malus` formula + the "decay after the 5th quiet" trick
   (`actualMalus -= actualMalus*(i-5)/i` for i>5). Self-contained, moderate effort, directly
   ports SF's exact idea (adjust constants for Zugzwang's ±400/update clamp).

10. **Check-extension removal/narrowing test.**
    Not a transplant so much as a validation: SF dropped this heuristic entirely. Run an
    SPRT with it disabled (Zugzwang already has a `Tune` struct pattern — add a flag) to see
    if it's now dead weight given Zugzwang's other pruning has moved on from 2020-era shape.

**Not included above (deliberately deferred, too structural for a quick transplant):**
IIR IIR IIR — restricting to `!allNode` requires Zugzwang to distinguish "expected all-node"
from plain non-PV, which it currently doesn't model (`cutNode` alone isn't `!allNode`); the
full LMR reduction-table replacement (too many interacting terms to isolate cheaply); and
`cutoffCnt`-based reduction bump (needs new Stack state, moderate-to-large effort for the
expected payoff on a small engine's tree shape).

---

## C. Modern SF heuristics Zugzwang lacks entirely

Ranked qualitatively by (expected Elo × implementation ease) for transplant candidacy,
independent of the constant-comparison table above.

1. **Correction history (pawn / minor-piece / non-pawn(w) / non-pawn(b) / continuation×2).**
   Already tracked as a separate planned item per project context (do not duplicate effort
   here) — but flagging it as the single largest missing piece structurally: SF's `eval`
   used throughout every pruning decision (RFP, NMP, futility, razoring) is a *corrected*
   eval (`to_corrected_static_eval`), not raw NNUE output. This one change touches nearly
   every margin in the table above indirectly, since SF's constants were tuned assuming a
   corrected, lower-variance `eval`. Highest expected Elo of anything in this doc, highest
   implementation cost (needs 4-6 new history tables + write/read points at every eval site).

2. **`ttMoveHistory` (global, single running stat of "does the tt move usually hold").**
   Very cheap to add — one `int` per thread, one `<<` update site (search.cpp:1420,1162) —
   feeds into the singular-extension double-margin above and a small IIR-adjacent signal.
   Good ease/Elo ratio, but its main payoff in this doc is only realized once double/triple
   singular extensions (item 3 above) are also transplanted, since that's the only current
   consumer.

3. **`cutoffCnt` sibling fail-high signal** (`(ss+1)->cutoffCnt`, incremented on beta cutoffs,
   read one ply up to bump reduction when a sibling recently failed high a lot). Needs one
   new `int` field on `Stack`, cleared/incremented at existing cutoff sites — cheap-ish,
   moderate expected Elo per SF's own comments ("(*Scaler) Infrequent and small updates
   scale well" — i.e. real but not huge).

4. **`opponentWorsening`** (`ss->staticEval > -(ss-1)->staticEval`) as a second improving-like
   flag, used in RFP and elsewhere alongside `improving`. Trivial to compute (one extra bool,
   reads state Zugzwang already has via `ss` chain) — cheap, likely small-but-real Elo, good
   first "new heuristic" to try since it's nearly free.

5. **ProbCut** (both the full version at search.cpp:935-981 and the "small ProbCut idea" at
   :985-989 using just the TT entry). Zugzwang has neither. Real but moderate implementation
   cost (needs a capture-only MovePicker mode + a probCut-depth reduced search) — classic
   SF-era technique, worth doing but not "cheap."

6. **Hindsight hi-reduction hindsight adjustment** (`priorReduction>=3 && !opponentWorsening
   → depth++`; `priorReduction>=2 && ... → depth--`, search.cpp:754-757) — requires the
   `ss->reduction` bookkeeping this doc's item C.3/LMR discussion mentions Zugzwang lacks.
   Cheap once `ss->reduction` exists (a natural side-effect of doing item 3), meaningful
   per SF's design (self-correcting over/under-reduction).

7. **Multi-cut via singular search reaching `value>=beta`** — Zugzwang's singular code
   already has a multi-cut branch (`singularBeta>=beta`) but returns `singularBeta`
   (a fixed bound) rather than SF's raw `value` (search.cpp:1160-1164, which also updates
   `ttMoveHistory` on this path). Small fix once item C.2 (`ttMoveHistory`) exists — but
   note Zugzwang's multi-cut condition is subtly different (`singularBeta>=beta` tested
   BEFORE the reduced search even runs, vs SF testing the reduced search's actual `value`)
   — this may be a correctness/effectiveness gap worth flagging on its own, not just a style
   difference. Worth a closer look outside this doc's scope.

8. **Stalemate-avoidance guard in qsearch** (search.cpp:1710-1722 — explicit check for
   "did we just capture the last non-pawn-material piece and could this be stalemate")
   and the SEE-pruning stalemate-sac guard (item A "Capture-SEE pruning" row above). Both
   are narrow correctness nets, cheap, low-but-nonzero Elo (avoids occasional blunders in
   endgame-adjacent tactics), worth bundling with item B.2 above.

9. **Two-tier "small ProbCut" idea via TT alone** (search.cpp:985-989) — a nearly-free
   pre-move-loop check using only the existing TT entry (`ttData.bound & BOUND_LOWER &&
   ttData.depth>=depth-4 && ttData.value>=beta+418`) that doesn't even require the full
   ProbCut machinery from item 5. Genuinely cheap (no new search, no new MovePicker mode) —
   arguably should be re-ranked above full ProbCut for a first pass.

10. **Aspiration delta scaled by `meanSquaredScore`** (score-volatility-aware window sizing,
    search.cpp:355) — ties into item B.6 above; listed here separately because it requires
    tracking `meanSquaredScore` per root move (new state) rather than just changing the
    flat constant, which is why B.6 above only proposes the flat-constant version first.
