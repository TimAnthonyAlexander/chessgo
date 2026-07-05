# Session handoff — NPS + search-efficiency push (2026-07-04→05)

> Written mid-session in case of autocompaction. A fresh instance should be able to
> continue from here. Goal: make gomachine faster (NPS) and stronger (search
> efficiency), inspired by Stormphrax, everything SPRT-gated. User wants ambition +
> breadth ("search is never at a local optimum until you've tried 10× the things"),
> hates verbose replies (be terse), keep the Mac idle (all heavy compute on the
> server boxes coalla/lairner).

## Confirmed WINS (bank these)
1. **screluDot int32 mul — +4.7–4.9% NPS, bit-exact, SHIPPED (default).**
   `internal/nnue/kernels_simd_amd64_v4.go` `screluDotSIMD`: replaced two int64
   `VPMULLQ` with one int32 `VPMULLD` — `c²·w ≤ 65025·32767 = 2.13e9 < 2^31`, so it
   fits int32 exactly (never overflows). Confirmed +4.9% coalla / +4.7% lairner via
   the `bench nps` harness (below). Legacy int64 path kept behind `SetScreluLegacy`
   for A/B. **Follow-ups:** apply to v3/arm64 kernels (they use `MulEvenWiden`/
   `MulWidenLo` — different surgery); Stormphrax's faster `(v·w)·v` madd (`VPMADDWD`)
   needs output weights re-scaled so `v·w` fits int16 (QA·|w|≤32767) — eval change,
   SPRT-gated, not bit-exact with our current int16 weights.
2. **nullr=4 — +32.1 ± 3.7 Elo (fixed-nodes, isolated).** SPSA pushed `NullMoveR`
   2→4 (hit the [1..4] cap → try 5+). Our null-move was under-reducing. **Needs
   movetime confirm, then flip default `NullMoveR` in `params.go`.** NOTE: SPSA's
   *combined* θ (seequiet=144,captsee=32,nullr=4) measured **−32** — the seequiet/
   captsee moves were noise-driven and HURT; only nullr was real. Ship isolated, not
   SPSA's blind combined output.
3. **Coordinated search bundle (conthist + lmrcutnode + lmrdodeeper) — +55.6 ± 5.6
   fixed-nodes, and MOVETIME-VALIDATED +15.9 ± 5.9 @ 100ms (599/600 pairs).** The
   breakthrough: single ports FAILED (conthist ALONE −54.4 fixed-nodes!; lmrcutnode
   alone −7; rfpquad −15) but the COORDINATED SET wins big — aggressive reduction
   (cutnode-LMR) + strong ordering (conthist) + adaptive re-search safety net
   (doDeeper). conthist alone −54 but +55 in the bundle = textbook coordinated-set.
4. **★ THE STACK: conthist+lmrcutnode+lmrdodeeper+nullr=4 = +19.7 ± 5.9 Elo @ movetime
   (600 pairs, coalla).** bundle (+15.9) and nullr (+10.7) STACK. **This is the
   shippable config.** Fixed-nodes numbers (+55/+32) shrink at movetime because
   conthist/reductions cost NPS, but all stay clearly positive. nullr=5 = −12 (4 is
   the optimum). **TO SHIP:** flip defaults in `params.go`: `ContHist=true`,
   `LMRCutnode=true`, `LMRDoDeeper=true`, `NullMoveR=4`. Currently refining at movetime
   whether dropping conthist (it costs NPS) or using LMR2 beats +19.7 before shipping.

## Measured DUDS (don't retry; documented as scaffolding, default-off)
- **TT prefetch (`Prefetch`)**: wash — our 64MB TT fits in EPYC 128MB L3.
- **Column prefetch (`prefetchCols`)**: the "+17.6%" was CONTENTION contamination
  (two bench procs competing); clean harness says −3.7% (per-feature call overhead).
- **Lazy accumulator (`lazy`)**: −2.4% (deferral bookkeeping > terminal-node savings).
- **In-place accumulator (`inPlace`)**: −10% (Pop must re-apply inverse delta ~375ns,
  dwarfs the ~100ns copy it saves; the copy was never the cost).
- **Direct-apply (`directApply`)**: +0.9% noise (cancellation in applyDiff DOES fire).
- **rfpquad**: −15 (Stormphrax quadratic RFP fights our tuned baseline).
- **lmrcutnode alone**: −7 (needs the doDeeper safety net → the bundle).

## KEY LEARNINGS
- **MEASURE, don't predict** (I wrongly predicted column-prefetch a wash, then wrongly
  a win via contaminated measurement). Use the low-variance in-process harness.
- **Contention corrupts NPS A/B.** Never run two bench procs on a box during a timing.
- **Coordinated sets beat single ports** on a locally-tuned baseline. Aggressive
  reduction needs its safety nets (doDeeper/doShallower + conthist).
- **Raw NPS gap to Stormphrax is nearly closed** (prod lairner: us 300k vs native SP
  401k = 1.33×; coalla we're FASTER, 622k vs 457k). The "3× slower" is mostly SEARCH
  EFFICIENCY (nodes/depth), which the bundle attacks. On coalla we ~match SP raw.
- **Fixed-nodes is the right SPRT ruler for search/reduction changes** (reaching
  deeper at equal nodes = stronger). **Movetime is the ship gate** (conthist adds
  per-node cost that must survive time-bounding). §14.4: fixed-nodes only misleads
  for EVAL changes.
- **cmdUCI didn't load the enriched net** (external UCI tools played weak v6) — FIXED
  (`loadEnrichedDefault` in cmdUCI + cmdBenchSPSA).

## Infrastructure built this session
- **`bench nps`** (`cmd/gomachine/bench_nps.go`): low-variance in-process NPS A/B.
  One process, net loaded once, fixed position + fixed DEPTH (deterministic node
  count), timed by `Result.Elapsed`, configs toggled + INTERLEAVED, median of N.
  Node-identity gate (warns on mismatch). Toggles: `SetScreluLegacy`,
  `SetSelectLegacy`, and net flags. This is the trustworthy NPS ruler — use it.
- **`sweep.sh`** (on `~/` of both boxes): sequential pooled SPRT sweep — each arg is a
  `--new` spec, runs K-pooled fixed-nodes SPRT vs baseline, logs Elo to
  `~/sweep_summary.txt`. `K=10 PAIRS=120 NODES=40000` default.
- **New search flags** (all default-OFF, in `params.go` + parsed in
  `internal/bench/config.go` + diff-printer): `LMRCutnode`(+`LMRCutnodeRed`),
  `LMRDoDeeper`, `RFPQuad`(dud), `QSMaxMoves`, `IIRCutnode`, `LMPHist`, `FutHist`.
  Existing relevant flags: `ContHist`, `ContHist2`, `Razor`, `LMR2`. LMR2 path now
  also honors `LMRCutnode` (for the aggressive-LMR + safety-nets extension test).

## Box / toolchain reference
- **coalla** (12-core Zen4, strong): `~/chessgo-prof/gomachine` (synced source, NOT
  git). Build: `GOEXPERIMENT=simd GOAMD64=v4 ~/go/bin/go1.26.4 build -o bin/gomachine
  ./cmd/gomachine`. v12 net at `data/nnue/v12.bin` (symlink). Use `LEAN_NET_PATH=
  data/nnue/v12.bin` for SPSA (loadEnrichedDefault reads it). `~/stormphrax/stormphrax`
  (native AVX2 build; interactive is broken/FRC — only `bench` works, 457k nps).
- **lairner** (4-core Zen4, weak mem = PROD box): `~/chessgo-prof/gomachine` same
  setup. `~/stormphrax-bench/stormphrax-8.0.0-native` (bench = 401k nps).
- **Both**: `data/` is a real dir with `book.bin` + `nnue/net.nnue` (embed) +
  `nnue/v12.bin`. Rebuild ONLY when the box is free (build CPU perturbs running SPRTs).
- Local Mac (arm64): light edits + `go build` compile-checks only. No `go test`
  (spins fans). arm64 SIMD needs go1.27rc1 (not set up).

## IN-FLIGHT at write time (pollers armed, re-invoke on completion)
- **Coalla sweep** (`~/sweep_summary.txt`): 6 items, done 2 (SPSA-θ −32, nullr=4 +32).
  Remaining: nullr=5, qsmaxmoves=2, iircutnode=on, conthist=on. ~40 min.
- **Lairner bundle** (`~/bundle_sprt.out`): +54.9 @ 482/600, ~done.

## NEXT STEPS (the plan)
1. **Lairner (when bundle done):** rebuild, sweep the ABLATION
   (`lmrcutnode=on,lmrdodeeper=on` / `conthist=on,lmrdodeeper=on` /
   `conthist=on,lmrcutnode=on`) + STACK (`conthist=on,lmrcutnode=on,lmrdodeeper=on,
   nullr=4`) + LMR2 extension (`lmr2=on,lmrcutnode=on,lmrdodeeper=on,conthist=on`).
2. **Coalla (when sweep done):** MOVETIME-validate the winners (bundle, nullr=4,
   stack) — `--movetime 100`, the ship gate.
3. Assemble best combined config → **flip defaults in `params.go`** → final aggregate
   **movetime SPRT** (new-defaults vs old-defaults) to bank total Elo → update
   `docs/ENGINE_STRENGTH.md` + `ROADMAP`.
4. Untried breadth still on the list (subagent ranked): full LMR adjustment set (#8,
   improving/check/ttpv/movecount terms), threat-indexed+from-sq history (#10),
   qsmaxmoves variants, alphaRaises/ttMoveNoisy LMR terms, hindsight reduction. Also:
   staged movepicker (NPS, big refactor), screlu madd (needs weight re-scale + SPRT).

## FINAL CONFIG SHIPPED (defaults flipped in params.go, working tree)
Refinement (movetime) proved the full stack is best — nothing beats it:
- stack (conthist+cutnode+doDeeper+nullr=4) = **+19.7** ← shipped
- stack MINUS conthist = +11.9 (conthist earns its NPS cost); no-conthist = −44 fixed
- LMR2 variant = +18.5 (LMRFormula wins); lmrcutred=2 = +11.0 (cutred=1 optimal)

**Flipped in `internal/search/params.go` DefaultParams:** `ContHist=true`,
`LMRCutnode=true`, `LMRDoDeeper=true`, `NullMoveR=4`. Compile + perft green.
**FINAL CONFIRMATION: +23.3 ± 3.7 Elo over 1500 pairs @ movetime (new-defaults vs
old).** Rock solid. NOT committed/deployed — user decides that. To A/B new-vs-old:
`--new "" --old "conthist=off,lmrcutnode=off,lmrdodeeper=off,nullr=2"`.

Rounds 3–4 (extras on the new baseline, ALL rejected at movetime): conthist2 −17.8
(4-ply cost eats it; as replacement +8, worse than conthist), futhist +1.5 (was +19
fixed — didn't hold), qsmaxmoves=2 −34, razor −66, iircutnode inert (IIR default-off),
lmphist neutral. doDeeper-drop = −4.1 ± 5.1 movetime → the fixed-nodes ablation (+9
without) was misleading; at movetime doDeeper earns its keep → KEEP it.
**FINAL CONFIG = the +23.3 stack, unchanged. Search-lever hunt exhausted.**

## Verdict
Session delivered: **screlu +4.7% NPS** (bit-exact kernel, shipped) + a **+19.7 ± 5.9
Elo movetime search stack** (coordinated conthist+cutnode-LMR+doDeeper+nullr, shipped
as defaults). NOT a local optimum — the coordinated-set approach cracked it (single
ports all flat/negative; the *set* wins). Remaining breadth in "NEXT STEPS §4".
