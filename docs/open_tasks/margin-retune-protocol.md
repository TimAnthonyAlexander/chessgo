# Stale-flag / margin re-tune — session protocol (started 2026-07-08)

> **Living document.** Chronological record of the audit → scaffold → SPSA/SPRT
> re-tune initiative kicked off 2026-07-08. Append results at the bottom as each
> phase gate lands. Branch: `feat/margin-retune-scaffolds` (off `b80da65`).
> Related: `spsa-margins.md`, `data-retrain-640sb.md`, `../ENGINE_STRENGTH.md` §27.5.

## 0. Why this exists (the trigger)

A frontend-vs-bench discrepancy investigation found the admin Engine-vs-Engine view
drives Stockfish via `server.handleStockfishMove` — a **fresh SF process per move**
(cold 16 MB hash, no move history) — whereas the honest `bench vs-stockfish` runs one
**persistent, warm-hash, full-history** SF per game. Controlled measurement isolated it:

| SF mode | coalla, SIMD v4, KB net, `b80da65`, 100/100, full-strength SF, 60 games | Score | ≈ Elo |
|---|---|---|---|
| **Warm** (honest bench) | W0 D15 L45 | **12.5%** | −335 |
| **Cold** (frontend path, new `--sf-cold`) | W4 D35 L21 | **35.8%** | −102 |

**⇒ the cold-per-move spawn is worth ≈235 Elo of SF handicap.** The frontend "gomachine
beats full-force SF at blitz" observation was a cold-SF artifact; the warm bench is the
honest number. Retracted the §27 "~2× time-odds / equal-TC parity" tell (ENGINE_STRENGTH
§27.5 + CLAUDE.md). Does NOT touch the v6 CCRL floor. **Re-anchor remains the only honest
path to a strength number.**

## 1. The staleness thesis

Every search flag's on/off verdict (and every hand-set margin) was SPRT-decided at *one*
past point — many against the **pre-NNUE PeSTO/HCE eval** (June 2026), before NNUE, the
mirror-KB net, and the 07 search stack. The engine grew past its own constants: a plain
re-tune of stale margins already shipped **+38.7 Elo** (`nullr 4→3`, `seequietmargin
150→103`, …). Staleness is **per-flag, dated** — trust decays from each flag's own last
SPRT. Priority = oldest-tested first; the June default-ON core (validated on an engine that
no longer exists) is the stalest cohort.

## 2. The audits (5 features, adversarial, vs SF18 + Stormphrax source on disk)

SF18 = fresh clone in scratchpad; Stormphrax = `~/stormphrax`. **Result: ZERO logic bugs.**
All five are correctly implemented; the exposure is staleness + one tooling gap + un-ported
refinements.

| Feature | Bug? | Stale knob | Instrumented? | Un-ported refinement (ref has, we don't) |
|---|---|---|---|---|
| RFP | none | `RFPMargin=75` | ✅ Param | quadratic margin (`RFPQuad`, coded+correct, off); soft fail-firm (`RFPSoft`) |
| Aspiration | none | `AspInitDelta=25` | ✅ Param | variance-scaled init window; fail-high depth reduction |
| DeltaPrune | none | `deltaMargin=200` | ❌ was a const → **promoted (Phase 0)** | `givesCheck`/recapture exemptions; net-scaled piece values |
| LMP | none | table is scale-free (robust) | — | non-pawn-material gate (negligible) |
| Improving | none | gate *value* noisier under NNUE | — | ply-4 fallback; default-true-when-unknown; `\|= eval≥beta` |
| TunedEval | none | — | **inert** under default-on NNUE (dead ~16KB) | — |

**Scale premise check:** NNUE output is cp (`CpScale=400`); "~2× hotter" is a *distribution*
claim not proven by units. Data point: net evals startpos ~+0.7–0.8 pawn vs classical ~+0.25
→ cp-hot, mildly supporting "widen eval-scaled margins" — but not uniformly (SPSA drifts SEE
margins *down*). **Direction stays empirical; SPSA/SPRT arbitrate per-margin.**

## 3. Phase 0 — scaffolds (DONE, all default-off / byte-identical)

Commits on `feat/margin-retune-scaffolds`:
- `21f9e74` — `--sf-cold` gauntlet flag + §27 retraction (docs)
- `d821858` — Phase-0 search scaffolds
- `e64b51e` — widen `TestSearchStartposSane` band ±100→±250 (brittle test; embedded-net startpos is legitimately ~+0.8 pawn; search pkg now green)

Phase-0 changes (all in `d821858`):

| Change | Default | SPSA field |
|---|---|---|
| `DeltaMargin` (const→Param) | 200 (byte-identical) | `deltamargin`/`dm` |
| `ImprovingRich` (ply-4 fallback + default-true + ≥β) | off | — |
| `DeltaExemptChecks` (recapture exemption **wired**; gives-check **TODO** — no cheap pre-move primitive) | off | — |
| `AspVariance` + `AspBaseDelta` + `AspVarScale` | off / 7 / 65 | `aspbasedelta`, `aspvarscale` |
| `AspFailHighReduce` (fail-high depth reduction, cap 3, floor 1) | off | — |

Verified each: `go build`, `go test` (non-race), perft(6)=119060324.

## 4. The SPSA run (Phase 1, step 1 — RUNNING)

coalla pid 693945, `bench spsa --params
singularmargin:1:4,singularmindepth:5:9,seequietmargin:60:250,seequietmaxdepth:4:8,captseemargin:10:60,captseemaxdepth:4:8,nullmover:3:6
--iterations 1200 --pairs 16 --nodes 25000 --concurrency 12`. Tunes against the **mirror-KB
prod net** (`nnue.DefaultEnriched()`). Checkpoint `/tmp/spsa_margins.log`, log
`/tmp/spsa_run.out`.

Live direction @ k≈194/1200 (converging, `a`/`c` decaying):

```
singularmargin   2 → 1     singularmindepth 6 → 5    (fire singular MORE)
seequietmargin 103 → 88     captseemargin  25 → 21    (SEE-prune MORE)
seequietmaxdepth 6 → 7                                (apply deeper)
captseemaxdepth  4 → 4     nullmover       3 → 3      (steady)
```

**Read:** defaults are too *conservative* for today's engine — wants more aggressive SEE
pruning + more singular. Same "grew past its constants" class as the +38.7 win. **Caveat:
fixed-nodes objective; converged θ MUST clear a movetime SPRT (lower bound stably >0) before
shipping** — fixed-nodes can reward "prune more" in ways movetime discounts.

## 5. The plan (phase gates)

- **Phase 0** — scaffolds. ✅ DONE.
- **Phase 1** — SPSA chain on coalla (sequential; fixed-nodes = compute-bound, parallel saves
  no wall-time): (1) 7 margins [running] → (2) LMR/history (`lmrbase`/`lmrdiv`/`lmrhistdiv`/
  `histbonus*`/`rfpmargin`) → (3) eval-scaled margins (`RFPMargin`+`AspInitDelta`+`DeltaMargin`,
  both directions). Each converged θ → movetime validation SPRT → ship+commit if lb stably >0.
- **Phase 2** — movetime on/off re-SPRTs of the June core (`RFP`/`Aspiration`/`DeltaPrune`/
  `LMP`/`Improving` =off vs default) in coalla gaps; confirm each still earns its keep on NNUE.
- **Phase 3** — if a re-SPRT shows a feature underperforming, SPRT the matching scaffolded
  refinement (`ImprovingRich`, `AspVariance`, `RFPQuad`, …) on-vs-off.

**Decision policy (autonomous):** auto-flip a default only when the established rule fires
(movetime SPRT accepts H1, lb stably >0); commit each shipped change. Consequential/novel
moves (dropping a load-bearing default-on feature; anything prod-facing) → stage + flag, do
not flip silently.

## 6. Open items

- **Widened-floor margin refinement pending.** In the killed margin SPSA, `nullmover` (floor 3) and
  `captseemaxdepth` (floor 4) sat pinned at the *bottom* of their ranges — the optimum is likely
  below. A follow-up run with `nullmover:2:5`, `captseemaxdepth:2:8` should recover that.
- **The +15±31 margin adoption is deploy-gated.** Before deploying this branch, run a clean
  full-stack **tt=64 movetime validation** of the new DefaultParams vs the last-deployed prod
  defaults (lower bound stably >0). The self-play SPRTs here are the coarse gate, not the deploy gate.
- `DeltaExemptChecks` gives-check exemption is a TODO (needs a cheap pre-move gives-check
  primitive gomachine lacks; recapture exemption is wired, so the flag currently tests that).
- CLAUDE.md still frames the Texel-tuned eval as live strength ("+101 @ movetime") — it's
  **inert** under default-on NNUE. Doc-clarity fix owed.
- `TestSearchStartposSane` runs on the embedded net, not the prod KB net (never calls
  `loadEnrichedDefault`). Widened band is a stopgap; a truer test would install the KB net.
- **Re-anchor pending** — the only honest route to a current strength number (target now
  ~3700+ ranked NNUE opponent, ~50% score). Every SPSA/SPRT gain here is measured in self-play
  Elo until then.

## 7. Chronological log (append results here)

- **2026-07-08 — SF-cold discovery + §27 retraction.** Root-caused the frontend-vs-bench gap
  to cold-per-move SF (~235 Elo). Added `--sf-cold`; retracted §27. Commit `21f9e74`.
- **2026-07-08 — 5 adversarial audits.** No logic bugs; RFP/Aspiration/DeltaPrune/LMP/Improving
  correct vs SF18/Stormphrax; TunedEval inert; `deltaMargin` found un-instrumented.
- **2026-07-08 — Phase 0 scaffolds.** `DeltaMargin` promoted; 4 refinement flags added
  (default-off). Commit `d821858`.
- **2026-07-08 — startpos anomaly.** Benign brittle test (embedded net; startpos ~+0.8 pawn is
  genuine). Widened band. Commit `e64b51e`.
- **2026-07-08 — margin SPSA launched** (coalla pid 693945). Direction @ k≈194: more aggressive
  SEE prune + more singular.
- **2026-07-08 — killed margin SPSA at k≈360** (not converged; low-value/flat run, and see the tt
  finding below). Ran a quick **tt=64 movetime SPRT** of the k≈353 snapshot
  (`singulardepth=5,seequietmargin=75,captseemargin=23`) vs the old defaults: **+15 ± 31 Elo**, LLR
  climbing, positive-leaning (not a formal cross; draw-heavy flat surface).
- **2026-07-08 — ADOPTED the snapshot as the new base** (commit `53112b2`): DefaultParams
  `singulardepth 6→5`, `seequietmargin 103→75`, `captseemargin 25→23`. Prod *candidate*, not live —
  deploy-gated on a clean full-stack tt=64 validation. Const `singularMinDepth` synced.
- **2026-07-08 — TT-mismatch finding + fix** (commit `5afeb82`): `bench spsa`/`sprt`/`calibrate`/
  `blunders` all defaulted **tt=16**; `b80da65` fixed only the vs-stockfish gauntlet to 64. So ALL
  self-play tuning (incl. the shipped +38.7) was measured at 16MB against a **64MB prod**. Bumped all
  four to 64. coalla synced to branch + rebuilt SIMD v4 (tt=64 default confirmed).
- **2026-07-08 — quick SPRT final: +8.6 ± 16.0 over 300 pairs** (inconclusive by SPRT[0,5] — CI spans
  0 — but a stable small-positive that never went negative; LLR climbed monotonically). **Banked** the
  margin adoption on this coarse read (user call); the binding gate stays the deploy-time full-stack
  tt=64 validation.
- **2026-07-08 — LMR/history SPSA launched** (option A, the untapped lever; coalla pid 704381, tt=64,
  from the new base): `lmrbasex10k:5000:11000, lmrdivx10k:18000:32000, lmrhistdiv:1024:8192,
  rfpmargin:40:150, histbonusscale:8:80, histbonusmax:512:3072`. ~19s/iter → ~6.3h. Log
  `/tmp/spsa_lmrhist.out`.
- **2026-07-08 — round-2 audits (LMR formula, history mechanics, SEE)**, run in parallel with the
  LMR/history SPSA. Again ZERO logic bugs (**8 audits total, 0 bugs**). Leverage found, ranked:
  1. **★ LMR reduction table is INTEGER plies (0..7); refs use ×1024 fixed-point.** So `lmrbase`/
     `lmrdiv` are quantization-crippled — nearly INERT to SPSA (a +0.01 base step flips ~26/3969
     cells). The running run validly tunes only `rfpmargin`/`lmrhistdiv`/`histbonus*`; the 2
     LMR-table params are noise. Fix = ×1024 fixed-point (`LMRFixedPoint`), then a real lmrbase SPSA.
  2. **History bonus & malus share one knob** (malus = −bonus) → SPSA can't reach the asymmetric
     optimum both refs use. Fix = decouple `HistMalus{Scale,Max}` (default = bonus → byte-identical).
  3. **Default LMR lacks PV-relief + improving** (both refs apply always; `LMRImproving` is built but
     default-off) — free standard terms.
  4. **SEE omits pin handling** (mild mis-sign in pinned positions); no x-ray/pin/EP test coverage.
- **2026-07-08 — round-2 scaffolds DONE** (wait-window, all default-off/byte-identical, verified
  build+test+perft): `LMRFixedPoint` (×1024 table, commit `ecb4c92`); decoupled malus
  `HistMalusScale`/`HistMalusMax` + `LMRPvRelief` (commit `ae2217c`). Every audit finding now has
  ready SPRT/SPSA ammo.

## Ready coalla queue (after the LMR/history SPSA converges — the box is the serialized resource)

1. **Validate LMR/history θ** — tt=64 movetime SPRT of converged θ vs new base; ship `rfpmargin`/
   `lmrhistdiv`/`histbonus*` if lb stably >0 (expect weak/no signal on `lmrbase`/`lmrdiv` — quantized).
2. **`LMRFixedPoint=on` SPRT** vs off (expect ~neutral, it's byte-ish at default base/div) → if
   non-negative, ship → then a **dedicated `lmrbasex10k`/`lmrdivx10k` SPSA on the smooth table** (the
   real lmrbase payoff the integer table blocked).
3. **Decoupled-malus SPSA**: `histmalusscale:8:80,histmalusmax:512:3072` (asymmetric optimum) → validate.
4. **Free-LMR-terms SPRTs**: `LMRPvRelief=on`, `LMRImproving=on` (both refs apply always).
5. **Phase 2 on/off re-SPRTs**: `RFP`/`Aspiration`/`DeltaPrune`/`LMP`/`Improving` =off vs default.
6. **Phase 3 scaffolds**: `RFPQuad`/`RFPSoft`, `AspVariance`, `ImprovingRich`, `DeltaExemptChecks`,
   `DeltaMargin` SPSA, widened-floor margin SPSA (`nullmover:2:5`,`captseemaxdepth:2:8`).

- **2026-07-08 — LMR/history SPSA (integer table): dry.** Killed at k365; its one mover
  (`rfpmargin 75→58`) feel-SPRT'd **−0.6 ± 16.3** at movetime — a fixed-nodes "prune more" artifact.
  `lmrbase`/`lmrdiv` jittered (quantization), `histbonus`/`lmrhistdiv` flat. Nothing shipped.
- **2026-07-08 — harness fixes:** `tt=16→64` everywhere (`5afeb82`); wired round-2 flags into
  `ParseParams` so `--base "lmrfixedpoint=on"` / `--new "lmrpvrelief=on"` parse (`2820ca0`).
- **2026-07-08 — fixed-point LMR SPSA: LMR base/div CLOSED.** Ran `--base lmrfixedpoint=on` on
  `lmrbasex10k`/`lmrdivx10k` (the smooth ×1024 table that finally gives them a gradient). θ jittered
  around defaults — an apparent drift at k200 (`lmrdiv↑/lmrbase↓`) **reversed** by k224. Feel-SPRT of
  the θ washed **−0.0 ± 16.0** (perfectly symmetric pentanomial). Verdict: **integer quantization was
  strength-neutral AND hid no gain** — the fixed-point unblock confirmed there was nothing to grab.
  (`LMRFixedPoint` scaffold stays default-off; no reason to ship it.)
- **2026-07-08 — decoupled-malus SPSA launched** (pid 745246, tt=64): `histmalusscale:8:80,
  histmalusmax:512:3072`, init 32/1536 (= bonus, byte-identical). The one search sub-lever with real
  headroom — both SF and Stormphrax sit at a steeper asymmetric malus we've never reached.
- **Standing verdict:** search tuning is largely exhausted on this engine — small margin win banked
  (+8.6, unvalidated-but-adopted), LMR/history + LMR-fixed-point both dry. If the malus lever also
  washes, the honest highest-EV move is the **data retrain** (`data-retrain-640sb.md`), not more
  search-constant squeezing.
- _(next: decoupled-malus convergence → feel-SPRT; else → Phase-2 on/off re-SPRTs / data retrain …)_
