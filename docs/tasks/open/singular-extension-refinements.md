# Singular / extension block refinements vs SF

Small refinements to zug's singular-extension code (`search.cpp:926-956`). Bundle these + the
already-parked triple-extension (`spsa-margin-polish.md`) into one SPSA-able extension pass.

1. **Negative-extension magnitude.** Zug uses `-2/-1`; SF uses `-3/-2` (larger negative extensions,
   SF singular block ~`search.cpp:1174-1180`). Cheap SPRT of the larger magnitudes.
2. **Multi-cut returns the verification score, not the margin.** On the multi-cut branch zug returns
   the fixed `singularBeta` (`search.cpp:949`); SF returns the actual verification score `s` /`value`.
   Flagged in `SF_MARGINS.md` C.7, never revisited — a correctness/effectiveness nuance.
3. **ttMoveHistory → extension margin.** SF keeps a single running `ttMoveHistory` stat
   (`history.h:216`) that feeds the double/triple-extension margin; zug uses flat constants. Add the
   stat + wire it into the (currently fixed `64`) double-ext margin.

**Why.** Double singular extension was the single biggest win of the SF-selectivity campaign (+28) —
these are the untuned residuals around it. Individually **~+2–8**; bundle for one SPSA/SPRT pass.

**Gate.** Movetime SPRT + a tactics suite (extensions are tactically load-bearing). Effort: small.
