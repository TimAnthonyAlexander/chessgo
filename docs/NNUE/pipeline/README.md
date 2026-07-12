# NNUE training pipeline — re-executable recipe (SF_PARITY_ROADMAP Phase 1)

A **re-runnable** interleaved multi-source data pipeline for training the full-threats net.
This is Phase 1 of `../SF_PARITY_ROADMAP.md` — the named biggest lever — and it also
re-judges the threats net we already shipped (the fine geometry was data-starved).

Everything here defaults to the **exact shipped baseline** (`chessgo_threats_sf_640`,
test80-2024 Jan–Apr, sequential concat, `ConstantWDL 0.6`) and turns each Phase-1 improvement
into an **env lever**, so you can A/B one variable at a time and always reproduce prod.

## Where the pieces live

| Piece | Path | Role |
|---|---|---|
| Interleaved loader | `bullet/crates/bullet_lib/src/value/loader/sfbinpack.rs` | `new_interleaved_multiple` — round-robins sources ∝ file size *before* the shared shuffle buffer (batch decorrelation). Additive; `new_concat_multiple` unchanged. |
| Trainer | `bullet/examples/chessgo_ml_threats_sf.rs` | now env-configurable: `BINPACKS`, `INTERLEAVE`, `WDL_ANNEAL`/`WDL_START`/`WDL_END` (+ existing `SB`/`START_SB`/`NET_ID`/`WARMUP`). Defaults = shipped baseline. |
| `fetch-data.sh` | this dir | download + decompress test80-2024 months to disk, symlink into `/dev/shm`; resume-safe. |
| `train.sh` | this dir | resume-capable training wrapper (supervisor-friendly); finds the highest checkpoint, exits 0 when done. |

## The env levers (the trainer reads these)

| Env | Default | Effect |
|---|---|---|
| `BINPACKS` | built-in Jan–Apr | `:`-separated source list. Phase 1 = the full multi-source set. |
| `INTERLEAVE` | `0` (trainer) / `1` (`train.sh`) | `1` = round-robin sources per batch (decorrelation); `0` = sequential concat (baseline). |
| `WDL_ANNEAL` | `0` | `1` = `LinearWDL(WDL_START→WDL_END)`; `0` = `ConstantWDL(WDL_CONST=0.6)`. |
| `WDL_START`/`WDL_END` | `0.0`/`0.25` | anneal endpoints. bullet's WDL value = weight on **game result**, so `0.0→0.25` anneals result-weight **up** (= SF lambda 1.0→0.75; `DATA_RECIPE_SF_2026.md:35`). |
| `SB`,`START_SB`,`NET_ID`,`WARMUP`,`BPSB`,`OUT_DIR` | 640,1,`chessgo_threats_sf_640`,400,6104,`checkpoints` | unchanged. |

> ⚠ **WDL anneal is COUPLED to teacher quality** (`DATA_RECIPE_SF_2026.md:91-94`): our `0.6`
> was calibrated to raw test80-Q. Do **not** blind-ship an anneal — run it as a *single-variable*
> A/B (interleave fixed) and gate on movetime SPRT. Leaving `WDL_ANNEAL=0` reproduces prod.

## Run it (on the GPU box — see `[[gpu-train-box-recipe]]`)

```sh
# 0. provision: rent the box, ssh with the devgit key + IdentitiesOnly, clone/pull nnue-training,
#    apt-get install -y aria2 zstd, set CUDA_PATH (train.sh does the env).

# 1. data: download test80-2024 Jan-Jun, decompress to /root/data, symlink into /dev/shm.
#    Prints the BINPACKS=... line to feed the trainer.
MONTHS="01-jan 02-feb 03-mar 04-apr 05-may 06-jun" bash docs/NNUE/pipeline/fetch-data.sh

# 2. train (interleaved, all sources). FETCH=1 re-runs the fetch first (recreates /dev/shm
#    symlinks after a container bounce). Resumes from the highest checkpoint automatically.
FETCH=1 NET_ID=chessgo_ipl_640 SB=640 INTERLEAVE=1 FEATURES=cuda \
  bash docs/NNUE/pipeline/train.sh

# 2b. the WDL-anneal A/B (single variable, interleave held on):
FETCH=1 NET_ID=chessgo_ipl_wdl_640 SB=640 INTERLEAVE=1 WDL_ANNEAL=1 FEATURES=cuda \
  bash docs/NNUE/pipeline/train.sh
```

### Container-bounce hardening (multi-hour runs)

vast containers can stop/start mid-run — tmpfs (`/dev/shm`) + any `nohup` process die, disk
survives. Run `train.sh` under **supervisor** with `autorestart=unexpected`, `exitcodes=0`,
and `FETCH=1` so each restart recreates the `/dev/shm` symlinks and resumes from the highest
checkpoint. `train.sh` exits 0 once `latest >= SB`, so a completed run stops cleanly.

```ini
# /etc/supervisor/conf.d/chessgo-train.conf
[program:chessgo-train]
command=/bin/bash -lc 'FETCH=1 NET_ID=chessgo_ipl_640 SB=640 INTERLEAVE=1 bash ~/chessgo/docs/NNUE/pipeline/train.sh'
autostart=true
autorestart=unexpected
exitcodes=0
stdout_logfile=/var/log/chessgo-train.log
redirect_stderr=true
```

## Data sources

| Series | Status | Notes |
|---|---|---|
| test80-2024 **Jan–Apr** | shipped baseline | the 4 files `chessgo_threats_sf_640` trained on. |
| test80-2024 **May–Jun** | **Phase 1 — add** | same `linrock/test80-2024` HF repo; `fetch-data.sh` MONTHS default already includes them. SFNNv10+ uses Jan–Jun. |
| **T78 / T79** | **Phase 1 — needs prep** | next-oldest Leela series. HARD condition: **v6-dd (v6 filter + dedup) AND syzygy-rescored** or they regress (`DATA_RECIPE_SF_2026.md:73`). Confirm the exact HF paths + rescore infra before adding — do NOT feed raw old runs. Add to `BINPACKS` once prepared. |
| T60/T77, dfrc_n5000, tb5dtm, UHO | defer | marginal (`DATA_RECIPE_SF_2026.md:82-88`). |

## Export → validate → ship (unchanged, `[[nnue-ship-annealed-final]]`)

1. Take the **final annealed** checkpoint `checkpoints/<NET_ID>-<SB>/quantised.bin` (never a mid-run one).
2. A/B **directly vs the current prod net** — FN + **movetime SPRT** on coalla (AVX-512); gate on
   the movetime lower bound. Periodic Abitur anchor (SF18/Stormphrax/Reckless).
3. Ship only on a clear positive: `cp quantised.bin gomachine/data/nnue/kb-mirror.bin` (place the
   file **before** the SIMD rebuild or the binary falls back to embedded v6), then `chessgo-deploy`
   on lairner. The Go side imports at load and deploys the threat-FT at **int16** (lossless; int8-FT
   fails `TestKBNetClampCount`).

## Measurement discipline (every phase)

- One variable per A/B (`[[sprt-direct-vs-prod-and-fn-mt]]`); interleave and WDL are separate levers.
- **Gate on movetime SPRT**, not FN (an FN win can wash at MT).
- More **unique** data, not more epochs — superbatch count scales with dataset size, not clock
  (`SF_PARITY_ROADMAP.md §5`).
