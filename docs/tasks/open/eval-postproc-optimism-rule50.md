# Eval post-processing: optimism + rule50-damping (narrow angle)

**What.** SF post-processes its raw net output before returning (SF `evaluate.cpp:43-84`):
- **optimism**: `optimism[us] = 142*avg/(|avg|+91)` from the root-move average score
  (`search.cpp:360-362`), blended into the eval.
- **rule50 damping**: `v -= v * rule50_count() / 199`.
- complexity blend + material blend (need a psqt/positional split zug's single-scalar net lacks).

Zug's NNUE path (`nnue_eval.cpp`, `eval.cpp:331-337`) is a direct single-scalar forward pass — no
optimism, no rule50 damping, no complexity/material blend (zero hits for `optimism` in zug source).

**⚠️ Status — partly WASHED, narrow angle only.** The rule50 + material-output-scaling COMBO was
SPRT'd **−7.6 ± 13.4 reject** (`smp-search-wave-2026-07-15.md`) — SF's constants don't transfer to
our net's scale even rescaled. So do NOT re-run the combo. What remains **untested**:
- **rule50-damping ALONE** (the combo's failure may have been the material-scaling half).
- **optimism ALONE** (from root-avg score — never isolated).

**Why.** rule50-damping in particular is a cheap, orthogonal draw-awareness term (a winning eval
should decay as the 50-move counter climbs) that a net trained on WDL may under-capture. **low
priority** given the combo's −7.6, but the isolated pieces are genuinely untried.

**How.** Isolate rule50-damping first (one term, one env flag), retune the `/199` divisor to zug's
CpScale, movetime SPRT. Skip the complexity/material blend (needs a net-arch change to expose a
psqt-like sub-output). Note: this touches eval, but it's a search-side post-process, no retrain.
