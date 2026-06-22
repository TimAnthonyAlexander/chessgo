# NNUE net v2 — distillation data pipeline (spec)

> ⚠️ **Historical (v2, Go trainer).** This documents the Go-native CPU pipeline
> (`internal/nnuedata`) that fed nets **v1–v3**. From **v4 on we train with
> `bullet`** on the Metal GPU, which reads the SF binpack **directly** — so this
> Go convert/label pipeline is **no longer on the critical path** (kept for the
> binpack-format notes + the data-starvation diagnosis that justified the pivot).
> Current trainer: `BULLET_SETUP.md`. Lineage: `PLAN.md` → Trainer lineage banner.
>
> Build spec for net v2: distill from public Stockfish/Leela training data instead
> of our own ~1.6M WDL positions (net v1 failed Phase 3 — see PLAN.md §4). All byte
> offsets/formulas quoted from primary sources, linked inline. Net v2 = same 768
> features, but stronger teacher + cp-unit labels + SCReLU + λ-schedule loss.

## Why the pivot (recap)

Net v1 (pure-WDL λ=0 on 1.6M quiet/dup positions) lost −332 Elo to tuned HCE at
fixed nodes; best post-hoc `cpScale` (0.78) only recovered to −220, and it lost to
bare PeSTO at every scale. Two causes: cp-scale mismatch (sigmoid(y/400) → net
learns y≈400·logit(wp); HCE K≈160) and a genuinely thin eval signal. Both are
fixed by distilling a **strong dense teacher** (SF/Leela cp) with the sigmoid
constant set from a WDL model so the net is **on-scale by construction**.

---

## 1. On-disk formats (two — do not confuse)

- **`.bin`** = flat array of fixed **40-byte `PackedSfenValue`**; board is a
  **Huffman bitstream**. (legacy nodchip/YaneuraOu format)
- **`.binpack`** = block-compressed, move-chain-delta stream of **32-byte
  `PackedTrainingDataEntry`**; board is a **CompressedPosition** (occupancy
  bitboard + nibbles). **What modern public datasets ship in.**

Both struct defs: [`nnue-pytorch/.../nnue_training_data_formats.h`](https://github.com/official-stockfish/nnue-pytorch/blob/master/data_loader/cpp/lib/nnue_training_data_formats.h).

### 1a. `.bin` `PackedSfenValue` (40 bytes, no file header; count = filesize/40)

| Off | Size | Field | Type | Meaning |
|---|---|---|---|---|
| 0 | 32 | `sfen` | u8[32] | Huffman board (256-bit stream) |
| 32 | 2 | `score` | i16 LE | cp, **side-to-move-relative** |
| 34 | 2 | `move` | u16 LE | from(6)+to(6)+promo/flags(2) |
| 36 | 2 | `gamePly` | u16 LE | plies from start |
| 38 | 1 | `game_result` | i8 | **STM-relative** +1 win / −1 loss / 0 draw |
| 39 | 1 | pad | u8 | — |

**Huffman board** (bit cursor **LSB-first within each byte**): stream order =
[1b stm (0=W,1=B)] [6b WK sq] [6b BK sq] [board pieces rank8→1, fileA→H: per
non-king square a codeword; if piece, +1 color bit (0=W,1=B)] [4b castling
WK,WQ,BK,BQ] [1b ep + 6b ep sq if set] [6b rule50 + 1b high at end] [8b+8b
fullmove]. Codes (LSB-first, match `(code,bits)`): empty `0`/1b; Pawn `0001`/4b;
Knight `0011`/4b; Bishop `0101`/4b; Rook `0111`/4b; Queen `1001`/4b. Kings are NOT
in the loop (they're the two 6-bit fields). Triple per record: decode board →
(piece,square)+STM; cp=score; WDL=game_result (both STM-relative).

### 1b. `.binpack` `PackedTrainingDataEntry` (32 bytes) — convert, don't hand-parse

Base record: [0..24) `CompressedPosition` = 8-byte occupancy bitboard (big-endian)
+ 16 bytes nibbles (2 pieces/byte, low first, bitboard order; nibble 0–11 = piece
types, 12=pawn+ep, 13=WR+castle, 14=BR+castle, 15=BK+black-to-move); [24..26)
move BE; [26..28) score BE; [28..30) `ply | result<<14`; [30..32) rule50 BE. File
is **chunked** with **move-chain continuation** (each ply = VLE `(pieceId, move,
scoreDelta)` replayed through movegen). **Standard workflow: convert binpack →
flat, not parse-in-place.**

---

## 2. Starter dataset

Sources: [nnue-pytorch wiki Training-datasets](https://github.com/official-stockfish/nnue-pytorch/wiki/Training-datasets),
[robotmoon.com/nnue-training-data](https://robotmoon.com/nnue-training-data/),
manifest [`vondele/nettest/threats.yaml`](https://github.com/vondele/nettest/blob/main/threats.yaml).
Wiki recipe: train first on SF-generated (depth 9 / nodes 5000) data, **then**
fine-tune on Lc0-derived sets (Lc0-only doesn't train as well).

| Dataset | Fmt | Teacher | Use |
|---|---|---|---|
| **`nodes5000pv2_UHO.binpack`** ⭐ | binpack | SF 5000-node, UHO book | **start here** (few GB, tens of M pos) |
| `large_gensfen_multipvdiff_100_d9.binpack` | binpack | SF depth-9 | alt stage-1 |
| `T60T70wIsRightFarseer.binpack` | binpack | Leela T60/70 + SF | fine-tune stage |
| `data_d9_2021_09_02.binpack` ⚠️ | binpack | SF d9 | ~16B pos — **skip for v1** |

License: SF is **GPLv3**; attribute SF project + dataset authors; keep
trainer/engine GPL-compatible if redistributing. (Our `gochess` ref has **no
license** → reference only; `Maelstrom` is **MIT**.)

---

## 3. WDL model → set the sigmoid by construction

**Trainer-side** (`TrainingDataEntry::win_rate_model`, the one to match):
`m = min(240,ply)/64`; `as={-3.68389304,30.07065921,-60.52878723,149.53378557}`,
`bs={-2.0181857,15.85685038,-29.83452023,47.59078827}`; `a=((as0*m+as1)*m+as2)*m+as3`,
`b=(((bs0*m+bs1)*m+bs2)*m+bs3)*1.5`; `x=clamp(100*score/208,±2000)`;
`w=1/(1+exp((a−x)/b))`, `l=1/(1+exp((a+x)/b))`, `d=1−w−l`.

**Engine-side** (`uci.cpp` @ [4a869f4](https://github.com/official-stockfish/Stockfish/commit/4a869f41c6113f1ccdd0f11551858fdc849a245a)):
`NormalizeToPawnValue=377`, so eval==377 internal ⇔ ~50% win ⇒ `cp = 100*internal/377`.

**For us:** standard nnue-pytorch is `wdl = sigmoid(cp / scaling_factor)`,
`scaling_factor≈410`. Pick OUR `scaling_factor` = our engine's "50%-win cp" (the
377/410 analogue) and train `eval_target = sigmoid(label_cp/scaling_factor)`; net
output ÷ same constant is in our cp units → the v1 scale problem vanishes.

---

## 4. SCReLU (adopt over plain CReLU)

Forward `f(x)=clamp(x,0,1)²`; backward `f'(x)=2·clamp(x,0,1)` on `(0,1)` else 0
(i.e. `2x` for `0<x<1`). Near-free Elo: a 1024-wide SCReLU net ≈ a 1536-wide CReLU
net (≈+50% effective width), double-digit Elo in practice.
**Quant caveat:** with `QA=255`, `SCReLU` reaches `255²=65025` → int16 overflow.
Fix: order the dot product `(v·w)·v` (not `(v·v)·w`) and clip L1 weights to
`±1.98 (=±127/64)`. Float training ignores this; it bites only at quant/inference —
plan the int layout around `(v·w)·v` up front.

---

## 5. Go references

- **`adamtwiss/gochess`** (no license → reference only): `cmd/tuner` has
  `convert-binpack` (binpack→flat .bin), `rescore`, `check-net` (eval-scale +
  dead-neuron health), `selfplay`, `shuffle`, `dump-binpack`. Its flat record is a
  **32-byte LE** scheme (occupancy u64 @0, 16B nibbles @8, stm @24, castling @25,
  ep-file(8=none) @26, halfmove @27, **score i16 White-relative** @28, **result
  0=Bwin/1=draw/2=Wwin** @30). Copy this layout + its convert approach; normalize
  the White-relative vs SF's STM-relative sign on import.
- **`saisree27/Maelstrom`** (MIT): `(768→512)×2→1` SIMD **SCReLU** Go engine
  trained on Lc0/SF data — proof our exact design works in Go. Read its quantized
  SCReLU inference path.

---

## 6. Loss + hyperparameters (nnue-pytorch, confirmed)

`loss = λ·loss_eval + (1−λ)·loss_result`, cross-entropy in WDL space with
`p=sigmoid(label_cp/sf)` (or game result for loss_result), `q=sigmoid(net_cp/sf)`,
stabilized `CE = −[p·log(q+ε)+(1−p)·log(1−q+ε)]` (minus the constant target
entropy). Params: `start-lambda 1.0 → end-lambda 0.75`, `lr 8.75e-4`,
`gamma 0.992/epoch`, `batch 16384`, `max_epoch ~600` (≈400 saturation),
`random-fen-skipping 3`, epoch-size 1e8, val 1e6. Fine-tune: lr 4.375e-4, gamma
0.995, lambda end higher.

---

## 7. OUR flat training-record spec `.flat` (the contract — LOCKED 2026-06-21)

Pipeline: `SF binpack →(SF C++ convert)→ .plain (text) →(our Go converter)→ .flat
(compact binary) →(our Go reader, per epoch)→ features + labels`. **We never parse
binpack or Huffman in Go** — SF's C++ owns that half; our Go owns only plain→flat
and the reader.

**Record = 32 bytes, little-endian, headerless** (records concatenated; count =
filesize/32; cat-concatenable, shuffle-friendly):

| Off | Size | Field | Notes |
|---|---|---|---|
| 0 | 8 | `occupancy` u64 | bit i set ⇒ a piece on square i (a1=0, LERF) |
| 8 | 16 | `nibbles` | for the k-th set bit of `occupancy` (ascending), nibble k = byte[8+k/2] low(k even)/high(k odd); value 0..11 = `chess.Piece` (WP..BK). ≤32 pieces → ≤32 nibbles → 16 B |
| 24 | 1 | `stm` | 0=White, 1=Black |
| 25 | 1 | `castling` | bit0 WK, bit1 WQ, bit2 BK, bit3 BQ |
| 26 | 1 | `epFile` | 0..7 file of ep target; **255 = none** (rank implied by stm: W→rank6, B→rank3) |
| 27 | 1 | `halfmove` | 50-move clock, capped 255 |
| 28 | 2 | `score` i16 | **WHITE-relative** cp (converter flips STM→White on import) |
| 30 | 1 | `result` | **WHITE-relative**: 0=Black win, 1=draw, 2=White win |
| 31 | 1 | reserved | 0 |

**Why White-relative storage:** makes the label-semantics gate crisp — "White up a
queen ⇒ score>0 and result=2, regardless of stm" — independent of side to move.
The reader converts back to **stm-relative** for the net's target (the net is
stm-relative): `stmScore = white?score:-score`; `stmResult = white?result:(2-result)`.

**Encode/Decode contract.** Decode reconstructs a FEN (fullmove=1) and runs it
through `chess.ParseFEN`, so the decoded board is a real, perft-able `Position`.
Encode is the **core of the plain→flat converter** (not throwaway): board (occupancy
+nibbles) from the position, plus castling/ep/halfmove/stm + White-relative labels.

## 8. SF `.plain` parser (converter input)

SF's `convert` emits text blocks, one position per block ending in `e`:
```
fen <FEN with spaces>
move <uci|none>
score <int cp, SIDE-TO-MOVE-relative>
ply <int>
result <int: +1 stm win, 0 draw, -1 stm loss>     # ASSUMPTION — verify on real data
e
```
Converter per block: `chess.ParseFEN(fen)` → position (board/stm/castling/ep/half);
**flip STM→White**: if stm==Black `whiteScore=-score`; `whiteR = white?r:-r ∈{-1,0,1}`
→ `result = whiteR+1`. Encode.

**Read/convert-time filtering** (drop noisy tails; all configurable):
- skip **in-check** positions
- skip **mate scores** (`|score| ≥ 30000`) and `|score| ≥ scoreLimit` (flag)
- skip **opening plies** (`ply < minPly`, default per gochess ≈ 8)

## 9. The two gates (both before training)

1. **Format round-trip (synthetic).** A set of FENs (incl. castling/ep cases) →
   Encode → Decode → reconstructed FEN → `ParseFEN`; assert position equality AND
   `perft(d)` equal on original vs decoded. Bidirectional (encoder+decoder), so a
   subtle one-directional byte bug can't pass.
2. **Label semantics (real records) — LOAD-BEARING.** On real SF-converted `.flat`,
   assert: eval sign tracks the side to move correctly through the STM→White flip,
   and result perspective matches assumption — checked against a couple of known
   positions (e.g. a clearly-winning-for-White record must have score>0, result=2).
   This catches the perspective/sign mismatch the round-trip cannot. **No training
   until this passes on real data.**

## Build order

1. **Go reader first.** Implement the **binpack `CompressedPosition` / 32-byte
   gochess-style flat record** (occupancy bitboard + nibbles — no Huffman, no
   move-replay). Get `convert-binpack` working (port gochess; don't parse the
   binpack delta stream). Add the 40-byte Huffman `.bin` reader only if ingesting
   legacy flat data. **Normalize sign conventions on import.**
   **HARD GATE (like the gradient check):** a decode unit test — decode known
   records → assert exact piece placement (round-trip to FEN, perft-check) before
   trusting a single training position.
2. **Trainer:** SCReLU (+ plan `(v·w)·v` quant), WDL-model `scaling_factor`,
   λ-schedule CE loss, the hyperparameters above.
3. **Dataset:** `nodes5000pv2_UHO.binpack` → train v1 → fine-tune on
   `T60T70wIsRightFarseer.binpack`. Skip the 16B set.
4. **Sanity tooling:** port gochess `check-net` (eval-scale + dead-neuron) and
   `rescore` as cheap insurance before SPRT.
