# New move-ordering history tables (low-ply + pawn)

Two SF move-ordering history tables zug lacks entirely. Related (both are new ordering signals) —
one task, but SPRT each independently.

## 1. Low-ply history

**What.** SF `LowPlyHistory` (`[ply][from][to]`, 5 plies), read in movepick with a ply-decayed weight:
`m.value += 8 * (*lowPlyHistory)[ply][m.raw()] / (1 + ply)` (SF `movepick.cpp:179`). Zug has no
`lowPly` table anywhere.

**Why.** Sharpens ordering at the root-adjacent plies where getting the first move right matters most
(and where the butterfly table is noisiest early in a search). SF's own history: **small** but real.

## 2. Pawn-structure history for ordering

**What.** SF `PawnHistory` (keyed by a pawn-structure hash, `history.h:153`), read/updated via
`sharedHistory.pawn_entry(pos)`. A quiet move's ordering value gets a pawn-structure-conditioned
bump. Zug has a pawn *correction*-history (different mechanism) but no pawn *ordering* history.

**Why.** Move quality is often pawn-structure-conditioned (a knight outpost move is good in some
structures, bad in others). SF usually bundles this with the eval-diff ordering bump. **small-medium.**

**How.** Add each table to `Context` (house int16 gravity), read in `score_moves_impl`, update in the
cutoff block. Gate: movetime SPRT each. Effort: small-medium (pawn history needs a pawn-key already
available via `pos.pawn_key()`).
