# bullet trainer setup — how to (re)build the NNUE training rig

> The shipped net was trained with **`bullet`** (jw1912/bullet) on the M3 Pro's
> Metal GPU. bullet is a *third-party build tool*, not chessgo code — only our
> **importer** (`internal/nnue/bulletimport.go`, the `nnue-import-bullet` CLI) and
> the net file (`data/nnue/net.nnue`) live in this repo. This doc captures the
> external rig (config + patches) so a re-clone is copy-paste, not re-discovery.
> Strength methodology: `../ENGINE_STRENGTH.md §11`. Build log: `PLAN.md §4`.

## Where the rig lives (this machine)

Moved off volatile `/tmp` to a persistent home (2026-06-22):

| What | Path |
|---|---|
| bullet checkout (patched, built) | `~/nnue-training/bullet` |
| Trainer config (shipped net) | `~/nnue-training/bullet/examples/chessgo.rs` |
| Trainer config (v5 maturity) | `~/nnue-training/bullet/examples/chessgo_v5.rs` |
| Checkpoints (chessgo-1 … 600) | `~/nnue-training/bullet/checkpoints/` |
| **Shipped net's source** | `~/nnue-training/bullet/checkpoints/chessgo-600/quantised.bin` |
| Training data (38 GB SF binpack) | `~/nnue-training/pool.binpack` |
| v4 run logs | `~/nnue-training/logs/` |

> ⚠️ These were originally in `/tmp` and nearly lost — `/private/tmp` is cleared on
> reboot and sweeps files untouched 3+ days. Keep training scratch under
> `~/nnue-training`, never `/tmp`.

## Re-cloning from scratch (if the checkout is ever lost)

bullet upstream rev used: **`ae9dd18`** (github.com/jw1912/bullet). Two local
patches needed, both tiny:

**1. Metal device arm** — `crates/trainer/src/run.rs` (upstream defaults to a
silent `MockGpu` on macOS; this wires the real Metal device):

```diff
-#[cfg(not(any(feature = "cuda", feature = "rocm")))]
+#[cfg(not(any(feature = "cuda", feature = "rocm", feature = "metal")))]
 pub type DefaultDevice = Device<runtime::mock::MockGpu>;

 #[cfg(feature = "cuda")]
 pub type DefaultDevice = Device<runtime::cuda::Cuda>;

 #[cfg(all(feature = "rocm", not(feature = "cuda")))]
 pub type DefaultDevice = Device<runtime::rocm::ROCm>;
+
+#[cfg(all(feature = "metal", not(feature = "cuda"), not(feature = "rocm")))]
+pub type DefaultDevice = Device<runtime::metal::Metal>;
```

**2. Register our examples** — `crates/bullet_lib/Cargo.toml` (the `metal` feature
already exists upstream; this just adds our example targets):

```toml
[[example]]
name = "chessgo"
path = "../../examples/chessgo.rs"

[[example]]
name = "chessgo_v5"
path = "../../examples/chessgo_v5.rs"
```

Then drop `chessgo.rs` / `chessgo_v5.rs` into `examples/` (copies of the configs
below) and:

```sh
cd ~/nnue-training/bullet
cargo r -r --features metal --example chessgo      # shipped-net config
# cargo r -r --features metal --example chessgo_v5 # v5 maturity config
```

## The trainer config (shipped net = `chessgo.rs`)

Architecture `(768→256)×2→1`, SCReLU, dual-perspective. Key knobs:

| Knob | Value | Note |
|---|---|---|
| `HIDDEN_SIZE` | 256 | L1 width |
| quant | `QA=255, QB=64, SCALE=400` | must match `internal/nnue/quant.go` |
| loss | `output.sigmoid().squared_error(target)` | MSE-on-sigmoid (not CE) |
| `batch_size` | 16384 | |
| `batches_per_superbatch` | 1020 | ≈16.7M positions / superbatch |
| `end_superbatch` | **600** (shipped) | |
| `wdl_scheduler` | `LinearWDL 1.0 → 0.75` | WDL+eval blend |
| `lr_scheduler` | `StepLR start 8.75e-4, gamma 0.3, step 200` | |
| data filter | `ply≥16`, not in check, `|score|≤10000`, quiet (normal non-capture move) | |
| data loader | `SfBinpackLoader`, 256 MB buffer, 3 threads | **streams from disk** — never loads 40 GB into RAM |

**Shipped run:** 600 superbatches, **58m55s**, ~2.9M pos/sec, final running
loss 0.0318. → imported to `data/nnue/net.nnue`, **+212 Elo @ movetime** (§11).

## Import → engine

bullet writes `checkpoints/<net_id>-N/quantised.bin` (bullet's ints, verbatim).
Convert to our GNN2 net:

```sh
cd ~/chessgo/gomachine
# NOTE: named flags --in / --out (NOT positional args)
go run ./cmd/gomachine nnue-import-bullet \
    --in  ~/nnue-training/bullet/checkpoints/chessgo-600/quantised.bin \
    --out data/nnue/net.nnue
```

Feature indexing is identical to bullet's `Chess768` (verified; our `Eval`
reproduces bullet's within 1 cp — `bulletimport.go`). `CpScale = SCALE = 400`.

---

## v5 maturity net — RAN, was a DUD (kept for the record)

> **Outcome: v5 was a wash and was reverted.** A 2400-superbatch 256-wide retrain
> floored at the **same loss as v4 (0.0317)** — the 256 net's capacity ceiling — and
> SPRT'd **−25 ± 31 vs v4 @ fixed nodes**. Lesson: more epochs can't lower a
> saturated width's floor. The lever was **width**, not training length → see v6
> (512) below, which shipped. The config notes below are kept for reference.

The shipped net is only ~600 superbatches ("competitive but immature"; bullet
matures ~2400). v5 = **same architecture, trained 4× longer with LR annealed
late** → free per-node Elo at **zero NPS cost** (inference unchanged).

**Prepared:** `~/nnue-training/bullet/examples/chessgo_v5.rs` (registered as the
`chessgo_v5` example). Diff from `chessgo.rs`: `net_id "chessgo_v5"`,
`end_superbatch 2400`, `lr step 200 → 800` (anneal late), new data path.

```sh
cd ~/nnue-training/bullet
cargo r -r --features metal --example chessgo_v5     # ≈4h on the M3 Pro
```

**Faster option:** resume from `chessgo-600` instead of from scratch (saves ~1h):
uncomment `trainer.load_from_checkpoint("checkpoints/chessgo-600")` and set
`start_superbatch: 601`. The optimiser state is preserved, so it's a pure low-LR
anneal. Both reach maturity; from-scratch is the default.

**Then gate it** (the long pole — run locally on the M3 Pro's 11 cores, NOT the
4-core prod box):
1. Back up `data/nnue/net.nnue`, import `chessgo_v5-2400/quantised.bin` over it.
2. SPRT the **v5 net vs the current shipped net**, both on the **current
   TT-static-eval-cache binary** (HEAD `7f4e09f`) — do not gate against a
   pre-cache baseline. `--movetime 100`, `[0,6]` bounds. A maturity gain is
   usually small (+10–40 Elo) → expect many pairs / hours to resolve.
3. Accept H1 → keep the new `net.nnue` (commit it; binary + net travel together).
   H0 → restore the backup.

**Why the TT eval cache matters here:** it caches static eval in the TT slot so
non-cutoff TT hits skip re-evaluating — with NNUE default-on that's the expensive
node cost, narrowing the 1.59× NPS deficit. A per-node-stronger v5 net therefore
converts *more* cleanly to movetime Elo. Measure on the current binary to capture
that interaction.

---

## v6 (512-wide) + SIMD — SHIPPED to prod ★

Width was the lever v5 wasn't. v6 = `chessgo_v6.rs` (HIDDEN **512**, bpsb **6104**,
**320 superbatches**, `CosineDecayLR 0.001→2.43e-6` no warmup, WDL 0.6, SCALE 400;
~4h21m on the M3). **+124.5 ± 50 vs v4 @ fixed nodes.** At movetime it needs SIMD
(512's ~2× eval cost is a scalar wash; SIMD recovers the full +124). Full arc:
`docs/ENGINE_STRENGTH.md §12`.

```sh
cd ~/nnue-training/bullet
cargo r -r --features metal --example chessgo_v6     # ~4.5h on the M3
```

**Anneal warning:** the lowest-*loss* checkpoint is an *un-annealed* early one and
plays **−96** vs v4; the fully-annealed final net plays **+124**. **Never import a
mid-run checkpoint** or stop the cosine on the loss plateau — take `chessgo_v6-320`.

### SIMD build (`archsimd`) — required for v6 to win at movetime

The engine ships a scalar **seam** (`internal/nnue/kernels.go`); SIMD backends
(`kernels_simd_{amd64,arm64}.go`) repoint it behind `//go:build goexperiment.simd`.
The **default build stays scalar** — SIMD only compiles with the experiment flag.
Bit-exact to scalar (gated by `TestKernelsMatchScalar`).

| Target | Go toolchain | build command |
|---|---|---|
| **prod (amd64)** | **1.26.4 stable** (amd64 archsimd is GA) | `GOEXPERIMENT=simd GOAMD64=v4 ~/go/bin/go1.26.4 build -o bin/gomachine ./cmd/gomachine` |
| **dev (arm64/M3)** | **1.27rc1** (arm64 NEON needs Go 1.27) | `GOEXPERIMENT=simd ~/go/bin/go1.27rc1 build -o bin/gomachine ./cmd/gomachine` |

Per-node eval speedup @512 (vs scalar): **6.5× (amd64 AVX2) / 4.16× (arm64 NEON)**.

**AVX-512 (`GOAMD64=v4`) — SHIPPED to prod (2026-06-23).** A 512-bit-wide backend
(`kernels_simd_amd64_v4.go`, bound under the `amd64.v4` build tag; the AVX2 file
now carries `!amd64.v4` so exactly one binds). 32 int16 lanes/iter for the
accumulator add/sub, 16 elem/iter for the SCReLU dot (`Int16x16`→`Int32x16`, with
`Int64x8.Mul`/VPMULLQ for the int32×int32→int64 widen — cleaner than AVX2's
even/odd VPMULDQ trick). **Bit-exact** vs scalar (same `TestKernelsMatchScalar`
gate), `-race` clean (nnue+search). Needs an AVX-512 CPU (avx512f/bw/vl/dq) —
both lairner and coalla (Zen 4) have it incl. `avx512_vnni`. `chessgo-deploy()`
now builds with `GOAMD64=v4` (was v3); rollback binary on the box:
`bin/gomachine.v3-backup`. Go's `simd/archsimd` does **not** expose VNNI int8
(`VPDPBUSD`) yet, so the further int8/VNNI step would need hand-written asm —
deferred.

**Honest impact numbers (measured at fixed depth on lairner, same node count):**
the AVX-512 *kernel* is ~5% faster eval @ HL=512 in isolation (accumulator −30%,
dot flat), but **at the full-engine level AVX-512-over-AVX2 is only ~0.6%** (eval
is a fraction of total search time). The *real* win was a discovery: the binary
actually serving prod had regressed to **scalar** (22.0s vs 6.6s SIMD on a
3.07M-node depth-16 search = **~3.3× slower**). So scalar→SIMD ≈ **3.3×**;
AVX2→AVX-512 ≈ 0.6%. The v6 net had been running at scalar speed = the very
"movetime wash" this doc warns a v6-on-scalar build is.

> **Deploy gotcha that caused the scalar regression:** editing the
> `chessgo-deploy()` body in `~/.zshrc` does nothing for a shell that already has
> the old function in memory — it ran the stale (pre-SIMD-hardening) function and
> built scalar. **ALWAYS `source ~/.zshrc` (or use a fresh shell) before running
> `chessgo-deploy` after editing it**, or it silently builds the old way. A build
> self-check (assert the binary isn't scalar before restarting services) would
> prevent this class of bug — see TODO.

**Prod (lairner, amd64 Ubuntu) is live on v6+SIMD.** `chessgo-deploy()` (in
`~/.zshrc`) was hardened to use the amd64 SIMD build line above (was `go1.25`,
scalar). `net.nnue` is promoted to v6. **Net + SIMD build must ship together** —
a v6 net on a scalar binary is a movetime wash. Rollback backups on the box:
`bin/gomachine.scalar-backup`, `data/nnue/net.nnue.v4-prod-backup`.

**A/B any two nets** (e.g. v6 vs v4) with the net-vs-net SPRT (forces concurrency 1):
```sh
./bin/gomachine bench sprt --new "" --old "" \
  --new-net data/nnue/net.nnue.v6-320 --old-net data/nnue/net.nnue.v4-prod-backup \
  --movetime 100 --nodes 0 --elo0 0 --elo1 6 --maxpairs 200
```
(Stop a run with **Ctrl-\**, not Ctrl-C — `bench sprt` traps the first SIGINT.)
