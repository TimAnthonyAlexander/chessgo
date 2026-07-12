# Session 2026-07-12 — Retrain-free Elo sweep (honest ledger)

**Goal:** find retrain-free Elo (no net retrain — GPU budget spent) via search/NPS/bug
work on the full-threats net (`chessgo_threats_sf_640`, prod `data/nnue/kb-mirror.bin`
/ coalla `ft_final.bin`). All SPRTs 100 ms/move, 12-way self-play on coalla (AVX-512),
`bench sprt` LLR[0,5]. **Thin yield — mostly negative (but well-characterized) results.**

## The one decisive lesson

**gomachine is a tuned, self-consistent local optimum. Grafting "correct" Stockfish
mechanisms onto it LOSES Elo (non-transitivity), even when the graft is faithful to SF
source.** Every behavioral SF-divergence fix we tried lost. The only reliably-safe
retrofit is **byte-identical / node-identical** change that doesn't perturb the tuned
tree — and even those are NPS-noise-level on amd64. The genuine remaining Elo is in the
**net** (retrain), not search.

## Ledger (candidate → evidence → verdict → commit)

### Banked
| Change | Evidence | Verdict | Commit |
|---|---|---|---|
| **NEON int8 tail-dot kernel** (`dotU8I8SIMD`, arm64-only) — vectorize the int8 L1 matmul; `dotU8I8Scalar` was the last hot scalar NNUE kernel on NEON (51% of the arm profile) | **+80.5% whole-engine NPS** on M3 SIMD (int16-threatFT prod config, ~227.5k→~410.7k medianNPS, node-identical, 3 reps); bit-exact to scalar (maddubs saturation reproduced), amd64 byte-identical (never compiles the file) | **SHIP arm64-default-ON** — the single biggest arm win to date; a pure NPS win (⇒ deeper search per move ⇒ real strength on arm). Found by the 2nd-night bug-hunt (arch-kernels agent). | `096103a` |
| golden eval-output regression lock (38 FENs, all 8 buckets, incremental==scratch) | GREEN; no Go↔Rust eval discrepancy found while building it | KEEP (hygiene — locks composed bucket/scale/quant/activation parity) | `8073def` |
| appendAttackerEdges — one geometry pass, both perspectives | byte-exact (`TestEnrichedMoveAwareBitExact`) + Go↔Rust threat crosscheck green; +0.8% arm / flat amd64 | KEEP (clean code, ~0 Elo) | `42d1a87` |
| **NMPNonPV — gate null-move pruning to non-PV nodes** (SF search.cpp:893) | **+5.3 ± 4.7 movetime SPRT, 3388 pairs** (CI +0.6..+10.0, LLR +2.50, stable across 877→3388 pairs, never negative). **Abitur external confirm (1s, 2T):** head-to-head nmp-on vs nmp-off **+8 ± 36** (direction agrees with SPRT, NOT a non-transitivity loss); anchors healthy — gomachine beats SF-capped-3190 **63.7%** and loses SF-full **25% (−170)** (in line with the known ~150-200 Elo gap). | **SHIP (default-on)** — the one SF-divergence fix that FITS: NMP was wrongly firing at PV nodes, pruning would-be principal variations. A genuine defect, not a graft. | `9ea2589` |

### Rejected — SF behavioral grafts (all lose to the tuned optimum)
| Candidate | Movetime SPRT | Note |
|---|---|---|
| DeferredQuiets (staged move-picker, fixed to order quiets + drop alloc) | **−43.7** | fixed a genuinely-broken port (quiets were unordered); still lost — over-pruning on the reordered list. `d814832` (flag default-off, inert) |
| QSearchTT (quiescence TT probe+store, SF-faithful, fail-soft) | **−12.9** direct / **−39** bucketed | impl verified SF-faithful; TT-pollution hypothesis DISPROVED (bucketed TT didn't rescue it) — genuinely bad for us. `67d9dcc` |
| TTRefinesEval (eval = ttScore when bound-consistent, SF search.cpp:730) | **−33.7** | `323d772` |
| ttcluster (depth-preferred bucketed TT, shift 0→2) | **−0.6** wash | `TTBucketShift` scaffold; not a default win |
| LMRResearchFix (carry doDeeper/doShallower depth into PV re-search, SF:1253) | **+2.6 ± 19** | a REAL always-on port slip, but immaterial at 100 ms. `eeeab5f` (flag off) |
| QSCaptSEEMargin=80 (qsearch keep captures losing ≤80cp, SF:1665) | **−1.0** wash | `4184b60` |
| TTCutoffNonPV (gate TT cutoff to non-PV, SF:760) | **−2.9** wash | `17d2e5d` |
| _(NMPNonPV moved to Banked — it WON, +5.3)_ | — | `fa9be89`→`9ea2589` |

### Reverted
| Change | Evidence | Commit / revert |
|---|---|---|
| computeDelta reuses search's child board (drop redundant per-eval DoMove) | node-identical (5-FEN node counts identical) BUT flat/−2% amd64 NPS — the arm +1.5% did NOT transfer ([[arm64-vs-amd64-speed-divergence]]). A node-identical change that's slower on prod is a movetime regression. | `25045cf` → reverted `9c5b7bd` |

### Ruled out clean (valuable negatives, verified against Rust trainer *source*)
- **Threat-INPUT parity:** 1500 positions Go == Rust byte-exact (`crosscheck_dump` incl.
  adversarial same-type/mirror cases). The `threats_sf.go:175` dedup suspect is REFUTED.
- **Eval-OUTPUT parity:** output bucket `(occ-2)/4`, eval_scale 400, quant scales
  (QA=255, QACT=127, QW=64), activation order, weight layout/transpose, biases — **all
  match** the bullet trainer that fit the weights (cross-referenced against bullet source,
  not comments). No systematic eval bias.
- ⇒ **The cold-Stockfish "regression" is genuine non-transitivity, NOT a bug.** The
  full-threats net is fed and read exactly as trained.

### SPSA margin re-tune (the last systematic shot)
- 7 least-recently-tuned active params (LMR base/div/histdiv, RFP, hist bonus scale/max,
  MaxHistory), 200 iters × 32 pairs, 40k nodes. **θ never left ±5% of defaults** all run.
- Final-θ movetime SPRT: **−3.4 ± 9.2 (wash/slight-neg)**. ⇒ margins near-optimal on this
  net (the +38.7 re-tune earlier this project already banked the reclaimable margin Elo;
  the well doesn't refill in one net generation).

## Night 2 (2026-07-12) — four grounded bug-hunt agents (SF18 `~/sf18-arm/src` + Stormphrax `~/Stormphrax/src` local)

Method discipline the user set: a single SF technique that washes in isolation is **"not yet," not "dead"** —
SF does it for a reason; our margins are often just stale/un-tuned for it. Evaluation LADDER for any
SF-grounded candidate: flag → naive SPRT → **SPSA the interacting margins** → **test in combination** →
**Abitur** (external, time-odds ladder) as arbiter. Don't cite a naive-isolation number as a verdict.

| Angle | Result |
|---|---|
| **Arch kernels** | ★ **NEON int8 tail-dot → +80% arm NPS, SHIPPED** (`096103a`, see Banked). Rest of the accumulator well confirmed dry (amd64). |
| **Eval golden test** | ★ **Shipped** (`8073def`). No Go↔Rust discrepancy — output parity locked. |
| **Move ordering** | **CLEAN** — no defect in the active path (`search.go:2252–2785`); tiers/history-signs/gravity/cutoff-sites match SF18 + Stormphrax. One ladder candidate: **parent-move continuation-history credit** — BOTH SF (`search.cpp:775/1438/1862`) and Stormphrax (`1398–1424`) have it, we don't. Additive, not a bug; put it on the ladder (flag → SPSA conthist weights → combine w/ ContHist2 → Abitur), don't dismiss on the naive number. |
| **Time management** | **Structural finding:** a full Stormphrax-grade adaptive time manager (`internal/search/timemanager.go`) exists but is **DEAD in live play** — the hub hands the engine a fixed rating-derived movetime (`hub/bot.go:179` `moveTimeCap=0` → `configForRating().MoveTime`) with `Limits.TimeLeft==0`, so the manager (which needs `TimeLeft>0`) never runs. Set only by the unused UCI adapter (`uci.go:209`). **Every gate is blind to it** (SPRT/vs-SF/Abitur all drive `go movetime`/`go nodes` ⇒ `soft==hard`). Two real bugs fall out: (1) search budget is never bounded by the remaining clock → a strong bot (~1.18s budget) can **flag in a bullet endgame** (SF caps `min(totalTime, maximum())`); (2) no single-legal-move short-circuit (`search.go:813`). Big live-play lever (plausibly double-digit Elo at real TC) but needs a **real-clock (`wtime/btime`) gauntlet** to measure — invisible to movetime SPRT. |

**Open, ranked (Night 2):**
1. **Time-management: wire the clock into a clocked hub entry point** so the existing manager runs, + fix the flag-risk bound + single-legal-move short-circuit. Needs a real-TC Abitur to measure. Highest live-play ceiling.
2. **Parent-move conthist** on the ladder (flag → SPSA → combine → Abitur).

## Honest conclusion

**One genuine ship: NMPNonPV (+5.3 Elo)** — we were running null-move pruning at PV nodes,
pruning would-be principal variations (SF forbids this). A real defect, and the one
SF-divergence fix that *fit* our engine rather than fighting its tuning. That's the concrete
win + a real bug diagnosis.

Beyond that, retrain-free **search + eval-application** Elo is largely **exhausted** this
session. The engine is already heavily optimized past the +250 (search stack) / +38.7
(margin re-tune) era; the remaining wells (behavioral grafts, NPS scraps, margin re-tune)
are dry, lose to the tuned optimum, or are noise-level, and both input+output eval parities
are clean, so there's no hidden eval bug to reclaim. The value here is mostly the
**well-characterized negatives** (a whole class of speculative work ruled out) + the one +5.

**The real remaining lever is the NET (retrain)** — `docs/NNUE/SF_PARITY_ROADMAP.md`:
data pipeline (interleaved multi-source) → richer base (32 king-buckets) → dual net →
threat-PSQT skip → 1024 width. That needs the GPU retrain the user deferred.

## Recommended next (non-retrain, low-cost hygiene)
- **Golden eval-output cross-check test** (from the eval-output audit): dump the Rust
  trainer's `eval_raw_output(fen)×400` for ~20-30 FENs and assert Go `Eval` matches within
  ~5 cp — pins bucket/scale/quant/activations as a composed value (the one thing no current
  test does). Not Elo, but locks the parity that took this session to verify by hand.
- When ready to retrain: start the SF_PARITY Phase-1 data pipeline (the named biggest lever).
