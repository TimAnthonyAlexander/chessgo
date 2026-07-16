# Search-lever movetime sweep — 2026-07-15

Autonomous SPRT campaign over the `docs/tasks/open/` search backlog. Method: each lever
behind a default-OFF env kill-switch (main stays byte-identical), one coalla binary =
base (flag off) + cand (wrapper sets flag on), movetime SPRT `st=0.1` on coalla
(fastchess, pentanomial, elo0=0/elo1=5, α=β=0.05). Concurrency bumped 6→10 (coalla =
12 physical cores, no HT) for ~1.7× throughput.

## Result: no isolated lever produced a shippable movetime win.

| Lever (env flag) | Movetime SPRT | Verdict |
|---|---|---|
| CAPTHISTPRUNE | −11.4 @426 | reject (capture-LMR-enable confound) |
| CAPTHISTMARGIN (margin-only split) | −0.0 @476 | wash |
| RFPDEEP (RFP depth cap 8→13) | +5.5 c6 / −13.6 c10 | wash (straddles 0) |
| SINGRETSCORE (singular multi-cut return score) | +1.3 @785 | wash |
| CORRVARIANTS (minor+continuation corrhist) | **+4.6 @1600 / −4.1 @596** | **wash (2 indep. samples straddle 0)** |
| NMPSF (full SF null-move rewrite + verification) | 0.00 @705 | wash |
| LOWPLYHIST (SF low-ply ordering history) | −3.4 @723 | wash |
| PAWNORDHIST (SF pawn-structure ordering history) | −0.6 @548 | wash |
| TTMOVEHIST (adaptive double-ext margin) | +9.9 @463 / −4.0 @436 | wash (not reproducible) |
| STACK: CORRVARIANTS+TTMOVEHIST | −15.8 @198 | negative (levers don't stack) |
| ROOTDELTALMR (fixed-point LMR rootDelta term) | −190 @15 | **BUG** — over-reduces (see below) |
| ALLNODELMR | no-op alone | needs a working fine-term to bite |
| RAZORQUAD / NEGEXT3 / ASPADAPT / CORRMARGIN / CONTHISTSPLIT | (built, untested) | dormant, low prior |

## Interpretation (NOT "search has no Elo left")
zug is a **co-tuned system** (SF-selectivity campaign + SMP + margins tuned for its own
tree). Isolated SF-technique drop-ins net ~0 because they break that co-tuning — even
"complete" ports (NMPSF was the full mechanism incl. verification search, still 0.00).
The two positive-leaning levers neither reproduced (TTMOVEHIST) nor stacked (CORR+TT −15.8).
At the SPRT cap noise (~±8.8 Elo), a true +3–5 lever is below detection anyway. The
consistent read: **isolated levers are the wrong unit of work here.**

## Pivot: SPSA joint margin re-tune (running)
`spsa/tune.py SPSA_SET=margins` — jointly re-optimizes 6 margins (RfpMargin, RazorMargin,
FutSlope, SeeQuietCoeff, NmpEvalDiv, SingularMargin) from accepted-base via movetime
self-play. This is the systematic play the [[spsa-margin-polish]] task flagged ("margins
never re-tuned for zug's tree; ~+3 trapped"). Launched 2026-07-15 19:07, ~27s/iter, 3000-iter
schedule (resumable via `--resume`, state in `spsa/state.json`, log `~/spsa_zug.log`).
Validate the tuned theta with a confirmation SPRT vs base before baking into defaults.

## Everything committed behind default-OFF flags (dormant, reversible)
All 15 levers are in `src/search.cpp` (+ `position.{h,cpp}` for CORRVARIANTS' minorKey)
gated off — main byte-identical (d14=63075, perft5=4865609). They're combination-retest
candidates: a lever that washes solo can carry Elo stacked or once the net/tree shifts
(a wash-at-SPRT ≠ dead — per the "keep dormant, don't revert" policy).

## Known bug to fix
**ROOTDELTALMR** (`search.cpp`, fixed-point LMR): `r -= delta*608/max(1,rootDelta)`
blows up (−190 Elo) — the node-local `delta` can exceed `rootDelta` at wide-window
internal re-search nodes, making the term a multi-ply over-reduction. Fix: clamp
`delta` to `rootDelta`, or verify rootDelta is the widest window. Then re-SPRT (expect
small, per SF).

## Infra added
`zugzwang/zbuild.sh` (standard coalla build, excludes perft.cpp dual-main), per-lever
`cand_*.sh` wrappers, concurrency-10 SPRT scripts.

---

# Follow-up: fixed-nodes triage + harness control + SPSA (2026-07-15/16 overnight)

**Why FN:** movetime SPRTs conflate "does it improve the tree?" with "is it worth the NPS
cost?" and bury both under noise. Fixed-nodes (every engine searches the same 50k/30k nodes)
isolates pure search QUALITY. Ran an FN sweep (`fn_sweep.sh`, 30k nodes, 600g/lever) over all
levers.

**FN table (Elo at fixed nodes) vs movetime:**
| Lever | FN | Movetime | Read |
|---|---|---|---|
| LOWPLYHIST | **+7.5** | −3.4 | REAL divergence: quality masked by per-move read cost |
| NMPSF | +5.2 | 0.0 | weak divergence (verification-search cost) |
| RAZORQUAD | +3.5 | 0.0 | no per-node cost → FN/MT gap is noise |
| SINGRETSCORE | +2.9 | +1.3 | small+, no divergence |
| CORRVARIANTS | −0.6 | ~0 | ~0 both |
| CAPTHISTPRUNE/MARGIN, CONTHISTSPLIT, TTMOVEHIST | ~ −2 to −4 | ~0 | ~0 both |
| RFPDEEP −5.8, ASPADAPT −6.4, CORRMARGIN −9.3, PAWNORDHIST −12.2, NEGEXT3 −15.1 | **FN-negative** | — | genuinely HURT tree quality — dead ends, drop |

**Harness control (important):** null wrapper (same binary, no flag) vs direct base at
movetime = **−1.7 ±11.4 @1032** → no meaningful wrapper artifact. The systematic MT<FN gap
(3-11 Elo across feature-adding levers) is **real feature NPS-cost**, not a harness bug.

**LOWPLYHIST optimization (the one actionable divergence):** hoisted the ordering read's
gate/plane-pointer/divisor out of the per-move loop, replaced the per-move runtime divide
with compile-time-constant `switch` cases — **behavior-identical** (node counts unchanged),
committed `1920d75`. Movetime re-test: −3.4 → **−0.00 ±12.0 @810**. The optimization recovered
~+4 Elo but it lands at a **wash**. The FN +7.5 was partly noise (true quality ~+4-5) + residual
cost. **Even the cleanest FN divergence does not convert to a shippable movetime win.**

**SPSA margin re-tune** (`SPSA_SET=margins`, 6 margins): theta **orbits the defaults** (RfpMargin
75→77, SingularMargin 32→36 after an early 49 noise-spike; RazorMargin/FutSlope/NmpEvalDiv drift
modestly). iter-500 theta validated vs defaults = **−0.9 ±12.9 @768 → flat.** The margins are
already near-optimal; SPSA finds no edge. (Left running toward higher iters for a final check.)

## Bottom line
Individual + cost-optimized search levers AND a joint margin re-tune are all **tapped for
shippable movetime Elo** on this engine (post SF-selectivity + SMP). Nothing cleared LB>0; nothing
shipped to prod. Real remaining Elo is in the **net/data pipeline** (the August track), consistent
with the engine's own history. Kept: the FN-triage method (`fn_sweep.sh`) and the LOWPLYHIST perf
opt (real, behavior-identical). Deploy-ready wins: **none.**
