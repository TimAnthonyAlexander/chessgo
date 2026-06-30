# Phase 0 — int8 + sparse + multilayer forward pass: Go port spec

> **Deliverable of `NEXT_ARCH.md` Phase 0.** A clean-room specification of the modern
> NNUE forward pass (read from Stormphrax `~/stormphrax`, GPLv3 — **algorithm learned,
> no code copied**), written for a Go port into `internal/nnue/`.
> **Status:** spec (2026-06-29). No code yet.

---

## 0. Headline finding (changes the risk picture)

**int8 inference does NOT require AVX-512 VNNI.** Stormphrax's `dpbusdI32`
(`src/util/simd/avx512.h:254`, `avx2.h:263`) has two paths:
- VNNI: `_mm512_dpbusd_epi32(sum, u8, i8)` — 1 instruction, 4 MACs/lane.
- **Fallback (no VNNI): `maddubs_epi16(u8,i8)` then `madd_epi16(·, 1)`** — 2 instructions,
  plain AVX2/SSE, **available everywhere we already run AVX2**.

So the int8 NPS win is reachable with the AVX2 ops we already use in `archsimd`; VNNI is
a later ~2× bonus, **not a prerequisite**, and not on the critical path. This downgrades
the `NEXT_ARCH.md §5` "may need Plan9 VNNI asm" risk to "optional optimisation."

---

## 1. The architecture (target)

```
inputs --FT(i16 accumulator, incremental)--> [stm | nstm] i16
   --activateFt: pairwise CReLU --> u8[L1Size]  (+ sparse nonzero-index list)
   --propagateL1: SPARSE int8 matmul (dpbusd / maddubs+madd) --> i32[L2]  (+ dual activation, skip)
   --propagateL2: i32 matmul --> i32[L3]
   --propagateL3: i32 dot + skip --> i32  --descale--> cp
   x N output buckets (MaterialCount<8> selects the L1/L2/L3 weight slice)
```

Stormphrax's production shape (for reference, **not** our first target):
`((704x16 + threats) hm -> 640) x2 -> (32x2 -> 64 -> 1) x8`.

**Our first target = the *minimal* multilayer-int8 net** (add the fancy bits later):
`768 -> L1(512) x2 -> (L2(16) -> L3(32) -> 1) x8`, single activation, **no** threats,
**no** king buckets, **no** pairwise/dual/skip. Prove the pipeline, then enrich
(§7 of `NEXT_ARCH.md`).

---

## 2. Quantization constants (Stormphrax values; ours TBD via bullet)

| Const | Stormphrax | Meaning |
|---|---|---|
| `kFtQBits` | 8 | FT activations quantised to u8 `[0, 255]` |
| `kL1QBits` | 7 | L1 weight scale |
| `kFtScaleBits` | 7 | pairwise-mul shift |
| `kQuantBits` (`kQ`) | 6 (64) | L2/L3 fixed-point scale |
| `kScale` | 400 | final cp scale |
| L1 weights | **i8** | the sparse int8 matmul |
| FT weights | i16 | accumulator |
| L1/L2/L3 biases & L2/L3 weights | i32 | |

The exact bit shifts are derived in `propagateL1`'s `kShift`:
`kShift = 16 + 2*kQuantBits - kFtScaleBits - 2*kFtQBits - kL1QBits`. Reproduce this
**exactly** for bit-exactness; don't re-derive by feel.

---

## 3. The forward pass, step by step (Go-oriented, scalar reference)

### 3.1 `activateFt` — i16 accumulator → u8 activations + sparse list
For each perspective (stm, then nstm), over the L1 pairs:
1. clamp accumulator value to `[0, (1<<kFtQBits)-1]` = `[0,255]` (Clipped ReLU).
2. **pairwise**: `out = (i1 * i2) >> kFtScaleBits` where `i1`,`i2` are the two halves
   of the accumulator pair (this is the "pairwise CReLU"). *(Minimal first net can use
   plain CReLU `out = clamp(acc,0,255)` and skip pairwise — simpler, still valid.)*
3. pack to **u8**; write to `outputs[0..L1Size]` (stm in `[0,L1/2)`, nstm in `[L1/2,L1)`).
4. **sparse list:** scan the u8 outputs in chunks; record the index of every chunk that
   is **not all-zero** (Go: compare-to-zero → movemask → if nonzero, push index). This
   list is the only thing `propagateL1` iterates.

### 3.2 `propagateL1` — SPARSE int8 matmul (the NPS core)
For the selected output `bucket`:
- `acc[L2] = 0`
- for each **nonzero** input chunk index `idx` in the sparse list:
  - broadcast 4 consecutive u8 inputs as one i32 (`inI32s[idx]`),
  - load the i8 weight column for `idx`,
  - `acc += dpbusd(input_u8, weight_i8)` → **int8 dot via `maddubs+madd`** (§0).
- descale: `out = (acc >> kShift) + bias`
- **activation** → produces the L2 input (`L2Full = L2 * (1 + dualActivation)`):
  - single (our first net): `out = clamp(out, 0, kQ*kQ); out = out*out >> (2*kQuantBits)` (SCReLU).
  - dual (Stormphrax): a CReLU side **and** an SCReLU side, concatenated; with `kSkipL2`
    the CReLU side is shifted and the SCReLU side carries forward (skip connection).
- **Zero inputs are never touched** — that's the speed. On a 512-wide FT, typically
  ~40-60% of chunks are zero after CReLU → that fraction of the L1 matmul is skipped.

### 3.3 `propagateL2` — i32 matmul, no activation
`out[L3] = l2Bias[bucket]; for each L2Full input: out += input * l2Weight_column`
(plain i32 `mullo` + `add`; small — L2≈16-32). With `kSkipL2`, inputs are `>> kQuantBits` first.

### 3.4 `propagateL3` + output
`y = l3Bias[bucket] + Σ L3 * l3Weight[bucket]` (+ skip term if used), then
`cp = y * kScale / (Q...)` per the descale chain. One output, side-to-move relative.

---

## 4. Net format (GNN4)

New header + sections (extend the GNN2/GNN3 loader, `internal/nnue/quant.go`,
`net.go`):
- header: magic `GNN4`, `L1`, `L2`, `L3`, `outputBuckets`, flags (threats / pairwise /
  dual / skip / kingBuckets), quant constants.
- FT weights+biases: **i16** (accumulator), `[inputs × L1]` (+ king-bucket dimension later).
- L1 weights: **i8** `[buckets × L1 × L2]`; L1 biases: i32 `[buckets × L2]`.
- L2 weights/biases: i32. L3 weights/biases: i32.
- Import from bullet's quantised export (bullet emits exactly this layout for a
  multilayer int8 net — verify field order against bullet's writer, like GNN2 did).

---

## 5. Go port plan (Phase 1, all no-train)

1. **Scalar reference forward** (`net.go`): the §3 steps in plain Go, i32 math, no SIMD.
   Validate against a **bullet-exported tiny/random net** (no training) — the gate is
   **bit-exactness vs bullet's own inference on the same net**, not strength.
2. **Incremental accumulator**: reuse `accumulator.go` (absolute-color halves) — FT is
   unchanged in spirit; only width/threats differ. No refresh path until king buckets.
3. **Kernels** (`kernels.go` seam): `activateFt`, the sparse list build (nonzero-mask),
   the int8 `dpbusd` (scalar → AVX2 `maddubs+madd` → optional VNNI), L2/L3 i32 madd.
   Gate **SIMD == scalar bit-exact** (`TestKernelsMatchScalar`, the §12.4 discipline).
4. **Measure** only after a net is trained: movetime + **external NNUE anchor** (the
   `--full-strength` harness), never fixed-nodes (§14.4).

**Minimal-first:** ship the simplest multilayer-int8 (no threats/pairwise/dual/skip/
king-buckets) and confirm it's at least neutral vs v6 at movetime *before* enriching.
Each enrichment (pairwise → dual+skip → output buckets → king buckets → threats → width)
is its own retrain + movetime gate.

---

## 6. Open questions to settle in bullet (training side)

- Exact bullet config for a multilayer int8 net (layer sizes, activation names, quant
  flags) + its quantised export field order → fixes the GNN4 layout.
- Our quant constants (start from Stormphrax's: FtQ=8, L1Q=7, FtScale=7, Q=64, scale=400).
- PoC schedule: a **~1 h** run (short but *complete* cosine anneal — never early-stop,
  §12.2) to validate end-to-end, before any full production anneal.

## 7. Reference map (Stormphrax, for re-reading)
`src/eval/arch.h` (config) · `arch/multilayer.h` (`activateFt`/`propagateL1/2/3`) ·
`arch/util/sparse_default.h` (sparse index list) · `util/simd/{avx2,avx512}.h`
(`dpbusdI32` + maddubs fallback) · `features/threats.h` (later) · `output.h` (buckets).
