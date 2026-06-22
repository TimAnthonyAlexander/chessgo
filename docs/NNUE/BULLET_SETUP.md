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

## v5 maturity net — ready to run (don't start without intent)

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
