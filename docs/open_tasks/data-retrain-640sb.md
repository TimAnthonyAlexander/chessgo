# Data retrain — 640-sb, 512-wide, test80 (the next net)

**Status:** open — READY TO LAUNCH, pending a rented GPU + the test80 binpack path.
**Owner:** engine
**Created:** 2026-07-05
**Lever:** data is the proven live lever (v12 = v9 arch retrained on test80 → +24 movetime).
This is option (a) from the recipe audit: same arch, more training, better data. Safest +,
zero node-cost risk, ships by file-swap. (Option (b), width→1024, is deferred — int16-bound,
~1.7× node cost, only ever tested as a 32-sb stub. Do (a) first.)

## ⚠️ MUST-FIX-BEFORE-LAUNCH checklist (the retrain-then-realize killers)

From the recipe audit (`docs/NNUE/ARCH_DIRECTION.md` §6, `ENGINE_STRENGTH.md` §29). Each of these,
if missed, silently wastes the entire GPU run:

- **D1 — DATASET PATH.** The committed `chessgo_lean_threats.rs` still points `file_path` at the
  **old, weak `pool.binpack`** (2021 SF-14 pool). Training as-is silently reproduces v9 and burns
  the GPU with no error. **→ Set `file_path` to the test80-2024 binpack** (the same data v12 used;
  Leela T80 self-play, SF-rescored). Supply the actual path at rental time.
- **D2 — SUPERBATCHES.** `SB` defaults to **64** (a PoC stub). **→ Launch with `SB=640`.** Verify
  `final_superbatch = superbatches` (full cosine anneal to the end).
- **D3 — DATA INTEGRITY.** The `curl | zstd -dc >>` streaming-decompress trap silently truncated the
  binpack → 100% loss (bit us twice). **→ Download-to-disk, then `zstd -t <file>` to verify BEFORE
  launching.** Non-negotiable pre-flight.
- **D4 — CHECKPOINT.** Take the **final `-640` annealed** checkpoint, NOT the min-loss one. The loss
  curve has a benign center-minimum then rises; min-loss is −56 Elo vs the annealed final. Never
  early-stop on the loss plateau. (§29.4 / §12.1: the +220 anneal swing.)
- **D5 — FT-weight QAT gap: DEFER (do NOT fix for this 512 run).** The int8-FT leak is real but on
  the lean net int8-FT nets +11…+28 movetime anyway (memory-speed masks it). It only matters at
  1024+. Leave the config as-is; note it for the width bet.

## The LOCKED recipe (every knob; base = v12's twice-SPRT-won config, only SB changes)

| Knob | Value | Why |
|---|---|---|
| Example / arch | `chessgo_lean_threats` — lean single-layer + threats, dual-perspective | shipped champion arch |
| FT width `H` | **512** | proven v12 width (`const H` in the .rs, NOT the stale 1024 in the header comment) |
| Inputs | 768 psq + 9216 threats = 9984 | byte-matched to Go `appendEnrichedFeatures` |
| Output buckets `NB` | **8**, MaterialCount = `(popcount−2)/4` | train↔infer verified identical |
| Activation | SCReLU, `QA=255` + `faux_quantise(255)` QAT on the FT activation | matches Go `ftQA=255` |
| Tail | int16 PTQ (`leanTailQB=1024`), no QAT | int16-bound single-SCReLU tail, lossless by headroom |
| WDL λ | **ConstantWDL 0.6** | what v9+v12 both won with; keep fixed (single-variable run) |
| Superbatches | **640** | v12's 320 loss was still descending pre-anneal → room to give |
| batch / bpsb | 16384 / 6104 | bullet canonical superbatch (~100M pos) |
| LR + anneal | CosineDecayLR 0.001 → full anneal, `final_superbatch = SB`, no warmup | anneal is load-bearing (+220) |
| Optimiser | AdamW defaults (decay 0.01, clip ±1.98) | v12 used unmodified |
| Dataset | **test80-2024 binpack** (path corrected from pool.binpack — D1) | the whole point |

## Launch runbook (on the rented GPU box, bullet + Metal/CUDA)

1. Download test80-2024 binpack **to disk**; `zstd -t <file>` → must pass (D3).
2. Edit `~/nnue-training/bullet/examples/chessgo_lean_threats.rs`: set `file_path` = the test80 path (D1).
   Confirm `const H = 512`, `NB = 8` (D-note: ignore the stale 1024 header comment).
3. Launch: `SB=640 cargo r --release --example chessgo_lean_threats` (D2). ~8h (v12's 320-sb ≈ 4h, linear).
4. Take the **final `-640`** checkpoint (D4). Save it + an insurance `-560`ish checkpoint.
5. Import + validate on our side before shipping (see below).

## Acceptance (before shipping the net)

- Import the raw net, quantize as prod does (`QuantizeFTInt8` + move-aware) — confirm it loads
  (`H=512 NB=8`, "routing eval through v9/v12").
- **Gate at MOVETIME** (the ship rule — fixed-nodes lies, proven again 2026-07-05): SPRT
  `--new-lean "<new>.bin,512,8" --old-lean "data/nnue/v12.bin,512,8"` @ 100ms, both `--lean-int8ft
  --lean-moveaware`. Ship only if the CI **lower bound is STABLY >0** (not a low-pair spike — the
  rfpsoft lesson: +19/lb+7 @119 pairs collapsed to +2/lb−6 @295).
- If it clears: swap `data/nnue/lean.bin → <new>.bin` (or update `v12.bin` symlink), file-swap ship,
  no code change (`loadEnrichedDefault` applies int8-FT + move-aware automatically).

## Related
- `docs/NNUE/ARCH_DIRECTION.md` §6 (defect audit, FT-weight QAT gap), `docs/ENGINE_STRENGTH.md` §29 (v12 data win).
- `docs/open_tasks/long-tc-sweep.md` (validate the shipped stack at long TC before a CCRL re-anchor).
