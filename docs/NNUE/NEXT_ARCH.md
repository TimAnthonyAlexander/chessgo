# NNUE next architecture — closing the ~400-Elo gap to the open-source frontier

> **Status:** plan / analysis (2026-06-29). No code yet.
> **Motivation:** the CCRL re-anchor (`ENGINE_STRENGTH.md §15`) put gomachine at
> **≈3260 "dirty" CCRL Blitz** — and it got there by *losing* 6–12% to open-source
> NNUE engines (Starzix 3622, Viridithas 3708, Stormphrax 3722). Those engines have
> search stacks much like ours, so **the gap is almost entirely the NNUE net.** This
> document is the plan to close it, learned by reading Stormphrax's source
> (cloned to `~/stormphrax`; GPLv3 — we learn the *techniques*, we do **not** copy code).

---

## 1. The gap, measured

| | gomachine (v6) | Stormphrax | 
|---|---|---|
| **Inputs** | 768 plain piece-square | **704×16 king-buckets** + **60,144 threat features** + pawn-threats, king-side **mirrored** |
| **L1 width** | 512 | 640 |
| **Tail** | 512→**1** (single dot) | 640×2 → **32 → 64 → 1** (multilayer) + skip over L2 |
| **Quantization** | **int16** (QA=255, QB=64) | **int8** FT (`kFtQBits=8`), int7 L1 |
| **Output buckets** | 1 (v8 GNN3 shelved — movetime wash) | **8** (`MaterialCount<8>`) |
| **Inference** | dense int16 dot | **sparse** (skip zero activations, VBMI2) + AVX-512 |
| **Activation** | SCReLU | pairwise CReLU → dual CReLU+SCReLU → CReLU |
| **Training data** | ~40 GB **Stockfish** binpacks | **self-generated from zero**, never third-party |

Stormphrax's own arch string (top of `src/eval/arch.h`):
```
((704x16 + 59808 + pp) hm -> 640) x2 -> (32x2 -> 64 -> 1) x8     [FT int8, L1 int7, scale 400]
```

**That table is the ~400-Elo gap. None of it is the language** (see §3).

---

## 2. The key insight — richer eval need not cost more per node

The reflex "widening doubles eval cost, so it's pointless without NPS work" is true
**for our current shape** — a single 512-wide int16 dot; widening to 1024 just doubles
that dot (this is exactly why v7/1024 was shelved: +95 fixed-nodes, movetime wash,
`docs/NNUE/PLAN.md`). The fix is **not** "widen the dot" — it's **change the shape so
width is cheap.** Stormphrax runs a *far* richer net at competitive per-node cost
because:

1. **The huge part is incremental.** 60k+ inputs → 640 lives in the accumulator;
   per node it's only the small feature delta. We already do this (absolute-color
   halves, `internal/nnue/accumulator.go`). Size *there* is nearly free.
2. **The per-node part is a tiny tail** (`640→32→64→1`), not a big dot — and it's
   **int8 + sparse**:
   - **int8 / VNNI** (`VPDPBUSD`) does **4 int8 MACs** where our int16 does 1.
   - **sparse**: after ClippedReLU ~half the L1 activations are zero, so the L1→L2
     matmul skips them (nonzero-mask + gather; `src/eval/nnue/arch/util/sparse_default.h`
     builds the nonzero index list via `popcount`).

   Net: a much richer tail at **comparable or lower** per-node cost than our single
   int16 dot.

So the path is the chain already in `ENGINE_ROADMAP.md`:
> **output buckets → multilayer tail → int8/VNNI → affordable width**

Stormphrax is the existence proof that it works — with the **same trainer we use (bullet)**.

---

## 3. Go vs C++ — don't rewrite

A well-written Go engine runs ~**1.3–2× slower NPS** than equivalent C++ (GC — a
non-issue if the hot loop is alloc-free, which ours is; bounds checks — a few %;
weaker inlining — partly closed by PGO; **SIMD maturity — the real one**, especially
AVX-512/VNNI int8). At ~70 Elo/NPS-doubling that's **~40–70 Elo**. The other **~330**
is net architecture + features + data.

**Verdict: rewriting in C++ to reclaim ~50 Elo while leaving ~350 in the net would be
the wrong trade.** The one place Go's tooling genuinely bites is the **int8/VNNI
kernel** (Phase 2) — `archsimd` likely can't emit `VPDPBUSD`, so that single kernel
may need **Go assembly (Plan9)**. That's a contained cost, not a reason to switch
languages.

---

## 4. The plan (phased, each gated at MOVETIME)

**Measurement rule (non-negotiable, from `ENGINE_STRENGTH.md §14.4`):** every EVAL
change is gated at **`--movetime`** (or fixed depth) **and** against **external NNUE
anchors** (the new `--full-strength` harness, §15), **never fixed-nodes self-play** —
fixed-nodes *inflates* eval changes (it turned a v8 wash into a +90 mirage). bullet
supports every arch below natively.

### Phase 0 — Port spec (read, no code)
Read Stormphrax's int8 + sparse forward pass cold and write a clean-room spec:
data layout, per-layer quantization (`kFtQBits=8`, `kL1QBits=7`, `kScale=400`), the
`VPDPBUSD` accumulation, the descale, and the sparse nonzero-index trick. Files:
`src/eval/nnue/arch/multilayer.h`, `arch/util/sparse_default.h`, `util/simd/avx512.h`,
`activation.h`. Deliverable: a Go porting spec. *(Clean-room — no GPL code copied.)*

### Phase 1 — Multilayer + int8 inference in Go (the keystone)
`L1 → L2(32) → L3(64) → 1`, int8 FT, 8 output buckets, skip over L2. New net format
(GNN4). Keep the incremental absolute-color accumulator. **Scalar int8 kernels first**
(correctness over speed). Train a matching candidate in bullet.
- **Gate:** Go inference **bit-exact** vs a reference; then candidate-net **vs v6 at
  movetime AND vs an external NNUE anchor** — promote only on a clean movetime win.
- *Why first:* it adds capacity **and** restructures eval so width/depth become cheap —
  it dissolves the NPS blocker that shelved v7. Highest leverage single move.

### Phase 2 — int8/VNNI + sparse kernels (the NPS payoff)
SIMD the Phase-1 tail: `VPDPBUSD` (AVX-512 VNNI — prod is amd64 `GOAMD64=v4`, has it;
**likely needs Plan9 asm**) + AVX2 fallback + NEON; sparse inference (nonzero-mask +
gather). **Bit-exact** to the scalar Phase-1 path (the `TestKernelsMatchScalar`
discipline from §12.4). Measure NPS + movetime Elo.

### Phase 3 — Richer inputs
- **King buckets** (bullet native — start ~4–16 buckets, mirrored). Retrain → measure.
  Note: buckets reintroduce an accumulator **refresh** path on king moves crossing a
  bucket (we currently have *no* refresh path — `PLAN.md §11.1`); budget for it.
- **Threat features** (pawn/piece threats as extra inputs, incrementally updated —
  `src/eval/nnue/features/threats.*`, ~60k features). Plumbing-heavy; retrain → measure.

### Phase 4 — Width scaling
With eval now cheap (multilayer + int8 + sparse), scale **L1 → 1024+** and re-test the
v7 result that was NPS-blocked before. Measure at movetime.

### Phase 5 — Self-generated data
A data-gen pipeline (self-play at fixed nodes, WDL + search-eval labels) to pass the
Stockfish-distilled ceiling — Stormphrax's whole data philosophy. Complements the
existing blunder-miner (`bench blunders`, `ENGINE_STRENGTH.md §2.4`).

### Parallel track — SPSA
Search-param tuning (LMR/LMP/RFP/futility/NMP/singular margins + history constants).
Cheap, **no retrain**, language-agnostic, runs anytime. ~+20–30 Elo (Triumviratus
co-tuned 55 params for +29.5). Independent of all net work.

---

## 5. Risks & unknowns

- **Go VNNI — downgraded (Phase 0 finding, `INT8_PORT_SPEC.md §0`).** int8 inference
  does **not** require VNNI: the portable **`maddubs + madd`** path (plain AVX2, which
  `archsimd` already uses) gives the int8 throughput win; `VPDPBUSD`/Plan9 asm is a
  later ~2× *bonus*, off the critical path.
- **Bit-exactness gates.** Every new kernel/format needs a scratch-vs-incremental and
  SIMD-vs-scalar equality gate (the existing `NNUE_ASSERT` / `TestKernelsMatchScalar`
  machinery extends to this).
- **Retrain cost.** Each arch change is a bullet retrain (hours on the M3 Metal GPU);
  **never early-stop the cosine anneal** (`§12.2` — a +220 swing came from the anneal alone).
- **Measurement.** Gate at movetime + external NNUE anchor, never fixed-nodes (§14.4).
- **Licensing.** Stormphrax is GPLv3. We **read it to learn techniques** and implement
  clean-room in Go; we do not copy code. bullet (our trainer) already supports every
  arch here, so the training side needs config, not borrowed code.

---

## 6. Recommendation

The keystone is **Phase 1 (multilayer + int8 net)** — the rare move that buys *quality
and speed at once* and unblocks width. Suggested order: **Phase 0 → 1 → 2**, then
**3 (king buckets first, threats second) → 4**, with **SPSA running in parallel** as a
cheap, independent win. Phase 5 (self-gen data) is the long-tail lever to pass the
teacher.

## 7. References

- **The gap measurement:** `docs/ENGINE_STRENGTH.md §15` (CCRL anchor), `§14.4`
  (movetime-gating rule), `§12` (SIMD), `docs/NNUE/PLAN.md` (current arch, v7/v8 shelved).
- **Roadmap chain:** `docs/ENGINE_ROADMAP.md` (output buckets → multilayer → int8 → width).
- **Reference engine:** Stormphrax (`~/stormphrax`, github.com/Ciekce/Stormphrax, GPLv3)
  — `src/eval/arch.h` (config), `arch/multilayer.h`, `arch/util/sparse_default.h`,
  `features/threats.h`, `util/simd/avx512.h`.
- **Trainer:** bullet (jw1912/bullet) — supports multilayer, int8, king buckets,
  output buckets, threats. Setup: `docs/NNUE/BULLET_SETUP.md`.
- **Our inference today:** `internal/nnue/{net,accumulator,quant,kernels}.go`.
