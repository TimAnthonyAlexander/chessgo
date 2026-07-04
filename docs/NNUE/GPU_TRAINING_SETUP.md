# Rented-GPU training setup — turnkey checklist

> **Dated 2026-07-03.** For training the enriched (threats) NNUE on a rented Linux/NVIDIA
> GPU box with `bullet` (instead of the M3's Metal build). The target run is the
> **multilayer int8 + int8-FT** net (the next experiment; see `ARCH_DIRECTION.md §4`).
> Provider recommendation is being researched separately — slot it into step 1.

## Why a rented box
- The M3 does a 320-sb run in ~5–7 h and monopolizes the laptop. A rented NVIDIA GPU is
  faster and frees local hardware; several iteration runs are cheaper/quicker there.
- **bullet is usually data-loader (CPU) bound, not GPU-bound** — pick a box with a mid GPU
  **and** 8–16+ CPU cores + fast NVMe, not a monster GPU with few cores.

## The two things that make a fresh box non-trivial (don't miss these)
1. **Our bullet clone is PATCHED and has UNTRACKED example files.** You cannot just
   `git clone jw1912/bullet`. The local `~/nnue-training/bullet` has:
   - a working-tree **STE fix** (`crates/compiler/src/tensor/operation/pointwise/unary.rs`
     — `Round`/`Truncate` backward = straight-through; without it QAT panics),
   - the **`chessgo_*.rs` examples** (untracked: `chessgo_enriched.rs`,
     `chessgo_lean_threats.rs`, etc.) + their `Cargo.toml` registration + Metal `run.rs`
     wiring.
   ⇒ **rsync the whole local `~/nnue-training/bullet` to the box** (simplest), OR clone
   upstream + copy those specific files. Metal-specific `run.rs` bits are harmless on CUDA.
2. **The ~38 GB `pool.binpack` dataset** (`~/nnue-training/pool.binpack`) must be on the box.
   rsync it up (slow over home uplink — budget hours) OR re-download the source SF binpack
   directly on the box (much faster from a datacenter). Prefer the latter if we still have
   the source URL (`docs/NNUE/DATA_PIPELINE.md` lists the SF binpack names).

## Checklist (in order)
1. **Rent the box — Vast.ai RTX 4090** (provider research, 2026-07-03). On the marketplace,
   **filter: reliability ≥ 0.99, vCPU ≥ 16, RAM ≥ 64 GB, disk ≥ 100 GB NVMe**, good up/down
   Mbps; prefer **On-Demand** over Interruptible (don't get outbid mid-run). ~$0.29–0.39/hr
   → **under ~$2 per ~4 h run**, ~$10–15 for the whole iteration campaign (a 3090 host is
   even cheaper and trains this tiny net fine). Pick a **plain Ubuntu 22.04 + CUDA** image
   (e.g. `nvidia/cuda:12.x-devel-ubuntu22.04`), NOT a Jupyter-only template, so `nvcc` is
   present for `cargo build --features cuda`. Vast reliability varies by host — the
   reliability filter is not optional; a low-rel host can vanish mid-run. **Fallback:**
   TensorDock RTX 4090 ($0.37 on-demand / $0.20 spot, cleanest KVM+root). **Avoid** RunPod
   community for this (fixed 6-vCPU bundle bottlenecks the CPU loader; idle storage billed).
   **Tear the box down when done** — Vast bills storage while merely stopped; at 38 GB,
   re-uploading next run usually beats days of idle storage.
2. **Toolchain:** confirm CUDA toolkit present (`nvcc --version`); install Rust
   (`curl https://sh.rustup.rs -sSf | sh`).
3. **Get bullet:** `rsync -az ~/nnue-training/bullet/ <box>:~/bullet/` (carries the STE
   patch + chessgo examples). Verify the STE fix is present in `unary.rs`.
4. **Get data:** rsync `~/nnue-training/pool.binpack` up, or re-download the SF binpack on
   the box and (if needed) rebuild `pool.binpack`. Confirm size (~38 GB) + path.
5. **Config edit (int8-FT losslessness) — VERIFY before running.** For the int8 threat
   columns (`QuantizeFTInt8`) to be lossless, the FT **threat** weights must satisfy
   `|round(W·255)| ≤ 127`, i.e. `|W| ≤ ~0.498`. The current `chessgo_enriched.rs` does NOT
   constrain this (config audit, 2026-07-03). **This is a weight-CLIP/constraint on the l0
   threat weights, not a simple `faux_quantise` — needs a closer look at bullet's API
   before applying.** If unsure, run the FIRST retrain WITHOUT int8-FT (primary int8-tail
   path is already retrain-ready per the audit), measure, then add int8-FT once the clip is
   confirmed. Do NOT guess-edit the config and silently train a clamped (lossy) net.
6. **Build:** `cd ~/bullet && cargo build -r --features cuda` (the Metal build uses
   `--features metal`; confirm the CUDA feature name in `Cargo.toml`).
7. **Smoke test:** `SB=4 cargo r -r --features cuda --example chessgo_enriched` — confirms
   the pipeline (loader finds the data, GPU trains, checkpoint saves) before the real run.
8. **Full run:** `SB=320 cargo r -r --features cuda --example chessgo_enriched`
   (v6 shipped at 320-sb; the anneal is worth ~+220 Elo — **never early-stop it**).
   Save format is float `raw.bin` at `checkpoints/chessgo_enriched-320/`.
9. **Retrieve + measure:** rsync `checkpoints/chessgo_enriched-320/raw.bin` back to local
   (and to coalla). Then movetime SPRT on coalla vs **v6 AND the lean net**
   (`gomachine bench sprt --new-enriched "...,512,16,32,8" --enriched-int8 [--enriched-int8-ft]`)
   at `--movetime`, never fixed-nodes.

## Cost/rhythm note
Data upload dominates the first setup (~38 GB over home uplink). After that, each iteration
is just the ~2–6 h GPU run + a few-MB net pull. Stop/deallocate the box between runs to
avoid idle billing (watch for providers that bill storage while stopped).
