# gomachine — Session Handoff (2026-06-29)

> Written for a **fresh Claude instance with no prior context.** Read this top-to-bottom
> before touching the engine. It captures what was done, where things stand, the
> **expensive gotchas we already hit** (don't re-burn the hours), and prioritized next ideas.
> Background: `CLAUDE.md`, `docs/SPEC.md`, `docs/ENGINE_STRENGTH.md`, `docs/NNUE/*`.

---

## 0. TL;DR

- **gomachine** = the Go chess engine for chessgo (rules + AI). NNUE eval, αβ search, Lazy SMP.
- **Current strength: ≈3260 "dirty" CCRL Blitz @ 100ms** (2026-06-29, two-NNUE-anchor agreement: Starzix 5.0 3276±83 / Viridithas 17 3245±94; ENGINE_STRENGTH.md §15). Supersedes ALL SF-UCI_Elo figures (~2880 / ~2934) — that scale runs ~390 below CCRL (2882+390≈3270, so they agree).
- **This session shipped 3 search patches** (history pruning, quiet-SEE pruning, capture-SEE pruning) = **+71.8 ± 23.9 Elo @ movetime** combined, all committed.
- **Investigated the NNUE 1024-wide net (v7)** → **shelved**: +95 fixed-nodes but movetime-blocked by NPS.
- **Recommended next step: NNUE output buckets** (free Elo, no NPS tax — unlike width).

---

## 1. CRITICAL ENVIRONMENT GOTCHAS — read before any benchmark

These each cost real time this session. Internalize them.

### 1.1 SIMD build is mandatory for movetime / absolute tests (the big one)
The NNUE eval is SIMD-accelerated. **A plain `go build` produces a SCALAR binary** (the SIMD
kernels are gated `//go:build goexperiment.simd`). A scalar build searches ~3.3× fewer
nodes/sec → it's a "movetime wash" and **loses games it should win.** We wasted hours
benchmarking a scalar binary against Stockfish and concluding the engine was weak — it wasn't.

| Purpose | Build command |
|---|---|
| **Fixed-nodes SPRT** (SIMD-independent — same tree) | `go build -o bin/gomachine ./cmd/gomachine` (default `go1.25.5`, scalar, fine here) |
| **Movetime / vs-Stockfish / NPS — dev (M3 arm64)** | `GOEXPERIMENT=simd ~/go/bin/go1.27rc1 build -o bin/gomachine ./cmd/gomachine` (NEON) |
| **Prod (lairner, amd64)** | `GOEXPERIMENT=simd GOAMD64=v4 ~/go/bin/go1.26.4 build -o bin/gomachine ./cmd/gomachine` (AVX-512) |

Rule of thumb: **fixed-nodes = any build; movetime/absolute = SIMD build only.**
Sanity check NPS jumped: scalar startpos `go movetime 100` ≈ 41k nodes; NEON SIMD ≈ 66k.

### 1.2 Stockfish UCI_Elo is a bent, version-specific ruler
- **Prod runs Stockfish 16; local brew is Stockfish 17.1.** `UCI_Elo 3000` means *different
  strengths* across versions — **SF16@3000 ≪ SF17.1@3000.** Prod beats SF16@3000 ~95%; we
  score ~41% vs SF17.1@3000. Both correct, different opponents. **Always name the SF version.**
- **UCI_Elo saturates near its ceiling (max 3190):** the handicap switches off around ~3000–3050,
  so SF@3100 is ≈ full-strength (crushed us 6%) while SF@3000 is genuinely handicapped. **Anchor
  in the graded band (~2600–2900), sweep several points, never a single point near the ceiling.**
- The honest absolute anchor is a **gauntlet of known-CCRL engines** (bayeselo/ordo), not
  handicapped SF. SPRT (self-play) is the ruler for deltas; SF is a noisy tape measure.

### 1.3 `bench vs-stockfish` / `bench sprt` movetime flag trap
`--movetime` is **ignored unless `--nodes 0`** is also set (default `--nodes` is non-zero →
silently runs fixed-nodes). Always pass `--nodes 0 --movetime 100` for a movetime run.
SF side uses `--sf-movetime 100`.

### 1.4 `bench sprt` traps the first SIGINT
Ctrl-C is swallowed (graceful shutdown). Stop a run with **Ctrl-\ (SIGQUIT)** or
`pkill -f "gomachine bench"`. Cap runs with `--maxpairs` + `timeout`.

### 1.5 Prod facts (lairner)
- **4-core AMD EPYC 9634** (Zen 4 → has AVX-512 **and** `avx512_vnni`). 1 thread/core.
- Live config: `serve -search-threads 2`, `hub -bot-search-threads 2` (in systemd units).
- **Net = v6 (L1=512).** Build = `GOAMD64=v4` (AVX-512). Repo path `/var/www/chessgo`.
- **Deploy gotcha:** `chessgo-deploy()` lives in `~/.zshrc`; **`source ~/.zshrc` before running
  it** or a stale in-memory function silently builds scalar (this regressed prod to scalar once).
- Check prod's net: `cd /var/www/chessgo/gomachine && python3 -c "import struct,os; b=open('data/nnue/net.nnue','rb').read(20); print('L1',struct.unpack('<I',b[16:20])[0],'size',os.path.getsize('data/nnue/net.nnue'))"`

### 1.6 Misc
- Use `gawk`, not `awk` (macOS BSD awk breaks scripts).
- Bash tool cwd persists; a `cd /Users/.../chessgo` (e.g. for git) leaves you at repo root —
  `./bin/gomachine` then 404s (it's under `gomachine/`). `cd .../chessgo/gomachine` first.
- **Never run git unless explicitly asked.** (User authorized per-phase commits this session;
  that authorization was session-specific.)

---

## 2. WHAT WE DID THIS SESSION

### 2.1 Search-patch wave (the §13-style loop: subagent implements default-off flag → SPRT → ship or drop)
All measured **self-play SPRT @ 40k fixed nodes, [0,6] bounds, pentanomial GSPRT.**

| # | Patch | Flag | Result | Final config | Commit |
|---|---|---|---|---|---|
| 1 | History pruning | `HistPrune` | **+86.8 ± 26.8** | maxDepth 6, margin **−1000** | `dca222b` |
| 2 | Quiet-SEE pruning | `SEEQuiet` | +21 vs off → retune → **150 beats 50 by +75.9** | maxDepth 6, margin **150** | `dca222b` |
| 3 | Double extensions | `DoubleExt` | **REJECTED** (margin 16 = −11; margin 64 = flat 0) | default-off scaffolding | `211f60d` |
| 4 | Capture-SEE pruning | `CaptSEE` | **+77.7 ± 25.2** vs off @100 → margin sweep | maxDepth 6, margin **25** | `2ebcd8a`, `93681ba` |

- **History pruning**: skip late quiets with strongly-negative history near leaves (new signal vs
  LMP move-count / Futility static-eval). Seed `maxDepth=4, margin=−2000` barely fired (10 prunes) —
  re-seeded to `6/−1000` to make it a *fair* test before SPRTing. Lesson: **check firing rate first.**
- **Quiet-SEE pruning**: skip quiets that hang material (SEE < −margin·depth). Seed margin=50 *grew*
  the tree (mis-pruned safe quiets) → retune found **150** is the peak (150>50 by +76; 100≈50).
- **Capture-SEE pruning**: the capture analog (captures were SEE-*ordered* but not SEE-*pruned* in
  the main search). Margin sweep: `150 < 100 (−32.5), 50 > 100 (+32.8), 25 > 50 (+64.8), 0 ≪ 25 (−86.6)`
  → peak **25** (aggressive wins for captures, opposite of quiets — a losing-SEE capture genuinely
  loses material). Margins promoted to tunable `Params` ints (`SEEQuietMargin`, `CaptSEEMargin`, etc.).
- **Key lesson — RETUNE THE SEED.** SEEQuiet shipped +21 at the seed but +76 retuned; CaptSEE's
  margin sweep was pure profit. Hand-picked seeds leave big Elo on the table; sweep them.

### 2.2 Movetime validation
Combined on-vs-off, **SIMD build, movetime 100ms, concurrency 2**: **+71.8 ± 23.9 Elo (H1)**.
(Fixed-nodes chained ~+250–360, but that's inflated; movetime is the honest number. Bigger than
the entire prior §13 search wave.) The patches **barely cost NPS** (their SEE share ~1% — see 2.3),
so the fixed→movetime discount is **self-play inflation, not patch overhead.**

### 2.3 NPS profiling (measure-first killed a planned optimization)
Profiled `BenchmarkSearch` (depth 9, SIMD build) with pprof. Real-search breakdown (~1.2–1.9 Mnps):

| Cost center | ~% of real search |
|---|---|
| **NNUE eval** (SIMD kernels) | **~40%** |
| Move generation | ~22% |
| Move ordering (`selectMove`) | ~15% |
| Make/unmake | ~10% |
| **SEE** | **~2.5%** |

→ A planned **early-exit `see_ge`** optimization was **abandoned**: SEE is only 2.5%, so halving it
buys ~1% NPS for a risky differential-tested rewrite. **Measure before you cut.** No cheap 2× NPS
win exists; the engine is already well-optimized (SIMD NNUE, mature movegen).

### 2.4 The NNUE 1024-wide net (v7) investigation
- A **v7 = isolated width 512→1024** net was trained back on Jun 22 (`~/nnue-training/bullet/
  examples/chessgo_v7.rs`, checkpoints to `chessgo_v7-320`) but **never shipped.** We found out why.
- Imported `chessgo_v7-320` (annealed final — **never use a mid-run checkpoint**, anneal swing is
  ±220 Elo) → `data/nnue/net.nnue.v7-1024`.
- **Fixed-nodes: v7 (1024) vs v6 (512) = +95.1 ± 28.3 (H1).** Real eval quality.
- **Movetime (SIMD): ~−15 (wash-to-loss).** The 2× eval cost eats the gain at 100ms.
  (Old Jun-23 movetime test showed −46 — that was a slow/scalar build; SIMD improved it to −15
  but not enough to flip positive.)
- **Verdict: 1024 is NPS-blocked at our clock.** +95 of latent eval Elo, unrealizable at movetime
  until eval gets cheaper. Net kept at `data/nnue/net.nnue.v7-1024` for that day.

---

## 3. WHERE WE STAND

- **Engine defaults** (`internal/search/params.go` `DefaultParams()`): all this session's patches
  default-ON (HistPrune, SEEQuiet@150, CaptSEE@25); DoubleExt default-off (rejected). Plus the
  prior stack (SEE, RFP, LMP, null-move, LMR, singular, corrhist, futility, NNUE, TT, Syzygy, …).
- **Net: repo + prod both run v6 (L1=512), `data/nnue/net.nnue`.** v7 (1024) imported locally but
  shelved (`data/nnue/net.nnue.v7-1024`, gitignored area — **not committed**).
- **Commits this session (on `main`):** `dca222b`, `211f60d`, `2ebcd8a`, `93681ba`, `ee4758a`.
  Working tree otherwise clean (user's pre-existing `CLAUDE.md`/`docs/*` edits untouched).
- **Local binary:** `bin/gomachine` was last built as the **NEON SIMD** build (M3). Rebuild
  appropriately per §1.1 for whatever you're testing.
- **Docs are stale at NNUE v6** — they don't mention v7 (trained, shelved). No v8 exists despite a
  passing belief; prod is v6.

---

## 4. POTENTIAL IDEAS / NEXT STEPS (prioritized)

Ordered by **what actually ships at 100ms** (the NPS wall is the recurring theme).

### 4.1 NNUE output buckets — TOP PICK (free Elo, no NPS tax)
- 8 piece-count output buckets (`(popcount−1)/4`), each a small head; standard in every modern
  bullet engine (SF, Stormphrax). **Evaluates one bucket per position → ~flat cost**, so unlike
  width it *survives movetime*. This is the right next strength step.
- Work: engine-side bucket selection in `internal/nnue` (inference + importer + net format), then a
  bullet retrain with `OutputBuckets` (config `chessgo_v8.rs`, base off `chessgo_v6.rs`/`v7`).
- SPRT at movetime (net-vs-net A/B), ship on H1. See `docs/NNUE/NEXT_STEPS.md §2`.

### 4.2 int8 / AVX-VNNI eval — the lever that UNLOCKS width
- The 1024 net's +95 is locked behind eval cost. **int8 dot via `VPDPBUSD` (`avx512_vnni`, which the
  prod EPYC has)** ~halves eval cost → could flip 1024 (and 1536) movetime-positive.
- **Blocker:** Go's `simd/archsimd` does **not** expose VNNI int8 yet → needs **hand-written
  assembly.** High effort, deferred — but it's the structural key to width. (BULLET_SETUP notes this.)

### 4.3 More / better NNUE data (the gate for everything > 1024)
- Count the binpack positions (`~/nnue-training/pool.binpack`, ~38 GB) — is it enough for 1024/1536
  without overfit? Rebalance eval-distribution (≥50% within ±100cp, ≥40% material-imbalanced).
- Use the `bench blunders` hard-example miner (gomachine's own blind spots, WDL-labelled).
- **Do NOT self-generate** at our strength (we're ~2930 distilling ~3600 SF data — our games are
  worse labels). Higher-depth SF data + λ tuning is the lever. See `docs/NNUE/NEXT_STEPS.md §3`.

### 4.4 SPSA tuning of hand-set search constants
- Many never-tuned knobs: LMR formula, RFP/futility margins, singular margin, NMP reduction,
  aspiration window, corrhist weights, **and the new SEEQuiet/CaptSEE/HistPrune margins.**
  **NOTE: tune SEARCH constants only — the HCE eval-term weights (KingProxEG etc.) are INERT under
  default-on NNUE** (`rawEvaluate` returns the net; `eval.Evaluate` is dead in the default config).
- The in-process SPRT harness is an ideal SPSA backend (games/sec is the bottleneck, and it's fast).

### 4.5 King-buckets / HalfKA — the structural project, LAST
- ~+15–40 Elo eventually, but it's the **only** step that abandons the "no-refresh absolute-color
  accumulator" invariant (king-keyed features force a refresh path + Finny tables). More data-hungry.
- A small **custom king-mirror / 2–4 bucket** scheme is a lighter middle ground worth prototyping
  first. Do this after the free wins are banked. See `docs/NNUE/NEXT_STEPS.md §5`.

### 4.6 Honest re-anchor (do once, for a real absolute number)
- Build a **clock+increment gauntlet vs known-CCRL engines** with bayeselo/ordo, replacing the
  bent handicapped-SF anchor. This also doubles as the harness to measure **time management**
  (currently a flat per-move deadline — no soft/hard limit, no best-move-stability; ~+20-50 Elo for
  a clock-based engine, but only realizable on a true competitive path, not the fixed-strength bot).

### 4.7 Lower-priority NPS (only if pursued)
- No cheap win (see 2.3). Real targets are movegen (~22%, staged/lazy generation — a refactor) and
  the NNUE eval itself (which 4.2 addresses). `see_ge` is not worth it (SEE 2.5%).

---

## 5. HOW THE USER WORKS (methodology)

- **SPRT-gate everything.** Search patches: 40k fixed nodes, [0,6]. Speed/width/eval: **movetime
  100ms** (SIMD build!). Net changes: net-vs-net A/B (`--new-net/--old-net`, forces concurrency 1).
- **Retune seeds** — a passing patch at its seed often has a much better operating point one knob away.
- **Measure first** (profile before optimizing; firing-rate before SPRTing a prune).
- **Verify, don't trust** — check pasted analyses against real counts/data before acting.
- **Commit each phase after its SPRT** (don't hoard — visible, durable progress). Honest commit
  messages with the actual numbers.
- **Quiet CPU at night**: `nice -n 19 … --concurrency 2` (≈2 cores, fans ~2400 RPM). Full speed
  (`--concurrency 8`) only when the user is around / says go.
- **Don't touch git** beyond what's explicitly authorized. Don't even discuss git unless it's broken
  or the user raised it.
- Direct, honest, no overselling. Admit mistakes plainly (we made several — scalar build, SF version).

---

## 6. COMMAND & PATH REFERENCE

```sh
# --- builds (see §1.1) ---
go build -o bin/gomachine ./cmd/gomachine                                    # scalar (fixed-nodes ok)
GOEXPERIMENT=simd ~/go/bin/go1.27rc1 build -o bin/gomachine ./cmd/gomachine  # NEON SIMD (M3, movetime)

# --- SPRT: a search flag ---
./bin/gomachine bench sprt --new "flag=on" --old "flag=off" \
  --nodes 40000 --elo0 0 --elo1 6 --maxpairs 700 --concurrency 8

# --- SPRT: movetime (NOTE --nodes 0) ---
./bin/gomachine bench sprt --new "" --old "histprune=off,seequiet=off,captsee=off" \
  --nodes 0 --movetime 100 --elo0 0 --elo1 6 --maxpairs 600 --concurrency 2

# --- SPRT: net-vs-net A/B (forces concurrency 1) ---
./bin/gomachine bench sprt --new "" --old "" \
  --new-net data/nnue/net.nnue.v7-1024 --old-net data/nnue/net.nnue \
  --nodes 0 --movetime 100 --elo0 0 --elo1 6 --maxpairs 150

# --- absolute anchor vs Stockfish (name the SF version!) ---
./bin/gomachine bench vs-stockfish --sf /opt/homebrew/bin/stockfish --sf-elo 2800 \
  --nodes 0 --movetime 100 --sf-movetime 100 --games 30 --threads 2 --concurrency 2

# --- import a bullet checkpoint (use the FINAL annealed one, e.g. -320) ---
go run ./cmd/gomachine nnue-import-bullet \
  --in ~/nnue-training/bullet/checkpoints/chessgo_vN-320/quantised.bin --out data/nnue/net.nnue.vN

# --- profile NPS (SIMD build) ---
GOEXPERIMENT=simd ~/go/bin/go1.27rc1 test ./internal/search/ -run='^$' -bench=BenchmarkSearch \
  -benchtime=2s -cpuprofile=cpu.prof -o search.test
~/go/bin/go1.27rc1 tool pprof -top -nodecount=30 search.test cpu.prof
```

| What | Path |
|---|---|
| Committed net (v6, 512) | `gomachine/data/nnue/net.nnue` |
| v7 net (1024, shelved) | `gomachine/data/nnue/net.nnue.v7-1024` |
| bullet rig (configs, checkpoints) | `~/nnue-training/bullet/` (`examples/chessgo_v*.rs`, `checkpoints/`) |
| bullet training data (~38 GB) | `~/nnue-training/pool.binpack` |
| training/SPRT logs | `~/nnue-training/logs/` |
| Go 1.27rc1 (NEON SIMD) | `~/go/bin/go1.27rc1` |
| Stockfish (local, 17.1) | `/opt/homebrew/bin/stockfish` — **prod is SF16** |
| Engine roadmap / strength | `docs/ENGINE_STRENGTH.md`, `docs/NNUE/{PLAN,NEXT_STEPS,BULLET_SETUP}.md` |

---

## 7. THE ONE-PARAGRAPH SUMMARY (if you read nothing else)

gomachine is a **≈3260 "dirty" CCRL Blitz** NNUE chess engine (2026-06-29 two-NNUE-anchor agreement; ≈2882 on the older SF-UCI_Elo scale). This session shipped three SPRT-gated search prunes
(history / quiet-SEE / capture-SEE pruning, +71.8 movetime Elo, committed) and proved — via a fixed
NPS profile — that there's no cheap node-count win left (SEE is 2.5%, NNUE eval is ~40% and already
SIMD'd). The big finding: a trained **1024-wide net is +95 fixed-nodes but movetime-negative** — its
eval cost eats the gain at 100ms — so **width is NPS-blocked at our clock.** The next real strength
is **output buckets** (free Elo, no NPS tax), with **int8/VNNI** (hand-asm) as the eventual key to
unlocking width, and king-buckets/HalfKA as the last structural project. Always build with SIMD for
movetime tests, always name the Stockfish version, and SPRT-gate (and retune the seed of) everything.


------------

Fresh Research + Analysis:

All three streams are in and I've checked the top recommendations against your actual code. Two of the agents' headline suggestions turned out to gate on "does gomachine already do this" — and the answers reorder everything. Here's the synthesis.

---

## The reframe (the one causal chain that ties all three reports together)

The single most important finding: **int8/VNNI — the technique you'd most expect to cut your 40%-eval cost — is architecturally impossible on your current net shape.** `VPDPBUSD` needs a *plain* ClippedReLU (output in `[0,127]`) feeding a *hidden affine layer*. Your **SCReLU→1** net squares the activation (up to QA²=65025), so the output dot is mathematically forced into int16 `VPMADDWD` forever. There is no int8 path for a single-SCReLU→scalar net.

This is *why* Stockfish/Stormphrax/Viridithas/Obsidian all went **multilayer** — the extra hidden layer is what unlocks int8. So the levers aren't independent; they chain:

> **output buckets → multilayer tail (LayerStacks) → int8/VNNI → affordable width**

Each step enables the next. You can't shortcut to "1024-wide" (you proved it's movetime-negative) because the eval is int16-bound. You make eval *cheaper per FLOP* first, then width becomes affordable.

---

## What I verified in YOUR code (ground truth, not generic advice)

| Agent's top rec                                                | Status in gomachine                                                                                                                                                                                                                                                                          | Verdict                                                    |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| **"Never eval in check"** (free NPS)                           | **Already done.** `search.go:921` `if !inCheck { rawEval = ... }` and qsearch `1409`.                                                                                                                                                                                                        | ✅ Drop it — banked.                                       |
| **"Lazy/deferred accumulator updates"** (the headline NPS win) | **NOT done — and worse than generic.** `accumulator.go:224` `Push` does a full `copy(dst.w, src.w); copy(dst.b, src.b)` (2×HL int16 = **2 KB memcpy at HL=512**) **plus** the deltas, eagerly, on **every** move push — even for nodes that TT-cut or get pruned before ever calling `Eval`. | 🎯 **Biggest confirmed unrealized NPS win.**               |
| **Output buckets** = single bucket today                       | Confirmed: `net.go` `B1 float32` scalar, `W1i []int16` of `2*HL`.                                                                                                                                                                                                                            | 🎯 Free Elo, ~0 NPS.                                       |
| Output dot already uses int16 SIMD                             | Confirmed: `screluDot` in kernels (archsimd `VPMADDWD`).                                                                                                                                                                                                                                     | ✅ No asm needed for current net.                          |
| Formula correction                                             | Handoff says `(popcount−1)/4`; **bullet's actual `MaterialCount<8>` is `(popcount−2)/4`** (drops both kings).                                                                                                                                                                                | ⚠️ Fix before implementing or training/inference disagree. |

The lazy-accumulator gap is **doubly** wasteful in your code: Stockfish never copies the parent (it stores deltas and resolves lazily from the nearest computed ancestor). You pay a full 2 KB copy *and* the delta on every node, and discard it whenever the node TT-cuts or is pruned before eval — which on a heavily-pruned, high-TT-hit engine like yours is a large fraction of nodes.

---

## The ranked plan (tiered by confidence × NPS/Elo ÷ effort)

### Tier 1 — cheap, high-confidence, do these first

| #   | Item                                                                                                                                                                | Win                                                                       | Effort                                                                     | Evidence                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------- |
| 1   | **Lazy/deferred accumulator** — mark dirty + store deltas on Push, resolve only when `Eval` is actually called; skip the 2 KB copy for TT-cut/pruned/in-check nodes | Attacks the 40% directly. All top engines do it.                          | Medium (per-ply dirty stack + walk-back)                                   | CPW NNUE; SF `AccumulatorCaches`        |
| 2   | **PGO build** from a real search profile                                                                                                                            | **2–14% NPS**, zero code change                                           | Trivial (`-pgo=default.pgo`)                                               | Go blog; Datadog 14%                    |
| 3   | **GOGC↑ / GOMEMLIMIT** + confirm zero allocs in make/movegen hot loop (`-benchmem`, `-gcflags=-m`)                                                                  | A few % if GC fires in search; free + reversible                          | Low                                                                        | Go gc-guide                             |
| 4   | **Output buckets `MaterialCount<8>`**                                                                                                                               | ~+8–20 Elo, **~0 NPS**                                                    | Low (3 bullet lines + bucket index in `evalFrom`; new net format `arch=2`) | bullet `outputs.rs`; universal adoption |
| 5   | **64-byte align accumulators + weights**; BCE pass on movegen/kernels                                                                                               | ~8% (register/align) + ~7–9% (BCE); matters more for AVX-512 on your EPYC | Low                                                                        | cosmo; Sourcegraph slow-to-SIMD         |
| 6   | **TT cache-line alignment + prefetch-on-key** (issue prefetch in make, the instant the child key is known)                                                          | ~1–3%                                                                     | Low                                                                        | SF PR #5770                             |

### Tier 2 — the strength engine, but real work

| #   | Item                                                                                        | Win                                                                                                      | Effort                                                | Note                                                |
| --- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------- |
| 7   | **Multilayer tail** (`512×2 → 16 → 32 → 1`, LayerStacks over the 8 buckets, CReLU→pairwise) | Tens of Elo (Viridithas v13→v14 headline); **costs a few % NPS** — SPRT at **movetime**, not fixed nodes | High (new SIMD kernels + retrain)                     | The gateway to #8                                   |
| 8   | **int8/VNNI hidden layer** (only possible *after* #7)                                       | Kernel-level ~3×; engine-level single-digit–15%; real payoff = "bigger net at equal speed"               | High (hand Plan9 `VPDPBUSD` — archsimd can't emit it) | Where your Zen4 EPYC's `avx512_vnni` headroom lives |
| 9   | **More corrhist dimensions** (`CorrHistMinor`/`Cont` are scaffolded, default-off)           | ~+10 Elo-class each via sharper pruning → fewer nodes                                                    | Low (just SPRT them)                                  | SF +10.57 per dim                                   |

### Explicitly DROP (the report killed these)

- **Staged movegen / Gigantua / copy-make rewrites** — net ~nil NPS on an already-pruned engine; Gigantua's gigamoves/sec is a *perft* artifact that doesn't survive a real search. Your skepticism was right.
- **PEXT bitboards** — ~2–3% movegen only, needs Go asm, marginal. Last.
- **Dual small/big net** — Stockfish added it (2024) then *removed* it (2025). Skip.
- **`see_ge` early-exit** — SEE is 2.5%, already correctly shelved.

---

## My recommendation for the first build

**Two parallel tracks, both Tier 1, both low-risk:**

1. **Lazy accumulator** (NPS) — the confirmed 40%-cost win, and it's a prerequisite mindset for everything bigger. It's pure algorithm, zero Elo risk (bit-identical eval), and your `NNUE_ASSERT` gate + `forceScratch` A/B harness already exist to validate it.
2. **Output buckets** (Elo) — free strength, tiny diff, and it's the structural gateway to the multilayer→VNNI→width chain that's the *only* way past your movetime wall.

Then re-anchor at movetime and decide whether to commit to the multilayer tail (the big lever, but the one that actually costs NPS).

