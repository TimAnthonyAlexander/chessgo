# NNUE pipeline runs (ready-to-fire)

Each GPU run is **~€5 + ~12 h**, so a run is not spent on a single speculative knob — it's spent on
the **maximal evidence-backed improvement**, then A/B'd **directly vs the current prod net** at
movetime on coalla (`[[sprt-direct-vs-prod-and-fn-mt]]`), then an Abitur anchor. Ship only on a clear
positive movetime lower bound; ship the **final annealed** checkpoint (`[[nnue-ship-annealed-final]]`).

---

## Run 1 — heterogeneous rescored interleave  **[THE next run]**

**What it is.** Train the current full-threats arch on a genuinely richer, more diverse corpus — the
roadmap's actual Phase-1 thesis (data > arch), moving toward SF's own recipe (SF trains on the full
test60–80 mix, all rescored). **All sources are already syzygy-rescored + v6[-dd]** on HuggingFace
(the `tb7p` token = 7-piece-TB rescored; verified vs linrock's HF trees + SF PR #4782 + the lc0
rescorer docs) — so this is a **pure download, no self-rescore, no infra**.

**The data (`run1.manifest`, ~65 GB .zst, ~150 GB decompressed):**
- **test80-2024 Jan–Jun** (~52 GB) — the proven-best contemporaneous teacher, the **dominant ~80%**.
- **test79-2022 apr+may** (~13 GB, `*.v6-dd.min`) — a **~20% diversity additive** (older, weaker
  teacher → deliberately a minority of the mix).

**Why this mix (the design decisions):**
- **Heterogeneous is where interleave pays.** Interleaving test80 *months* is a no-op (same
  distribution; the 16.7M shuffle buffer already decorrelates within-source). Interleaving test80 **vs
  test79** (different Leela generation) is the real thing — `INTERLEAVE=1` keeps every batch
  source-balanced so the optimizer never swings toward whichever source it's draining. So run 1 is a
  **coherent single lever** ("SF-recipe diverse-data pipeline"), not a confounded bundle — interleave
  and heterogeneous data are inseparable.
- **test80 stays ~80%.** Interleave samples ∝ file size, so test79 is a diversity *additive*, not a
  distribution takeover — directly limiting the old-data regression risk the recipe warns about.
- **Held for run 2:** test78 (30 GB — would push 2022 data to ~44%), test77-dec, test60 (marginal,
  `DATA_RECIPE §roadmap 4`). Add them only if run 1's test79 addition helps.
- **WDL stays 0.6** (the proven raw-label value). Do NOT also anneal it here — one lever per run; the
  WDL anneal is a separate knob (below), not worth its own €5 run.

**Run it (GPU box — `[[gpu-train-box-recipe]]`; needs ~200 GB disk for the decompressed set):**
```sh
# 1. data: download + decompress the manifest, symlink into /dev/shm, emit BINPACKS=
MANIFEST=docs/NNUE/pipeline/run1.manifest bash docs/NNUE/pipeline/fetch-data.sh

# 2. train — interleaved, all sources, 640 sb, everything else = prod defaults.
#    FETCH=1 re-runs the fetch first (recreates /dev/shm symlinks after a container bounce).
FETCH_MANIFEST=docs/NNUE/pipeline/run1.manifest \
FETCH=1 NET_ID=chessgo_hetero_640 SB=640 INTERLEAVE=1 FEATURES=cuda \
  bash docs/NNUE/pipeline/train.sh
```
(If `train.sh`'s `FETCH=1` should use the manifest, pass `MANIFEST=<...>`; it forwards env to
`fetch-data.sh`. Otherwise run step 1 once manually and pass the printed `BINPACKS=...` to step 2.)

**Measure.** Copy `checkpoints/chessgo_hetero_640-640/quantised.bin` to coalla; SPRT vs prod at
movetime:
```sh
KB_NET_PATH=data/nnue/ft_final.bin ./bin/gomachine_simd bench sprt \
  --new-enriched "<path>/quantised.bin,512,16,32,8" --old "" --movetime 100 --maxpairs 3000
```
Gate on the movetime lower bound; then an Abitur anchor (SF18/Stormphrax/Reckless).

**Reading the result:**
- **Wins** → ship, and run 2 = add test78 (+ maybe test77/60), same interleave.
- **Washes/loses** → the diverse-data lever needs the mix tuned (lower the test79 fraction) or the
  labels reconciled (WDL re-calibration for the blended-Q) — a *diagnosed* second run, not a reroll.

---

## A knob to fold in later, NOT its own run — WDL anneal

`LinearWDL{0.5→0.7}` (result-weight up over training: eval-heavy early, result-heavy late — standard
NNUE practice; mean-matched to our `ConstantWDL 0.6`). Available as a one-flag lever
(`WDL_ANNEAL=1 WDL_START=0.5 WDL_END=0.7`). **Do not spend a €5 run A/B-ing this alone** — it's a
coin-flip on raw labels (`DATA_RECIPE §34.3`: our 0.6 was calibrated to raw test80-Q; don't blind-copy
SF's eval-heavy numbers). If a future run is being spent anyway, it can ride along as a second variable
only once the data lever is settled and we accept the small confound.

## Source reference

Full verified source tables (repos, filenames, sizes, what's rescored vs raw) in
`../DATA_RECIPE_SF_2026.md` and the research notes. Key: `linrock/{test80-2024,test79,test78,test77,
test60}`, URL `https://huggingface.co/datasets/<repo>/resolve/main/<file>`. `tb7p` = rescored,
`v6-dd` = v6 filter + dedup, `min` = minimized (training-equivalent). Avoid bare `.tar.zst` (raw) and
`bullet-training-data` (`.bullet.bin`, wrong format).
