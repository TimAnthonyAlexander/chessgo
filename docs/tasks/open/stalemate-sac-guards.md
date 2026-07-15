# Stalemate-sacrifice guards (capture-SEE + qsearch)

**What.** Two SF stalemate-avoidance guards zug lacks. Correctness edge cases with a small Elo tail.

1. **Capture-SEE prune stalemate guard.** SF's capture-SEE pruning skips the prune when the capture
   is the side's last non-pawn material: `non_pawn_material(us) != PieceValue[movedPiece]`
   (SF `search.cpp:1077`). Zug's capture-SEE prune has no such guard — it can prune a capture that
   walks into a stalemate-saving line.
2. **Qsearch stalemate-avoidance.** SF's qsearch checks for "captured the last piece → could be
   stalemate" and avoids scoring it as a win (SF `search.cpp:1708-1721`). Zug's qsearch has no
   `stalemate`/checkers logic of this kind.

**Why.** These prevent the engine from over-valuing a line that captures into a stalemate (a draw the
static/SEE view misreads as winning). **Tiny Elo**, but they are real, known-position bugs — the kind
that cost half-points in exactly-drawn endgames. SF carries both.

**How.** Port each guard behind its own env flag; validate with a handful of stalemate-trap FENs, then
a movetime SPRT (expect ~flat but non-negative — the value is in the rare correct save). Effort: small.
Low priority relative to the Elo-bearing levers, but cheap and correctness-positive.
