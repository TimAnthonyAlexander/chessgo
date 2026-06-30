# Handoff: int8 + SIMD for the multilayer NNUE (Phase 2)

> **For a fresh instance.** Everything below is current as of this session. The
> multilayer NNUE architecture is **built, wired, and proven at fixed depth
> (+102 Elo vs v6)** but **loses at movetime (−284) purely on speed**. Your task
> is the speed work: **int8 + SIMD on the multilayer tail** so the +102 eval edge
> survives the clock. Read `NEXT_ARCH.md` (the plan) and `INT8_PORT_SPEC.md` (the
> clean-room int8 kernel spec) first — this doc is the execution context.

---

## 1. TL;DR — where we are

- gomachine is **≈3260 "dirty" CCRL Blitz** (re-anchored this session vs real NNUE
  engines; `ENGINE_STRENGTH.md §15`). The open-source NNUE frontier (Stormphrax,
  Viridithas ~3700) is **~400 Elo up**, and that gap is **net architecture**, not
  Go-vs-C++ (~40 Elo) — see `NEXT_ARCH.md §1-3`.
- We built a **multilayer NNUE** (`768 → 512 → 16 → 32 → 1`, "MultiNet"/GNN4) as
  the scaffold the enrichments (king buckets, threats, width) bolt onto.
- **Fixed-depth result: MultiNet PoC beats v6 by +102.1 ± 49 Elo** (lower bound
  +53), on **1/5 the training data**. The multilayer eval is genuinely much better.
- **Movetime result: −284 Elo.** Pure speed: the float tail is ~16× v6's per-node
  eval, so it gets out-searched. **This is the problem you fix.**

## 2. The numbers (so you can reproduce / re-baseline)

| Test | Regime | Result |
|---|---|---|
| MultiNet PoC vs v6 | fixed depth 8, 40 pairs | **+102.1 ± 49** (W38 L14 D28) — eval quality, real |
| MultiNet PoC vs v6 | movetime 100 ms, 21 pairs | **−284** (W1 L32 D9) — speed-bound, float tail |

**Goal: get movetime net-positive for the bare multilayer.** Honest expectation
(`NEXT_ARCH`): even fully int8+SIMD the tail is *inherently* a bit heavier than v6's
single dot, so the bare arch likely lands **~+30 to +60 at movetime**; the big Elo
then comes from the **enrichments** stacked on top. So "int8 gets us to net-positive
and unblocks enrichments" is success here, not "int8 recovers the full +102."

## 3. THE TASK

Make the MultiNet eval fast enough at movetime to realize the eval edge, by
**int8 + SIMD on the tail** (and an int-SIMD feature-transformer accumulator).

**Bottleneck (the int8 target):**
- Per-node tail: L1 `16×1024=16384` + L2 `16×32=512` + L3 `32` ≈ **17K scalar float
  mults**, vs v6's **1024 int16-SIMD** output dot. ~16× heavier.
- Plus the FT accumulator update is **float** (vs v6's int16-SIMD `addCol`/`subCol`).

**Headline de-risk (from `INT8_PORT_SPEC.md §0`): int8 does NOT need VNNI.** The
`maddubs + madd` AVX2 path (already in `archsimd`) gives the int8 throughput; VNNI
(`VPDPBUSD`) is a later ~2× bonus, off the critical path.

### Recommended order (each step measurable, lower-risk first)

1. **SIMD the FLOAT tail first** (no quantization). SIMD the `tailEval` matmul
   (Float32x8 AVX2 / Float32x4 NEON) via the kernel seam. ~8× on the bottleneck,
   **exact eval** (preserves +102), zero quantization risk. *I was about to start
   exactly this when handed off.* Measure movetime — likely brings −284 toward
   neutral.
2. **int16 the FT accumulator** (reuse v6's `addCol`/`subCol`): MultiAccumulator
   becomes int16, MultiNet gets `W0i`/`B0i` (int16, QA=255). Bit-exact, fast
   per-move update, kills the float-drift in the current accumulator.
3. **int8 the tail** (the spec): u8 FT activation → int8 L1 weights → `maddubs+madd`
   matmul (+ sparse skip of zero activations) → int32 L2/L3 → descale. The further
   ~2-4×. This is the intricate part (the scale/descale chain — `INT8_PORT_SPEC.md
   §3`); gate it bit-exact-ish vs the float reference.
4. **Re-measure** fixed-depth (must stay ~+102 if quantization is faithful) **and**
   movetime (the real number).

Steps 1-2 alone may be enough to flip movetime positive; do them, measure, then
decide how far into int8 (step 3) to push.

## 4. What's already built (this session — ALL uncommitted working-tree)

**`internal/nnue/`:**
- `multilayer.go` — `MultiNet` (float), `Eval` = `buildAcc`→`evalFromAcc`→`tailEval`
  (split so the incremental path reuses the tail), constructors, `materialBucket`,
  `screluF`/`creluF`, `SetMultiNet`/`DefaultMulti` (process-global, like `SetNet`).
- `multilayer_acc.go` — `MultiAccumulator` (float, absolute-color halves),
  `buildAcc`/`applyAcc`/`evalFromAcc` (incremental, reuse the net-agnostic
  `moveChanges`), and **`MultiStack`** (NewStack/Reset/Push/PushNull/Pop/Eval +
  `NNUE_ASSERT` drift gate). **This is where the int kernels plug in.**
- `bulletmulti.go` — `ImportBulletMultiNet(path, H, D2, D3)`: reads bullet float32
  export, FT straight-copy, tail layers **transposed** (bullet input-major → our
  output-major). CpScale = 400.
- `kernels.go` — **the SIMD seam**: package-level func vars (`addCol`, `subCol`,
  `screluDot`) default to scalar, repointed by build-tagged SIMD files in `init()`,
  zero per-call dispatch, **bit-exact contract** (`TestKernelsMatchScalar`). Add
  your new tail kernel(s) here following this pattern. SIMD backends:
  `kernels_simd_amd64.go` (+`_v4`), `kernels_neon_arm64.go`, `kernels_simd_arm64.go`.
- Tests: `multilayer_test.go`, `multilayer_acc_test.go` (incremental==scratch across
  all move types), `bulletmulti_test.go` (loads the smoke net, sane evals).

**`internal/search/search.go`:** `s.multiStack`/`s.multiStackCache` fields; `acc*`
helper methods (`accReset`/`accPush`/`accPushNull`/`accPop`/`accEval`) that nil-check
`multiStack` and route to it or the v6 `accStack` (cheap branch, **v6 path
byte-unchanged**); `nnueBegin` builds the multiStack when `DefaultMulti()` is set;
`rawEvaluate` routes via `accEval`.

**`cmd/gomachine/bench.go`:** `--new-multi`/`--old-multi "path,H,D2,D3"` flags +
`loadMultiOrExit` + forces `--concurrency 1`. (Also committed earlier as `192c9e2`:
`--full-strength` + `--opp-opts` for the CCRL anchor harness.)

**`internal/bench/match.go`:** `NewMultiNet`/`OldMultiNet` in Config, `player.multiNet`,
`nnue.SetMultiNet` swap in `play()`.

**bullet (`~/nnue-training/bullet/`):** `examples/chessgo_ml_smoke.rs` (smoke),
`examples/chessgo_ml_poc.rs` (the 64-sb PoC config), both registered in
`crates/bullet_lib/Cargo.toml`. Activation stack: **SCReLU on FT, CReLU on tail
layers** — must match the Go forward and any int quantization. Save format = float
(no `.quantise()`); for an int8 net you'd add `.quantise::<i8>(...)` per layer or
quantize Go-side (PTQ).

## 5. Key artifacts & commands

- **PoC net:** `~/nnue-training/bullet/checkpoints/chessgo_ml_poc-64/raw.bin`
  (float32, 410,705 f32, H=512 D2=16 D3=32 NB=1, full cosine anneal).
- **v6 (baseline):** `data/nnue/net.nnue` (the `--old ""` default; cwd = `gomachine/`).
- **Reference engine:** `~/stormphrax` (cloned; C++ int8+sparse+multilayer; **GPLv3 —
  learn the technique, do NOT copy code**). Key files: `src/eval/arch.h`,
  `src/eval/nnue/arch/multilayer.h`, `arch/util/sparse_default.h`, `util/simd/{avx2,avx512}.h`.

**Measure (run from `gomachine/`):**
```sh
# fixed-depth (eval quality) — must stay ~+102 after quantization
go run ./cmd/gomachine bench sprt \
  --new-multi "$HOME/nnue-training/bullet/checkpoints/chessgo_ml_poc-64/raw.bin,512,16,32" \
  --old "" --new-depth 8 --old-depth 8 --maxpairs 40 --elo0 -5 --elo1 5

# movetime (the real test) — NOTE: --nodes defaults to 25000, MUST pass --nodes 0
go run ./cmd/gomachine bench sprt \
  --new-multi "$HOME/.../chessgo_ml_poc-64/raw.bin,512,16,32" \
  --old "" --nodes 0 --movetime 100 --maxpairs 40 --elo0 -5 --elo1 5

# validate incremental accumulator in real search (no desync panic):
NNUE_ASSERT=1 go run ./cmd/gomachine bench sprt --new-multi "...,512,16,32" --old "" \
  --new-depth 6 --old-depth 6 --maxpairs 2
```
SPRT is self-play, forced `--concurrency 1` (the nets are process globals). Build +
test: `go build ./... && go test ./internal/nnue/ ./internal/search/`.

## 6. Gotchas & lessons (don't relearn the hard way)

- **`--nodes 0` for movetime** — `bench sprt` defaults `--nodes 25000`, which
  overrides `--movetime`. (Cost us a wrong-regime run this session.)
- **Gate EVAL at movetime or fixed-DEPTH, never fixed-nodes** (`ENGINE_STRENGTH.md
  §14.4`): fixed-nodes *inflates* eval changes (turned a wash into +90 once). Search
  features are fine at fixed-nodes; eval is not.
- **Bit-exact gates are non-negotiable** — every SIMD/int backend must match the
  scalar reference (`TestKernelsMatchScalar` pattern; `NNUE_ASSERT` in-search gate).
  int adds are associative (exact); float is bit-*close* (tolerance).
- **bullet export layout:** `raw.bin` (exact f32, unpadded) / `quantised.bin` (padded
  to 64). Order `l0w l0b l1w l1b l2w l2b l3w l3b`; tail weights are **input-major
  [in×out]** → transpose to MultiNet's **[out×in]** (see `bulletmulti.go`).
- **Never early-stop a cosine anneal** (`§12.2` — a +220 swing came from the anneal).
  The 64-sb PoC is *fully* annealed (complete short schedule), not a mid-run checkpoint.
- **Prod = amd64, `GOEXPERIMENT=simd GOAMD64=v4`, Go 1.26.4**; laptop = arm64 M3, Go
  1.27rc1 (NEON). New kernels need scalar + both SIMD backends. (Deploy builds v4; the
  docs/memory say v3 — stale.)
- **Don't touch git** unless the user asks (their standing rule). All of this session's
  multilayer work is **uncommitted** in the working tree.

## 7. Read these
`docs/NNUE/NEXT_ARCH.md` (plan + phases), `docs/NNUE/INT8_PORT_SPEC.md` (the int8
kernel spec, clean-room from Stormphrax — §0 the no-VNNI de-risk, §3 the forward),
`docs/NNUE/PLAN.md` (NNUE history, v4/v6/v7/v8), `docs/ENGINE_STRENGTH.md §14-15`
(fixed-nodes lesson + the CCRL anchor), `CLAUDE.md` (project orientation).

---

## 8. SESSION 2 RESULTS (2026-06-30) — the speed path is solved; the residual is eval QUALITY

> **What got built and measured this session.** All uncommitted in the working tree.
> Everything is gated behind `--multi-int8` / `MultiNet.QuantizeForInt8()`; the shipped
> engine (v6 single-layer `Net`) is untouched, so none of this affects prod.

### 8.1 The decisive negative result: float-tail SIMD is movetime-neutral

SIMD-ing the **float** tail (`dotF32`, 4-accumulator FMA; + `screluActivateF`) sped the
tail ~2.5× (NEON) and more (AVX512), but the movetime deficit stayed put: **NEON −255
(30pr), AVX512 −214 (8pr)** — vs the −284 baseline. **Why:** under SIMD, v6's int dot
speeds up *equally*, so the eval-cost RATIO (MultiNet ÷ v6) is unchanged, and Elo is
ratio-invariant to absolute speed. **int8 is the only lever that changes the ratio**
(`VPMADDUBSW` packs 4× the MACs/op of float32; v6's int16 dot can't get denser). Exactly
the `NEXT_ARCH` prediction. The float-SIMD work is kept as the exact reference + the
`dotF32`/activation kernels the int8 path reuses.

### 8.2 What made the eval fast (per-node cost, AVX512, vs v6's 694 ns)

| Step | MultiNet int8 eval | × v6 | What |
|---|---|---|---|
| start (float scalar tail) | 6564 ns | 9.4× | |
| + int8 L1 (maddubs) | ~8000 ns | — | **no help** — accumulator+activation dominate |
| + **int16 accumulator** | 4120 ns | 5.9× | Push **2829→240 ns** (reuse v6 `addCol`/`subCol`) |
| + **SIMD activation** | **2028 ns** | **2.9×** | `quantU8I16` **2532→153 ns** (AVX512 `VPMOVUSDB`) |

Three things mattered, in order: (1) the **int16 accumulator** — the float accumulator's
4 KB copy + scalar delta was the single biggest per-node cost; int16 makes Push the same
fast SIMD as v6 and incremental==scratch becomes EXACT. (2) **alloc elimination** — the
per-eval `make()` of ft/aq/l2/l3 (~5 KB) is now reused scratch on the `MultiStack`. (3)
**SIMD `quantU8I16`** — the FT→u8 activation was a 2.5 µs scalar loop; AVX512 narrows
int32→u8 in one op (`VPMOVUSDB` = `Uint32x16.SaturateToUint8`, NO lane-crossing) for
153 ns. int8 L1 (`dotU8I8x16`) is only 657 ns and was never the bottleneck.

**Key int8 design choices** (in `multilayer_int8.go`, `kernels.go`):
- **L1 only is int8** (96% of tail FLOPs); L2/L3 stay float (`dotF32`).
- **Activation QA=127, not 255**: pair sum ≤2·127·127=32258 < 32767 ⇒ maddubs int16
  saturation never fires ⇒ exact + scalar==SIMD trivially.
- Activation is **pure-int**: `u8 = (clamp(acc,0,255)² + 256) >> 9` (255²>>9 = 127 = int8QA),
  so the descale `L1Inv = 1/(int8QA·Sw)` is unchanged and the SIMD is a clean
  clamp/square/shift/narrow. `quantU8I16` SIMD is **AVX512-only** (`VPMOVUSDB`); AVX2/NEON
  keep the scalar binding (prod is v4/AVX512, like `dotU8I8` on NEON).
- Per-output-row int8 weight scale `Sw=127/max|row|`. PTQ closeness to float = **6.8 cp
  mean / 17 cp max**.

### 8.3 Movetime result and the real remaining gap

int8 + int16-accumulator + SIMD-activation (2.9× v6) lands movetime at **≈ −90**
(8 pr, ±95; W1 L6 **D9** — mostly holding draws now, where the float tail bled losses;
from the −284 baseline that's ~+195 Elo recovered by the speed work). Big improvement,
**but still negative — and the residual is eval QUALITY, not speed**: int8 **fixed-depth**
vs v6 was only **≈ +15 to +50** (noisy, 9 pr) where the
**float** MultiNet was **+102**. PTQ cost ~50–90 Elo of eval quality. So:
- **Speed is largely solved** (2.9× v6; further micro-opt on L2/L3 via direct scalar dots
  was tried and measured SLOWER — the `dotF32` SIMD seam handles width-16/32 fine on AVX512).
- **The next lever is eval quality, i.e. QAT** — retrain the PoC net **int8-aware** in
  bullet (`.quantise::<i8>` / activation-range-aware training), or widen the activation
  resolution. That recovers the +102→ and, at 2.9× v6 speed, should flip movetime positive.
  This is a GPU retrain, not a kernel change — the natural next session.

### 8.4 Infra notes (so the next instance can reproduce)
- **Measure on lairner** (real AVX512): `ssh lairner`, scratch repo at `~/chessgo-simd/`
  (rsync `gomachine/` excl `data,bin,.git`; copy `data/nnue/net.nnue`, `data/book.bin`,
  and the PoC `raw.bin`→`~/chessgo-simd/poc.bin`). Build `GOEXPERIMENT=simd GOAMD64=v4
  ~/sdk/go1.26.4/bin/go`. SPRT flags: `--multi-int8 --nodes 0 --movetime 100 --engine-book
  "" --tb-path ""`. **Don't disturb `/var/www/chessgo`** (the live service).
- **Laptop** can compile-check amd64 via `~/sdk/go1.26.4` cross-build (`GOOS=linux
  GOARCH=amd64 GOAMD64=v3|v4`), and run NEON via `~/sdk/go1.27rc1` + `GOEXPERIMENT=simd`.
- **Bit-exact gates**: `TestDotU8I8MatchScalar`, `TestQuantU8I16MatchScalar`,
  `TestDotF32MatchScalar`, `TestScreluActivateFMatchScalar`, `TestKernelsMatchScalar`,
  `TestMultiIncrementalMatchesScratch` (now EXACT int16), `NNUE_ASSERT=1` in-search.
  All green on scalar / NEON / AVX2(cross) / AVX512(lairner).
- New kernels in the seam: `dotF32`, `screluActivateF`, `dotU8I8`, `quantU8I16`,
  `screluActivateI16`. New net fields: `W0i/B0i` (int16 FT), `L1W8/L1Inv` (int8 L1),
  `int8L1` flag. `QuantizeForInt8()` enables the path.

### 8.5 QAT config — WRITTEN, not yet run (the eval-quality lever)

`~/nnue-training/bullet/examples/chessgo_ml_qat.rs` (registered in
`crates/bullet_lib/Cargo.toml`) is the next step: **320 superbatches + QAT**. It is
the PoC config with two `faux_quantise` calls that simulate the int8 inference EXACTLY
(traced & aligned): `l0.forward(x).faux_quantise(255).screlu().faux_quantise(127)` —
255 = the int16 FT accumulator (`ftQA`), 127 = the u8 activation (`int8QA`).
`faux_quantise(s) = round(s·x)/s` with straight-through grad, kept in float, so a
float affine over fake-quantised inputs equals the descaled int dot ⇒ the QAT forward
== the int8 inference (modulo the L1-weight PTQ residual, ~small). **The Go side needs
NO change** — it still reads the float `raw.bin` and runs `QuantizeForInt8()`; QAT just
makes that PTQ near-lossless on the activation. (L1-weight fake-quant omitted in v1 —
needs the weight node, not a forward node; add if fixed-depth still trails the float.)

**STATUS (2026-06-30, launched):** smoke-validated (4 sb) end-to-end — bullet compiles
the `faux_quantise` graph, trains, saves `raw.bin`, and the Go side loads it via
`ImportBulletMultiNet`+`QuantizeForInt8` and plays (`int8L1=true`). The full **320 sb
run is RUNNING** (~6 h at ~1.47M pos/sec; `nohup`, log in the session scratchpad
`qat_full.log`; checkpoints every 32 sb → final `chessgo_ml_qat-320`).

**BULLET BUG FOUND + FIXED (the local clone is now modified — don't `git reset` it):**
`builder.faux_quantise` lowers (via `model/operations/pointwise.rs::FauxQuantise::lower`)
to a raw `Unary::Round`, whose **backward was `unimplemented!()`**
(`crates/compiler/src/tensor/operation/pointwise/unary.rs`) — so QAT training PANICS on
the first backward pass (the `qat.rs` straight-through `CustomAutograd` is never wired
in). Fix applied: give `Unary::Round`/`Unary::Truncate` a **straight-through backward**
(local gradient 1 via `DValue::one`), so `faux_quantise` differentiates as identity —
exactly the STE QAT needs. The `superbatches`/`save_rate` in `chessgo_ml_qat.rs` are now
`SB` env-driven (default 320) so a `SB=4` smoke and the full run share one compile.

**Launch checklist (do when fans are OK — it's a ~6 h HOT GPU+data run):**
1. `cd ~/nnue-training/bullet && cargo r -r --features metal --example chessgo_ml_qat`
   (the compile is the first real validation of the `faux_quantise` API; consider a
   4-superbatch smoke first — edit `superbatches` — to confirm it trains + the net
   loads in Go, before the full 320).
2. Take the FINAL annealed `checkpoints/chessgo_ml_qat-320/raw.bin` (NEVER mid-run).
3. **Fixed-depth gate first** (speed-independent, scalar OK): `bench sprt --new-multi
   ".../chessgo_ml_qat-320/raw.bin,512,16,32" --multi-int8 --old "" --new-depth 8
   --old-depth 8 --maxpairs 40`. Target: beat the +30 PTQ net, ideally → the float +102.
4. Then the real **movetime** number on lairner AVX512 (`--nodes 0 --movetime 100`).
   Expectation (INT8_HANDOFF analysis): at the unchanged 2.9× v6 speed, recovering the
   eval to ~+150 fixed-depth should flip movetime POSITIVE (~+20 to +70).
