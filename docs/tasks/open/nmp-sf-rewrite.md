# Null-move: the FULL SF rewrite (not the gate alone)

**What.** Replace zug's null-move mechanism with SF18's, as a *whole* — not the cutNode gate in
isolation (that already washed).

**Why the gate alone isn't enough.** Zug currently null-moves at ALL non-PV nodes with `eval>=beta`
— more prune-happy than SF, and it can hide zugzwangs. Bolting on just SF's cutNode gate SPRT'd
**−27 reject** (`OPTIMIZATIONS.md:72`, margin bundle 2). That's the classic "washed SF technique =
incomplete port" — SF's gate only works alongside the rest of its NMP structure.

**Where (SF `search.cpp`, spec in `SF_MARGINS.md` §Null-move R):**
- **cutNode-only gate** + relaxed margin: `cutNode && staticEval >= beta - 18*depth + 350`
  (can null-move somewhat *below* beta, unlike zug's strict `eval>=beta`).
- **Depth-only R**: `R = 7 + depth/3` (no `(eval-beta)/nmpEvalDiv` bonus term — zug has that term).
- **Verification search at depth≥16** (`nmpMinPly`, SF `search.cpp:906-919`): re-search to confirm the
  null-move cutoff, guarding against zugzwang-blindness. Zug has no verification at all.

**Zug now.** `search.cpp` NMP block: `R = 3 + depth/4 + min((eval-beta)/nmpEvalDiv, 3)`, gate
`eval>=beta`, plain non-PV, no verification. `nmpCutGate` flag exists (default-off, −27) — do NOT
just flip it; port the whole mechanism behind a new flag.

**Value / risk.** Medium-high value (over-pruning fix + verification safety net), medium risk (touches
the most load-bearing pruning rule). Gate: movetime SPRT + a tactics-suite sanity (verification search
is a correctness net). Consider isolating the three parts to see which carries the Elo.
