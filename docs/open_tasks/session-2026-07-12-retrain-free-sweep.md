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
| appendAttackerEdges — one geometry pass, both perspectives | byte-exact (`TestEnrichedMoveAwareBitExact`) + Go↔Rust threat crosscheck green; +0.8% arm / flat amd64 | KEEP (clean code, ~0 Elo) | `42d1a87` |

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
| NMPNonPV (gate null-move to non-PV, SF:893) | _running (expect wash)_ | `fa9be89` |

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

## Honest conclusion

Retrain-free **search + eval-application** Elo is largely **exhausted** this session. The
engine is already heavily optimized past the +250 (search stack) / +38.7 (margin re-tune)
era; the cheap wells (grafts, NPS scraps, margin re-tune) are dry or noise-level, and both
input+output eval parities are clean, so there's no hidden bug to reclaim.

**The real remaining lever is the NET (retrain)** — `docs/NNUE/SF_PARITY_ROADMAP.md`:
data pipeline (interleaved multi-source) → richer base (32 king-buckets) → dual net →
threat-PSQT skip → 1024 width. That needs the GPU retrain the user deferred.

## Recommended next (non-retrain, low-cost hygiene)
- **Golden eval-output cross-check test** (from the eval-output audit): dump the Rust
  trainer's `eval_raw_output(fen)×400` for ~20-30 FENs and assert Go `Eval` matches within
  ~5 cp — pins bucket/scale/quant/activations as a composed value (the one thing no current
  test does). Not Elo, but locks the parity that took this session to verify by hand.
- When ready to retrain: start the SF_PARITY Phase-1 data pipeline (the named biggest lever).
