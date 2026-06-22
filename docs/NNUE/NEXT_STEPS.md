# NNUE — next steps ladder (researched 2026-06-22)

> Prioritized, sourced plan for what to do **after v6 (512-wide)**. Compiled from a
> multi-source deep-research pass (Stockfish nnue-pytorch docs, bullet docs, SF
> commits/regression tests, Alexandria/Stormphrax/Viridithas, an arXiv data paper),
> with adversarial verification (3-vote per claim, 21 confirmed / 4 refuted). Tailored
> to gomachine's exact design: **plain Chess768 input, (768→HL)×2→1, SCReLU, int16
> quantized, absolute-color accumulator with NO refresh path.**
>
> **Golden rule:** every source Elo number is from *that engine's* SPRT at *its* TC and
> does **not** transfer 1:1 to gomachine's 100ms movetime / rating pool. Treat all
> figures as direction + rough magnitude; **re-SPRT every change locally at 100ms.**
> See `docs/ENGINE_STRENGTH.md` for the SPRT workflow.

---

## TL;DR ladder

| # | Step | Class | Elo (source) | Effort | Compute | Touches no-refresh accumulator? |
|---|---|---|---|---|---|---|
| 1 | **Width 512 → 1024** | **free win** | positive, diminishing (see §1) | low | ~2× v6 | **No** |
| 2 | **Output buckets (8, piece-count) + small deeper head** | **free win** | standard practice; per-engine Elo unquantified | low | ~flat | **No** |
| 3 | **Data scale-up + eval-distribution rebalance** | enabler | gates everything > 1024 | low–med | n/a | **No** |
| 4 | **Width 1024 → 1536** | conditional | +27 @25k nodes but **failed STC/LTC** in SF | low | ~3× v6 | **No** |
| 5 | **King-bucketed inputs (HalfKAv2_hm or small custom scheme)** | **structural project** | +15–40 (Alexandria) | **high** | more data-hungry | **YES — abandons the invariant** |

**Free wins = steps 1–2** (pure bullet config + retrain, no engine-side refresh change;
our SIMD kernels are already width-agnostic and `Net.HL` is dynamic). **Structural =
step 5** — the only step that forces giving up the no-refresh absolute-color design.
**Step 3 (data) is the gate** that decides how far 1/4/5 can actually go.

---

## 1. Width 512 → 1024 — the biggest single lever (FREE WIN, do first)

- **Why first:** SF/bullet docs — *"The number of outputs in the first layer is the most
  crucial parameter, and also has the highest impact on speed and size."* L1 width is
  THE architectural knob.
- **Elo:** positive but **diminishing per doubling**, and the gain accrues mostly at
  higher depth/compute. There is **no clean verified isolated-width Elo number at short
  movetime** in the literature (the curve is anchored at only two SF points, below), so
  **gomachine must SPRT it locally at 100ms.** Our own history says we're still low on
  the saturation curve (256→512 gave us **+124 @ fixed / +101 @ movetime**, far more than
  SF gets), so 1024 should still be clearly positive at 100ms — but **expect less than
  +101**, and watch for the NPS hit.
- **Effort:** trivial — `HIDDEN 1024` in the bullet config + retrain. The hardcoded-256
  bug is already fixed (`Net.HL` dynamic, slice accumulator, importer infers width from
  file size), and the AVX2/NEON kernels are tested bit-exact at widths up to 513. No
  engine refresh change.
- **Compute:** ~2× v6's 4h21m on the M3 Pro Metal (so ~8–9h, likely less if
  data-loading-bound); ~1–2h on a rented 4090. See §7.
- **Accumulator:** untouched (plain 768, no king features → no refresh).

**Verified anchor points (the whole measured width curve):**
- **SF 256 → 512** (bundled with HalfKAv2 + output buckets): **+21.7 Elo @ 10s**,
  **+5.85 @ 60s**, ~15–20% slower, ~2× larger. *(the drop 21.7→5.85 IS the
  diminishing-returns / efficiency-loss signal.)*
- **SF 1024 → 1536** (SFNNv6): **+26.9 ± 1.6 @ 25k nodes**, but **FAILED STC (LLR −2.94)
  and LTC (−1.91)**, passed **only VLTC** (LLR 2.95). → width past ~1024 is **depth-
  sensitive and can be net-negative at short TC.**

> **⚠ DO NOT CITE (refuted in verification):** "Alexandria 512→1024 = +68.87 Elo" (0-3),
> "SF 256x2-32-32-1 → 1024x2-8-32-1 as the modern template" (0-3). These were extracted
> then killed — they are wrong.

---

## 2. Output buckets + small deeper output head (FREE WIN, cheap)

- **What:** replace the single `2·HL→1` output with **8 piece-count output buckets**,
  each a small head, selecting the bucket by `(popcount(pieces)-1)/4` per eval. Optionally
  deepen the head (e.g. `2·HL→16→32→1`).
- **Precedent:** Stockfish uses **8 output-bucket subnetworks (`512x2-16-32-1`)** + 8 PSQT
  values; Stormphrax mirrors **8 buckets + `16x2-32-1`** head. Standard in modern
  bullet-trained engines.
- **Elo:** **standard practice but per-engine isolated Elo is unquantified** — the specific
  Alexandria "+26.46 (buckets)" and "+28.84 (multi-layer head)" numbers were **refuted in
  split votes (1-2)**, so don't quote them. Expect a modest-but-real gain (a handful of
  Elo); SPRT to find the real number.
- **Effort:** low — bullet config; inference-cheap (one bucket evaluated per position).
- **Accumulator:** untouched.

---

## 3. Data scale-up + eval-distribution rebalance — the GATE (do alongside 1–2)

bullet docs, verbatim: *"Just start with basic 768 inputs. You won't have enough data for
things like HalfKA/HalfKP at first (or perhaps ever; custom bucket schemes will generally
serve better with less data)."* Data is what decides how far you can widen/bucket.

- **King-bucketing splits the same data across 40960+ sparse features** (~50× fewer
  samples per feature), so step 5 is **far more data-hungry** than width.
- **Action items:**
  1. **Count gomachine's binpack positions** (open question — we don't know the number) and
     sanity-check it's enough for a 1024/1536-wide plain-768 net without overfitting.
  2. **Check & rebalance the eval-target distribution.** Since we already train on Stockfish
     binpack (largely pre-filtered), this is the highest-value cheap data lever, not
     re-filtering. Target shape (medium confidence, single arXiv preprint 2412.17948):
     ~50% positive / 50% negative STM evals, **≥50% within [−100,100] cp**, **≥40%
     materially imbalanced**.
  3. Label-quiet filtering thresholds, if we ever generate our own data: reject if
     `|static − quiescence| > ~60cp` or `|static − shallow-negamax| > ~70cp`, exclude
     in-check positions (margins are engine-specific starting points — tune by testing).
- **Effort:** low–medium. **Accumulator:** untouched.

---

## 4. Width 1024 → 1536 — CONDITIONAL, gate hard at 100ms

- **Elo:** SFNNv6 (1024→1536) was **+26.9 @ 25k nodes but FAILED STC and LTC**, passing
  **only at very-long TC.** At gomachine's **100ms movetime**, this is exactly the regime
  where a wider net's **NPS loss can eat the eval gain** → likely the first width step that
  goes **net-negative** for us.
- **Verdict:** only attempt after step 3 (enough data) AND if a 1024 SPRT shows headroom.
  **Mandatory 100ms SPRT**; do not ship on a fixed-nodes win alone (fixed-nodes flatters
  width — see `docs/ENGINE_STRENGTH.md §6.4`). Effort low (config), compute ~3× v6.
- **Accumulator:** untouched.
- **Context:** SF has since gone to **L1 = 3072**, so 1536 is a lower bound on *top-engine*
  practice — but those run at much longer TC than 100ms. Width ≠ free at our clock.

---

## 5. King-bucketed inputs (HalfKAv2_hm / small custom scheme) — STRUCTURAL PROJECT, do LAST

- **The Elo:** the proven structural upgrade. **Alexandria v8.0.0** went 1 → **16 input
  (king) buckets** (`(768-1536x16)x2-1x8`, HL 2048→1536), gaining **+14.89 (balanced) to
  +42.25 (unbalanced)**. Stormphrax ships `(704x16hm-1792)x2-(16x2-32-1)x8`. So **~+15–40
  Elo** eventually.
- **The cost — this is the crux for gomachine:** SF docs, verbatim — *"when the king moves,
  all features change, so an accumulator refresh is executed."* Every feature is keyed on
  the king square (HalfKP = `(our_king_square, piece_square, piece_type, piece_color)` =
  40960 features). **This directly destroys gomachine's deliberate no-refresh
  absolute-color invariant** — the thing that currently makes null moves AND king moves
  cheap deltas with zero refresh path (and sidesteps the whole worst accumulator-bug
  class). King-bucketing **forces the refresh path back in.**
- **Mitigation, not avoidance:** per-king-square accumulator caches (**"Finny tables"**)
  amortize refreshes, but the refresh path still has to exist and be correct.
- **Data-efficient middle ground (bullet's own recommendation):** a **small custom bucket
  scheme** (e.g. king-side mirror only, or 2–4 buckets) captures much of the king-bucket
  Elo with **far less data hunger** than full HalfKA — but still introduces a refresh path.
  This is the halfway design worth prototyping before committing to full HalfKAv2_hm.
- **Effort:** **high** — accumulator rewrite + refresh + Finny tables + retrain (more data,
  step 3 first) + re-verify ALL bit-exact incremental==scratch and SIMD gates + `-race`.
- **Decision:** worth it eventually, but it's the **only** step that costs the no-refresh
  invariant, so it goes **after** the free wins have been banked and SPRT-confirmed.

---

## 6. Activation & other notes

- **SCReLU (already ours) is the modern choice** — no verified claim surfaced that switching
  activation (ClippedReLU etc.) helps from SCReLU; leave it. (Viridithas activation writeups
  cited as background, no actionable Elo delta.)
- **Cosine LR anneal stays load-bearing** (our own v6 finding: un-annealed lowest-loss = −96
  vs annealed final +124). Carry the full cosine schedule into every retrain; never
  early-stop on the loss plateau.

---

## 7. Training compute — NOT a blocker (free win)

- **bullet officially supports Apple Silicon Metal** as a first-class backend (real `metal`
  cargo feature, objc2-metal + MPS; docs: just "enable the metal feature" vs CUDA/ROCm
  toolchain setup). It's *"used for training NNUE-style networks for many of the strongest
  chess engines in the world"* (Stormphrax, Viridithas v11+, Obsidian, Alexandria). **No
  cloud or CUDA GPU is required** even for wider / king-bucketed nets.
- **Scaling:** wall-clock scales **~linearly** with width on the same hardware (v6 512-wide =
  4h21m / 320 superbatches → 1024 ≈ ~2×). King-bucketing is costlier mostly via **data**,
  not FLOPs.
- **Renting is for convenience, not necessity** (the "run it overnight, fans off, laptop
  asleep" case): a single **RTX 4090** (vast.ai ~$0.30–0.50/hr, RunPod ~$0.34–0.70/hr) or a
  **3090** is ideal — NNUE nets are tiny; don't waste money on A100/H100. A full overnight
  run is ~$2–3. bullet's CUDA backend on NVIDIA is faster than Metal.
- **Data transfer — pull on the box, not from home.** The ~40 GB of public Stockfish binpack
  data should be **`wget`/`rclone`/`aria2c`'d directly onto the rented box** over its
  multi-Gbps datacenter link (lands in minutes). Home uplink is irrelevant. *Only*
  locally-generated data (our own self-play / blunder-mined EPDs) ever needs pushing up —
  and even then our fiber uplink (~253 Mbps measured Wi-Fi, gig symmetric wired) does 40 GB
  in ~20–40 min. Put the dataset on a **persistent volume** so it's uploaded once.
- **Workflow:** spin up 4090 → `wget` data → `cargo build --release` bullet (CUDA) → train in
  `tmux`/`nohup` (survives SSH drop / laptop sleep) → pull the few-MB net back → done.

---

## 8. gomachine-specific open questions (must answer locally — no source covers these)

1. **Isolated width Elo at 100ms** (512→1024→1536, feature set + data fixed) — unmeasured
   anywhere; SPRT locally to find where width turns net-negative at our clock.
2. **NPS cost of widening in OUR AVX2/NEON kernels** — the Elo verdict hinges on
   gomachine's exact NPS-loss-per-width, which differs from Stockfish's. Measure it.
3. **How many positions is our ~40 GB binpack?** Enough for 1024/1536 plain-768 without
   overfit? What count makes HalfKAv2_hm worthwhile?
4. **Could a small custom king-bucket scheme (king-mirror / 2–4 buckets)** capture most of
   the king-bucket Elo while minimizing refresh complexity — a halfway design that doesn't
   fully abandon the no-refresh invariant?

---

## 9. Sources (primary unless noted)

- Stockfish nnue-pytorch docs (the "NNUE from scratch" reference):
  <https://github.com/official-stockfish/nnue-pytorch/blob/master/docs/nnue.md>,
  <https://official-stockfish.github.io/docs/nnue-pytorch-wiki/docs/nnue.html>
- SF net commits / regression tests: SFNNv6 width
  <https://github.com/official-stockfish/Stockfish/commit/c1fff71>,
  HalfKAv2+buckets <https://github.com/official-stockfish/Stockfish/commit/e8d64af1230fdac65bb0da246df3e7abe82e0838>,
  <https://github.com/official-stockfish/Stockfish/wiki/Regression-Tests>
- bullet trainer: <https://github.com/jw1912/bullet>,
  <https://github.com/jw1912/bullet/blob/main/docs/1-basics.md>
- Engine references: <https://github.com/Ciekce/Stormphrax>,
  <https://github.com/PGG106/Alexandria/releases>,
  <https://github.com/cosmobobak/viridithas>
- Data/quiet-filtering preprint (medium confidence): <https://arxiv.org/abs/2412.17948>
- Background: <https://www.chessprogramming.org/NNUE>,
  <https://www.chessprogramming.org/Stockfish_NNUE>, <https://beuke.org/nnue/>

> **Refuted numbers — never cite (killed in verification):** Alexandria 512→1024 = +68.87
> (0-3); SF 256→1024-as-modern-template (0-3); Alexandria 1536+8-buckets +26.46 (1-2);
> Alexandria multi-layer head +28.84 (1-2). The only firmly-verified width datapoints are
> the two SF results in §1/§4.
