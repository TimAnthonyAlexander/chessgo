# Threat-richness build — port SF18 Full_Threats (9,216 → 79,856)

**Goal:** replace our coarse threat feature block (attacker-class × victim-class ×
victim-square = 9,216) with SF18's **Full Threat Inputs** (79,856), which encode the
**attacker's geometry** via the ordered (from→to) attack edge. Our own null result
(multilayer tail ≈ lean, −24 ± 27) + SF's trajectory (threats were the Elo; the tail
grew only *after* threats made the FT cheap) both say the lever is **input richness**,
not tail/width. Our threats are ~9× coarser than SF's (9,216 vs 79,856).

Status: **design locked, implementing.** Target first train: **320 superbatches**
(annealed, dedicated — the 320-vs-640 question is genuinely open; no valid dedicated
comparison exists). efs28 data pipeline (test80, ply-28). Gate: Abitur vs lean.

## Why this is cheap at movetime (the important part)

Adding attacker geometry does **not** add active edges — our threats already emit one
edge per (attacker → occupied-attacked-square). SF's set is actually *same-or-fewer*
active edges (exclusions + same-type dedup; SF caps active threats at **128** vs our
current 256). The delta engine (`computeDelta`/`appendAttackerEdges`/
`appendChangedEdges`) already carries the attacker square as a parameter — only the
**index arithmetic** changes. So: **NPS-neutral at movetime**; the cost is net size
(threat weight table 8.7× → net ~135 MB) and training (big sparse table → needs a
threat factoriser).

## SF18 Full_Threats exact spec (from ~/sf18-arm/src/nnue/features/full_threats.{cpp,h})

**Dimensions = 79,856.** Per-attacker block = `numValidVictimSlots × attackTableSize(type)`:

| attacker | victim slots (nvt) | attackTableSize | block | base offset |
|---|---|---|---|---|
| Pawn   | 6  | 84   | 504   | 0 / 39928 (b) |
| Knight | 12 | 336  | 4032  | 504 / 40432 |
| Bishop | 10 | 560  | 5600  | 4536 / 44464 |
| Rook   | 10 | 896  | 8960  | 10136 / 50064 |
| Queen  | 12 | 1456 | 17472 | 19096 / 59024 |
| King   | 8  | 420  | 3360  | 36568 / 76496 |

(White attackers 0..36567, Black 39928..79855; total 79,856.)

- `attackTableSize(type)` = Σ over 64 from-squares of `popcount(PseudoAttacks[type][from])`
  (empty board; pawns count only ranks 2–7). Pawn 84, N 336, B 560, R 896, Q 1456, K 420.
- `numValidVictimSlots` per color-half = P 3, N 6, B 5, R 5, Q 6, K 4 (×2 colors = nvt).

**Index formula** (`make_index`, full_threats.cpp:191-204):
```
orientation = OrientTBL[ksq] ^ (56 * perspective)     // 56*p flips rank for black
from_o = from ^ orientation ; to_o = to ^ orientation
swap = 8 * perspective                                 // flips piece color for black
atk_o = attacker ^ swap ; vic_o = attacked ^ swap
index = lut1[atk_o][vic_o][from_o < to_o]              // attacker base + victimSlot*tableSize (or =Dimensions if excluded)
      + offsets[atk_o][from_o]                          // Σ popcount(pseudo_attacks) over from-sq < from_o
      + edgeRank[atk_o][from_o][to_o]                   // popcount( ((1<<to_o)-1) & PseudoAttacks[atk][from_o] )
```
- `victimSlot = color_of(attacked)*(nvt/2) + map[atkType-1][vicType-1]`; friendly victims
  low half, enemy high half. `map` (full_threats.h:60-67) encodes exclusions as `-1`.
- **Mirror:** `OrientTBL` = 0 for king files a–d, 7 for e–h (XOR ^7 flips file). NOTE: this
  is the **inverse** of HalfKA's mirror — threats fold the king onto **a–d**. There is
  **NO king bucket** for threats; king enters only through this one mirror bit.

**Emission condition** (`append_active_indices`, full_threats.cpp:208-272): real-occupancy
attacks landing on an occupied square: `attacks_bb(pt, from, occ) & occ`. Directed
attacker→victim; both colors as attacker and victim; slider attacks use first-blocker occ.

**Exclusions** (`map`): Pawn→{B,Q,K}; {B,R,K}→Q; K→K. So piece→king IS kept for
N,B,R,Q (only Pawn→K and K→K dropped); queen-as-victim only for N,Q attackers.

**Same-type dedup** (`semi_excluded`): for `atkType==vicType && (enemy || type!=PAWN)` the
`from<to==true` variant → Dimensions (dropped), so mutual same-type pairs emit one feature.

**Refresh** (`requires_refresh`): only when moving side == perspective AND king crossed the
d/e boundary (mirror bit flips) — far cheaper than HalfKA's any-king-move refresh.

## Our port (adapted to our arch)

- Keep base king-bucketed block (`PsqSize = 12288`) unchanged.
- Threat block = SF's 79,856 scheme, **global**, offset `PsqSize`. New `EnrichedNet.InputDim`
  = `12288 + 79856 = 92144`.
- **Mirror convention:** use OUR existing threat mirror (`perspMirror`, kingbucket.go) applied
  to BOTH from and to squares (SF applies its OrientTBL to both) — direction is arbitrary as
  long as Go feature-gen and the Rust trainer match; keep it consistent with our base block to
  avoid a second mirror table. Verified by the `kb_verify` Go↔Rust pin tests.
- Precompute LUTs in Go (offsets, edgeRank, lut1 with exclusions/dedup) at init, mirroring
  `init_threat_offsets`/`init_index_luts`.

### Change surface (Go)
1. `enriched.go:181` `ThreatBlock` → 79856 (and the doc block :339-343).
2. New file `threats_sf.go`: LUT precompute + `sfThreatIndex(atk, vic, from, to, persp, mir)`.
3. Rewrite the 6 emission sites to call the new index fn:
   `enriched.go:380` (appendEnrichedFeatures), `:432,:433` (appendEnrichedFeaturesBoth),
   `enriched_delta.go:64` (appendAttackerEdges), `:394,:395` + `:410,:411` (appendChangedEdges).
   The exclusion/dedup guard (`< Dimensions`) must be applied at each site (drop excluded edges).
4. `maxEnrichedActive` (enriched.go:185): current 32+256; SF cap is 128 threats → keep 256 (safe).
5. Everything else parametric on `ThreatBlock`/`PsqSize` (weight sizing, int8 W0t8, SIMD apply).

### Change surface (trainer, bullet checkout — NOT in this repo)
- `examples/chessgo_*.rs` `map_features`: replicate the exact index scheme.
- **Threat factoriser** (new): to train 79,856 sparse features on test80/320sb, add virtual
  sub-features (e.g. collapse edge→(attacker-type × victim-square) and/or victim-slot) that sum
  into the full feature, so rare edges borrow gradient. Mirror bullet's base factoriser merge.
- `kb_verify_test.go` / `kb_verify2_test.go`: update the Go↔Rust index pin in lockstep.

### Gates
- `go test ./internal/nnue/` (incl. new LUT unit tests + kb_verify pin), `NNUE_ASSERT` clean
  (accumulator incremental == scratch), `perft` green, `go test -race` not required (TT only).
- Train 320sb annealed → import → **Abitur vs lean** (movetime, ~200+ games) + vs externals.
  Ship only on a clear positive lower bound.
