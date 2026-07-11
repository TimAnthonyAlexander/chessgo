# Threat-richness build — port SF18 Full_Threats (9,216 → 79,856)

**Goal:** replace our coarse threat feature block (attacker-class × victim-class ×
victim-square = 9,216) with SF18's **Full Threat Inputs** (79,856), which encode the
**attacker's geometry** via the ordered (from→to) attack edge. Our own null result
(multilayer tail ≈ lean, −24 ± 27) + SF's trajectory (threats were the Elo; the tail
grew only *after* threats made the FT cheap) both say the lever is **input richness**,
not tail/width. Our threats are ~9× coarser than SF's (9,216 vs 79,856).

Status: ✅ **TRAINED + DEPLOYED (2026-07-11).** Trained at **640 superbatches**
(net_id `chessgo_threats_sf_640`, annealed, dedicated) on the efs28 data pipeline
(test80, ply-28), and **shipped to prod** (`data/nnue/kb-mirror.bin`, ~180 MB full-threats
file) — **+10 movetime vs efs28**. int16 threat FT (int8 threat FT is lossy on the mature
net — see gotcha #3). Forward plan: `docs/NNUE/SF_PARITY_ROADMAP.md`. The build notes below
are kept as the implementation record.

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
- **Threat factoriser** (new): to train 79,856 sparse features on test80/640sb, add virtual
  sub-features (e.g. collapse edge→(attacker-type × victim-square) and/or victim-slot) that sum
  into the full feature, so rare edges borrow gradient. Mirror bullet's base factoriser merge.
- `kb_verify_test.go` / `kb_verify2_test.go`: update the Go↔Rust index pin in lockstep.

### Trainer factoriser (bullet recipe — owner-specified 2026-07-10)

Three virtual (shared) blocks, summed into each real edge during training, **coalesced
→ real at export** (0 inference params). Rel-piece `a,v` = relColor·6+type (0..11):

| Factor | Formula | Dim | Role |
|---|---|---|---|
| **V1 victim marginal** | `(a·12 + v)·64 + victimSq` | 9,216 | = our current lean feature → geometry net is a strict superset; rare edges fall back to what works. |
| **V2 attacker marginal** | `(a·12 + v)·64 + attackerSq` | 9,216 | the NEW from-square info; the only shared prior on the from-axis → rescues the sparse tail (queen 1,456 edges/attacker). |
| **V3 pair bias** | `a·12 + v` | 144 | absorbs material/threat-class mean so V1/V2 learn residuals. |

Total virtual 18,576, folded at export. **Do NOT go richer** (ray-dir/delta-offset are
implied by V2|V1 and compete with real weights) or **leaner** (V1-alone = no pooling on
the from-axis = paying 79,856 features to learn geometry unregularized).

**Gotchas (owner):**
1. **Mirror inside the factor index** — V1/V2's victimSq/attackerSq MUST pass through the
   same `s ^ orient ^ mir` as the real index, or shared weights split across mirror halves
   (loses the §31 2× pooling).
2. **Dedup mirrored in the factor** — same-type mutual pairs emit ONE feature; if real
   dedups and virtual doesn't, the coarse weight gets 2× gradient. Assert
   `len(realIdx) == len(virtualIdx)/nFactors` in the NNUE_ASSERT gate.
3. **int8 threat FT — RULED OUT; ship int16 (deployed).** The l0/threat-FT int8-QAT was
   **REMOVED**: `faux_quantise` on the threat FT rows **froze from-scratch training**, and PTQ
   int8 is **lossy on the mature net** (~66 cp RMS). The "near-lossless / clamp-clean" claim is
   WRONG for this net — int8 does NOT work here. Prod ships the **int16 threat FT** (79,856·512·2B
   ≈ 81.7 MB), which is the deployed config.
4. **Fold + verify before SPRT** — `coalesce` virtual→real at export, run the byte-exact
   Go-vs-Rust replica (`kb_verify` pattern) on the FOLDED net (a wrong fold is silent).

### SF trunk finding (2026-07-10, from ~/sf18-arm/src/nnue/nnue_architecture.h)

`TransformedFeatureDimensionsBig = 1024` in the SF18 checkout (bignet nn-c288c895ea92) —
so the **3072→1024 L1 cut landed at v10, WITH threats**: threats carry ~3× the trunk
width's knowledge. Implication: our **512 trunk may be too wide** for a real-geometry
threats net; revisit trunk width (and the L2 16→32 shape, which we already run) after the
640sb read. `L2Big=15(+1), L3Big=32`; master v13 doubled L2 to 31(+1).

### The 640sb A/B run (owner-specified) — DONE, shipped as `chessgo_threats_sf_640`

- Arch: `(12,288 base + 79,856 threats) → 512×2 → pairwise → 16 → 32 → 1`, NB=8, mirror-KB.
- Factoriser V1+V2+V3, folded at export. Data: test80 Jan–Apr, efs28, ConstantWDL 0.6
  (hold every other variable — this is the ARCH A/B, not a pipeline run).
- **Gate: movetime 100 ms vs `ml640.bin` DIRECTLY, ≥250 pairs** (§35.3 — no chaining through
  −560 or the lean net). Expected: FN wash-to-positive, MT positive. If MT flat + FN
  negative → tail starving / V2 dead → check the FOLD, don't add factors.
- Movetime cost budget: **~1–2% NPS** (same active edges/cap/churn/applyDiff; only the index
  arithmetic changes — 3 table loads vs 1 madd, on the enumeration path §30.4 proved
  uop-bound at 5.5–5.9 IPC), NOT SF's 20-25% (theirs was 0→threats).

### Gates
- `go test ./internal/nnue/` (incl. new LUT unit tests + kb_verify pin), `NNUE_ASSERT` clean
  (accumulator incremental == scratch), `perft` green, `go test -race` not required (TT only).
- Train 640sb annealed → import → **Abitur vs lean** (movetime, ~200+ games) + vs externals.
  Ship only on a clear positive lower bound. (Done: shipped 2026-07-11, +10 vs efs28.)
