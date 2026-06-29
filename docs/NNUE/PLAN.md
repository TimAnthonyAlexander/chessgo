# NNUE — phased implementation plan

> The build plan for replacing gomachine's linear HCE judge with a learned NNUE
> eval. Background/theory: `BASICS.md`, `HCE_TO_NNUE.md`, `OTHER_SYSTEMS.md`.
> Strength methodology (SPRT, books): `../ENGINE_STRENGTH.md`.
>
> **One-line philosophy (unchanged):** the eval is a swap behind a stable
> boundary (`eval(pos) → side-to-move cp`); we keep HCE compiled in as the
> fallback + correctness oracle, and **SPRT gates every step** exactly like the
> search patches. Correct-but-slow first, fast second.

---

## ⚙️ Trainer lineage — read this first

**We train with `bullet`, not our own trainer.** Two generations exist; don't
confuse them:

| Nets | Trainer | Hardware | Status |
|---|---|---|---|
| **v1–v3** | Go-native CPU (`internal/nnuetrain`, this repo) | M3 Pro CPU | **Legacy.** Gradient-check-correct but **data-starved** (−120 to −332 vs HCE). Kept only as a correctness oracle — *not* used to train shipped nets. |
| **v4 (shipped), v5 (maturity)** | **`bullet`** (jw1912/bullet, Rust) | **M3 Pro Metal GPU** | **Current — the trainer going forward.** Reads our 38–40 GB SF binpack at ~2.7M pos/sec (~7× the Go trainer). v4 is the shipped net (+212 Elo @ movetime); v5 is the longer "maturity" retrain. |

The Go trainer's only lasting value: its finite-difference gradient check
*proved* the v1–v3 failures were **data**, not math — which is what justified the
pivot to bullet + 40 GB of Stockfish data. bullet itself is **third-party,
out-of-repo** (`~/nnue-training/bullet`); only our **importer**
(`internal/nnue/bulletimport.go`, `nnue-import-bullet`) and the net file
(`data/nnue/net.nnue`) live here. Rig setup, configs, patches, and the v5 run
command: **`BULLET_SETUP.md`**. As-built record: §4 below + `../ENGINE_STRENGTH.md §11`.

---

## 0. Decisions locked (2026-06-21)

| Decision | Choice | Why |
|---|---|---|
| **Feature set** | **768 piece-square, dual perspective** (6 types × 2 colors × 64) | King is an ordinary piece → **no king-relative refresh**, the worst accumulator-bug source. Every move is a single remove+add delta. Fits our ~1.6M positions (HalfKP's 40,960 sparse features are under-determined at this data size). Clears current HCE comfortably. The trainer, loaders, accumulator stack, and invariant test **all transfer to HalfKA later** — this is a base, not throwaway. |
| **Trainer** | ~~Go-native~~ → **`bullet` on Metal GPU** *(superseded — see §4 v4)* | The Go-native bet (CPU is fine at 1.6M positions) was right *at that data size* but the real lever turned out to be **far more data** (40 GB), where CPU is the limiter. `bullet` reads our SF binpack at ~2.7M pos/sec on the M3 Pro's Metal GPU (~7× the Go trainer) and trained the shipped net. The Go trainer (`internal/nnuetrain`) is legacy; its gradient-check correctness is what *proved* the failures were data, not math. |
| **First architecture** | `(768 → 256)×2 → 1`, ~~ClippedReLU~~ **SCReLU**, float32→**int16** *(SCReLU/int shipped)* | Simplest net that beats linear HCE. One feature transformer (shared weights, two perspectives), concat stm-first → 512, single output. SCReLU (clamp²) replaced ClippedReLU (near-free Elo, matches bullet); float32 v1 → int16 GNN2 in Phase 4b. |
| **Inference language** | **Pure Go** (`internal/nnue`) | Engine stays one binary. `nnue` imports only `internal/chess` (no cycle: `eval → nnue → chess`). |

**Hard prerequisite (Phase 2):** a finite-difference gradient check
(`(loss(w+ε) − loss(w−ε)) / 2ε` vs the analytic gradient, relative error ≈1e-6)
**before trusting any training run.** The ClippedReLU backprop's failure mode is
a silently wrong gradient that trains a mediocre net and masquerades as "NNUE
isn't beating HCE." No net is SPRT'd until this check passes.

---

## 1. Architecture spec (the contract every phase checks against)

### 1.1 Feature indexing (768, perspective `p ∈ {White, Black}`)

For a piece of color `c`, type `t` (0=P,1=N,2=B,3=R,4=Q,5=K) on square `sq`:

```
relColor = (c == p) ? 0 : 1            // 0 = own piece, 1 = enemy piece
relSq    = (p == White) ? sq : sq ^ 56 // vertical mirror for Black's POV
index    = (relColor*6 + t)*64 + relSq // 0..767
```

No piece-color swap beyond the own/enemy relabeling; the vertical flip handles
board orientation. ~16–32 features are active at once (one per piece).

### 1.2 Forward pass

```
acc[p] = b0 + Σ_{active feat of p} W0[feat]      // W0[feat] is a 256-vector; acc[p] ∈ ℝ^256
x      = concat(acc[stm], acc[~stm])             // side-to-move FIRST → ℝ^512
h      = clamp(x, 0, 1)                           // ClippedReLU
y      = W1 · h + b1                              // scalar
eval_cp = round(y * cpScale)                      // side-to-move-relative cp
```

stm-first concat gives a consistent "me vs them" frame → output is naturally
side-to-move-relative, matching `eval.Evaluate`'s existing contract. No external
sign flip at the call sites.

### 1.3 Weight layout (cache-friendly)

`W0` is stored **feature-major**: `W0[feat*256 : feat*256+256]` is one feature's
column, so an accumulator add is a contiguous 256-wide slice add (the same shape
the Phase-4 incremental update wants).

### 1.4 Net file format `v1` (float32, little-endian)

```
magic    [4]byte  "GNN1"
version  uint32   1
arch     uint32   0           // 0 = 768×256×1 float32 perspective net
inDim    uint32   768
l1       uint32   256
W0       [768*256]float32     // feature-major
b0       [256]    float32
W1       [512]    float32     // over the concatenated 512 input
b1       [1]      float32
cpScale  float32              // raw output → centipawns
```

Loaded cwd-relative from `data/nnue/net.nnue`; `NNUE_PATH` overrides. **The shipped
net is now `GNN2`** (version 2, integer): same header, then int16/int8 weights +
`QA/QB/Scale` (Phase 4b, `internal/nnue/quant.go`) — bullet's quantised.bin ints
stored **verbatim**. The float `GNN1` layout above is still readable (the legacy/
reference path). The net file is **committed** (un-gitignored, 772 KB; `data/syzygy`
+ training scratch stay ignored) so prod `git pull` carries it — keep net + binary
in sync (a GNN2 net needs a Phase-4b binary).

---

## 2. Phases (each ends at a verifiable gate)

### Phase 1 — Float inference, recompute-every-node  ⟵ *start here*
**Goal:** a correct, stateless, slow NNUE forward pass behind a default-off flag.
No accumulator stack, no training, no quantization.

Deliverables:
- `internal/nnue/feature.go` — `ActiveFeatures(pos, perspective)` per §1.1.
- `internal/nnue/net.go` — `Net` struct, `LoadNet(path)`, `(*Net).Eval(pos) int`
  (full recompute per call, §1.2), `RandomNet(seed)` for pre-training tests.
- Flag wiring (5 spots from the code map): `Params.Nnue` (`params.go`,
  default false) → `evalConfig` → `eval.Config.NNUE` + `eval.Config.Net` →
  `eval.Evaluate` branch (`if cfg.NNUE && net != nil { return net.Eval(pos) }`)
  → `bench/config.go` parser `case "nnue"` + `DiffParams` entry.
- Net auto-load (cwd-relative, like syzygy); inert if no file present.

**Gate (no training needed):**
- Hand-computed tiny-net unit test → exact output match.
- Feature-index unit test: known piece placement → exact active-index set,
  including Black-perspective flip and own/enemy labeling.
- Symmetry test: with a structurally-symmetric net, start position evals to the
  same stm-relative score for white-to-move and black-to-move.
- `go build ./... && go test ./... && go vet`; perft still green; `nnue=off` is
  byte-identical to today (HCE path untouched).

### Phase 2 — Go-native training pipeline  ⟵ *LEGACY (v1–v3 only) — superseded by `bullet`, see §4 v4*
**Goal:** produce `net.nnue` from the existing EPD corpora. *(This is the Go CPU
trainer that produced nets v1–v3; it was data-starved and is no longer used to
train shipped nets — bullet on Metal replaced it from v4 on. Kept as a
gradient-check correctness oracle. See the Trainer lineage banner above.)*

Deliverables:
- `internal/nnue/train.go` — minibatch Adam (mirror `internal/tune/texel.go`),
  ClippedReLU forward+backward, parallel over `runtime.NumCPU()`.
- Data: reuse `tune.LoadEPD` (parses `quiet-labeled` + `augmented` + `tb_eg`,
  ~1.6M WDL rows). Target = WDL (λ=0 to start). Loss = `(sigmoid(y·s) − wdl)²`.
- `gomachine nnue-train --epd … --out data/nnue/net.nnue` CLI.
- `cpScale` calibration: linear-fit NNUE raw output vs HCE cp on a holdout so
  magnitudes land in real cp (startpos ≈ 0, a queen up ≈ +900-ish) — the engine's
  margins/aspiration windows are in cp, so scale must be honest.

**Gate (the hard one):**
- **Finite-difference gradient check passes** (rel err ≈1e-6) — *before* any real
  run. This is the prerequisite, not a nicety.
- Training loss strictly decreases; holdout loss tracks; no NaN/overflow.
- Sanity: eval(startpos) ≈ 0; sign correct on a few won/lost holdout positions;
  rough correlation with HCE on quiet positions.

### Phase 3 — SPRT: NNUE-float vs HCE  ⟵ *go/no-go milestone*
**Goal:** prove the learned eval out-plays the linear one.

- `bench sprt --new "nnue=on" --old "nnue=off" --movetime 100` from the **standard
  opening book** (this is a whole-eval change, not an endgame term — use the normal
  book, movetime, [0,6] bounds).
- Re-anchor with `bench vs-stockfish` for an absolute read.

**Gate:** **Accept H1.** Even a modest first net should beat linear HCE. If H0:
the gradient check passed, so suspect data volume / cpScale / λ — iterate the net,
not the plumbing. Do **not** advance to Phase 4 until H1.

### Phase 4 — Incremental accumulator + int quantization  ⟵ *DONE & SHIPPED — see §4 (4a float, 4b int) for the as-built record; spec below kept for context*
**Goal:** the real-time speed (and the bulk of the real Elo). Pure engineering;
behavior must not change beyond rounding.

- Searcher-side accumulator stack mirroring `pushKey`/`popKey` (NOT inside
  `Position` — keeps it a cheap value type). **As built:** the accumulator is stored
  **by absolute color** (White-persp + Black-persp), so **null move doesn't touch
  the accumulator at all** — orientation to the side-to-move happens at the output dot
  (`evalFrom`), not by flipping a perspective. (The original "only the stm
  perspective flips" plan assumed a stm/opp layout; the absolute-color layout is
  simpler and makes null-move a genuine no-op.)
- **Invariant test (critical):** incrementally-maintained accumulator ==
  from-scratch recompute **at every node** (mirror `computeKey()`'s validator
  role). Run under `go test -race` (Lazy-SMP shares nothing here, but prove it).
- Quantize to the Stockfish-style scheme (feature transformer int16, output int8,
  ClippedReLU→[0,127]); net format `v2`. Re-verify invariant, **re-SPRT** vs the
  float net (expect ≈neutral; quant is for speed) and vs HCE.
- Gate weakened-bot path like the TB probes (`weakenedSearch`) if needed so
  `levelForRating` stays calibrated.

**Gate:** invariant holds at every node; quantized re-SPRT ≥ float net; race-clean.

### Phase 5 — Grow (each SPRT-gated, independent)  ⟵ *not started; concrete near-term order in §4 Phase 5*
Wider L1 (512/768/1024), output buckets by piece count, PSQT side-output, then
**HalfKA + mirroring + SIMD** of the two hot loops (accumulator update, output
layer). `bullet` already came off the bench (it trains the shipped net); the data
pipeline already scaled to the full 40 GB. **Near-term order (see §4):** v5 maturity
net (free per-node Elo) → SIMD (amd64 `archsimd`, the 2 hot loops) → wider net.
Re-SPRT every step; flip defaults only on H1.

---

## 3. Risks & gotchas (carried from the code map)

- **`Position` is a pure value type** (`search.go:834` relies on cheap copy).
  Accumulator must NOT add pointers/slices to it — live in the searcher stack.
- **Sign discipline:** `eval.Evaluate` returns stm-relative cp (negates for Black
  + tempo). NNUE is stm-relative *by construction* (stm-first concat) — do not
  double-negate. Tempo is an HCE term; the net learns its own.
- **cpScale honesty:** NNUE output must be genuine cp or the cp-denominated search
  margins (RFP `margin*depth`, delta, aspiration) misbehave.
- **Gradient check is non-negotiable** (Phase 2). Silent-wrong-gradient is the
  expensive failure here.
- **Endgame vs standard book:** NNUE is a whole-eval change → standard book. (The
  §10 endgame terms used the endgame book because they were ≤5-man-scoped.)
- **TB / weakened-bot interaction:** keep root-DTZ + WDL-in-search as-is; gate the
  full-strength net out of `RootScores` if it perturbs `levelForRating`.

## 4. Status

- [x] **Phase 1 — float inference + flag** (2026-06-21). `internal/nnue`
  (`feature.go` indexing, `net.go` float forward + v1 serialization + atomic
  default net + cwd-relative auto-load). Flag wired: `search.Params.Nnue` →
  `evalConfig` → `eval.Config.NNUE` → searcher `evaluate()` routing (eval pkg
  keeps no nnue import) → `bench/config.go` parser + `DiffParams`. Gates green:
  6 unit tests incl. hand-computed forward, feature-index, color-swap symmetry,
  save/load round-trip; `-race` clean; full suite + perft(5) green; end-to-end
  SPRT smoke with a random net (`nnue: off→on` header, net auto-loaded, lost
  0–6 to HCE as expected — proves the net drives move selection). `nnue=off`
  (default) is byte-identical to HCE. `data/nnue/` gitignored.
- [x] **Phase 2 — Go-native trainer** (2026-06-21). `internal/nnuetrain` (float64
  model/forward/backprop, minibatch Adam, 2% holdout, `ToNet()` float32 cast) +
  `gomachine nnue-train`. **Gradient check passes at 3.678e-13** (gate <1e-6),
  re-verified independently + backprop read by hand. Full run: 1.65M rows, 40
  epochs, 2m41s, val MSE 0.149→0.0673 monotonic (no overfit). Net materially
  sane (queen-up +749 both perspectives, pawn +253, startpos +4, sign/perspective
  correct), HCE corr r=0.865. **Caveat surfaced in Phase 3:** pure-WDL target
  (λ=0) + small/quiet/duplicated data → see Phase 3.
- [~] **Phase 3 — SPRT vs HCE (go/no-go): FAILED at the first net → PIVOT.**
  Fixed-nodes (40k) NNUE-float vs tuned-HCE → **−332 ± 99 (H0)**, not a speed
  artifact. Diagnosed (cheap experiments): (1) **cp-scale mismatch** — training
  `sigmoid(y/400)` makes the net learn `y≈400·logit(wp)` while HCE is Texel-
  calibrated to `K_hce≈160`, a *structurally predicted* ~2.5× inflation (pawn
  reads 253cp vs ~100). Post-hoc `cpScale=0.78` (least-squares) recovered −332→
  −220; the 0.78≠0.40 gap proves the inflation is **non-uniform**, so a scalar is
  only a patch. (2) **Thin eval signal (dominant)** — pure-WDL λ=0 on ~1.6M quiet,
  heavily-duplicated positions is low-resolution; still −220 vs HCE after scaling.
  **Decision (2026-06-21): pivot net v2 to distillation from public Stockfish/
  Leela training data** (binpack) — a far stronger teacher than our own HCE+search,
  feature-set-agnostic (we extract our own 768 features downstream), which deletes
  the generate-and-label pipeline. Net v2 plan: **(a)** Go reader for SF `.bin`/
  binpack (convert via `gochess`/SF tools); **(b)** trainer changes — **SCReLU**
  (clamp²; near-free Elo), **λ-schedule loss** (cross-entropy in win-prob:
  `λ·eval_loss+(1−λ)·result_loss`, λ 1.0→0.75), **sigmoid constant from
  Stockfish's WDL model** so the net is on-scale by construction (0.78/0.40 both
  vanish); **(c)** start from a few-GB SF/Leela dataset, not self-gen. Refs:
  `adamtwiss/gochess` (binpack reader, convert-binpack, check-net eval-scale tool),
  `saisree27/Maelstrom` ((768→512)×2→1 SCReLU in Go — proof the approach works).
  Full spec from research → `docs/NNUE/DATA_PIPELINE.md`. Do NOT advance to Phase 4
  until a net accepts H1.
  - **Net v2 progress:**
    - [x] **Go data pipeline** (`internal/nnuedata` + `nnue-convert`/`nnue-verify-labels`).
      Flat 32-byte codec (occupancy+nibbles, White-relative labels), `.plain→.flat`
      converter (SF C++ owns binpack→.plain; we never parse binpack/Huffman) with
      STM→White flip + in-check/mate/score-limit/min-ply filtering. **Two gates green:**
      format round-trip (FEN→encode→decode→FEN, perft@3 equal, race-clean) + label
      semantics (queen-up flips sign correctly, in-check filtered) — verified
      independently. Spec: `DATA_PIPELINE.md §7-9`.
    - [x] **Data acquired + label gate PASSED on real SF data.** Built SF `tools`-branch
      `convert` (M3: drop dead `-lstdc++fs` link flag). `nodes5000pv2_UHO.binpack` is
      **40.3 GB** (~32× plain expansion!), so a **50 MB prefix already = 18.4M positions**.
      Converted → **16,735,338 positions** at `data/nnue/train.flat` (robust: skips
      kingless/illegal via `pos.Legal()` + in-check filter). `nnue-verify-labels`
      stride-samples the file: **89.9% score-sign consistency on decisive-material
      positions** (reversed flip would be ~10%) → STM→White flip verified correct.
      (More/diverse data is a later lever if v2 SPRT is marginal.)
    - [x] **Trainer + inference changes** (one agent owns both → identical forward).
      **SCReLU** (`clamp²`) in `nnue` inference *and* `nnuetrain`; **λ-schedule CE loss**
      (`λ·CE(q,p_eval)+(1−λ)·CE(q,p_res)`, λ 1.0→0.75, grad `[λ(q−p_eval)+(1−λ)(q−p_res)]/sf`);
      `.flat` reader with White→stm label flip (`whiteWP=result/2`, mirror if Black);
      `scaling_factor` flag (default 200), lr 8.75e-4, gamma 0.992, batch 16384, CpScale=1.
      **Gates green (verified independently):** gradient check **6.9e-13** (covers SCReLU
      `2z` deriv + CE `(q−p)/sf` grad), **train/infer consistency** <1cp, all unit tests.
      Note: SCReLU int quant needs `(v·w)·v` ordering (Phase-4 concern).
    - [x] **Net v2 trained + evaluated** (2026-06-21). 60 epochs / 16.7M SF positions,
      val CE 0.587→0.501 (converged). Sanity: material scaling correct (Q +937, R +594,
      P +235), sign/perspective correct. **SPRT results (fixed 40k nodes):**
      - as-trained (CpScale=1) vs HCE: **−145** (vs v1's −332 — big lift from the strong teacher)
      - affine-calibrated (`B1−=137.8, CpScale=0.751`) vs HCE: **−120 ± 39** (R²(net,HCE)=0.68,
        so linear calib only recovered +25; the ~32% non-linear residual is the net diverging
        toward SF + thin-data noise — NOT a quality verdict, HCE isn't ground truth)
      - calibrated vs **bare PeSTO**: **−64** from opening book, but **−0.0 ± 33** from
        **in-distribution midgame** starts (a **+64 swing**). → **OOD-opening confirmed:**
        net never trained on openings (`min-ply 8` + UHO books exclude the start), loses
        games before the midgame it knows. In-distribution it only *ties* PeSTO (not beats).
    - **Diagnosis (no bug):** v2 is a real eval, ~PeSTO-level in midgame, opening-blind.
      −120 vs HCE is **data-starvation**: trained on a **50 MB / 0.12% slice** of the 40.3 GB
      file, correlated + White-skewed (data mean White-rel score +331 / 74% pos, but STM-rel
      +24 / 50.2% — training target correctly centered; offset is OOD + data-slice, traced).
    - [~] **Net v3 (Go trainer, 150M decorrelated) — abandoned mid-convert.** The data-jump
      plan was correct, but while it converted, **v4 on `bullet` succeeded outright** (below),
      making the slow Go-CPU path moot. Root cause of v1/v2/v3 confirmed: **data-starvation**,
      not a math bug — the Go trainer was always gradient-check-correct.
- [x] **★ Net v4 — NNUE CLEARS HCE (2026-06-21).** Pivoted training to **`bullet`**
  (jw1912/bullet) on the **M3 Pro's Metal GPU** (`--features metal`; 1-line upstream fix
  adding the metal `DefaultDevice` arm, else silent MockGpu). bullet reads our 40 GB SF
  binpack directly at **~2.7M pos/sec (~7× the Go CPU trainer)**. A 60-superbatch (6 min)
  net scored **+171.6 @ 40k fixed nodes** vs HCE; a 600-superbatch (~1 h, ~10B positions,
  annealed LR) net is the shipped one. `gomachine nnue-import-bullet`
  (`internal/nnue/bulletimport.go`) imports `quantised.bin` → our net (indexing identical to
  bullet's Chess768, verified; gate: our eval reproduces bullet's within 1cp). The Go trainer
  (`internal/nnuetrain`) is now **legacy**; bullet is the trainer going forward.
- [x] **Phase 4a — incremental accumulator (float), SHIPPED default-on.**
  `internal/nnue/accumulator.go`: accumulator stored **by absolute color** (null-move touches
  nothing), **ply-indexed stack** (Push=`copy+delta`, Pop=`sp--`, no reverse-delta). Gate: a
  from-scratch-vs-incremental equality assert run *inside real αβ search with null-move +
  qsearch* (17 966 null + 411 552 qsearch nodes covered). NNUE NPS 198k→637k (**3.2×**),
  deficit 6.9×→2.1×. **+177.8 ± 41.5 @ 100 ms/move, H1.** `nnue` flag flipped **default-on**;
  net committed at `data/nnue/net.nnue` (un-gitignored, 772 KB).
- [x] **Phase 4b — int16 quantization (bit-exact), SHIPPED.** `internal/nnue/quant.go`:
  int16 accumulator, int8/int16 weights, int32 SCReLU square, int64 dot, round-to-nearest
  descale (QA/QB/Scale = 255/64/400). New **GNN2** net format stores bullet's ints **verbatim**
  (no float round-trip → exact). Gates: int-incremental == int-scratch **exactly**;
  int-vs-float reference **0 cp** / 14 FENs; int-vs-float A/B SPRT **−0.0 Elo** (quality-neutral);
  `-race` clean. Deficit 2.1×→**1.59×** (int16 = half the memory traffic; reaches depth 15 vs
  HCE's 14). **+212.2 ± 49.2 @ 100 ms/move, H1.** Note: now that NNUE is default-on, SPRT HCE
  baseline is `--old "nnue=off"` (bare `--old ""` = NNUE).
- [x] **Phase 5 — grow: DONE through 512 + SIMD, SHIPPED to prod.** The ordered ladder
  (v5 → SIMD → wider) resolved; **width was the lever**, not training length. Full write-up:
  `docs/ENGINE_STRENGTH.md §12`.
  - [~] **v5 maturity net (256-wide) — DUD, reverted.** 2400-superbatch retrain (7h9m) floored
    at loss **0.0317 = v4's** (the 256 net's capacity ceiling; v4 hit it in 600 SB, v5 just took
    4× longer via a stretched LR schedule). SPRT v5-vs-v4 @ fixed nodes **−25 ± 31 (wash)**.
    More epochs can't lower a saturated width's floor. (Also corrected: bullet's canonical
    superbatch = **6104 batches/~100M pos**; our old 1020-batch "superbatches" made "600/2400"
    counts ~6× smaller than standard.)
  - [x] **Dynamic hidden width (bug fix prerequisite).** NNUE inference was hardcoded `L1=256`
    (const + fixed `[256]int16` accumulator arrays + importer), which **silently mis-read a 512
    net as garbage** (no header on quantised.bin + a `<`-only size check). Fixed: `Net.HL` field,
    `NewNetSize`/`RandomNetSize`, accumulator `w`/`b` are slices off one contiguous per-`Stack`
    buffer, importer **infers width from file size** (`771·HL+1` int16), GNN2 loader allocates
    per-header L1. Gates: bit-exact incremental==scratch @512, `-race`, perft, **256 byte-identical**.
    New tool: `bench sprt --new-net X --old-net Y` (net-vs-net A/B; forces `--concurrency 1`).
  - [x] **v6 (512-wide) — SHIPPED.** Researched config (HIDDEN 512, bpsb 6104, **320 SB**,
    `CosineDecayLR 0.001→2.43e-6` no warmup, WDL 0.6, SCALE 400; 4h21m). **+124.5 ± 50 vs v4 @
    fixed nodes.** *The anneal is everything:* the un-annealed lowest-loss early checkpoint scored
    **−96**, the final annealed (higher-loss) net **+124** — **+220 swing from the cosine anneal**
    (never early-stop on the loss plateau). @ movetime *scalar* it was a wash (**+13 ± 53**) — 512's
    ~2× eval cost → SIMD-gated.
  - [x] **SIMD (`archsimd`) — SHIPPED both backends, bit-exact.** Scalar seam (`kernels.go`:
    `addCol`/`subCol`/`screluDot` func vars) repointed in `init()` behind `//go:build goexperiment.simd`;
    default build stays scalar. **amd64 AVX2** (Go **1.26.4 stable**, `Int16x16`, `GOAMD64=v3`,
    AVX2-only): per-node eval **6.5×**, dot 7×. **arm64 NEON** (Go **1.27rc1**, `Int16x8`): **4.16×**,
    dot 5×. With SIMD the +124 survives at movetime — the v6-vs-v4 movetime SPRT firmed to
    **+101 Elo @ 100 ms/move**. **Live in prod** (lairner = amd64 Ubuntu): `net.nnue`→v6,
    binary built `GOEXPERIMENT=simd GOAMD64=v3 go1.26.4`, `chessgo-deploy` hardened to the SIMD
    toolchain. **Net + SIMD build ship together** (v6 scalar = movetime wash). See
    `docs/NNUE/BULLET_SETUP.md`.
  - [x] **Output buckets — BUILT & TESTED (2026-06-29): movetime WASH, infra kept.**
    8 piece-count buckets, `bucket=(popcount−2)/4` (`MaterialCount<8>`), shared trunk
    + per-bucket output, new **GNN3** format, importer `nb` (commit `860f3ef`;
    `buckets_test.go`). v8 net (`data/nnue/net.nnue.v8`) SPRT vs v6: **+90 @ fixed
    100k nodes but ≈0 @ movetime AND ≈0 @ fixed depth 11** (240 pairs, zero arm bias) — the +90 is a
    fixed-nodes mid-iteration artifact, not strength. **v8 NOT promoted** (`net.nnue`
    stays v6); the GNN3/bucket infra is retained so a future wider net can be bucketed
    free. Full write-up: `ENGINE_STRENGTH.md §14.3–14.4`, `NEXT_STEPS.md §2`.
  - [x] **NPS push (2026-06-29): +23% compounded, shipped.** PGO build (+3%,
    `c77ccb5`, `cmd/gomachine/default.pgo`) × pin-aware legal movegen (+20%,
    `a7c4884`, `internal/chess/movegen_legal.go`, order-sensitively diff-tested vs
    the make/unmake oracle). Lazy/deferred accumulator (`NNUE_LAZY`, `484685c`) tested
    bit-identical but **flat — not shipped**. `ENGINE_STRENGTH.md §14.1–14.2`.
  - [ ] **Next NNUE width step: 1024** — now cheap behind SIMD; **SPRT-gate it at
    MOVETIME, not fixed-nodes** (the bucket experiment proved fixed-nodes inflates
    eval changes — `ENGINE_STRENGTH.md §14.4`). Buckets can be layered on 1024 for
    free (infra built) if a movetime SPRT ever shows they pay. Full researched plan
    for everything after v6 (width / buckets / data / king-buckets vs the no-refresh
    invariant): **`docs/NNUE/NEXT_STEPS.md`**.

Full shipped write-up: `docs/ENGINE_STRENGTH.md §11`. **CCRL anchor (2026-06-29): ≈3260
"dirty" CCRL Blitz** (two NNUE anchors — Starzix 5.0 3276±83 / Viridithas 17 3245±94 @
100ms; ENGINE_STRENGTH.md §15), superseding the SF-UCI_Elo **≈2882** reading (band
2847–2935 vs SF-2700/2800/2900, 2026-06-22) — the two consistent via the ~390
CCRL-over-FIDE offset.
