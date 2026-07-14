# gomachine ↔ zugzwang Search-Parity Diff

**Purpose:** gomachine (Go) and zugzwang (C++) run the **identical NNUE net**, so unlike
`SF_MARGINS.md` (which compares zugzwang to Stockfish — a *different* net/eval scale, hence
"direction transfers, literals don't"), gomachine's cp-denominated search constants (RFP/futility/
razor/SEE margins, aspiration delta, singular margin) are tuned against the **same eval magnitude**
zugzwang produces. Those constants are directly portable, not just directionally suggestive.
The one caveat: internal history-table units (butterfly/continuation history clamps, gravity
divisors) are each engine's own arbitrary bookkeeping scale, not eval-cp-denominated — a divisor
swap there needs the *ratio* preserved, not the literal.

**Sources read in full:** `gomachine/internal/search/{search.go,params.go,ordering.go,corrhist.go,
conthist.go,conthist2.go,tt.go,timemanager.go}`; `zugzwang/src/{search.cpp,search.h,tt.cpp,tt.h,
movegen.cpp}`; `zugzwang/SF_MARGINS.md` (context only — its constants are SF-scaled, not used as
port targets here).

**Headline:** zugzwang is not a blank slate — several "SF-divergence fixes" gomachine has as
*unshipped, off-by-default scaffolding* (TT-refines-eval, TT-cutoff-gated-non-PV, qsearch TT,
RFP-soft+quietTT-gate) are already permanently ON in zugzwang. Conversely, zugzwang is missing one
likely-load-bearing correctness gate (§D.0) and several of gomachine's shipped, SPRT-accepted
features (continuation history, do-deeper/do-shallower, history pruning) outright.

---

## Section A — Feature-presence matrix

✓ = present and reachable at the engine's **shipped default** config; **(off)** = code exists but
default-disabled in gomachine (so it is *not* validated evidence either way); ✗ = no code path at all.

| # | Feature | gomachine | zugzwang | Note |
|---|---|:-:|:-:|---|
| 1 | Correction history (pawn + per-color non-pawn) | ✓ | ✓ | different formula/scale — §B |
| 2 | Correction history: minor-piece key | (off) | ✗ | gomachine's own key is SPRT-inconclusive |
| 3 | Correction history: continuation key | (off) | ✗ | gomachine's own key is SPRT-rejected |
| 4 | Continuation history (1-ply + 2-ply, feeds ordering + LMR) | ✓ | ✗ | **HIGH VALUE gap** — §D.2 |
| 5 | Continuation history v2 (Stormphrax 4-ply coupled) | (off) | ✗ | gomachine's own is unproven |
| 6 | Capture history | (off) | ✗ | gomachine's own is unproven |
| 7 | Countermove table (binary, ordering only) | ✓ | ✓ | matches (COUNTER_SCORE tier both sides) |
| 8 | Parent-counter-move (PCM) bonus/malus | (off) | ✗ | gomachine's own is unproven |
| 9 | Null-move pruning: base gate + R formula | ✓ | ✓ | **already matches almost exactly** — §B |
| 10 | Null-move: gated to non-PV only | ✓ | ✓ | matches (structural in zugzwang) |
| 11 | Null-move: cutNode gate + relaxed margin (modern SF) | (off) | (off) | both unshipped, matches |
| 12 | Reverse futility pruning (RFP) | ✓ | ✓ | differing margin — §B |
| 13 | RFP soft fail-firm + quiet-TT-move gate | (off) | ✓ | **zugzwang ahead** — §C.1 |
| 14 | RFP quadratic (Stormphrax) margin shape | (off) | ✗ | gomachine's own is unproven |
| 15 | Razoring | (off) | ✓ | gomachine reverted this — §C.2 disable-candidate |
| 16 | Internal iterative reduction (IIR) | (off) | ✓ | gomachine found it dead-flat — §C.2 |
| 17 | ProbCut | (off) | ✗ | gomachine reverted this; low priority either way |
| 18 | Singular extensions | ✓ | ✓ | differing minDepth — §B |
| 19 | Singular verification depth/margin/gate shape | ✓ | ✓ | **structurally identical formula** — §B |
| 20 | Multi-cut (hard early return) | ✓ | ✓ | matches |
| 21 | Negative extensions (non-singular TT move) | (off) | ✓ | different defaults + magnitudes — §B/§D |
| 22 | Soft multicut (ilerp blend toward beta) | (off) | ✗ | zugzwang always hard-returns; low priority |
| 23 | Double/triple extension tiers | (off, double only) | ✗ | gomachine's own is rejected; low priority |
| 24 | Check extension | ✓ | ✓ | **different mechanism** — §B, worth an SPRT |
| 25 | LMR: log(d)·log(m) base table | ✓ | ✓ | differing base/div constants — §B |
| 26 | LMR: cutnode term | ✓ | ✓ | matches (both +1) |
| 27 | LMR: "not improving" term | (off) | ✓ | zugzwang unconditional; keep, low risk — §C.1 |
| 28 | LMR: explicit PV/non-PV term | (off/partial) | ✓ | gomachine's default path omits this — §B |
| 29 | LMR: history-magnitude term | ✓ | ✓ | differing divisor, roughly scale-consistent — §B |
| 30 | LMR: "gives check" reduce-not-skip | (off) | ✓ | gomachine skips LMR on checks by default — §B |
| 31 | LMR: TT-move-is-noisy term | (off) | ✗ | gomachine's own is unproven |
| 32 | LMR: alpha-raises term | (off) | ✗ | gomachine's own is unproven |
| 33 | LMR: ordering-trust discount (ttMove/killer) | (off, LMR2-only) | ✗ | not in either shipped path |
| 34 | LMR: move-count onset threshold | ✓ | ✓ | **hugely differing constant** — §D.1 |
| 35 | LMR: do-deeper / do-shallower adaptive re-search | ✓ | ✗ | **HIGH VALUE gap** — §D.3 |
| 36 | LMR: aggressive LMR2 (reduce captures too) | (off, rejected) | ✗ | correctly absent both sides |
| 37 | LMR: ×1024 fixed-point table | (off) | ✗ | precision scaffold only, low priority |
| 38 | Frontier futility pruning (quiets) | ✓ | ✓ | differing base/slope — §B |
| 39 | History pruning (quiet, magnitude-gated) | ✓ | ✗ | **HIGH VALUE gap** — §D.4 |
| 40 | SEE-quiet pruning | ✓ | ✓ | **different functional shape** (linear vs quad) — §D.5 |
| 41 | Capture-SEE pruning | ✓ | ✓ | **hugely differing magnitude** — §D.1 |
| 42 | Late-move pruning (LMP) move-count formula | ✓ | ✓ | formula matches exactly — §B |
| 43 | **Late-move pruners gated to non-PV only** | ✓ | **✗** | **correctness-parity bug** — §D.0, top priority |
| 44 | Qsearch: captures-only generation out of check | ✓ | ✓ | matches |
| 45 | Qsearch: SEE prune of losing captures | ✓ | ✓ | differing threshold (0 vs −50) — §B |
| 46 | Qsearch: delta pruning | ✓ | ✓/merged | zugzwang fuses delta+futility into one check — §D.6 |
| 47 | Qsearch: node-level futility (Stormphrax qsearchFp) | ✓ | ✓/merged | see above |
| 48 | Qsearch: TT probe + store | (off) | ✓ | **zugzwang ahead** — §C.1 |
| 49 | Qsearch: move-count cap | (off) | ✗ | gomachine's own is unproven |
| 50 | Qsearch: delta-prune check/recapture exemptions | (off) | ✗ | gomachine's own is unproven |
| 51 | Aspiration windows | ✓ | ✓ | differing initial delta/growth — §B |
| 52 | Aspiration: variance-scaled window | (off) | ✗ | gomachine's own is unproven |
| 53 | Aspiration: fail-high-count depth reduction | (off) | ✗ | gomachine's own is unproven |
| 54 | TT: static-eval caching/reuse on hit | ✓ | ✓ | **already matches** |
| 55 | TT: stored bound refines pruning eval (TTRefinesEval) | (off) | ✓ | **zugzwang ahead** — §C.1 |
| 56 | TT: early cutoff gated to non-PV | (off, cuts at PV too) | ✓ | **zugzwang ahead** — §C.1 |
| 57 | TT: lock-free / SMP-safe (Hyatt XOR) | ✓ | n/a | zugzwang is single-threaded; out of scope |
| 58 | TT: clustered replacement (4-way / bucketed) | (off, direct-mapped) | ✓ | **zugzwang ahead structurally** — §C.1 |
| 59 | TT: PV-aware replacement priority | ✗ | ✓ | **zugzwang ahead**, gomachine itself lacks this |
| 60 | Staged/deferred move picking (TT→captures→quiets) | (off) | ✗ | gomachine's own is unproven |
| 61 | Deferred quiet re-scoring after capture-stage mutation | (off) | ✗ | gomachine's own is unproven |

---

## Section B — Differing constants (port targets)

All cp-denominated margins below are direct-port candidates (same net, same eval scale). History-
table divisors are flagged with the scale caveat.

| Constant / heuristic | gomachine value (file:line) | zugzwang value (file:line) | Action |
|---|---|---|---|
| **Null-move R formula** | `R = 3 + depth/4 + min((eval−beta)/200, 3)`, gate `eval≥beta`, non-PV only — `search.go:1452-1487` (`NullMoveR=3` `params.go:225`, `NMPDepthDiv=4` `params.go:565`, `NmpEvalDivisor=200` `params.go:512`, `NMPEvalCap=3` `params.go:566`, `NMPNonPV=true` `params.go:530`) | `R = 3 + depth/4 + min((eval−beta)/200, 3)`, gate `eval≥beta`, structurally non-PV (whole pruning block is `!PvNode`) — `search.cpp:400-421` (`nullMoveR=3` implicit literal `L410`, `nmpEvalDiv=200` `L47`) | **Already matches.** No action — confirms both are correctly net-tuned here. |
| **RFP margin** | `staticEval − 75·(depth−improving) ≥ beta`, depth≤8 — `search.go:1421-1443` (`RFPMargin=75` `params.go:548`, `RFPMaxDepth=8`→`rfpMaxDepth` `search.go:57`) | `eval − 80·(depth−improving) ≥ beta`, depth≤8 — `search.cpp:392-398` (`rfpMargin=80` `L41`) | Adopt gomachine's SPSA-tuned **75** (from 80). Depth cap already matches. |
| **RFP soft return / quiet-TT gate** | off (`RFPSoft=false` `params.go:264`, `rfpFailFirmT=711` unused) | on: `(2β+eval)/3`, skip RFP entirely when ttMove is quiet — `search.cpp:396-398` | **Already matches / zugzwang ahead** — gomachine's own SPRT on this was a wash, not a rejection. Keep zugzwang's version (§C.1). |
| **Razor margin** | off by default (`Razor=false` `params.go:501`; const `razorMargin=250`, `razorMaxDepth=3` — `search.go:105-106`) | on: `eval + 200·depth ≤ alpha`, depth≤3 — `search.cpp:423-427` (`razorMargin=200` `L42`) | gomachine's own evidence on razor is inconclusive (bundled in a reverted 5-patch stack, never isolated at movetime) — disable-SPRT in zugzwang, §C.2. Margin itself (200 vs 250) is secondary. |
| **IIR trigger** | off (`IIR=false` `params.go:459`; `depth≥4`, PV-only when on — `search.go:1292-1310`) | on unconditionally: `depth≥4 && !ttMove && !rootNode → depth--` — `search.cpp:430-432` | gomachine measured this **dead flat** (+0.3±11.5 movetime) individually — disable-SPRT in zugzwang, §C.2. |
| **Check extension** | uncapped, fires once per **node** when the side to move is in check (before movegen), stacks freely with singular — `search.go:1244-1250` (`CheckExtension=true` `params.go:227`, no depth cap, no Params field) | capped `depth<12`, fires per **move** when that move gives check, **mutually exclusive** with singular (`extension==0` gate) — `search.cpp:511-512` | Structurally different mechanisms, not a simple constant swap. Recommend an SPRT of gomachine's exact mechanism (node-level in-check, uncapped, always-stacks) transplanted into zugzwang — §D.7. |
| **Singular min depth** | `5` (SPSA-tuned down from 6) — `params.go:412` (`SingularMinDepth`), read at `search.go:2324` | `8` hardcoded — `search.cpp:494` | Adopt gomachine's **5**. Everything else about the singular mechanism (margin=2·depth, verify depth=(depth−1)/2, ttDepth≥depth−3 gate, lower/exact bound gate) is **already byte-identical in shape** between the two — `search.go:2322-2381` vs `search.cpp:493-509`. |
| **Singular margin** | `singularBeta = ttScore − 2·depth` (`SingularMargin=2` `params.go:411`) | `singularBeta = ttValue − 32·depth/16` = exactly `ttValue − 2·depth` (`singularMargin=32` `L48`) | **Already matches exactly.** |
| **Negative extension magnitudes + priority** | off by default (`NegExt=false` `params.go:447`); when on: `−3` if `ttScore≥beta`, `−2` if cutNode, **replaces** the hard multicut with a soft ilerp blend — `search.go:2352-2381` | on by default (`negExt=true` `L32`): `−2` if `ttValue≥beta`, `−1` if cutNode, hard multicut is checked **first** (negExt is only reached if multicut didn't fire) — `search.cpp:501-508` | Two issues: (1) zugzwang runs an untested-in-gomachine feature by default — gomachine's own `NegExt` has never cleared SPRT either way; (2) if kept, magnitudes should move toward gomachine's Stormphrax-derived `−3/−2` (from `−2/−1`) and the soft-multicut-replaces-hard-multicut ordering should be tried. Flag both, medium priority — §D.8. |
| **LMR base table** | `0.7844 + ln(d)·ln(m)/2.4696` — `search.go:34` (`LMRBaseX10k=7844`,`LMRDivX10k=24696` `params.go:545-546`) | `0.85 + ln(d)·ln(m)/2.6` — `search.cpp:648` | Adopt gomachine's SPSA-tuned base/divisor (7844/24696 in ×10000 terms). Cheap, low risk. |
| **LMR onset (move-count threshold)** | reduce from the **5th searched move** on (`searched≥4`, `LMRMinMoves=4` `params.go:567`, read `search.go:2601`) | reduce from the **2nd move** on (`moveCount>1+(rootNode?1:0)` — `search.cpp:523`) | **Highest-value single constant in this table** — zugzwang starts LMR ~3 moves earlier than gomachine's tuned onset. See §D.1. |
| **LMR "gives check" handling** | checking quiets are **excluded from LMR entirely** by default (reduction=0 unless `LMRCheckReduce` on, off — `params.go:43-44`, gate at `search.go:2601` `!givesCheck \|\| s.params.LMRCheckReduce`) | checking quiets **are** LMR'd, with a `r--` discount — `search.cpp:528` | gomachine's own `LMRCheckReduce`/`LMRCheckRed=1` scaffold is unproven (never SPRT'd to a verdict) — this is the same *value* zugzwang already runs, just untested on gomachine's side. Neutral; no strong recommendation either way, flag for zugzwang disable-SPRT if bundled with other LMR changes. |
| **LMR PV/non-PV term** | absent in the shipped `LMRFormula` path (only present, off, via `LMRPvRelief` scaffold or the rejected `LMR2` bundle) | unconditional: `!PvNode: r++` — `search.cpp:525` | gomachine's shipped default has **no** explicit PV discount term at all in this exact spot. Since zugzwang already has it and gomachine has no contrary evidence, keep — flag as a "gomachine should probably add this too" note, not a zugzwang removal candidate. |
| **LMR "not improving" term** | absent in shipped path (off via `LMRImproving` scaffold, `params.go:251`) | unconditional: `!improving: r++` — `search.cpp:526` | Same situation as above — zugzwang already runs gomachine's unproven scaffold value. Keep. |
| **LMR history-magnitude divisor** | `r -= hist/4096` (`LMRHistDiv=4096` `params.go:547,132`), history clamps to ±8192 (`MaxHistory=8192` `params.go:575`) | `r -= hist/8000` (`search.cpp:529`), history self-ages to ≈±16384 (`update_history`, `search.cpp:221-225`) | **Scale caveat applies** — zugzwang's history table saturates at roughly 2× gomachine's magnitude, and 8000/4096≈1.95 is proportionally close to matching. Likely already roughly consistent; low-priority re-tune only after other changes land. |
| **Frontier futility margin** | `staticEval + 0 + 100·depth ≤ alpha`, depth≤6 (`FutilityBase=0`,`FutilitySlope=100` `params.go:465-466`, cap `futilityMaxDepth=6` `search.go:88`) | `eval + 120 + 90·depth ≤ alpha`, depth≤6 — `search.cpp:479` (`futBase=120`,`futSlope=90` `L43-44`) | Adopt gomachine's **base 0** (drop zugzwang's flat +120 constant) and **slope 100** (from 90). |
| **Capture-SEE prune margin** | `SEE < −23·depth`, depth≤4 (`CaptSEEMargin=23`,`CaptSEEMaxDepth=4` `params.go:491-492`) | `SEE < −90·depth`, depth≤6, plus a `!givesCheck` exemption gomachine lacks — `search.cpp:489` (`captSeeCoeff=90` `L46`) | **High-value gap** — zugzwang is ~4× less aggressive than gomachine's tuned value. See §D.1. |
| **SEE-quiet prune shape** | **linear**: `SEE < −75·depth`, depth≤6 (`SEEQuietMargin=75`,`SEEQuietMaxDepth=6` `params.go:479-480`) | **quadratic**: `SEE < −25·depth²`, depth≤8 — `search.cpp:484` (`seeQuietCoeff=25` `L45`) | Functional-form mismatch, not just magnitude — see §D.5. |
| **Qsearch SEE-losing threshold** | `SEE < 0` (both main-search capture tiering `ordering.go:95` and qsearch prune via `SEEReuseQS`/`search.go:2972-2984`) | `SEE < −50` (main-search tiering `search.cpp:198`, qsearch `search.cpp:305`) | zugzwang is more permissive (keeps captures losing up to 50cp). Recommend testing gomachine's stricter 0 threshold, moderate risk (shape-adjacent to ordering, not just qsearch). |
| **Qsearch delta/futility margin** | two separate mechanisms: `DeltaPrune` margin 200 (`DeltaMargin` `params.go:522`) + `QSFutility` margin 100 with SEE≥1 gate (`QSFutilityMargin` `params.go:518`) — `search.go:2991-3025` | one fused mechanism: `futilityBase = standPat + 300`, gated on `!SEEGE(m,1)` — `search.cpp:272,297-303` (`qsFutMargin=300` `L34`) | Structural difference — see §D.6. |
| **Aspiration initial delta** | `25` (`aspInitDelta` `search.go:872`, `AspInitDelta` `params.go:233`) | `18` — `search.cpp:723` | Adopt gomachine's **25**. |
| **Aspiration widen rate** | doubling (`delta += delta`, `search.go:936`); 1.5× growth exists only as an off-by-default scaffold (`AspWidenGrow=false` `params.go:583`) | 1.5× (`delta += delta/2`, `search.cpp:735`) | zugzwang already runs the *scaffolded* gomachine value, not gomachine's *shipped* value. Ambiguous — gomachine's own default (2×) is what's actually validated by the original aspiration SPRT. Low-priority; leave as-is or A/B both directions. |
| **History cutoff bonus/malus shape** | `HistBonusScale·depth²` capped `HistBonusMax`; separate, currently-identical malus scale/cap (`32`,`1536` — `params.go:549-550,554-555`); gravity divisor = `MaxHistory=8192` — `search.go:112-131` | `bonus = depth²` clamped to `±400` per update, then gravity `h += 32·bonus − h·|bonus|/512` (self-ages to ≈±16384) — `search.cpp:221-225,581` | Same quadratic *shape*, different clamp/divisor scale (see LMR-history row above). No direct swap recommended without validating the whole history-magnitude pipeline together. |
| **TT static-eval cache** | on (`TTEval=true` `params.go:333`), reuses `ttEvalCached` — `search.go:1349-1353` | always on, no flag — `search.cpp:260,382` | **Matches.** No action. |

---

## Section C — Features zugzwang has that gomachine's shipped default lacks

### C.1 — Keep. Not dead weight; gomachine simply hasn't shipped these yet.

These are cases where zugzwang (built from "AI-written ~SF knowledge") already incorporates a
modern SF-standard fix that gomachine has coded as **inert, off-by-default scaffolding** — there is
no gomachine evidence against any of these, so do **not** disable-SPRT them. If anything, gomachine
should backport its own dormant flags.

1. **TT-refines-eval** (`search.cpp:384-385` — a bound-consistent stored TT score sharpens the
   pruning `eval`). gomachine's `TTRefinesEval` (`params.go:531`) is off, byte-identical, untested.
2. **TT-cutoff gated to non-PV** (`search.cpp:363` — the whole `if (!PvNode && ttHit && ...)` early
   return). gomachine's `TTCutoffNonPV` (`params.go:529`) is off — meaning gomachine's shipped
   default *does* take early TT-move cutoffs at PV nodes, a known minor SF-divergence.
3. **Qsearch TT probe/store** (`search.cpp:239-251,326-328`, unconditional). gomachine's
   `QSearchTT` (`params.go:533`) is off, scaffolded but never SPRT'd.
4. **RFP soft fail-firm + quiet-TT gate** (`search.cpp:396-398`). gomachine's `RFPSoft`
   (`params.go:264`) SPRT was a wash at low sample, not a rejection — comment explicitly says "NOT
   shipped; needs the full pooled run."
5. **4-way clustered TT with depth+PV-aware replacement** (`zugzwang/src/tt.cpp:36-69`,
   `tt.h:37-38`). gomachine's equivalent (`Params.TTBucketShift`, `tt.go:80-93`) defaults to
   direct-mapped (shift 0) and is itself under SPRT — and gomachine's TT store has **no PV-aware
   replacement bonus at all** (`tt.go:172-257`), a feature zugzwang has that gomachine genuinely
   lacks in either mode.
6. **LMR unconditional PV and "not improving" terms** (`search.cpp:525-526`) — gomachine's
   equivalents (`LMRPvRelief`, `LMRImproving`) are off scaffolding with no verdict.

### C.2 — Candidates for a disable-SPRT in zugzwang

These are cases where gomachine **built the same feature, shipped it, tested it individually at
movetime, and found it neutral-to-negative** on this exact search stack/net. Zugzwang running them
by default is a real disagreement with gomachine's evidence, not just an unshipped scaffold.

1. **Razoring** (`search.cpp:423-427`, `tune.razor=true`). gomachine's `Razor` is off; its only
   data point (`+32.8 @ 40k nodes`) was part of a 5-patch stack that regressed −77.7 at movetime,
   never isolated. Worth an individual zugzwang SPRT of `razor=off`.
2. **IIR** (`search.cpp:430-432`, unconditional `depth≥4`). gomachine measured its *own* reworked
   (PV-only) IIR at **+0.3 ± 11.5 movetime — dead flat** individually. zugzwang's version is even
   more aggressive (fires at every non-PV node too, not just PV). Worth a zugzwang SPRT of
   `iir=off`.

---

## Section D — Ranked port worklist

Ordered by (expected Elo × ease). **D.0 is the single highest-priority item in this document** —
cheap and structurally certain to matter.

### D.0 — Correctness-parity gate (fix first, bundle with nothing else)

**Add `!PvNode` to zugzwang's late-move-pruning block.** In `search.cpp:471-491`, the block housing
LMP, quiet frontier-futility, SEE-quiet pruning, and capture-SEE pruning is gated only on
`!rootNode && bestValue > -VALUE_MATE_IN_MAX_PLY && pos.non_pawn_material(us)` — **no `!PvNode`
check**. Every other pruning site in the same function (RFP `search.cpp:392`, NMP inside the
`!PvNode` block `search.cpp:393`, razoring `search.cpp:424`) is correctly non-PV-gated, and gomachine
gates every one of LMP/Futility/HistPrune/SEEQuiet/CaptSEE on `!isPV` explicitly (`search.go:2423,
2437,2448,2469,2485`). As written, zugzwang currently **prunes quiets and captures inside its own
principal variation** — actively degrading the PV it reports and searches deepest. One-line fix:
wrap `search.cpp:471-491` in `if (!PvNode) { ... }` (or add `&& !PvNode` to each of the four
conditions). Near-zero implementation risk; expected value likely exceeds every item below.

### D.1 — Cheap constant swaps (batchable in one SPRT)

Bundle these — none touch each other's code paths, all are single-literal or single-clamp edits:

1. Null-move R: **already matches**, no change (confirms both correctly tuned — sanity check only).
2. RFP margin: `80 → 75` (`search.cpp:41`).
3. LMR base/divisor: `0.85/2.6 → 0.7844/2.4696` (`search.cpp:648`).
4. **LMR onset: `moveCount > 1` → `moveCount > 4`** (`search.cpp:523`) — matches gomachine's
   `LMRMinMoves=4`/`searched≥4`. This is the single biggest LMR-shape change in the whole diff;
   zugzwang currently reduces starting at the 2nd move vs gomachine's tuned 5th.
5. **Capture-SEE margin: `90 → 23`, max-depth `6 → 4`** (`search.cpp:46,489`) — zugzwang is ~4×
   too permissive here relative to gomachine's tuned value.
6. Frontier futility: base `120 → 0`, slope `90 → 100` (`search.cpp:43-44`).
7. Singular min depth: `8 → 5` (`search.cpp:494`).
8. Aspiration initial delta: `18 → 25` (`search.cpp:723`).

Batch these 7 constant swaps (skip #1, it's a no-op) in one SPRT since they don't interact
structurally — only #4 and #5 are individually large enough to want a solo confirmation run if the
batch result is ambiguous.

### D.2 — Port continuation history (new feature, ~120-180 lines in `search.cpp`)

gomachine's `ContHist` (`conthist.go`, wired at `search.go:2410-2413,2451-2456,2564-2569,2612-2617,
2643-2648,2765-2767`) is a **shipped, default-on** feature — part of the explicitly-attributed
"+19.7 movetime stack" alongside cutnode-LMR + doDeeper. It is entirely absent from zugzwang, which
only has the binary `counterMoves` ordering slot (`search.cpp:160,204-208,438,587`) — no magnitude
table, and it never feeds LMR reduction. Port: two `[12][64][12][64]int16` tables (1-ply/2-ply
parent-keyed), a per-ply "move played" stack (zugzwang already has `ss->currentMove`, so this is
mostly reusing existing state), gravity update on cutoff (mirror `update_history`'s formula/scale),
and read sites in `score_moves` (ordering) + the LMR reduction term. Moderate effort, high
confidence (gomachine's own attribution note says it's near-worthless *alone* — ship it together
with D.3, not standalone).

### D.3 — Port do-deeper / do-shallower adaptive re-search (~15-25 lines)

gomachine's `LMRDoDeeper` (`params.go:268`, applied at `search.go:2702-2718`) adapts the LMR
re-search depth based on how far the reduced scout beat alpha (`sc > bestScore+44+4·newDepth` →
search one ply deeper; `sc < bestScore+newDepth` → one ply shallower) instead of zugzwang's flat
`newDepth` re-search (`search.cpp:530-532,537-538`). gomachine's own notes call this **the mechanism
that makes cutnode-LMR pay** ("SHIPPED — the adaptive re-search safety net"); zugzwang already has
the cutnode LMR term (`search.cpp:527`) but not this safety net — likely leaving Elo on the table.
Cheap: touches only the post-LMR re-search branch, no new state.

### D.4 — Port history pruning (new feature, ~15 lines)

gomachine's `HistPrune` (`params.go:470`, `search.go:2443-2461`) skips a late quiet whose combined
butterfly(+continuation) history is below `HistPruneMargin(-1000)·depth` at `depth≤HistPruneMaxDepth
(6)`. SPRT-accepted standalone at **+86.8 ± 26.8 Elo @ 40k nodes**. Zugzwang has no history-magnitude
pruner at all (only move-count LMP + static-eval futility + SEE-quiet). Straightforward port once a
history-magnitude read exists (already true without ContHist — butterfly `history[][]` alone
suffices as a first cut; richer once D.2 lands). Remember D.0's `!PvNode` gate.

### D.5 — Reconcile SEE-quiet pruning shape (constant + shape change, ~5 lines)

gomachine's tuned SEE-quiet prune is **linear** in depth (`SEE < −75·depth`); zugzwang's is
**quadratic** (`SEE < −25·depth²`, matching *old-SF's* shape per `SF_MARGINS.md`, not gomachine's).
These cross over: at depth 1, gomachine prunes below −75 vs zugzwang's −25 (zugzwang far more
permissive); at depth 6, gomachine prunes below −450 vs zugzwang's −900 (zugzwang far more
permissive again, gap widens). Since the net is identical, gomachine's directly-tuned linear form is
the safer target — replace zugzwang's `-tune.seeQuietCoeff * depth * depth` with
`-75 * depth` (`search.cpp:484`) and drop the depth cap from 8 to 6 to match `SEEQuietMaxDepth`.
SPRT this one alone (shape changes are riskier than pure magnitude swaps).

### D.6 — Split zugzwang's fused qsearch futility into gomachine's two mechanisms (~15 lines)

zugzwang's single check (`futilityBase = standPat+300; if (isCapture) { if (futilityBase+PieceVal[
victim] <= alpha && !see_ge(m,1)) prune; }`, `search.cpp:272,296-303`) conflates gomachine's two
independent, separately-tuned mechanisms: `DeltaPrune` (per-move, adds the *specific victim's* value,
margin 200, no SEE gate) and `QSFutility` (node-level floor, no victim term, margin 100, requires
`!SEEGE(m,1)`). Recommend splitting into both: a delta-prune check at margin ~200 without the SEE
condition, plus a separate node-level floor check at margin ~100 with the SEE≥1 gate — matches
gomachine's validated dual-mechanism structure instead of zugzwang's single blended one. Medium
effort (restructure, not just constants); SPRT independently from D.5.

### D.7 — SPRT gomachine's check-extension mechanism (structural, ~10 lines)

Replace zugzwang's per-move, depth-capped, singular-exclusive check extension (`search.cpp:511-512`)
with gomachine's per-node, uncapped, always-stacking form (`search.go:1244-1250`: `if (pos.InCheck())
depth++` immediately after entering the node, before the TT probe). Low implementation cost, genuine
behavior change (removes the `depth<12` cap and the mutual exclusion with singular extensions) —
needs its own SPRT since the two are not equivalent and gomachine has never isolated this feature's
own Elo (it predates the flag system).

### D.8 — SPRT negative-extension magnitude + ordering (structural, ~10 lines)

Two independent sub-changes to `search.cpp:501-508`: (a) bump magnitudes from `−2/−1` to gomachine's
Stormphrax-derived `−3/−2` (`ttScore≥beta` / `cutNode` cases respectively); (b) let `NegExt`'s soft
multicut (ilerp blend toward beta) take priority over the hard `return singularBeta`, instead of
zugzwang's current hard-multicut-checked-first ordering. Since gomachine's own `NegExt` has never
cleared SPRT (`params.go:447`, still off/untested), treat this as exploratory rather than a
confident port — pair with a disable-SPRT of zugzwang's current `negExt=true` default as a fallback
if the reordered version doesn't help.

---

## Not recommended for porting (gomachine's own evidence is negative or absent)

- **LMR2** (aggressive: reduces captures/promotions, PV/SEE-adjusted) — gomachine SPRT-**rejected**
  at movetime (−64.9 ± 21.6). Correctly absent from zugzwang; do not add.
- **ProbCut** — gomachine reverted it (part of a −77.7 regressed stack, never isolated positive at
  movetime). Zugzwang correctly lacks it; low priority to add.
- **Double/triple singular-extension tiers** — gomachine's own `DoubleExt` found "no positive
  operating point" across two margin sweeps. Do not port.
- **Capture history, ContHist2, CorrHistMinor, CorrHistCont, PCM bonus/malus, LMR alpha/tt-noisy
  terms, deferred/staged move picking, aspiration variance/fail-high-reduce, LMR fixed-point table**
  — all gomachine scaffolding with **no accepted verdict either way**. Not evidence for or against;
  skip until gomachine itself validates them.
