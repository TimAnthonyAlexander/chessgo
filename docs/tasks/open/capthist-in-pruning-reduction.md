# Capture history in pruning + reduction (build-on)

**What.** Feed the shipped `captHist` table (`docs/tasks/done/capture-history.md`) into the
capture-SEE pruning margin and the LMR statScore, not just move ordering.

**Where.** SF uses `captHist` in three places; zug wired only the ordering read:
- Capture-SEE pruning margin — SF `search.cpp:1077`: `int margin = std::max(166*depth + captHist/29, 0);`
  Zug's capture-SEE prune (`captSeeCoeff`, `search.cpp`) is a flat `coeff*depth`, no history term.
- LMR statScore — SF `search.cpp:1216`: `868*PieceValue[captured]/128 + captHist[...]`. Zug's LMR
  `hist` term is quiets-only (butterfly+conthist); captures reaching LMR get no capthist signal.
- (Ordering — already shipped.)

**Why.** Learned capture quality should sharpen *pruning/reduction* decisions the same way it
sharpened ordering. Cheapest fresh lever — build-on a table already maintained. **~+3–8.**

**How.** Scale SF's constants (166, /29, 868/128) to zug's `PieceVal`/history magnitudes (zug's are
~14× smaller than SF's PieceValue; the capthist gravity is ±16k int16 house-style). Gate behind an
env flag, movetime SPRT on coalla. The table + `piece_dense`/victim plumbing already exist, so this
is small code. Reference impls: SF (`~/sf18-arm`), Stormphrax, Reckless — all use captHist in
pruning/reduction; cross-ref for the exact wiring.

**Priority.** Highest of the SF-search-gaps — do first (no prerequisites; builds on the shipped table).
