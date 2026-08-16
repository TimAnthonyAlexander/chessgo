# Re-test the washed search ledger under a sighted eval (`zugzwang_sfnet`)

Research + a ready-to-run retest list. **No experiments were run for this doc** — coalla
was mid-match per the task's own restriction. Everything below is read from source
(`zugzwang/src/search.cpp`'s `Tune` struct and its `getenv` reads) and from the existing
SPRT/FN-SPRT records in `docs/tasks/{done,open}/*.md` and `zugzwang/docs/*.md`. Coalla was
checked **read-only** to confirm the `cand_*.sh` wrapper convention and that
`~/sfwork/zugzwang` is a clean worktree at this branch's HEAD (`91d0e24`) with
`zugzwang_sfnet` already built there.

## 0. The premise, restated precisely — and where it's narrower than it first sounds

`zugzwang_sfnet` swaps in Stockfish 18's own net (`sfnet-rail-comparison.md`: 12/12
bucket-fixed monotonic bases vs our 2/12 — SF's psqt head + fc_0 linear bypass don't rail).
The hypothesis: a pruning/extension rule gated on `eval` was SPRT'd against our own net,
which is a **per-bucket constant on 100% of positions once a side is down N+B+R**
(`eval-rail-collapse.md`). A technique that washed there might not be a bad technique — it
might be a good technique tested against a broken sensor.

**This only applies to techniques whose *verdict* actually depends on eval being an
accurate, varying number.** Reading `eval.cpp`'s existing analysis
(`eval-rail-collapse.md` §4c) sharpens this into two genuinely different failure modes,
and conflating them overstates the candidate pool:

- **(A) Structurally eval-dependent** — the technique is a near-**no-op** when eval can't
  vary: `OPTIMISM` (scales by root score), `EVALHIST`/eval-diff ordering bump (bumps by an
  eval *delta* between plies), `EVALCOMPLEXITY` (uses `|psqt−positional|` as an
  uncertainty proxy — meaningless if there's no second head). On a railed constant these
  literally have nothing to work with.
- **(B) Margin-comparison eval-dependent** — the technique still fires, every time, based
  on comparing *some* eval value to alpha/beta — RFP, razoring, NMP's gate, futility,
  ProbCut's gate, capture futility. A railed eval doesn't make these no-ops; it makes them
  compare against a **systematically wrong constant** in the decisive-position tail, which
  is a *miscalibration* failure, not an information-starvation one. `eval-rail-collapse.md`
  §4c makes exactly this point: "the washed ledger is mostly pruning/ordering, which the
  collapse does not touch" — but then immediately narrows its own "genuinely eval-dependent
  shortlist" to type-A items only (`OPTIMISM`, `EVALHIST`, the rule50+material-scaling
  combo), and reports **`OPTIMISM` already re-tested under a partial eval fix (`SATSOFT`,
  our own net, not SF's) and washing AGAIN** (+1.24±9.71 blind → −1.27±6.25 desaturated,
  4100 games combined, both ≈0).

**That is real prior evidence against the sharpest type-A candidate, from an experiment
already run.** It does not touch type-B. Type-B margins (RFP/razor/NMP/futility/ProbCut)
were never re-tested against *any* less-blind eval — `SATSOFT` only restores gradient
inside our own net's rails, it doesn't change what SF-trained margins were tuned against.
`zugzwang_sfnet` is the first chance to test type-B at all. **This doc's ranking weights
type-B (RFPDEEP, RAZORQUAD, CORRMARGIN, NMPSF/nmpCutGate, CAPFUT, FULLPROBCUT, RFPQUAD,
PCM) above type-A (EVALHIST, and OPTIMISM only for completeness/low-priority), because
type-A's flagship member already has a negative answer from a related instrument.**

## 1. How thin the ledger actually is

`zugzwang/src/search.cpp`'s `Tune` struct carries **~50 default-off or historically-tested
levers**. Reading every one's gate (not just its name), **roughly a dozen read the static
eval (or an eval-derived quantity like the corrhist residual) in their decision logic.**
The rest — `LMRHIST`, `TTCUTBONUS`, `HISTMARGIN`, `THREATORDER`, `TRIPLEEXT`, `TTCAPR`,
`MCLINR`, `CONTHISTSPLIT`/`CONTHISTPLIES`, `CAPTHISTPRUNE`/`CAPTHISTMARGIN`, `LOWPLYHIST`,
`PAWNORDHIST`, `TTMOVEHIST`, `DRAWJITTER`, `CHECKORDER` (SEE-gated, not eval-gated),
`HISTTAPER`, `HISTTTBONUS`, `LMREXT`, `SHUFFLEGUARD`, `CUTOFFGRADE`, `POSTLMRCH`,
`PIECETOHIST`/`PIECETOLMR`, `CONTHISTBASE`, `QSTTQUIET`, `QSMOVECAP`, `NONLMRRED`,
`SINGTTPV`, `NEGEXT3`, `SINGRETSCORE`, `CORRVARIANTS`, the `TTPVFAILLOW`/`TTPVRICH` family,
`NMPTTVETO`, `CONTEMPT`, `TIMEMAN`/`NODEEFFORT`/`TMFALLING` — gate on **history tables,
TT-stored scores/bounds, SEE, move counts, or ply/clock structure, never the static eval
directly.** A sighted eval cannot flip their verdict; a majority of the ledger this task
named (`LMRHIST −17`, `TTCUTBONUS −28`, `HISTMARGIN`, `TRIPLEEXT`, `TTCAPR`, `MCLINR`) falls
in this bucket. **Say this plainly, per the task's own instruction: most of the named
examples are poor candidates.** This whole line of attack is narrower than "re-test the
washed ledger" — it is "re-test the dozen levers whose gate is `eval`."

## 2. The table

Columns: flag; mechanism; eval-dependence type (A/B, see §0) and the exact read site;
prior measured result + regime; file:line. "FN" = fixed-nodes SPRT (isolates search
quality from NPS cost), "MT" = movetime SPRT (100ms, includes NPS cost) — both from
`docs/tasks/done/search-lever-sweep-2026-07-15.md` unless noted.

| Flag | Mechanism | Eval-dependence | Prior result | search.cpp |
|---|---|---|---|---|
| `CORRMARGIN` | discount RFP margin + LMR reduction by `\|correction_raw()\|` (corrhist residual = eval-uncertainty proxy) | **B/A hybrid** — reads `correction_raw()`, an eval-derived quantity, directly at the RFP and LMR sites | **FN −9.3** (genuinely hurt, not noise) | gate 2944, 3519, 3616; def 278 |
| `RFPDEEP` | raise RFP's depth cap 8→13 (more depths where `eval − margin ≥ beta` fires) | **B** — same RFP eval-vs-beta comparison, just live at more depths | FN **−5.8**; MT +5.5(c6)/−13.6(c10) straddles 0 | gate 2946; def 279 |
| `RAZORQUAD` | quadratic razoring curve `eval < alpha − 485 − 281·d²` (SF-scaled) vs zug's linear, depth-capped one | **B** — razoring only fires in *bad* positions, exactly the regime that rails | FN **+3.5**, MT **0.0** (clean wash, no per-node cost so the wash isn't noise-diluted) | gate 3053; def 280 |
| `nmpCutGate` (alone) | NMP gate `cutNode && staticEval ≥ beta − 18·depth + 350` bolted onto zug's existing NMP | **B** | **−27 REJECT** (`OPTIMIZATIONS.md:72`) — blamed on being an *incomplete* port (needs SF's R + verification too), not on eval quality | gate ~3019; def 120 |
| `NMPSF` | the FULL SF null-move rewrite: cutNode gate (above) + depth-only R (`7+depth/3`, no eval term) + `nmpMinPly` verification search | **B** (the gate) | FN **+5.2**, MT **0.0** — a genuine port, still a wash | gate 2974; def 318 |
| `CAPFUT` | capture futility: `eval + base + slope·lmrDepth + PieceVal[victim] + capHist ≤ alpha` prunes a capture before its SEE check | **B** | **Noise, not a win**: +3.8 / +3.07(1020g) / −4.19(580g) — `sf-sp-search-backlog.md:681` | gate 3272-3278; def 328 |
| `fullProbCut` | real capture-loop ProbCut: SEE clears `probCutBeta − eval`, verify w/ qsearch, confirm w/ reduced search | **B** | **untested** — `SINGTTPV, RFPQUAD | not fully screened (deprioritized after the pattern was clear)` implies this sibling was never isolated either; no SPRT number found anywhere in the docs | gate 3074; def 741 |
| `RFPQUAD` | add `rfpQuadCoeff·depth²` on top of RFP's linear margin (SP's quad/linear ratio) | **B** | **not fully screened** — `sf-sp-search-backlog.md:687` explicitly lists it un-isolated | use 2952; def 579 |
| `PCM` | fail-low credit to the parent's quiet move, weighted partly by "how much our OWN static eval undershot" and "how much the PARENT's undershot" (surprise terms) | **B** (surprise terms only; the rest is history) | **−8.25 ± 11.6 REJECT** @811g — blamed on hand-set, un-SPSA'd weights, not eval quality | gate 3864; def 504 |
| `qsChecks` | generate quiet checks at the qsearch entry ply instead of stand-patting on a captures-only eval | **eval-adjacent, not type A/B** — the *stand-pat value itself* is what's being second-guessed on forcing lines, not a margin comparison | PoC only, **never SPRT-gated**; memory note: the earlier finding (missed Bh6 refutations) was diagnosed as a qsearch structural gap, explicitly **"NOT the net"** | gate 2504-2508; def 502 |
| `INCHKEVAL` | propagate a real `staticEval` (from `ss-2`) through check sequences instead of `VALUE_NONE`, so `improving`/`opponentWorsening` survive | **enabling, not gating** — feeds eval into *other* eval-dependent chains (RFP's opponentWorsening term, improving) rather than comparing it itself | **untested** — no SPRT number found in any doc | gate 2871; def 2561-2568 |
| `EVALHIST` (#12) | bump quiet-move ordering by the eval *delta* between this node and its parent | **A** — literally zero signal if eval can't vary between plies | **"DROPPED — saturated"**, MT+FN wash bundled at +1.87/+3.80 (`sf18-selectivity-gap.md:26`); flagged as a same-hypothesis suspect, never re-tested with a real fix (`eval-rail-collapse.md:285`) | def 233 |
| `OPTIMISM` | additive eval tilt scaled by the running root-score average | **A** | **+1.24±9.71 wash (blind) → −1.27±6.25 wash (SATSOFT-desaturated, bundled w/ `SATSOFT`), 4100g combined** — already substantially disconfirmed by a related (not identical) experiment | def 618 |
| `EVALCOMPLEXITY` | shrink eval toward 0 by `\|correction_raw()\|/2600` (our proxy for SF's real `\|psqt−positional\|`) | **A**, but **inapplicable under SFNET** — SF's backend returns the REAL pair, making this proxy redundant by construction (`sf-net-experiment.md` §3.5: "EVALCOMPLEXITY must stay off for that backend") | n/a — do not test | def 550 |
| `RULE50DAMP` | `eval −= eval·rule50/199` | **A**, but **inapplicable under SFNET as a standalone test** — defaults **OFF** under `SFNET_BACKEND` because SF's own `post_process` already applies the identical formula; forcing it on double-damps | SHIPPED +7.45±8.7 on our own net (`search.cpp:522`) | def 535-539 (`#ifdef SFNET_BACKEND`) |
| `SMPVOTE`/`SMPDIV` | Lazy-SMP best-thread voting, weighted by each thread's score | score-dependent, not static-eval-dependent; also **requires `Threads>1`**, which `sprt.sh`'s default invocation never sets (`run_lazy_smp` early-returns at `threads<=1`) | untested at any Elo found | gate 4171/4179 |
| `rfpSoft`, `rfpTtHit`, `rfpOppWorsening`, `singCorrMargin` | shipped **default-ON** eval-margin techniques (softened RFP return, TT-miss RFP coefficient, opponentWorsening term, corr-uncertainty double-ext discount) | **B**, already accepted | shipped, SPRT-positive on our own net | various, all `= true` in `Tune` |
| everything else in §1's list | history/TT/SEE/ply/clock gates | **none** | (varies) | — |

## 3. Ranking, with reasoning

**Tier 1 — eval-dependent (type B), previously negative/rejected on a demonstrably blind
eval, cheap single-flag retest, no harness changes needed:**

1. **`CORRMARGIN`** — the single cleanest match to the hypothesis. It doesn't just compare
   eval to a threshold, it uses corrhist's residual *as an explicit "trust this less"
   signal*, which is close to meaningless when the underlying value it's correcting is a
   per-bucket constant (correcting a constant just measures how wrong the constant is on
   average, not genuine per-position uncertainty). FN **−9.3** is a real, not noise-level,
   negative. Highest information gain: if this flips positive under SF's net, it's strong
   direct evidence the failure was the eval, not the mechanism.
2. **`RFPDEEP`** — same logic as CORRMARGIN but on RFP's depth reach rather than its
   uncertainty discount. FN-negative, MT straddles 0 (genuinely inconsistent, consistent
   with "sometimes helps, sometimes actively wrong" — which is what mis-calibrated margins
   in a constant-eval regime would look like).
3. **`RAZORQUAD`** — the cleanest wash (not a reject) among the eval-margin levers, and
   razoring's whole domain is "this position looks bad" — precisely the down-N+B+R regime
   that rails 100% of the time on our net. A flip to positive here would be the least
   ambiguous result in the whole set, because there's no confound from "was this an
   incomplete port" (unlike `nmpCutGate`) or "were the weights hand-set" (unlike `PCM`).
4. **`nmpCutGate` alone, AND `NMPSF` (full port)** — test both. `nmpCutGate` alone already
   has a stated alternative explanation for its −27 (incomplete port, per
   `nmp-sf-rewrite.md`), so a positive result under SFNET wouldn't cleanly separate "the
   eval was the problem" from "the mechanism needed the rest of SF's NMP". Testing `NMPSF`
   (the complete, fair port that still washed 0.00) is the sharper instrument — it already
   controls for port-completeness, so a flip here is closer to isolating the eval variable.
   Run both; disagreement between them is itself informative.
5. **`CAPFUT`** — noisy but leaning-neutral-to-positive already on our net; capture
   futility gates directly on `eval`, and captures are exactly where a piece-count-crossing
   rail discontinuity (`eval-rail-collapse.md` §1: rails are keyed on the output *bucket*,
   which captures change) would misfire this margin.

**Tier 2 — eval-dependent, untested (no prior verdict to re-open, but a first real answer
under a sighted eval is still the highest-value thing to learn about them):**

6. **`fullProbCut`** — the real capture-loop ProbCut (not the cheap TT-only variant, which
   is already shipped and isn't gated on eval the same way). Never isolated at all. High
   prior expectation from SF/Stormphrax; worth knowing whether a sighted eval is what it
   was missing.
7. **`RFPQUAD`** — same story, never isolated.
8. **`PCM`** — rejected, but with a stated confound (hand-set, un-SPSA'd weights) that's
   independent of eval quality, so a positive flip here is weaker evidence than tier 1's
   (could just mean the weights happened to fit SF's eval scale better by luck). Still
   worth the cheap test since the surprise-magnitude terms are directly eval-derived.
9. **`INCHKEVAL`** — never tested. Doesn't gate anything itself; it's a prerequisite that
   makes `improving`/`opponentWorsening` (which DO feed RFP) accurate across check
   sequences. Test alone first (does it move Elo by itself under SFNET), then consider
   bundling with RFPDEEP/CORRMARGIN if it does.

**Tier 3 — type A, low priority given existing negative evidence, or structurally
excluded:**

10. **`EVALHIST`** — a legitimate type-A candidate never re-tested with a *real* eval fix
    (only listed as a suspect in `eval-rail-collapse.md`), so include it, but rank below
    tier 1/2 because ordering-only effects are historically the noisiest signal in this
    codebase's SPRTs (`sf18-selectivity-gap.md`: threat/eval ordering both saturated at
    movetime AND fixed-nodes even before the rail question was raised).
11. **`OPTIMISM`** — do not bother. Already tested under a related (if not identical)
    sighted-eval proxy and washed twice, 4100 games. A `zugzwang_sfnet` re-run would need
    to reproduce that negative before this doc would trust a positive from a different
    instrument; not a good use of the SPRT budget relative to tier 1/2.
12. **`EVALCOMPLEXITY`, `RULE50DAMP`** — excluded, see §4.

## 4. What cannot be tested this way (as asked)

- **`EVALCOMPLEXITY`** cannot be meaningfully tested under `zugzwang_sfnet` — its entire
  purpose (a `\|psqt−positional\|`-shaped uncertainty proxy, standing in for the split SF's
  net actually has) is superseded by construction once SF's real pair is available. Testing
  it ON there tests a redundant, possibly-conflicting duplicate of information already used
  elsewhere in `post_process`, not the original hypothesis.
- **`RULE50DAMP`** cannot be tested standalone under `zugzwang_sfnet` as "off vs on" the way
  it was on our own net — it already defaults OFF there specifically because SF's
  `post_process` bakes in the identical `v -= v·rule50/199` term; forcing `RULE50DAMP=1`
  (the env override still exists) tests **double-damping**, not the technique. The
  previously-washed **rule50+material-output-scaling** combo (`eval-rail-collapse.md`
  §4c, −7.6±13.4) is a *different*, never-isolated bundle; isolating its material-scaling
  half from rule50 first is a prerequisite before it's retestable at all, independent of
  SFNET.
- **`SMPVOTE`/`SMPDIV`** need `sprt.sh`'s default `-each ... ` line extended with
  `option.Threads=N` (N≥2) on both arms — the default single-thread invocation makes
  `run_lazy_smp` an early-return no-op, so as written these flags are inert under every
  other command in this doc.
- **Anything gated on `NODEEFFORT`/`TMFALLING`/`TIMEMAN`** is real-clock-only by
  construction (`search.cpp`: "movetime/depth/nodes/infinite stay byte-identical") —
  `sprt.sh`'s `st=0.1` movetime harness cannot exercise them at all; they'd need a
  real-clock (`tc=`) SPRT instead, a different harness shape than everything else here.
- **No flag in the ledger is missing from the `zugzwang_sfnet` binary.** `Tune` is one
  struct compiled once; the only `#ifdef SFNET_BACKEND` branch in the whole file is
  `rule50Damp`'s default (line 535-539). Every other env flag reads identically in
  `./zugzwang` and `./zugzwang_sfnet` — confirmed by reading the `#ifdef`/`#else` block
  directly, not inferred.

## 5. Exact commands

Confirmed on coalla (read-only): `~/sfwork/zugzwang` is a worktree at this branch's HEAD
(`91d0e24`, clean except an unrelated `config.json` diff and some untracked scratch
binaries), `zugzwang_sfnet` is built there (Aug 17 00:20), and `book.epd`/`sprt.sh` are
present in that directory — so it's a self-contained SPRT target, no copying needed. The
existing `cand_*.sh` convention (`~/chessgo/zugzwang/cand_histmargin.sh`,
`cand_lmrcluster.sh`, etc.) is a one-line `env VAR=1 exec <binary> "$@"` wrapper; the same
pattern applies here, pointed at `zugzwang_sfnet` instead of `zugzwang`.

Both arms are `zugzwang_sfnet` — base is the plain binary (every candidate flag here
defaults OFF, so "no wrapper" already IS the off arm); cand is a one-line wrapper. Create
each wrapper on coalla (not done by this task — read-only per the restriction), then run
`sprt.sh` with the 4th arg pointed at the `sfwork` worktree:

```sh
# --- tier 1 ---
cat > ~/sfwork/zugzwang/cand_sfnet_corrmargin.sh <<'EOF'
#!/bin/sh
CORRMARGIN=1 exec /home/tim/sfwork/zugzwang/zugzwang_sfnet "$@"
EOF
chmod +x ~/sfwork/zugzwang/cand_sfnet_corrmargin.sh
bash sprt.sh sfnet_corrmargin ~/sfwork/zugzwang/cand_sfnet_corrmargin.sh \
    ~/sfwork/zugzwang/zugzwang_sfnet ~/sfwork/zugzwang

cat > ~/sfwork/zugzwang/cand_sfnet_rfpdeep.sh <<'EOF'
#!/bin/sh
RFPDEEP=1 exec /home/tim/sfwork/zugzwang/zugzwang_sfnet "$@"
EOF
chmod +x ~/sfwork/zugzwang/cand_sfnet_rfpdeep.sh
bash sprt.sh sfnet_rfpdeep ~/sfwork/zugzwang/cand_sfnet_rfpdeep.sh \
    ~/sfwork/zugzwang/zugzwang_sfnet ~/sfwork/zugzwang

cat > ~/sfwork/zugzwang/cand_sfnet_razorquad.sh <<'EOF'
#!/bin/sh
RAZORQUAD=1 exec /home/tim/sfwork/zugzwang/zugzwang_sfnet "$@"
EOF
chmod +x ~/sfwork/zugzwang/cand_sfnet_razorquad.sh
bash sprt.sh sfnet_razorquad ~/sfwork/zugzwang/cand_sfnet_razorquad.sh \
    ~/sfwork/zugzwang/zugzwang_sfnet ~/sfwork/zugzwang

cat > ~/sfwork/zugzwang/cand_sfnet_nmpcutgate.sh <<'EOF'
#!/bin/sh
NMPCUTGATE=1 exec /home/tim/sfwork/zugzwang/zugzwang_sfnet "$@"
EOF
chmod +x ~/sfwork/zugzwang/cand_sfnet_nmpcutgate.sh
bash sprt.sh sfnet_nmpcutgate ~/sfwork/zugzwang/cand_sfnet_nmpcutgate.sh \
    ~/sfwork/zugzwang/zugzwang_sfnet ~/sfwork/zugzwang

cat > ~/sfwork/zugzwang/cand_sfnet_nmpsf.sh <<'EOF'
#!/bin/sh
NMPSF=1 exec /home/tim/sfwork/zugzwang/zugzwang_sfnet "$@"
EOF
chmod +x ~/sfwork/zugzwang/cand_sfnet_nmpsf.sh
bash sprt.sh sfnet_nmpsf ~/sfwork/zugzwang/cand_sfnet_nmpsf.sh \
    ~/sfwork/zugzwang/zugzwang_sfnet ~/sfwork/zugzwang

cat > ~/sfwork/zugzwang/cand_sfnet_capfut.sh <<'EOF'
#!/bin/sh
CAPFUT=1 exec /home/tim/sfwork/zugzwang/zugzwang_sfnet "$@"
EOF
chmod +x ~/sfwork/zugzwang/cand_sfnet_capfut.sh
bash sprt.sh sfnet_capfut ~/sfwork/zugzwang/cand_sfnet_capfut.sh \
    ~/sfwork/zugzwang/zugzwang_sfnet ~/sfwork/zugzwang

# --- tier 2 ---
cat > ~/sfwork/zugzwang/cand_sfnet_fullprobcut.sh <<'EOF'
#!/bin/sh
FULLPROBCUT=1 exec /home/tim/sfwork/zugzwang/zugzwang_sfnet "$@"
EOF
chmod +x ~/sfwork/zugzwang/cand_sfnet_fullprobcut.sh
bash sprt.sh sfnet_fullprobcut ~/sfwork/zugzwang/cand_sfnet_fullprobcut.sh \
    ~/sfwork/zugzwang/zugzwang_sfnet ~/sfwork/zugzwang

cat > ~/sfwork/zugzwang/cand_sfnet_rfpquad.sh <<'EOF'
#!/bin/sh
RFPQUAD=1 exec /home/tim/sfwork/zugzwang/zugzwang_sfnet "$@"
EOF
chmod +x ~/sfwork/zugzwang/cand_sfnet_rfpquad.sh
bash sprt.sh sfnet_rfpquad ~/sfwork/zugzwang/cand_sfnet_rfpquad.sh \
    ~/sfwork/zugzwang/zugzwang_sfnet ~/sfwork/zugzwang

cat > ~/sfwork/zugzwang/cand_sfnet_pcm.sh <<'EOF'
#!/bin/sh
PCM=1 exec /home/tim/sfwork/zugzwang/zugzwang_sfnet "$@"
EOF
chmod +x ~/sfwork/zugzwang/cand_sfnet_pcm.sh
bash sprt.sh sfnet_pcm ~/sfwork/zugzwang/cand_sfnet_pcm.sh \
    ~/sfwork/zugzwang/zugzwang_sfnet ~/sfwork/zugzwang

cat > ~/sfwork/zugzwang/cand_sfnet_inchkeval.sh <<'EOF'
#!/bin/sh
INCHKEVAL=1 exec /home/tim/sfwork/zugzwang/zugzwang_sfnet "$@"
EOF
chmod +x ~/sfwork/zugzwang/cand_sfnet_inchkeval.sh
bash sprt.sh sfnet_inchkeval ~/sfwork/zugzwang/cand_sfnet_inchkeval.sh \
    ~/sfwork/zugzwang/zugzwang_sfnet ~/sfwork/zugzwang

# --- tier 3 (lower priority; same pattern) ---
cat > ~/sfwork/zugzwang/cand_sfnet_evalhist.sh <<'EOF'
#!/bin/sh
EVALHIST=1 exec /home/tim/sfwork/zugzwang/zugzwang_sfnet "$@"
EOF
chmod +x ~/sfwork/zugzwang/cand_sfnet_evalhist.sh
bash sprt.sh sfnet_evalhist ~/sfwork/zugzwang/cand_sfnet_evalhist.sh \
    ~/sfwork/zugzwang/zugzwang_sfnet ~/sfwork/zugzwang

# --- qsChecks: never SPRT-gated before at all; same pattern, tier 2 interest ---
cat > ~/sfwork/zugzwang/cand_sfnet_qschecks.sh <<'EOF'
#!/bin/sh
QSCHECKS=1 exec /home/tim/sfwork/zugzwang/zugzwang_sfnet "$@"
EOF
chmod +x ~/sfwork/zugzwang/cand_sfnet_qschecks.sh
bash sprt.sh sfnet_qschecks ~/sfwork/zugzwang/cand_sfnet_qschecks.sh \
    ~/sfwork/zugzwang/zugzwang_sfnet ~/sfwork/zugzwang
```

Each is a standard movetime-100ms pentanomial SPRT (`elo0=0/elo1=5`, cap 800 rounds/1600
games — `sprt.sh`'s own header) exactly like every other lever in this codebase's history;
nothing about the harness changes for the SF-net backend except which binary is being
wrapped. Run tier 1 first — five runs, none needing more than the wrapper above. If a
result lands on `LB>0`, run the same lever's **fixed-nodes** counterpart too
(`sprt_fn.sh`, referenced throughout the done-docs, `nodes=50000`) to separate genuine
search-quality gain from a movetime NPS-cost artifact, the same FN/MT discipline this
codebase already applies everywhere else (`search-lever-sweep-2026-07-15.md`'s whole
second half exists because of exactly that gap).

## 6. What a result would and would not prove

**A positive result (LB>0) on a tier-1 lever** is evidence that the specific washed
verdict was an artifact of eval blindness, not a flaw in the technique — worth re-opening
that lever as a candidate for our own net **after the August retrain**, not before. It is
**not** evidence the retrained net will produce the same win: the retrained net's eval
distribution, railing behavior, and scale are unknown quantities today (this doc's whole
premise is that our current net rails; a retrained net with a psqt-style second head, per
`eval-rail-collapse.md` §5, is deliberately trying to NOT rail, which changes the very
regime CORRMARGIN/RFPDEEP/RAZORQUAD were tested in). A win under SF's net is a **necessary
plausibility check**, not a **sufficient proof** — the retrain could still land in a
different distribution where the same margin needs different constants (every margin here
was SF-scaled by the `k=0.481` cp conversion — `sf-search-vs-search.md` §1 — which is
itself flagged as unverified for margins vs eval levels, so even a clean SFNET win doesn't
pin down the RIGHT constant for a future retrained net, only the SIGN).

**A negative result (wash or reject)** on a tier-1 lever is real information too: it would
mean the technique is bad on its own terms, independent of which net is behind it —
narrowing, not just failing to grow, the set of "the eval was the problem" candidates. Given
`CORRMARGIN`/`RFPDEEP` are FN-*negative* (not just washed) on our own net, a continued
negative under SF's net would be the stronger of the two possible outcomes to act on: it
retires the "our net's blindness explains this" excuse for those two specific levers
concretely, rather than leaving it as an open question.

**Neither outcome says anything about the ~40 non-eval-dependent levers in §1.** Their
verdicts stand regardless of what `zugzwang_sfnet` shows — a sighted eval cannot make a
history table or a TT-bound comparison behave differently, and re-running them there would
just be spending SPRT budget to confirm a result the mechanism already guarantees.
