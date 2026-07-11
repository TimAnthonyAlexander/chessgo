# Retrain — efs28 + WDL-anneal on the prod mirror-KB arch (the "good pipeline" run)

**Status:** ✅ SHIPPED (2026-07-09) — **+18.8 ± 13.8 Elo @ movetime** (443 pairs, LLR +1.64, CI lb +5.0)
vs prod kb-mirror; net `chessgo_efs28_wdl06_640` (md5 92294de3) file-swapped over `data/nnue/kb-mirror.bin`.
See `ENGINE_STRENGTH.md §32`. WDL anneal remains the deferred follow-up.
**Superseded 2026-07-11:** efs28 is no longer prod — the SF full-threats net `chessgo_threats_sf_640`
replaced it (`data/nnue/kb-mirror.bin`, +10 vs efs28). This efs28 result stands as history.
**Owner:** engine
**Created:** 2026-07-08
**Lever:** data-pipeline quality (not arch, not search — both dry, HANDOFF-2026-07-08). Same net
topology as prod; fix the two weak pipeline knobs the 640-sb run left in place.
**Supersedes** the WDL/efs knobs of `data-retrain-640sb.md` (that doc kept them fixed for a
single-variable run; this run deliberately changes both — attribution traded for EV, gate is SPRT).

## What we train
The **current prod mirror-KB arch** (`chessgo_lean_threats.rs`: `H=512`, `NB=8`, 16 horizontal-mirror
king-buckets `PsqSize=12288` + `ThreatBlock=9216`, int16 tail) — **byte-identical topology to
`data/nnue/kb-mirror.bin`** — retrained on test80-2024 with the fixed data pipeline. Ships by
file-swap; zero node-cost change. net_id `chessgo_efs28_wdl06_640` (vN number assigned at ship).

## Δ vs past runs (the whole point)

| Knob | v12 (§29) | kbfact / **kb-mirror** (prod) | **THIS run** | Δ |
|---|---|---|---|---|
| early-fen skip | `ply≥16` | `ply≥16` | **`ply≥28`** | ✅ **CHANGED** — SF master-net cutoff (PR #4314); biggest lever |
| WDL blend | `ConstantWDL 0.6` | `ConstantWDL 0.6` | `ConstantWDL 0.6` | — **unchanged** (anneal deferred — scale mismatch, see note) |
| arch / width | lean+threats, 512 | **mirror-KB**, 512/NB8 | mirror-KB, 512/NB8 | — same as prod |
| superbatches | 320 | 320 | **640** | ✅ CHANGED vs prod (v12 loss still descending pre-anneal) |
| dataset | test80-2024 | test80-2024 | test80-2024 v6-dd | — unchanged |
| quiet filter | capture/promo drop | capture/promo drop | capture/promo drop | — unchanged (already smart-fen-skipping) |
| checkpoint | final `-320` | final `-320` | **final `-640`** | — same rule, longer run |

Everything else = the locked recipe in `data-retrain-640sb.md` (batch 16384 / bpsb 6104 / CosineDecay
0.001 full-anneal / AdamW defaults / int16 tail).

**Why WDL is left at 0.6 (settled by a two-AI debate, 2026-07-08 — not inherited).** The eval field
in test80 v6-dd is **Leela's own search eval** (Q→cp), NOT a deep-SF relabel (the lc0 "rescore" is
syzygy-TB on the *outcome* Z only — verified; `ENGINE_STRENGTH.md §29.1` corrected). So **both targets
are Leela-grade**: eval Q + result Z from the same self-play. That means the optimal blend sits near
the **middle of the Leela-data band** (result-weight 0.25 SF-on-Leela → 0.5 lczero-final), not pushed
toward pure-eval. `ConstantWDL 0.6` sits **just above** that band — plausibly a hair high, **not the
2.4×-SF outlier it looks like against a deep-SF eval** (that framing assumed an SF teacher we don't have).
- **0.4 rejected** — an overcorrection; it assumed a strong-SF eval to lean on. Void once eval = Leela-grade.
- **"short run → lower WDL" rejected** — NNUE averages Z's label-noise *spatially* (across similar
  positions), not by epoch count; at ~100M pos/sb the effect is ~neutral on WDL level.
- **0.5 vs 0.6 ≈ within noise** (both analyses) → switching has ~0 EV and would *confound* the efs+SB
  run (WDL is the one axis we'd want clean). So keep 0.6 → efs28+SB are the only new knobs, cleanly attributable.
- **WDL is a deferred single-variable knob**, not dead: if ever chasing the last sliver, A/B
  `ConstantWDL 0.4/0.5/0.6` **on top of this new baseline**, fixed-depth ≥2 or movetime. A *ramp*
  buys little at 640sb (§29.4). Polarity trap for any future ramp: bullet `wdl` = weight on
  game-result = **inverse** of SF `lambda` (anneal result-weight UP, NOT `0.75→0.5`).

## The 2 edits (`~/nnue-training/bullet/examples/chessgo_lean_threats.rs`) — DONE
1. `:392` — `entry.ply >= 16` → `entry.ply >= 28` ✅ applied
2. `:350` — `net_id` → `chessgo_efs28_wdl06_640` ✅ applied (distinct — reuse clobbers checkpoints)
- `:376–380` comment refreshed to reflect efs28 ✅. WDL line `:358` **left at `ConstantWDL 0.6`** (intentional).

## Pre-flight + launch + gate
Follows `data-retrain-640sb.md` D1–D4 verbatim, with these confirmed for this run:
- **D1 dataset** — already satisfied: `file_path` points at the four `/dev/shm/test80-2024-*.v6.binpack` (do not touch).
- **D2** — launch `SB=640` (default is 64); `final_superbatch = superbatches` at `:362` (verify).
- **D3** — `zstd -t` each of the 4 binpacks before launch (truncation trap, bit us twice).
- **D4** — ship the **final `-640`** checkpoint; save a `-560` insurance copy. Never pick by loss.
- **WDL-label sanity** — the one caveat that makes `λ≠pure-eval` *actively harmful*: confirm test80
  binpack game-results aren't garbled (known-good corpus, low risk, but check).
- **Box: rented NVIDIA/CUDA, 1TB RAM** (32GB disk is NOT enough — stage binpacks in `/dev/shm`, ~40GB decompressed).
- Launch: `SB=640 cargo r --release --features cuda --example chessgo_lean_threats` (~8h).
- **Gate at MOVETIME** (fixed-nodes lies): SPRT `--new-lean "<new>.bin,512,8" --old-lean
  "data/nnue/kb-mirror.bin,512,8"` @100ms, both `--lean-int8ft --lean-moveaware`, uncontended on
  coalla. Ship only if CI lower bound is **stably >0**. If it clears: swap `kb-mirror.bin`, file-swap ship.

## Not doing (this run)
- `random-fen-skipping=10` — no RNG hook in bullet's filter predicate (smallest lever; skip).
- **WDL anneal** — deferred to its own single-variable follow-up (see the WDL note above); not
  bundled here (scale mismatch + regime move).

## Related
`data-retrain-640sb.md` (base recipe + D1–D5), `docs/NNUE/DATA_RECIPE_SF_2026.md` (audit, WDL note fixed),
`ENGINE_STRENGTH.md` §29 (v12 data win), memory `nnue-ship-annealed-final` / `nnue-distinct-net-ids`.
