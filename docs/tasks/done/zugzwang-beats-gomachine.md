# DONE — zugzwang crosses gomachine (+24.6 Elo, same net)

**When.** Overnight 2026-07-13 → 07-14, coalla, autonomous 100 ms/move self-play
SPRT (candidate vs accepted base; "re-tax" = candidate vs gomachine on the same
net).

**Headline.** zugzwang went from **−93.4 ± 24 Elo** behind gomachine (baseline,
after the incremental accumulator but before the search campaign) to **+24.6 ±
28.1 Elo ahead** — it crossed the old engine and became the primary AI.

Re-tax progression: −93.4 → −7.2 (after CorrHist + SF-margin bundle 1) → **+24.6**
(after PV-guard + gomachine constants + ContHist + doDeeper).

**Accepted (~+120 Elo of search), each SPRT-gated:**
- **Correction history** — +57 ± 15 (bundled a real qsearch TT-eval bugfix).
- **SF-18 margin bundle 1** — +22.8 ± 9.5 (neg-singular-ext, RFP soften/quiet-ttMove
  gate, qsearch futility 130→300).
- **D.0 PV-guard** — +17.6 ± 9.1 (the LMP/futility/SEE-quiet/capture-SEE block was
  missing `!PvNode` and pruned inside its own PV).
- **D.1 gomachine constants** — +22.4 ± 11.5 (transplanted tuned structural search
  constants).
- **ContHist + LMR-doDeeper** — FN +19.6 / MT +8.0 (ships bundled).

All baked into `Tune` defaults (`zugzwang/src/search.cpp`, 2026-07-14).

**Correctly rejected:** HistPrune (wash), NMP cutNode gate (−27), doDeeper alone
(−5.7), SEE-quiet linear (−4.3), check-ext (wash), razor-off/IIR-off, an isolated
6-margin SPSA (+5 wash — base already on gomachine's tuned values). A −150 Elo
uninitialized-`score` bug in doDeeper was caught and fixed by gating on
`wasLMRReduced`.

Full record: `../../../gomachine/engine/docs/{OPTIMIZATIONS,PARITY_GOMACHINE,SF_MARGINS}.md`.
