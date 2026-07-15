# RFP + razoring: match SF's return/curve

Two pruning-margin shape mismatches vs SF (small, related — one task).

## 1. RFP softened return + gate

**What.** On a reverse-futility fail-high, SF returns the **softened** `(2*beta + eval)/3`, not the
raw eval, and gates the whole rule `depth<14 && !ttPv && (!ttMove || ttCapture)` (SF `search.cpp:876-889`).
Zug (`search.cpp:753-767`) returns a **raw** fail-high value and has neither the softening nor the
`!ttMove||ttCapture` gate.

**Why.** Softening avoids over-crediting a noisy static eval on the cutoff; the ttMove/ttCapture gate
holds RFP back where a stored move suggests the node is tactical. **~+2–6.**

## 2. Razoring curve

**What.** Zug razors on a **linear** margin: `eval + razorMargin*depth <= alpha` (`razorMargin=200`,
`search.cpp:801-806`). SF uses a **quadratic** drop: `eval < alpha - 485 - 281*depth*depth`
(SF `search.cpp:872-874`). Structurally different curve, never reconciled.

**Why.** The quadratic curve razors far more aggressively at high depth and barely at low depth — a
different (and SF-proven) selectivity profile. **small.**

**How.** Port each behind its own env flag, movetime SPRT independently (they're separable). Then a
follow-up SPSA of the new constants. Effort: small.
