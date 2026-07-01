# ★ CURRENT PHASE — closing the gap to Stormphrax (2026-06-30, 17:00) — READ THIS FIRST

> This block supersedes everything below it. The older blocks are kept as history.
> A fresh instance should be able to continue the engine from this section alone.
> Companion docs: `docs/NNUE/ENRICHED_MULTILAYER.md` (the phase plan),
> `docs/ENGINE_STRENGTH.md §16` (the measured numbers), `docs/NNUE/NEXT_ARCH.md`.

## Where we are
- **Shipped/prod: NNUE v6** — single-layer `(768→512)×2→1` SCReLU, int16, SIMD
  (`archsimd`), default-on. **≈3260 "dirty" CCRL Blitz** (`ENGINE_STRENGTH.md §15`).
- **The goal / the line to pass: Stormphrax (~3700 CCRL).** Stormphrax beats v6
  *clearly* (+~440). That is the target. **Stockfish is NOT the anchor** — it's not a
  representative CCRL peer; beating CCRL-level engines (Stormphrax, Viridithas) is what
  moves us up the leaderboard. We have Stormphrax cloned at `~/stormphrax` (GPLv3 — learn
  techniques, copy no code) and built/benched on lairner (`~/stormphrax-bench/`).

## The plan — ONE LADDER (not two paths). v6 = rung 0; threats = the climb.
The "stay fast & threat-free" option is a **dead end** (ceiling ≈ where v6 is). Every
~3700 engine runs **threat inputs**; they are the path up. Climb one rung, gate at
**movetime** (or fixed-depth; **never fixed-nodes** — it inflates eval changes,
`§14.4`), then the next:

1. **threats + single-layer tail + 8 output buckets, 320-sb, int8** → must **beat v6
   at movetime**.  ← *rung 1 **DONE (2026-07-01): +25 Elo vs v6 at movetime.** Path: +139
   fixed-depth but first movetime PARITY (speed wall — the ~22-column threat push is ~2.25×
   v6's eval cost). The **move-aware push** (`internal/nnue/enriched_delta.go`, bit-exact,
   1.58× faster push / ~1.2× NPS) bought back enough NPS to convert the eval edge:
   **+27.6 ± 24.9 @ 164 pairs**, CI excludes 0. Default-on for lean nets. The push is now
   TAPPED (3 further micro-opts measured slower — enumeration is irreducible). See
   `ENGINE_STRENGTH.md §17–19`. **Next lever = a retrain** that bakes in int8 tail+base
   (QAT+VNNI) and/or width/data — the remaining eval-speed lives behind training, not more
   push surgery (analysis in progress).*
2. **width → 1024** (cheap once int8 inference is real).
3. **king buckets** (needs an accumulator **refresh** path — the one piece the
   absolute-color accumulator doesn't have yet; bulletformat is stm-oriented, our acc is
   absolute-color, so reconcile carefully).
4. **multilayer tail** (the `…→16→32→1` enriched tail) — a **+30–50 Elo** refinement,
   added **last** and **only behind an int8-SIMD tail** (a float multilayer tail is a
   movetime wash — proven, twice).
5. **self-generated data** — the ceiling-breaker. We currently **distill Stockfish
   binpacks**, which asymptotes toward the teacher. Stormphrax forbids 3rd-party data
   for exactly this reason. This is how you pass the frontier; long pole, last.

**"Optimal" destination spec:** inputs `768 + threats (+ king buckets)`, width `1024`,
`8` output buckets, **int8 everywhere + QAT**, multilayer tail (last), self-gen data.

## The hard-won learnings (don't re-derive these)
- **Eval quality is NOT our problem; NPS is.** The enriched threats net is **+149 Elo
  vs v6 at fixed depth 8** (eval genuinely much better) but **−160 at movetime** — it is a
  better *eval* bolted onto a ~13×-slower engine. Transitivity holds: losing to v6 at
  100 ms = genuinely weaker (~3100, not 3700). Only a **movetime win over v6** counts.
- **Per-node cost (AVX-512/lairner): enriched ≈ 9 µs ≈ 13× v6 (~700 ns).** Split ≈ half
  **tail** (the multilayer/pairwise math) + ≈ half **threat-push** (the accumulator
  update, memory-bound on the ~10 MB threat-weight table — already incremental).
- **★ Stormphrax NPS anchor (lairner, same box): ~410k NPS / ~2,440 ns/node for a 56 MB
  net.** So a real 3700 threat-net is only **~3.7× slower than a lean net** (not 13×) and
  **~3.7× FASTER than our enriched** despite a bigger net. **⇒ our inference is ~3.7×
  inefficient — fixable, not fundamental.** Target = **~2,440 ns/node**; there the NPS
  penalty (~−130 Elo) is overcome by the eval edge → enriched beats v6.
- **Why we're 3.7× off = the two things Stormphrax does and we don't (yet):**
  1. **int8-SIMD tail.** Ours is **scalar float** (~5 µs). Profiled: the biggest single
     tail cost is the **pairwise activation (~2.4 µs, scalar, SIMD-able)**, NOT the
     matmuls. The output-stationary GEMV rewrite (`gemvF32`) gave only a small win — the
     tail was *not* reduction-bound as first hypothesized; it's the scalar pairwise +
     memory. **int8 tail was a WASH so far** because (a) on NEON our `dotU8I8` is SCALAR
     and (b) the old per-row layout was dispatch-bound. int8 only helps in the *right
     layout on a real int8-dot instruction* (see int8/asm note below).
  2. **move-aware threat push.** Ours re-enumerates all features + multiset-diffs each
     node (the diff is correct & already minimal on the apply side, ~50 scattered int8
     column adds; the re-enumeration ~0.5 µs is the avoidable part). Stormphrax computes
     only the changed threat edges directly (`threatsAdded`/`threatsRemoved`).
- **int8 status: PARTS BUILT, not yet paying off.** Built + bit-exact-gated: int8 FT
  threat columns (`addColI8`/`subColI8`, 3 SIMD backends), int8 L1 (`dotU8I8`),
  `gemvF32` (3 backends), `EnrichedStack` incremental accumulator (count-array multiset
  diff, no per-node sort). **Weight-QAT works**: PTQ leaked ~150 Elo (float +170 → int8
  +21 at fixed depth); adding `faux_quantise` on the L1 weights (scale QB=64) in training
  recovered it to **+149**. **What remains:** make int8 actually *fast* on the prod arch
  (int8-dot instruction) + move-aware push → hit ~2,440 ns/node.
- **Go is NOT the problem.** Go-vs-C++ ≈ 40–70 Elo; the gap is arch+data. The one real
  Go bite is the int8-dot kernel (see below). Do **not** rewrite in C++.
- **Multilayer is right** (Stormphrax IS multilayer + threats — our exact shape, at
  2,440 ns/node). Our slowness is the *implementation* (scalar tail + re-enumerated
  push), not the architecture. But single-layer FIRST (rung 1), multilayer LAST (rung 4).
- **Hardware nuance:** the "beats v6 at movetime" verdict is **hardware-dependent** —
  the threat-push is memory-bound and lairner is a weak 4-core box (push ~4.5 µs there
  vs ~1.9 µs on the M3). A stronger box narrows the deficit. Measure on the deploy box.

## Hardware / where to run
- **Mac (M3 Pro):** training (bullet on Metal GPU, ~1 M pos/s with threats), and local
  dev. NEON. **Currently our int8 is scalar on NEON** → int8 looks slow here; fixable
  (see int8/asm). The Mac *can* be a first-class int8 box (it has the `UDOT` dotprod
  instruction).
- **lairner:** prod (AVX-512 Zen4 EPYC, but only **4 cores**, weak memory → punishes the
  memory-bound threat push). All movetime numbers above are from here. Scratch repo
  `~/chessgo-simd/`; build `GOEXPERIMENT=simd GOAMD64=v4 ~/sdk/go1.26.4`.
- **coalla (optional, via SSH; 12 cores, ~3× RAM):** a stronger/better-memory box. Clone
  the public repo there for heavier single-thread movetime measurement (note: net-vs-net
  SPRT is forced **concurrency 1** — the net is a process global — so extra cores don't
  parallelize *that*; the value is faster single-thread + more cache/bandwidth).

## int8 via Go assembly — the path to "real" int8 (UDOT / VPDPBUSD)
Go's `archsimd` does **not** expose the int8 dot-product instruction (amd64-only, and
only the int16 `DotProductPairs`/`VPMADDWD`; no `VPDPBUSD`/`DotProdBytes` — that's why
`dotU8I8` is scalar on NEON and `maddubs`-bound on AVX-512). **CONFIRMED feasible via
hand-written Go (Plan9) assembly** (research, 2026-06-30):
- **x86-64 `VPDPBUSD` (AVX-512 VNNI, lairner): a NAMED Go-assembler instruction** since
  Go 1.11 (`avx512_vnni`) — write it directly with Z-registers. Trivial.
- **ARM64 `SDOT`/`UDOT` (NEON dotprod, M3 has it): NOT named, but `WORD`-encodable**
  (e.g. `WORD $0x4E829420` = `SDOT V0.4S, V1.16B, V2.16B`).
- **Prior art = `github.com/camdencheek/simd_blog`** ships BOTH `dot_amd64.s` (VPDPBUSD)
  and `dot_arm64.s` (WORD-encoded SDOT) for an int8 dot — a solved, shipped pattern.
- **Effort ~2–3 focused days** (two small `.s` leaf fns + scalar fallback + bit-exact
  test, like our existing kernels). avo can generate the amd64 side; hand-write arm64.
- **One caveat:** `VPDPBUSD` is **unsigned×signed** (need the +128-bias-and-compensate
  trick) while ARM `SDOT` is **signed×signed** — slightly different quant/bias per arch;
  unify in the test harness. Don't use cgo (per-call overhead kills a per-node kernel).

This makes int8 fast on BOTH boxes (the **Mac becomes a first-class int8 dev box** — no
more lairner round-trips just for int8). It's the keystone of getting to ~2,440 ns/node.

## What's training RIGHT NOW (2026-06-30 17:00)
- **`chessgo_lean_threats` — rung 1.** Lean single-layer + threats:
  `(768 + 9216 threats) → 512 ×2 → SCReLU → concat(1024) → 1, ×8 buckets`, 64 superbatches,
  QAT on the FT (scale 255). bullet on the M3 Metal GPU; config
  `~/nnue-training/bullet/examples/chessgo_lean_threats.rs`. At ~17:00 it's ~sb 23/64
  (~1 h to the annealed `-64`; log `…/scratchpad/lean_threats.log`).
- **Gate armed** (`…/scratchpad/lean_gate.sh`, auto-fires when `-64` lands → log
  `lean_gate.log`): fixed-depth + **movetime** lean-vs-v6 via `--new-lean
  "…/chessgo_lean_threats-64/raw.bin,512,8"`. **This decides rung 1:** beats v6 → bank
  single-layer+threats, climb width/buckets/data; loses → the threat *push* is the wall →
  the int8-dot-asm + move-aware-push speed work is mandatory first.
- The earlier **multilayer** enriched net (`chessgo_enriched-64`, `(…→512→pairwise→16→32→1)×8`,
  weight-QAT) is the +149-fixed-depth / −160-movetime net — kept for reference; it's
  rung 4 (multilayer) prematurely stacked, deferred until int8 tail is real.

## Code state (what exists, for a fresh instance)
- `internal/nnue/enriched.go` — `EnrichedNet`: multilayer **and** lean (`lean bool`)
  tails; threat feature map (`appendEnrichedFeatures`, byte-matches the Rust);
  `ftAdd`/`ftSub` base(int16)/threat(int8) dispatch; importers `ImportBulletEnrichedNet`
  (multilayer) and `ImportBulletLeanNet` (lean).
- `internal/nnue/enriched_acc.go` — `EnrichedStack` incremental accumulator (count-array
  multiset diff; `NNUE_ASSERT` bit-exact gate vs from-scratch).
- `internal/nnue/enriched_int8.go` — `QuantizeForInt8` (L1, fixed scale QB=64),
  `QuantizeFTInt8` (threat columns int8).
- `internal/nnue/kernels*.go` — `addColI8`/`subColI8`, `gemvF32`, `dotU8I8`, etc.;
  scalar + NEON + AVX2 + AVX-512, all bit-exact-gated (`kernels_test.go`).
- `chess.PseudoAttacks` (exported for the threat feature map).
- `cmd/gomachine/bench.go` — `--new-enriched/--old-enriched "path,H,D2,D3,NB"`,
  `--new-lean/--old-lean "path,H,NB"`, `--enriched-int8` (L1), `--enriched-int8-ft` (FT).
- bullet configs: `examples/chessgo_enriched.rs` (multilayer+QAT),
  `examples/chessgo_lean_threats.rs` (lean+QAT). bullet's QAT `faux_quantise` STE bug is
  patched in the local clone (don't `git reset` it).

## Immediate next steps (in order)
1. **Read the rung-1 gate result** (`lean_gate.log`) — fixed-depth confirms the eval,
   movetime is the verdict.
2. If movetime still loses (likely on lairner's weak box): **write the int8-dot asm
   kernel** (UDOT + VPDPBUSD) and **move-aware threat push**, re-measure toward
   ~2,440 ns/node. Optionally re-measure on **coalla**.
3. **320-sb full train** of the winning arch (the 64-sb runs are undertrained — v6 shipped
   at 320).
4. Then climb: width 1024 → king buckets → multilayer (behind int8) → self-gen data.
5. Anchor progress vs **Stormphrax** at movetime, not vs v6 alone.

---

> ## STATUS (updated after the endgame push) — older history below
>
> The diagnosis below was acted on. Full write-up with SPRT numbers in
> `docs/ENGINE_STRENGTH.md §10`. Summary:
>
> **Shipped (all default-on, SPRT-gated, live in prod via the auto-loaded TB):**
> - **WDL-in-search** (`tbsearch`) — `tb_probe_wdl` at internal nodes, lock-free,
>   cursed/blessed→draw, gated off for weakened bots. **+32.7 Elo** (endgame book),
>   +29 standard-book non-reg. This was "the biggest single gap" in the brief.
> - **KingProx** (`kingprox`) — EG-only, rank-weighted, *centered* king-to-passer
>   distance (priority-1 term below). **+30.5 Elo**, per-class rook +33 / minor +36
>   / K+P +24 (no class regressed). Shipped with the **seeded** weight.
> - **PawnRace** (`pawnrace`) — EG-only **knight-aware unstoppable-passer / race**
>   term (priority-2 below — the "do I queen first?" over-optimism killer).
>   **+17.4 Elo** (mixed endgame book, TB on both sides). Acts in 6–10-man positions
>   *above* the 5-man TB boundary, so it isn't TB-masked; returns exactly 0 on the
>   diagnosed symmetric position. Seeded `PawnRaceEG=700`, not a tuner feature.
>
> **Tried and REJECTED:** the joint re-tune to fit `KingProxEG`+`PassedEG`+PSQT
> together (priority-4 plumbing). The fit was clean (`KingProxEG 4→13`,
> `PassedEG 42→57`) but the re-tuned **table** A/B'd at **≈0 vs +30** — it gave back
> the gain, most likely **TB-label over-optimism** (perfect-play 1.0 labels teach
> winnability the eval can't realize). Controls confirmed the B/R MG drift was
> data/K-refit, not KingProx. So we kept the seeded weight on the existing table.
> If revisited: **MG-anchored** re-tune (freeze piece values, tune only EG terms).
>
> **Built and kept:** the point-symmetric endgame SPRT book
> (`scripts/gen_endgame_book.py`, `data/endgame_book*.fen`), the TB-WDL EPD
> generator (`gomachine gen-tb-epd`), and EG-only taper gating.
>
> **Built but NOT shipped:** (5) EG drawishness **scale factors** (`scalefactor`,
> Stockfish-classical port) — correct + safety-guarded, but SPRT'd ~neutral with
> the TB attached (`+2.7 ± 5.4`, inconclusive): the drawish configs it fixes are the
> ≤5-man endings the TB already decides, so it only acts in a thin 6–10-man slice.
> Kept **default-off** (zero-overhead, scaffolding for a future MG-anchored re-tune).
> Lesson: **the TB masks any eval term whose payoff lives ≤5 men** — which is why
> PawnRace (acts above the boundary) registered and scale factor didn't.
>
> **NNUE — SHIPPED, default-on, +212 Elo @ movetime.** A `(768→256)×2→1` SCReLU
> net (bullet on the M3 Pro's Metal GPU, ~40 GB SF data) replaced the HCE as the
> default eval. The arc: +172 vs HCE @ fixed nodes but −156 @ movetime (a
> non-incremental float accumulator, ~100–160× HCE's eval cost) → **Phase A**
> incremental accumulator (absolute-color halves so null-move is free, ply-stack,
> Pop=`sp--`; 3.2× faster, deficit 6.9×→2.1×) → **+177.8 ± 41.5 @ movetime, H1,
> shipped default-on** → **Phase B** int16 quantization (GNN2 net, bullet ints
> verbatim, bit-exact gate; deficit →1.59×, reaches depth 15 vs HCE's 14) →
> **+212.2 ± 49.2 @ movetime, H1, shipped.** Net committed at `data/nnue/net.nnue`,
> auto-loads. **CCRL anchor (2026-06-29): ≈3260 "dirty" CCRL Blitz** (two NNUE anchors —
> Starzix 5.0 3276±83 / Viridithas 17 3245±94 @ 100ms; ENGINE_STRENGTH.md §15),
> superseding the SF-UCI_Elo **≈2882** reading (band 2847–2935 vs SF-2700/2800/2900,
> 2026-06-22) — the two consistent via the ~390 CCRL-over-FIDE offset.
>
> **NNUE v6 (512-wide) + SIMD — SHIPPED to prod.** The post-NNUE ladder
> (v5-maturity → SIMD → wider net) is now resolved, and **width was the lever**:
> - **v5 maturity net (256, 2400 SB) = dud.** Loss floored at 0.0317 = the 256
>   net's **capacity ceiling** (v4 hit it in 600 SB; v5 just took 4× longer to the
>   same floor). v5-vs-v4 @ fixed nodes **−25 ± 31 (wash)**. Reverted. More epochs
>   don't help a saturated width.
> - **v6 (512-wide)** = same arch, doubled hidden. @ fixed nodes **+124.5 ± 50 vs
>   v4** (width works). **The anneal is everything:** the un-annealed lowest-loss
>   early checkpoint scored **−96**, the final annealed v6 (HIGHER loss) **+124** —
>   a **+220 swing from the cosine anneal alone** (loss≠strength; never early-stop a
>   cosine run). @ movetime *scalar* it was a **wash (+13 ± 53)** — 512's ~2× eval
>   cost ate the edge → SIMD-gated.
> - **SIMD (`archsimd`) unlocked it.** Scalar seam (`kernels.go`) with bit-exact
>   NEON/AVX2 backends repointed in `init()`; default build stays scalar. amd64
>   AVX2 (Go 1.26.4 **stable**, `GOAMD64=v3`): per-node eval **6.5×**, dot 7×.
>   arm64 NEON (Go 1.27rc1): **4.16×**, dot 5×. With SIMD the +124 survives at
>   movetime: the v6-vs-v4 movetime SPRT firmed to **+101 Elo @ 100 ms/move**.
> - **A latent bug fixed en route:** NNUE inference was hardcoded `L1=256` (silently
>   mis-read a 512 net as garbage). Now **dynamic width** (`Net.HL`, slice
>   accumulator, importer infers width from file size) — 256 path byte-identical.
> - **Live on prod** (lairner, **amd64** Ubuntu — not ARM as once assumed):
>   `net.nnue`→v6, binary built with `GOEXPERIMENT=simd GOAMD64=v3 go1.26.4`,
>   `chessgo-deploy` hardened to the SIMD toolchain. **Net + SIMD build must ship
>   together** (v6 is a movetime wash without SIMD). Full write-up:
>   `docs/ENGINE_STRENGTH.md §11–12`, `docs/NNUE/PLAN.md`, `docs/NNUE/BULLET_SETUP.md`.
>
> **Search-feature wave — SHIPPED (2026-06-28, default-on, full write-up
> `docs/ENGINE_STRENGTH.md §13`).** Three SPRT-gated search patches landed:
> **correction history** (`corrhist`, **+66.9 @ 40k nodes** — per-pattern
> eval-error correction), **singular extensions** (`singular`, **+22.2**), and
> **frontier futility** (`futility`, **+21.3**). Fixed-nodes self-play; the bundle
> owes a movetime SPRT before the headline figure (now **≈3260 "dirty" CCRL Blitz**,
> §15) moves (self-play
> inflation + corrhist's per-node cost). **Tried and REJECTED** (default-off): the
> cheap long tail mostly washed on our already-heavily-pruned baseline — conthist
> (flat, wiring-verified), IIR (−33.7, fired on all node types), capthist (≈−33,
> scaling), probcut/razor (flat), extra corrhist keys (flat), and **aggressive LMR
> stacked on singular (−67 anti-synergy** — each positive alone: lmr2 +9.7,
> singular +22.2). Lesson: the cheap-search-patch well is mostly dry here; the next
> search Elo is reworked-selective versions of the rejects or SPSA, not more pruning.
>
> **NPS push + output buckets — 2026-06-29 (full write-up `ENGINE_STRENGTH.md §14`).**
> Banked **+23% NPS** (un-anchored): **PGO** build (+3%, `c77ccb5`) × **pin-aware legal
> movegen** (+20%, `a7c4884` — compute checkers+pins once instead of make/unmake per
> pseudo-move; order-sensitively diff-tested vs the old oracle, perft green). The
> movegen win was 3–4× its profiling estimate (cost was *distributed*, not a fat leaf —
> the `dont-trust-dry-well-perf` lesson). **Lazy/deferred accumulator** built bit-exact
> (`NNUE_LAZY`, `484685c`) but SPRT'd **flat — not shipped** (no trace of the recalled
> "−60"). **Output buckets** (8 piece-count heads, GNN3 format, `860f3ef`) built + a v8
> net trained: **+90 @ fixed-nodes but ≈0 @ movetime AND fixed-depth** — a **fixed-nodes
> mid-iteration artifact, not strength.** v8 **NOT promoted** (`net.nnue` stays v6); GNN3
> + bucket infra retained for a future wider net. **The lesson that outlives all of it:**
> **fixed-nodes self-play inflates EVAL changes** (it rewards faster within-iteration
> convergence at the node cutoff) — **gate eval at movetime or fixed-depth, never
> fixed-nodes alone** (search features are unaffected). `ENGINE_STRENGTH.md §14.4`.
>
> **Still open (priority order):** (2) NMP **verification** / verified-null in
> low-material zugzwang (the simple no-non-pawn-material gate already ships; the
> re-search-on-fail-high variant does not); (7) LMP **`non_pawn_material` gate**
> (don't move-count-prune the critical pawn move in pure pawn endings) + passed-pawn
> **push extension** (6th/7th rank); (6) 50-move-clock eval damping. (The NNUE
> post-ship ladder — v5 maturity → SIMD → wider net — is now **resolved**: v5 was a
> dud, SIMD shipped, v6 512-wide shipped; next NNUE width step is 1024, now cheap
> behind SIMD.) Standalone EG centralization was dropped (folded into KingProx); the passed-pawn
> race + knight-aware rule-of-the-square (was priority-4) **shipped** as PawnRace.
>
> **Net on the original lost position vs full Stockfish:** 1.0/5 → 60% draw-hold at
> baseline, **83% with SMP+time**. The residual losses are horizon, not eval — more
> nodes ⇒ more holds. It can't *win* a dead draw, but it no longer walks into mate.
>
> ---

The lost position is point-symmetric: rotate it 180° and White maps exactly onto Black (Ke1↔Kd8, Nd1↔Ne8, a2/b2/c2↔h7/g7/f7). Two knights, two kings, each side with three connected passers on opposite wings. White even has the move. That is a dead draw, and going 0W-3L-2D *as the side with the tempo* means the engine isn't just failing to win, it's walking into lost pawn races. That points at eval and horizon, not at the tablebase.

Note first what the tablebase can and can't do here. The position has 10 pieces. Your 5-piece Syzygy is completely inert until seven pieces come off the board, and you only probe DTZ at the root, so it contributes nothing to this game until the actual board hits ≤5 men, which is long after it's decided. So this loss is not a TB problem. It's the classic classical-engine endgame problem, which the literature is blunt about: in the endgame chess programs usually have quite a lot of difficulties.

## Why HCE engines suck at endgames

Four root causes, all of which apply to a PeSTO + linear-terms eval like yours:

1. Eval blindness. HCE has almost none of the specialized endgame knowledge that decides these positions (king activity relative to pawns, fortresses, rule-of-the-square, drawishness). The result is statically wrong scores. In Stockfish's own issue tracker, dead-drawn endgames were evaluated around +1 to +3 even at depth 50-60 with 6-man tablebases, while Leela correctly saw them as dead drawn. Your eval almost certainly scores the symmetric start ~0.0 and then can't tell the move that keeps the king on the winning trajectory from the one that drops a tempo.

2. Horizon. Endgame wins are long thin lines. A connected-passer race resolves 15-25 plies out, past where even your pruned search reaches under a 100ms clock, and your aggressive forward pruning (LMR/LMP/RFP) is most likely to chop exactly the precise king march or knight blockade that holds.

3. Zugzwang breaks null-move. Null move produces very bad results in zugzwang positions, where not moving would be best. These are rare in the middlegame but not in endgames, especially king-and-pawn endings. Once your knights trade off and you're in a pure K+P race, NMP makes a passed move look fine when you're actually in zugzwang. Crafty's answer: no non-pawn pieces means no null move, with the material threshold tuned over the years from a queen down to one minor piece.

4. TB coverage gap. Even with tablebases, 5-piece only and root-only leaves the entire 6-to-10-piece "dead zone" to eval and search, which is where most endgames are actually decided.

## What strong engines do

WDL probing inside the search, not just DTZ at the root. This is the big one and it's your largest single gap. Stockfish integrates tablebases at two levels: internal-node probing and root filtering. During search, if piece count is at or below the max, it calls probe_wdl, and on a hit the search immediately returns a value adjusted for the distance to the current ply. This effectively turns the tablebase into a perfect evaluation function for endgames. The WDL files are the ones accessed during search; the DTZ files only need to be accessed at the root. You're doing the root half and skipping the search half. Adding `tb_probe_wdl` at internal nodes (Fathom exposes it) extends your effective horizon all the way to the 5-piece boundary: the search can then *see*, 15 plies deep, that a trade-down is won/drawn/lost. It won't fix the 10-piece position directly, but it fixes the whole conversion phase the moment trades start.

Specialized endgame eval and scale factors. Stockfish scales the endgame score down toward a draw for drawish material: scale factor 0 when the strong side has no pawns and at most a bishop's advantage, a factor based on the number of pawns of the strong side, reduced when pawns are on a single flank, plus opposite-colored-bishop scaling (those endings are drawn even a pawn or two up). This stops the engine trading into "won on paper, drawn in reality" positions.

Passed-pawn and king-activity knowledge. Concrete numbers from MadChess's HCE: endgame passed-pawn bonus by rank 0/4/18/42/75/118/170, free passed pawn 0/8/34/77/138/216/311, king-escorted passer 11, and an unstoppable-passer (rule-of-the-square) bonus of 775. That unstoppable-passer term is exactly what lets eval judge the race in your lost position without searching to promotion. Plus king-pawn tropism: average Manhattan distance from the king to the pawns, weighted higher for passers (a 6:3:2 weighting for passed, backward, and remaining pawns), the closer the better. That is the term that makes the king race to the correct wing instead of centralizing generically.

NNUE. The real long-term answer, already on your roadmap. NNUE carries implicit endgame knowledge and isn't blind in the dead zone the way linear HCE is (the Leela-vs-SF gap above). Weeks of work, so not the first move.

## Where you specifically lose Elo

Mapping the above onto gomachine: root-only DTZ (no WDL-in-search), a PeSTO+4-term eval with no king-pawn tropism, no rule-of-the-square, weak passed-pawn scaling, and no drawishness scale factors, plus NMP that's almost certainly still firing in low-material zugzwang. The 1.0/5 is the eval blindness (drifts in the symmetric draw) and the losses specifically are the horizon problem (walks into a lost race it can't see resolving).

One testing note that gates all of this: measure endgame patches from an endgame start-position book, not your normal opening book. From the opening, the overwhelming majority of self-play pairs are decided or drawn before reaching the thin endgames these patches touch, so the signal is buried and SPRT either runs forever or reports H0 on a real gain. The framework convention is to use more biased books to reduce the draw rate; for endgame work that means seeding from low-piece-count FENs (filter your Lichess positions to ≤7-9 men, or a known endgame suite as start positions) and running at movetime, since both the TB and horizon effects are real-time.

Priority order, each behind a flag, Texel-tuned where applicable, SPRT-gated from an endgame book at movetime:

1. WDL probing at internal search nodes (`tb_probe_wdl`), return a bounded TB score on hit, map cursed-win/blessed-loss to draw and pass the rule50 counter. Biggest gap, directly extends horizon to the 5-piece edge.
2. Disable NMP when the side to move has no non-pawn material (start threshold; tune up to ≤1 minor), or switch to verified null-move that re-searches on fail-high to catch zugzwang. Fixes the pure K+P phase.
3. King-pawn tropism term, endgame-only, weighted toward passers. This is the term that loses the shown position.
4. Stronger passed-pawn terms: steep rank scaling, free-passer bonus, king-escorted bonus, and rule-of-the-square unstoppable-passer detection (large, ~700cp).
5. Endgame scale factors / drawishness detection: no-pawn + ≤bishop → scale to 0, single-flank reduction, opposite-bishop scaling. Stops bad trades into drawn endings.
6. 50-move awareness in eval: dampen the score toward 0 as the halfmove clock approaches 100, so it stops believing in unconvertible wins and shuffling.
7. Soften LMR/LMP at very low material and add a passed-pawn push extension (6th/7th rank). Low branching in endgames means you can afford to prune less and search deeper.
8. NNUE, when you're ready to spend the weeks. The traced-coefficient dataset from your tuner is the data step.


1. The eval is over-optimistic in pawn-race endgames. gomachine's own UCI eval of the start is cp +50 — it thinks White is half a pawn up. Stockfish says +1. Believing it's winning, it commits to a race it can only draw, over-extends, and gets mated. It also only reaches depth 18 in 2s here — barely enough to see a ~6-push promotion race resolve.
2. The evaluator has almost no real endgame knowledge. internal/eval/terms.go has exactly one passer term:
if passed:  mg += PassedMG*adv;  eg += PassedEG*adv   // linear by rank, nothing else
There is no:
- King distance to passed pawns (own king escorting a passer, enemy king blocking it)
- "Rule of the square" / unstoppable-passer detection
- King activity/centralization beyond the static PSQT
- Connected/protected passed-pawn bonus

This means:
Your +50 isn't really wrong in magnitude. The true value is 0.00 (dead draw), and both engines overshoot it: gomachine +50, SF +100. The difference is that SF doesn't lose, because its search reaches the promotion and collapses the score back toward 0; yours can't at depth 18, so the optimism never gets corrected and the engine acts on it. So this is two coupled failures, not one: the eval over-commits, and the search is too shallow to veto it. A 6-push race with king moves is north of 24 plies, well past 18. That matters for ranking the terms, because the highest-value eval terms here are the ones that let a depth-18 eval reach the right verdict without searching to ply 30.

On your ranking: agreed, king-proximity is the highest-value smooth term, and it's the one tied straight to "never escorts, never stops." A king that stays near its pawns survives even if the eval stays a bit hopeful, so it breaks the loss chain (optimism → over-extend → king mispositioned → mated) at the link least likely to break. Two refinements to it:

Weight the proximity by the passer's rank. distance(king, 6th-rank passer) has to dominate distance(king, 3rd-rank passer). Escorting an almost-queen is worth far more than nudging a home pawn, and a flat distance term will under-react in exactly the sharp positions that decide the game.

Pure EG centralization (your third term) is the weakest of the three and can mislead here. In an opposite-wing race you don't want the king centralized, you want it on the wing that matters, and your PSQT already supplies generic centralization. Fold "activity" into proximity-to-passers plus king mobility rather than adding a separate center bonus.

What else I found, beyond your three terms:

1. Passed-pawn race comparison, distinct from rule-of-the-square. The term that actually kills the +50 over-optimism is one that counts both races: plies until my fastest passer queens vs his, accounting for whose move it is and who gets caught. Rule-of-the-square only asks "is my passer unstoppable." The race term asks "do I queen first." In a symmetric race that nets to ~0 and the eval stops believing it's winning. This is the single term most directly responsible for stopping the over-commitment that gets you mated.

2. The unstoppable-passer detector must account for the knight, not just the king. This is a correctness trap precisely in K+N+P, which is the game you lost. A king-only square rule will flag passers as unstoppable that the enemy knight catches and hand you wrong +700s. The check has to be "no enemy piece can reach the promotion path in time," not "enemy king is outside the square."

3. WDL-in-search is the other half of the horizon fix, and it is not an eval term, so your eval-term plan will never produce it. Don't let it get crowded out. It's inert at 10 pieces, but the moment trades start it returns exact leaf values and is worth far more per ply than any heuristic. Run it as a parallel track.

4. Don't bolt the new terms onto the existing PassedEG. Re-tune the passer terms jointly with the new king-distance and race terms. This is your own §6 lesson: bolt-on terms over a frozen baseline double-count and produce compensating wrong-signed weights, which is the −148 path. King-distance overlaps the linear passer term (an escorted passer is already partly scored by PassedEG), so they have to be fit together or the tuner will fight itself.

5. The terms won't tune or SPRT-register on your current data and book. Two separate problems:
   Tuning data: a generic quiet Lichess set is mostly middlegames, so the king-distance feature is active and decisive in too few positions. The gradient is weak and the weight comes out under-determined. Oversample low-piece-count positions in the tuning EPD.
   SPRT book: from the standard opening book, most pairs never reach a decisive king-and-pawn race, so these terms read as noise and the test runs forever or returns H0 on a real gain. SPRT them from an endgame start book (filter to ≤7-9 men), ideally pawn-race positions, at movetime. This is the difference between reading +40 Elo and reading 0.

6. Gate every new term to the EG side of the taper so it doesn't leak into the middlegame and get washed out there.

7. Connected/protected-passer bonus: correct knowledge, but both sides' passers are connected in this position, so it nets ~0 and won't move this result. Add it for general strength, not as a fix for these losses.

8. Side check worth one look: depth 18 in 2s at 10 pieces is low. Branching collapses in the endgame, so something is capping effective depth on the critical line, most likely over-aggressive LMR/LMP or null-move still firing in the race (a pass looks fine, so it prunes the line where it should be defending). The eval shortcuts only half-fix a search that's pruning away the king march.

Priority:
1. King-proximity, rank-weighted. The sturdiest fix for king placement, tied to the failure you saw.
2. Passed-pawn race comparison, with knight-aware unstoppable detection folded in. The fix for the over-optimism that drives the over-commit.
3. WDL-in-search. Parallel track, biggest per-ply value once pieces drop.
4. The plumbing that makes 1 through 3 real and measurable: re-tune passers jointly, EG-only gating, endgame-heavy tuning data, endgame SPRT book.

Drop standalone EG centralization. Connected-passer and the search-pruning audit are secondary.


---

> **⟵ OUTCOMES (2026-06-29) — this analysis block was acted on; here's what held.**
> The Tier-1 recs below were implemented and SPRT-tested. Scorecard:
> - **PGO (#2): ✅ shipped, +3% NPS** (`c77ccb5`).
> - **Pin-aware movegen (implied by "already-pruned" NPS): ✅ shipped, +20% NPS**
>   (`a7c4884`) — the single biggest win, 3–4× the estimate.
> - **Lazy/deferred accumulator (#1, "biggest confirmed unrealized NPS win"): ❌
>   built bit-exact, SPRT'd FLAT.** The 2 KB-copy waste is real, but the deferred
>   walk-back cancels it on our heavily-pruned/high-TT-hit tree. Not shipped.
> - **Output buckets (#4): ❌ built (GNN3, v8 net), but a MOVETIME WASH** — +90 @
>   fixed-nodes collapsed to ≈0 @ movetime & fixed-depth (a mid-iteration artifact).
>   Infra kept; net not promoted. **This refutes the "free Elo" label below.**
> - **The multilayer → int8/VNNI → width chain (#7–#8): UNTOUCHED** — still the
>   plausible structural path, but note buckets (its first rung) didn't pay at our
>   clock, so re-validate each rung at **movetime** before investing.
> - **Biggest meta-lesson, not in the analysis:** fixed-nodes SPRT *inflates eval
>   changes* — gate eval at movetime/fixed-depth. Full write-up `ENGINE_STRENGTH.md
>   §14`. Read the recs below as the *input hypothesis*, the scorecard as the *result*.

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

