# SPSA margin polish

**What.** Re-tune the 8 cp-denominated search margins after the accepted
search-feature stack landed: `RfpMargin`, `RazorMargin`, `FutBase`, `FutSlope`,
`SeeQuietCoeff`, `CaptSeeCoeff`, `NmpEvalDiv`, `SingularMargin`
(`zugzwang/src/search.cpp`, `Tune` struct; UCI `setoption`).

**Why.** These were bulk-transplanted from gomachine's SPSA-tuned values, not
re-tuned for zugzwang's own tree shape. A 350-iter validation washed (base sits
near gomachine's optimum), but the tree has since changed (CorrHist/ContHist/
PV-guard), so a fresh mirror-native SPSA likely finds more. Hand-set constants go
stale as the engine evolves.

**Where.** `zugzwang/spsa/` harness; SPRT the winner at movetime before baking.
