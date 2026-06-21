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

## 0. Decisions locked (2026-06-21)

| Decision | Choice | Why |
|---|---|---|
| **Feature set** | **768 piece-square, dual perspective** (6 types × 2 colors × 64) | King is an ordinary piece → **no king-relative refresh**, the worst accumulator-bug source. Every move is a single remove+add delta. Fits our ~1.6M positions (HalfKP's 40,960 sparse features are under-determined at this data size). Clears current HCE comfortably. The trainer, loaders, accumulator stack, and invariant test **all transfer to HalfKA later** — this is a base, not throwaway. |
| **Trainer** | **Go-native** (hand-rolled backprop, mirrors `internal/tune` Adam) | 768→256→1 on 1.6M positions is tiny; CPU on the M3 Pro is minutes–low hours, a GPU buys nothing here. Keeps the pure-Go, single-dependency repo + exact net-format control. PyTorch+MPS / Rust `bullet` held in reserve for the Phase-5 scale-up (wider L1, HalfKA, more data) where CPU becomes the limiter. |
| **First architecture** | `(768 → 256)×2 → 1`, ClippedReLU, float32 v1 | Simplest net that beats linear HCE. One feature transformer (shared weights, two perspectives), concat stm-first → 512, single output layer. |
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

Loaded cwd-relative from `data/nnue/net.nnue` (gitignored, like `data/book.bin`
/ `data/syzygy`); `NNUE_PATH` overrides. Quantized `v2` format defined in Phase 4.
Final shipping net may be `go:embed`-ed; during dev we iterate on the file.

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

### Phase 2 — Go-native training pipeline
**Goal:** produce `net.nnue` from the existing EPD corpora.

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

### Phase 4 — Incremental accumulator + int quantization
**Goal:** the real-time speed (and the bulk of the real Elo). Pure engineering;
behavior must not change beyond rounding.

- Searcher-side accumulator stack mirroring `pushKey`/`popKey` (NOT inside
  `Position` — keeps it a cheap value type). Hook deltas at the three chokepoints
  (`addPiece`/`removePiece`/`movePiece`) right beside the Zobrist XORs. Null move:
  no piece change → only the stm perspective flips.
- **Invariant test (critical):** incrementally-maintained accumulator ==
  from-scratch recompute **at every node** (mirror `computeKey()`'s validator
  role). Run under `go test -race` (Lazy-SMP shares nothing here, but prove it).
- Quantize to the Stockfish-style scheme (feature transformer int16, output int8,
  ClippedReLU→[0,127]); net format `v2`. Re-verify invariant, **re-SPRT** vs the
  float net (expect ≈neutral; quant is for speed) and vs HCE.
- Gate weakened-bot path like the TB probes (`weakenedSearch`) if needed so
  `levelForRating` stays calibrated.

**Gate:** invariant holds at every node; quantized re-SPRT ≥ float net; race-clean.

### Phase 5 — Grow (each SPRT-gated, independent)
Wider L1 (512/768/1024), output buckets by piece count, PSQT side-output, then
**HalfKA + mirroring + SIMD** of the two hot loops (accumulator update, output
layer). This is where PyTorch+MPS / `bullet` come off the bench if CPU training
becomes the limiter and where the data pipeline scales (self-play teacher cp via
`GenerateSelfPlay`, deeper labels). Re-SPRT every step; flip defaults only on H1.

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
- [ ] Phase 2 — Go-native trainer (+ gradient check gate)  ← *next*
- [ ] Phase 3 — SPRT vs HCE (go/no-go)
- [ ] Phase 4 — incremental accumulator + quantization
- [ ] Phase 5 — grow
