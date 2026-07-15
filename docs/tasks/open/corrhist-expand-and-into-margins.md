# Correction history: add variants + fold into futility/LMR

Two related corrhist gaps vs SF (same subsystem, one task).

## 1. Add the missing corrhist variants

**What.** SF has **5** correction-history types (`history.h:160-166`): pawn, minor, nonpawn (W/B),
pieceTo, continuation (ss-2/ss-4). Zug has **2**: pawn (`corrHist`) + nonpawn W/B (`corrHistNP`,
`search.cpp:218-219`). Add **minor-piece**, **pieceTo**, and **continuation** corrhist.

**Why.** Each refines the corrected static eval on a signal the others miss. The two biggest
components (pawn, nonpawn) are already shipped, so these are past peak diminishing returns —
**low-single-digit each** — but they stack and are cheap.

## 2. Fold |correctionValue| into futility + LMR (the cheaper half)

**What.** SF uses the correction magnitude as an *uncertainty discount* beyond just adjusting eval:
- futility margin: `+ std::abs(correctionValue)/174665` (SF `search.cpp` futility lambda)
- LMR reduction: `- std::abs(correctionValue)/30370`

Zug computes `correction()` (`search.cpp:317-333`) and applies it ONLY to `staticEval`, never feeds
it separately into RFP/futility/LMR. The value is already computed — this is nearly free.

**Why.** "The eval is uncertain here" (large correction) → prune less / reduce less. **~+3–6**, cheap.

**How.** Scale SF's divisors to zug's corrhist magnitudes (zug's `CORR_*` scale differs). Gate: env
flag + movetime SPRT. Do part 2 first (cheaper, higher EV); part 1 is the marginal follow-up.
