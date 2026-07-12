# Engine strength — measuring & improving gomachine

> How we test and improve the `gomachine` engine's playing strength. The tooling
> lives in `gomachine/internal/{bench,tune}` + the `gomachine bench` / `gomachine
> tune` CLI; the techniques live in `internal/{search,eval,chess}`.
>
> **One-line philosophy:** the only trustworthy measure of strength is **winning
> more games**, measured by **self-play SPRT**. Everything else (matching
> Stockfish's eval, solving test positions, an absolute Elo number) is a sanity
> check, not a measure — and we have the scars to prove it (see §6).

---

## 1. The two halves of an engine

- **Search** — *calculates*: looks ahead, prunes, picks a move. Improvements here
  (SEE, pruning, Lazy SMP) buy strength **per unit of work / per unit of time**;
  most vanish at infinite time.
- **Evaluation** — *judges*: scores a still position (material + tapered PSQT +
  tempo, today). Improvements here add **chess knowledge** that helps at *every*
  time control.

This session's gains came from **both halves**: a full suite of SPRT-gated
**search** patches (the cheap, reliable Elo — SEE, the pruning stack, Lazy SMP),
and then a **Texel-tuned eval** that — done right (joint Adam on WDL with the PSQT
tuned *in*) — added **+101 Elo @ movetime** (§5). An earlier hand-tuned attempt
was a dead end (−148 Elo), but that was a broken *method*, not a verdict on HCE
(§6). The frontier beyond today's linear terms is richer HCE knowledge and then
**NNUE** (§7).

---

## 2. The testing harness (`gomachine bench`)

### 2.1 `bench sprt` — self-play SPRT (the primary loop)

Two configurations of the **same binary** play game pairs (reversed colors from a
shared opening) until a **Sequential Probability Ratio Test** accepts H1 (the
patch is an improvement) or H0 (it isn't). Key design choices:

- **In-process, no UCI.** Both engines are Go functions; the arbiter is our own
  perft-verified `internal/chess` + `engine.Adjudicate`. No subprocesses, no
  serialization → far higher games/sec, which is the SPRT bottleneck.
- **A patch is a `search.Params` diff.** Because both engines live in one binary,
  a change is a feature flag (e.g. `lmr=off`), and `--new`/`--old` select the two
  configs. This *is* the per-feature gating workflow.
- **Fixed nodes** (`--nodes`) → reproducible, hardware-independent — **but valid
  only for SEARCH features.** Fixed-nodes *inflates EVAL changes*: it stops
  mid-iteration at the node cutoff and rewards whichever eval converged to the
  better move *first within* that iteration, an edge a completed-iteration search
  erases. It inflated a v8 output-bucket net to **+90 that was ≈0 at movetime**
  (§14.4). **Test eval at `--movetime` or fixed `--new-depth`/`--old-depth`**
  (completed iterations), never fixed-nodes alone. Use `--movetime` too for
  time-dependent features like Lazy SMP, §4.
- **Pentanomial GSPRT.** Game *pairs* (reversed colors, shared opening) give 5
  outcomes per pair; the pentanomial model has lower variance than win/draw/loss
  trinomial, so it converges faster. The LLR is the quadratic/normal-approximation
  GSPRT (cutechess-equivalent), with a small regularizing prior + a min-pairs gate
  so it never decides on a near-empty sample. See `internal/bench/sprt.go`.

```sh
# implement a feature behind a search.Params flag, then gate it:
gomachine bench sprt --new "see=on" --old "see=off" --nodes 40000 --elo0 0 --elo1 6
```

If H1: make the flag the default in `DefaultParams()` and re-baseline; if H0: drop
it. Param spec keys: `tt nullmove nullr lmr checkext see delta asp rfp lmp
mobility pawns kingsafety bishoppair kingprox eval tuned tb tbsearch` (`eval`
toggles all knowledge terms; `kingprox` is the EG king↔passer term (§10); `tb`
toggles root-DTZ and `tbsearch` toggles WDL-in-search — both need `--tb-path` to
point at a tablebase dir).

### 2.2 `bench vs-stockfish` — absolute Elo anchor

Plays our engine (in-process) against **Stockfish** (a UCI subprocess) limited via
`UCI_Elo`/`Skill Level`, our rules as arbiter. Estimates our absolute Elo as the
opponent's Elo plus the head-to-head difference.

```sh
gomachine bench vs-stockfish --sf /opt/homebrew/bin/stockfish --sf-elo 2500 \
  --movetime 100 --games 60 --threads 4
```

**Current reading (2026-07-11) — the clean picture:**
- gomachine is **~150–200 (closer to 150) Elo below full-strength Stockfish at equal movetime.**
- Warm gomachine already **beats cold Stockfish** (fresh process / empty hash every move) at the
  same movetime.
- v6's **100W–0L vs a ~3400 engine (2026-07-01, §20) is the hard floor → materially above 3400,
  upper bound unmeasured.** Do **not** quote any point rating (3400/3700/≈3260/≈3200 etc.) as
  current — only the ">3400 floor" and the "~150–200 below full-strength SF at equal movetime" lines
  above.
- **Prod net (2026-07-11) = the SF full-threats net** (`chessgo_threats_sf_640`, `data/nnue/kb-mirror.bin`),
  **+10 Elo over efs28** (FN +11 / MT +9 @100 ms). It supersedes the efs28 net (§32) and the
  multilayer ml640 net (§35 — its "+22 ship" was later found ≈lean and did not remain prod).

All dated reads below (the ≈3260/≈3200 anchors, the v6-era bands) are kept **for the record only**,
not as current strength.

**★ Priority direction (2026-07-05 anchor):** the anchor indicates the engine is **~280 Elo
EVAL-bound** — search is near-optimal (cheap Stormphrax flags washed at movetime; a full SPSA landed
every margin mid-range/flat). So the lever is the **eval/data retrain**, not more search work
(`docs/open_tasks/data-retrain-640sb.md`). [Anchor methodology: the valid gauntlet path, 2026-07-05;
confirm/link specifics before quoting the 280 as a hard figure.]

**Prior reading (2026-06-29, CCRL Blitz anchor — the then-headline figure, now raised to the
3400–3700 bracket by §20):** **≈3260 "dirty" CCRL Blitz.** Measured by
playing the prod v6+SIMD build at 100 ms/move vs **full-strength, officially-rated NNUE
engines**, anchoring to each opponent's CCRL Blitz rating (not the handicapped-SF
UCI_Elo scale). Two NNUE anchors agree: **3276 ± 83** vs Starzix 5.0 (~3622, scored 12%)
and **3245 ± 94** vs Viridithas 17.0.0 (~3708, scored 6.5%), pooled **≈3260**. It's
"dirty" — 100 ms/move (not CCRL's 2′+1″) and both scores are blowouts (a below-3622
~50% match is pending to tighten the CI) — but two engines 86 Elo apart estimating only
31 apart is real convergence. It **reconciles** the old SF number rather than refuting
it: CCRL runs ~390 above the FIDE/Lichess-ish scale SF's UCI_Elo approximates, so
2882 + ~390 ≈ 3270 — **SF was on a lower scale, not lying.** Full write-up §15. (A first
attempt used **Stash** as the anchor — wrong on two counts: HCE, and its "3399" was an
*unofficial estimate*, not a ranked CCRL entry — set aside, §15.)

**Prior reading (2026-06-22, SF-UCI_Elo anchor — now a lower-scale cross-check):**
**≈2882** across three settings —
**2847 ± 205 vs SF-2700** (70%, W6 D2 L2), **2870 ± 168 vs SF-2800** (60%, W4 D4 L2),
**2935 ± 205 vs SF-2900** (55%, W5 D1 L4), 10 games each @ 100ms on the prod amd64 box.
Inverse-variance pooled **≈2882 ± 110**; the monotonic rise with the SF setting is the
UCI_Elo non-linearity, so the honest read is the **band 2847–2935**, not the point. It
confirms the v6-vs-v4 self-play SPRT (+101 @ movetime, §12) and the v4-anchor-plus-SPRT
projection (~2780 + 101 ≈ 2881 — measured 2882).

**Prior reading (2026-06-19, tuned HCE):** **≈2720 ± 79** — 100 games vs **SF-17.1 @
UCI_Elo 2500**, scoring **78%** (W75 D6 L19, +220 head-to-head). Up from ~2600 before the
tuned eval; the anchor's ~+90 jump corroborated the eval's +101-Elo movetime SPRT (§5).

**Caveat (important):** this anchor is *noisy and biased*. Stockfish's UCI_Elo
scale isn't logistic-linear and it plays erratically when handicapped, so
reference points disagree (earlier we measured ≈2361 vs SF-2200 *and* ≈2627 vs
SF-2500 in the same run — intervals that don't overlap). Use it for a rough band
(now ~2700-ish), **never to gate a patch.** SPRT is the ruler; this is the tape
measure you eyeball — sweep a few `--sf-elo` values to triangulate.

### 2.3 `bench game` — watch one game

Plays a single gomachine-vs-Stockfish game and prints the move list + result —
for watching, not measuring.

```sh
gomachine bench game --sf-skill 20 --movetime 300 --color white --threads 4
```

### 2.4 `bench blunders` — mine eval blind spots → training data

Answers the question "gomachine just made a move and the eval bar cratered — how
did it not see that?" at scale, and turns the answer into **hard-example training
data**. gomachine plays N games vs Stockfish; a **separate full-strength Stockfish
"judge"** (its own process, deeper budget — never the handicapped opponent) scores
the position **before and after every gomachine move**. The drop is measured in
**win probability** (Lichess-style, `winProb(cp)=1/(1+10^(−cp/400))`), *not* raw
centipawns — so a "mate → still winning" move barely registers while an "equal →
losing" move is huge, and mate scores stop polluting the ranking.

```sh
gomachine bench blunders --sf /opt/homebrew/bin/stockfish \
  --games 200 --judge-movetime 200 --movetime 100 --sf-elo 2600 \
  --epd-out data/blunders/mined.epd --json-out data/blunders/mined.json
```

The load-bearing idea: every flagged blunder is classified **blind spot** vs
**horizon** using gomachine's *own* reported search score.

- **Blind spot** — gomachine's eval said "I'm fine" (high win-prob) but the position
  was actually lost. The **eval** is wrong → eval-trainable.
- **Horizon** — gomachine's own eval *already* saw the drop; it just couldn't avoid
  it (a deep tactic). More data won't fix this — it's a **search** problem. Filtered
  out of the training set.

Output: a JSON dump of every blunder (for scripting), and — the headline — an EPD
training set of the **blind-spot** positions. Respecting §6's hardest lesson, the
judge's cp only **selects** which positions to mine; the **label is the eventual
game result (WDL)**, never the distilled cp. It emits the position *after* the
blunder (genuinely bad — labelling the pre-blunder position, which was fine, with the
loss would poison the eval), gated to quiet, no-longer-winning positions so the label
is meaningful. The file drops straight into the existing tuner:

```sh
gomachine tune --epd data/blunders/mined.epd --out internal/eval/tuned_tables.go
# …then SPRT-gate as always — mined data is no exception to §8.
```

Flags worth knowing: `--blunder-wp` (win-prob drop to flag, default 0.30 = Lichess
blunder), `--blind-wp` (overestimate → blind spot, default 0.20), `--train-max-cp`
(EPD only if the result is ≤ this for gomachine, default 0), `--quiet-only`,
`--confirm-loss` (only blunders in games gomachine didn't win). **Cost note:** two
judge calls per gomachine move (~2 × moves × games), so it's compute-heavy — scale
`--games`/`--judge-movetime` to taste. This is hard-example mining, the data lever in
§7: it complements bullet's bulk Stockfish data with gomachine's *own* specific
weaknesses, the positions where the current eval is most wrong.

---

## 3. Search improvements (all SPRT-gated, now defaults)

Measured by self-play SPRT @ 40k nodes, [0,6] Elo bounds, 2026-06-18. These are
"per-unit-work" gains; the **combined real-time gain** (movetime self-play, full
stack vs all-off) was **+250.6 ± 83.4 Elo**.

| Feature | Flag | Self-play Elo | Where |
|---|---|---|---|
| Static Exchange Evaluation | `see` | +66.2 ± 22.9 | `internal/chess/see.go` |
| Delta pruning (quiescence) | `delta` | +22.0 ± 12.2 | `search.go` qsearch |
| Aspiration windows | `asp` | +21.8 ± 12.1 | `search.go searchRoot` |
| Reverse futility pruning | `rfp` | +67.2 ± 23.1 | `search.go` (needs static eval) |
| Late move pruning | `lmp` | +94.6 ± 28.5 | `search.go` move loop |

- **SEE** (`pos.SEE(m)`, `pos.SEEGE`) — the net material of a capture after all
  recaptures. Used to order captures (losing ones last) and to prune losing
  captures in quiescence. A rules primitive, so it lives in `internal/chess`.
- **Delta pruning** — skip a quiescence capture that can't raise alpha even with
  the victim + a margin.
- **Aspiration windows** — search the root in a narrow window around the previous
  iteration's score, widening only the failing bound. Correctness-tested to give
  *identical* results to a full-window search **under plain alpha-beta** (the
  re-search logic is exact). With window-sensitive pruning on (null-move / LMR /
  RFP / LMP / delta — all read α/β) a narrow search legitimately prunes a
  different tree, so move/score can differ by a few cp on some positions; that's
  expected, not a bug, which is why strength is judged by SPRT, not this equality.
- **Reverse futility pruning** (static null move) — at a non-PV node near the
  leaves, if `staticEval - margin*depth >= beta`, fail high without searching.
  Required adding a static eval inside negamax.
- **Late move pruning** — at low depth, after `3 + depth²` quiet moves, skip the
  rest (move ordering puts the good ones first).

---

## 4. Lazy SMP — multithreading (`+96.9 ± 36.9 Elo`, 4 threads vs 1 @ movetime)

`N` workers search the same position concurrently, **sharing one transposition
table**; they diverge via timing and cross-pollinate through the TT. The result is
taken from the deepest-completed worker. This is a **real-time** gain (more useful
nodes/sec → deeper at the same clock), so it's **invisible to fixed-nodes SPRT** —
measure it at `--movetime`.

- **Lock-free TT** (`internal/search/tt.go`) — Hyatt's XOR scheme: two atomic
  64-bit words per slot (`data`, and `lock = key ^ data`). A torn read fails the
  XOR check and becomes a harmless cache miss — never a crash or illegal move.
  Verified clean under `go test -race` with 8 concurrent workers.
- `threads=1` routes to the exact single-threaded path → **byte-identical** to
  serial, so all prior SPRT results are preserved.
- Driven via `--new-threads`/`--old-threads` (sprt) and `--threads`
  (vs-stockfish, game). Engine API: `Engine.PlayThreads(...)`.

> **Shipped to production (2026-06-21).** Both prod paths take a threads flag:
> `serve` via `-search-threads` and the hub bot via `-bot-search-threads` (the
> `serve`/`hub` worker pools route every full-strength search through
> `SearchParallel(…, threads)`; `threads=1` stays byte-identical to serial). The
> prod box is **4 cores shared by `serve`+`hub`**, so the live config is the
> **balanced 2-thread** setting (`serve -workers 2 -search-threads 2`, `hub
> -bot-search-threads 2`), keeping `workers × threads ≤ cores`. Set in the systemd
> `ExecStart` lines (see `docs/COMMANDS.md`), **not** the deploy script, so it
> survives every `chessgo-deploy` (which only `git pull`s + restarts, never
> `daemon-reload`s the units). The +96.9 figure above is **4t vs 1t**; the live box
> runs 2t, so it captures a fraction of that — getting the full gain would mean
> serializing concurrency on 4 cores. The watch-filler pool stays serial (cosmetic;
> threads hardcoded to 1, no flag).

---

## 5. The Texel tuner (`gomachine tune`) — **shipped, +101 Elo**

**SPRT result (2026-06-19) — tuned eval vs the bare PeSTO base** (`bench sprt
--new "tuned=on" --old ""`, pentanomial GSPRT, [0,6] bounds, accepted H1):

| Test | Budget | Elo | Pairs | Reading |
|---|---|---|---:|---|
| eval *quality* | 40k nodes | **+128.1 ± 34.7** | 151 | better moves per node |
| eval *real-time* | 100 ms/move | **+101 ± 29** | 172 | net of the terms' compute cost |

`tuned=on` flips the tuned PSQT + tuned weights + all four knowledge terms on as
one unit (now the default in `search.DefaultParams`). The ~28-Elo nodes→movetime
drop is the eval's added cost (mobility's per-piece attack lookups), well short of
eating the gain. Independently corroborated by the Stockfish anchor (§2.2: ~2600
→ ~2720). **This is the single biggest eval change in the engine's history — and
the first that *gained* strength** (vs −148 the old way; see §6).

Fits the **whole eval as one linear model** — PSQT/material *and* the knowledge
terms, jointly — to minimize MSE between the sigmoided eval and the game result.

```sh
# tune on a quiet-labelled EPD dataset (Lichess), write tuned tables, then SPRT:
gomachine tune --epd quiet-labeled.epd --out internal/eval/tuned_tables.go
gomachine bench sprt --new "tuned=on" --old "" --movetime 100 --elo0 0 --elo1 6

# self-play instead of a dataset (slower); --lambda blends in our own search eval:
gomachine tune --games 5000 --lambda 0.7
```

Pipeline (`internal/tune`): load quiet WDL positions (Lichess EPD, or self-play
with a SEE/in-check quiet filter) → trace each into eval **coefficients**
(`eval.EvalTrace`, the "evaluation wrapping" trick) → fit `K` once → **joint Adam
gradient descent** over all ~788 weights with decoupled decay toward PeSTO →
emit `tuned_tables.go`. The PSQT is tuned *with* the terms, which is the whole
point (see §6).

**This replaced the earlier −148 Elo result.** That loss was a broken *method*,
not a verdict on HCE: coordinate descent (per-term, not joint) over **bolt-on
scalars on a frozen PSQT**, fit to a **distilled Stockfish-cp** target by **MSE
alone** (no SPRT). Every one of those is a known anti-pattern; fixing them flips
the sign of the result.

---

## 6. Key findings (the expensive lessons)

1. **How you tune dominates what you tune.** The same terms that lost −148 Elo
   under coordinate-descent-MSE-on-frozen-PSQT *gained* +101 Elo (movetime, SPRT)
   under joint Adam on WDL with the PSQT tuned in. The fixes that mattered, in
   rough order: (a) **tune the PSQT jointly** — bolt-on terms over a frozen PSQT
   double-count and produce compensating wrong-signed weights; (b) **WDL target,
   not distilled cp** — eval-fit ≠ strength (the lowest-MSE distillation fit was
   play-catastrophic, e.g. `MobEG[Q] = -21`); (c) **joint gradient descent**, not
   per-coordinate; (d) **real, diverse data** — on 725k Lichess positions even
   pure WDL produces correctly-signed weights (queen-mobility +6 not −28, doubled
   −22 not +12), so the old sign-smearing was substantially a small-correlated-
   self-play *data* problem.

2. **Still SPRT-gate everything.** Lower MSE never means more Elo on its own — the
   `tuned=on` set was accepted by self-play SPRT (+128 @ nodes, +101 @ movetime),
   not by its error. A `--lambda` WDL+eval blend is available as cheap insurance
   against label-smearing, but its value (and λ) is an SPRT question, not an MSE one.

3. **The Stockfish anchor is a band, not a number** (§2.2). Trust SPRT for
   magnitude; the anchor only says "roughly here."

4. **Fixed nodes vs movetime matters.** Pure-efficiency features (SEE ordering,
   aspiration, SMP) are speed gains: SMP is invisible at fixed nodes; SEE's CPU
   cost is "free" at fixed nodes but real at movetime — so fixed-nodes Elo
   slightly *overstates* the real-time gain. The movetime/Stockfish numbers are
   the honest real-world check. **For EVAL changes the overstatement is not
   slight — it can be total** (§14.4, the expensive lesson of 2026-06-29): a v8
   output-bucket net read **+90 @ fixed nodes but ≈0 @ both movetime AND fixed
   depth.** Fixed-nodes rewards faster *within-iteration convergence* at the
   arbitrary node cutoff; a completed-iteration search (movetime or fixed-depth)
   lets the weaker eval reach the same move and erases the edge. **Gate eval at
   movetime or fixed-depth, never fixed-nodes alone.** (Search features are
   unaffected — they help per unit of work, completed iteration or not.)

---

## 7. Where the next Elo is

| Lever | Elo (rough) | Effort | Notes |
|---|---|---|---|
| **Tuned HCE (shipped)** | **+101 @ movetime** | done | joint Adam on WDL, PSQT tuned in (§5) |
| **Syzygy 5-piece root-DTZ (shipped, live)** | **+18.8 @ movetime** (std book) | done | CGo+Fathom, root probe, `tb` flag; SPRT-accepted (§9); auto-loads in prod from `data/syzygy` |
| **WDL-in-search (shipped, live)** | **+32.7 @ movetime** (endgame book) | done | `tbsearch` flag; lock-free `tb_probe_wdl` at internal nodes; default-on, gated off for weakened bots (§10) |
| **KingProx eval term (shipped, live)** | **+30.5 @ movetime** (endgame book) | done | EG king-proximity to advanced passers; `kingprox` flag, default-on; rejected a joint re-tune to pair it (§10) |
| **PawnRace eval term (shipped)** | **+17.4 @ movetime** (endgame book) | done | EG knight-aware unstoppable-passer / race term; `pawnrace` flag, default-on; acts above the 5-man TB boundary so it isn't TB-masked (§10.5) |
| Richer HCE terms (Phase 2, remainder) | +20–60 | medium | NMP verification / verified-null in low-material zugzwang, LMP `non_pawn_material` gate + passed-pawn push extension, 50-move-clock eval damping. (EG scale factors were built but SPRT'd ~0 with the TB — kept default-off, §10.6) |
| **Ship SMP to prod (shipped, live)** | **part of the +97** (2t on a 4-core box) | done | `serve -search-threads 2` + `hub -bot-search-threads 2` in the systemd units (§4); balanced for the shared box |
| **Clock-aware time management (shipped)** | not yet SPRT-anchored | done | soft/hard split, best-move-stability + score-drop scaling; UCI-clock aware, legacy `MoveTime` path byte-identical (§26). Only bites when a real clock is passed (`wtime`/`btime`) — inert for fixed-`--movetime` SPRTs |
| **Qsearch captures-only (shipped)** | **+20 @ movetime** | done | noisy-only qsearch movegen; byte-identical at fixed nodes (reads 0), +20 at movetime; `QCaps` default-on (§26.4) |
| **VNNI VPDPBUSD int8 dot (shipped, banked)** | **+18–22% kernel** | done | single-instruction int8 L1 matmul, CPUID-gated; off the default eval path until an int8 net ships (§26.4) |
| Remaining no-retrain NPS | +? | open | staged movegen, lazy enriched accumulator; NEON int8 kernels. Castling-drop was **rejected** (−8 movetime, §26.4) |
| **TT static-eval cache (shipped)** | **+14.8 @ movetime** (stopped early) | done | `tteval` flag, default-on; reuse the TT-cached static eval on non-cutoff hits → skips the NNUE SCReLU dot. Behavior-preserving at fixed nodes (byte-identical), so movetime-only. SPRT vs off @ 100ms: Elo +14.8 ± 10.8, LLR +2.32 @ 998 pairs (lower CI +4.0) — stopped just shy of the formal H1 cross, accepted on the stable trend. Also fixed a latent move-encoding bug (`promoCode` underflow leaked garbage into move bits 16-21) so moves are canonically 16-bit |
| **Correction history (shipped)** | **+66.9 @ 40k nodes** | done | per-pattern static-eval-vs-search bias correction; `corrhist` flag, default-on (§13) |
| **Singular extensions (shipped)** | **+22.2 @ 40k nodes** | done | extend the lone forcing TT move; `singular`+`multicut`, default-on; toxic with aggressive LMR (§13) |
| **Frontier futility (shipped)** | **+21.3 @ 40k nodes** | done | skip hopeless late quiets near leaves; `futility` flag, default-on (§13) |
| **SEE/history late-leaf pruning (shipped)** | **+86.8 / +75.9 / +97 @ 40k nodes** | done | HistPrune + SEEQuiet(margin 150) + CaptSEE(margin 25), default-on; shallow non-PV pruning with retuned margins (§13.5). CaptSEE peak=25 — margin 0 lost −86.6, sweep complete |
| Remaining search patches | +20–50 | low | countermove/conthist (rework), double extensions, fractional LMR — the cheap-pruning long tail mostly SPRT'd flat/negative on our already-heavily-pruned baseline (§13) |
| **NNUE 256-wide (SHIPPED, default-on)** | **+212 @ movetime** (H1) | done | bullet-trained `(768→256)×2→1` SCReLU on Metal; incremental int16 accumulator (Phases A+B, §11). Replaced HCE as the default eval |
| **NNUE v6 512-wide + SIMD (SHIPPED, live)** | **+124 @ fixed nodes** vs the 256 net; recovered @ movetime by SIMD | done | width was the lever (v5 maturity-retrain of 256 was a wash); `archsimd` AVX2/NEON kernels bit-exact, **6.5×/4.16×** eval. Live in prod (§12). Next width step: 1024 |
| **NPS push (shipped)** | **+23% NPS** (un-anchored) | done | PGO (+3%) × pin-aware legal movegen (+20%), compounded; movetime strength, not yet re-anchored (§14.1) |
| **Output buckets (tested — WASH)** | **≈0 @ movetime** | done | v8 net: +90 @ fixed-nodes but ≈0 @ movetime & fixed-depth — a fixed-nodes mirage (§14.3–14.4). Infra (GNN3 + buckets) banked in code; v8 net **not promoted** |
| SPSA (Elo-in-the-loop weight tuning) | modest | medium | the *correct* way to tune the few params with no static objective |

Current strength (2026-07-11): gomachine is **~150–200 (closer to 150) Elo below full-strength
Stockfish at equal movetime**, and warm gomachine already **beats cold Stockfish** at the same
movetime. v6's **100W–0L vs a ~3400 engine (2026-07-01, §20) is the hard floor → materially above
3400, upper bound unmeasured.** Do **not** quote any point rating (3400/3700/≈3260/≈3200/≈2882 etc.)
as current — only the ">3400 floor" and "~150–200 below full-strength SF at equal movetime" lines.
The prod net is the **SF full-threats net** (`chessgo_threats_sf_640`, **+10 over efs28**). All the
figures below (the ≈3260 "dirty" read, the SF-UCI_Elo ≈2882 band, the v6-era 3400–3700 band) are
historical record only, not current strength.
For reference the older SF-UCI_Elo anchor read **≈2882** (band 2847–2935 vs SF-2700/2800/2900,
2026-06-22, §2.2); the
**trustworthy relative** figure remains the self-play SPRT (**+212 ± 49 vs HCE @
movetime**, §11), not any absolute anchor. The NNUE width/data levers (§11.4) are how the
remaining long-TC gap to full-strength SF narrows (the old "~800 CCRL above us" was measured
off the superseded ≈3260 read; against the current floor it's **at most ~680** at CCRL TC — the ~380
lower end used the now-dead 3700 ceiling (§28), so the real gap is smaller/unknown. (The old "far
less at short movetimes" caveat is **retracted** — §27.5: that rested on the cold frontend SF; vs a
warm SF the short-TC gap is *large*, ~335 Elo at 100 ms.)

**Update — v6 (512-wide) + SIMD now live (§12):** the wider net adds **+124.5 ± 50
@ fixed nodes** over the 256 net, and `archsimd` SIMD (6.5× eval on amd64) lets that
survive at movetime — the v6-vs-v4 movetime SPRT firmed to **+101 Elo @ 100 ms/move**.
So current strength on the SF-UCI_Elo scale is **≈2882** (band 2847–2935 vs
SF-2700/2800/2900, §2.2) — which the 2026-06-29 CCRL anchor later re-expressed as
**≈3260 "dirty" CCRL Blitz** (§15), the two consistent via the ~390 CCRL-over-FIDE offset.

## 9. Syzygy endgame tablebases (shipped, +18.8 Elo)

5-piece Syzygy probing via **CGo + Fathom** (the reference C prober;
`internal/syzygy`, a `!cgo` stub keeps cross-compiles building). The engine probes
`tb_probe_root` (DTZ) at the search **root only** — same hook as the opening book —
and on a hit returns the provably-optimal move at zero search cost. Behind the `tb`
flag (`search.Params.UseTablebase`, default on); **inert unless a tablebase is
attached** via `Engine.SetTablebase`.

**Shipped to prod (auto-load):** `serve` + `hub` auto-discover the set from
`gomachine/data/syzygy/` (in-repo, gitignored, cwd-relative like `data/book.bin`;
`SYZYGY_PATH` overrides) and attach it to every pooled engine — no flag/env/deploy
change. Full-strength bot moves + `/analyze` probe it (weakened bots stay at their
level — only the no-noise branch probes). See `docs/SYZYGY_PLAN.md` for the
download command + verification.

**SPRT (2026-06-20):** `--new "tb=on" --old "tb=off" --tb-path <5-piece> --movetime
100` → accepted H1, **+18.8 ± 11.1 Elo**, 109 pairs, pentanomial `[0 0 97 12 0]`
(**zero lost pairs**). Use `--movetime` — the gain is real-time and invisible at
fixed nodes. It converts the endings search can't under a clock (K+B+N vs K, K+Q
vs K+R, wrong-bishop fortresses).

**Gotcha (cost a long debug):** Fathom assumes **legal** positions; feeding it an
illegal one (side-not-to-move in check) makes its capture-resolution "capture the
king" → `lsb(0)` → assert/SIGBUS that masquerades as a table-decode/alignment bug.
It is none of those. The `pos.Legal()` guard in `tablebaseMove` covers it (real
game positions are always legal).

**Why the simple `tb_probe_root`, not `tb_probe_root_dtz`:** the simple probe
returns FAILED for some positions (the DTZ table is stored from the other side) and
the engine searches there. The obvious "fix" — `tb_probe_root_dtz`, which ranks
every move by probing the resulting positions — was tried and **reverted**: its
`tbRank` is a *filter for a search*, not a standalone picker (it caps at 1000 for
all comfortably-winning moves, hiding the true DTZ distance), so picking max-rank
made the **winning** side shuffle among tied moves and **draw a won KBN by fivefold
repetition** (`TestTablebaseMatesKBNvK` caught it — a thrown win). The simple probe
reliably hits the side that *matters* (the winner, which needs the exact DTZ move
to convert); its misses fall mostly on the losing side, where the search fallback
is safe. So don't assert "every winning move is a TB hit," and don't swap in
`tb_probe_root_dtz` without a per-move-DTZ tiebreak + re-SPRT. Details in
`docs/SYZYGY_PLAN.md`.

---

## 8. Adding a new improvement — the loop

1. Implement the feature behind a new `search.Params` (or `eval.Config`) flag,
   **defaulting off**. Add a parser key in `internal/bench/config.go`.
2. `go build` + `go test ./...` + `perft` green; add a unit test for the feature.
3. SPRT-gate it: `bench sprt --new "flag=on" --old "flag=off" --nodes 40000
   --elo0 0 --elo1 6`.
4. **H1** → flip the default in `DefaultParams()`, re-baseline, update the table
   in §3. **H0** → drop or rework.
5. Every ~2–3 accepted patches, re-anchor with `bench vs-stockfish` to watch the
   absolute number move.

---

## 10. Endgame strength push (shipped: WDL-in-search + KingProx)

Triggered by a concrete failure: gomachine, as White with the move, **lost** the
point-symmetric K+N+3-pawn position `3kn3/5ppp/8/8/8/8/PPP5/3NK3 w` to full
Stockfish — a **dead draw** (180° rotation maps White onto Black; the move is the
only asymmetry, worth ~nil here). It scored **1.0/5** (0W-3L-2D), i.e. it walked
into lost pawn races. Two coupled causes (see `docs/ENGINE_ROADMAP.md` for the
full diagnosis): **eval blindness** (no king↔passer knowledge) and **horizon** (a
~6-push race resolves >24 plies out; the engine saw ~depth 18). Two SPRT-gated
fixes shipped.

### 10.1 WDL-in-search (`tbsearch`, default-on) — +32.7 endgame

`tb_probe_wdl_impl` at **internal** search nodes (not just root DTZ), turning the
tablebase into an exact eval the moment a position trades into ≤MaxPieces range —
extending the effective horizon to the 5-man edge.

- **Lock-free.** Fathom's WDL probe is thread-safe (unlike root/DTZ), so it runs
  with **no mutex** — critical, or it would serialize the Lazy-SMP threads.
  `go test -race` clean with concurrent probes across workers.
- **Score band.** A TB hit returns `±(tbWin − ply)`, a band *just below* the mate
  band (`tbWin = mateThreshold−1`), ply-adjusted to prefer faster wins. The TT
  ply-adjust threshold was lowered to cover it; `mateDistance` still keys off
  `mateThreshold` so a TB win is never misreported as a forced mate. Inert when
  `tbsearch` is off (no normal eval reaches the band).
- **Cursed/blessed → draw** (rule50-independent, so the 50-move clock can't turn a
  claimed win into a real draw) — calls `tb_probe_wdl_impl` directly, not the
  inline `tb_probe_wdl` wrapper (which returns FAILED whenever `rule50 != 0`,
  useless in-search).
- **Gated to full strength.** The probe is suppressed in `RootScores`
  (`search.weakenedSearch`), the weakened-bot ranking path — same gating root-DTZ
  gets via the no-noise branch — so a 1200 bot doesn't suddenly convert ≤5-man
  endings perfectly and break `levelForRating`. Verified by test.

**SPRT** (`--new "tbsearch=on" --old "tbsearch=off" --tb-path data/syzygy
--movetime 100`, mixed endgame book): **+32.7 ± 14.1** (318 pairs). Standard-book
non-regression: **+29 ± 19.6**, CI excludes 0 — net-positive even from openings
(decisive games reach ≤5-man more than expected). **Endgame-book-scoped — do NOT
stack on root-DTZ's +18.8**, which was the *standard* book (~89% draws); different
scales.

### 10.2 KingProx eval term (`kingprox`, default-on) — +30.5 endgame

EG-only king proximity to advanced passers — rewards escorting your own passer and
keeping the enemy king off it. Centered, rank-weighted core
`KingProxEG · rw · (enemyKingDist − ownKingDist)` to each passer's stop square,
where `rw = advancement−1` (only fires for ≥4th-rank passers, so an almost-queen
dominates), **Chebyshev** distance capped at 5, EG-gated via the taper. The
*centered* form (equidistant kings → 0) keeps it near-orthogonal to `PassedEG`, so
it double-counts as little as possible.

**SPRT** (on the shipped table, `tbsearch` on both sides, endgame book):
**+30.5 ± 13.6** (392 pairs). **Per-material-class** (the test the symmetric book
couldn't answer alone — does it *mislead* anywhere?): **rook +33 / minor +36 /
K+P +24** — every class positive, **including rook endings** (where king-proximity
is famously nuanced). No structural guard needed. Standard-book non-reg ~0.

### 10.3 The joint re-tune was tried and REJECTED

The plan was to jointly re-tune `KingProxEG` with `PassedEG` and the PSQT (the §6
"don't bolt terms onto a frozen baseline" lesson). Built the pipeline — TB-labelled
≤5-man slice (`gomachine gen-tb-epd`, Syzygy-WDL ground truth, **not** self-play, so
no §6(d) data bias) blended 12% onto the 725k real-game base, joint Adam — and it
fit cleanly: `KingProxEG 4→13`, `PassedEG 42→57` (both rose; centering held).

**But the table A/B regressed.** `(re-tuned table + kingprox)` vs `(shipped table +
kingprox off)` came back **≈0** on the endgame book, vs **+30** for KingProx alone
on the shipped table — the re-tuned PSQT *gave back* the entire gain. Controls
isolated it: the B/R MG drift was data/K-refit not KingProx (drift identical with
KingProx pinned out), and a base-only control reproduced the shipped table — so the
culprit is the **table change itself**, most likely the **TB-label over-optimism**
(perfect-play 1.0 labels teach a winnability the heuristic eval can't realize).

**Decision:** ship the seeded `KingProxEG=4` on the *existing* table; do **not**
adopt the re-tuned PSQT. If revisited, the path is an **MG-anchored** re-tune
(freeze piece values, tune only the endgame terms). Tooling for the A/B (selectable
`cand` table) was reverted; the `gen-tb-epd` generator + control flags remain.

### 10.5 PawnRace eval term (`pawnrace`, default-on) — +17.4 endgame

EG-only **knight-aware unstoppable-passer / race** term — the "do I queen first?"
over-optimism killer. Emitted as White−Black with a ply-decayed bonus (seeded
`PawnRaceEG=700`), so symmetric races cancel to ~0 and the term's real value is the
**negative** it gives the side whose opponent has the unstoppable passer (telling
an over-optimistic side NOT to race into a lost promotion — the exact diagnosed
failure). Detection is conservative on every axis and only fires when the
defender's non-pawn material is **knights-only** (the K+N+P case; bails on B/R/Q):
clean promotion path, enemy **king** outside the square, and no enemy **knight**
able to reach the promo/path squares in time (precomputed `knightDist[64][64]`
BFS). Every tempo is rounded in the defender's favour, so it under-claims
unstoppability rather than over-claiming it.

- **Not TB-masked** (unlike the scale factor, §10.6): it acts in **6–10-man**
  positions *above* the 5-man boundary, so the tablebase can't decide them first.
- On the diagnosed `3kn3/5ppp/8/8/8/8/PPP5/3NK3 w` it returns **exactly 0** — every
  passer is caught by the nearby enemy king, so no false optimism is added (right
  for a dead draw). Its payoff is in *other* positions reached during play.
- Seeded, **not a tuner feature** (the unstoppable detection is non-linear, so it
  can't be a linear trace coefficient — preserved as a constant through the trace
  round-trip, never fed to the Texel tuner).

**SPRT** (`--new "pawnrace=on" --old "pawnrace=off" --tb-path data/syzygy
--movetime 100`, mixed endgame book, TB on both sides): **ACCEPT H1, +17.4 ± 10.6**
(539 pairs, pentanomial `[9 61 364 77 28]`, LLR +2.95). Standard-book
non-regression: *in progress.*

### 10.6 The scale-factor term was built but did NOT register (default-off)

A faithful port of Stockfish's classical endgame **ScaleFactor** (`scalefactor`
flag): scales the eg term by `sf/64` in drawish material — no-pawn ≤minor → 0/4/14,
opposite bishops → 18+4·passers / 22+3·pieces, lone-queen → 37+3·minors, generic
pawn-count cap → 36+7·pawns — plus a guard SF doesn't need (a ≥-rook material lead
returns sf=64, since we have no specialized KXK endgames to return early; a unit
test caught it scaling a won KRvK to 36). Correct and safety-guarded.

**But it SPRT'd ~neutral with the TB attached:** `+2.7 ± 5.4` (2000 pairs,
INCONCLUSIVE — hit the pair cap, LLR −0.24). The reason is exactly the TB: the
drawish configs it most cleanly fixes (KBvK, KNvK, KRvKB, OCB) are the ≤5-man
endings the tablebase already decides *exactly*, so the term only acts in the
thinner 6–10-man slice, and in self-play both sides hold those equally → ~0.
**Decision:** keep the code, **default-off** (correct, zero-overhead when off,
useful scaffolding for a future MG-anchored endgame re-tune) but do **not** flip
it on — by the "only ship on a clean H1" rule it doesn't earn the default. The
lesson — **TB masks any eval term whose payoff lives ≤5 men** — is why PawnRace
(which acts above the boundary) was the better bet and why it registered.

### 10.4 Result on the original lost position

Re-running `3kn3/5ppp/8/8/8/8/PPP5/3NK3 w` vs **full** Stockfish (Skill 20):

| Setting | W-L-D | Draw-hold |
|---|---|---|
| 300ms · 1 thread (was 0W-3L-2D) | **0W-4L-6D** | 60% |
| 300ms · 8 threads (SMP) | 0W-2L-4D | 67% |
| 1500ms · 8 threads | **0W-1L-5D** | **83%** |

The losses are a **horizon** problem, as diagnosed — the more *nodes* it gets, the
more it holds the theoretical draw (SMP beats single-thread at every TC; the
strongest config loses 1/6). KingProx + WDL-in-search raised the floor (40%→60%
holds at baseline); compute does the rest. It still can't *win* (it's a draw), and
full SF is ~800 Elo above — but it no longer walks into the mate.

**Methodology notes worth keeping:**
- **Endgame SPRT book = point-symmetric positions** (`data/endgame_book*.fen`,
  generated by `scripts/gen_endgame_book.py`). A 180°-rotated position with White
  to move is theoretically ≈0.00, so the book is *balanced by construction* — a
  real gain shows as wins out of a drawn book, not as converting an already-won
  position. The static eval of such a start is still ~+49 (KingProx inert at the
  symmetric start; WDL inert at 10 men) — these terms fix **downstream** play, not
  the start eval.
- **Per-class SPRT** before trusting an aggregate: a +27 average can hide a −X
  subset; split by material to confirm no class regressed.
- **WDL-in-search is endgame-book-scoped**; KingProx accepted on both endgame and
  per-class books with ~0 standard-book regression.

## 11. NNUE — SHIPPED, default-on, +212 Elo @ movetime

Full build log + phased plan: `docs/NNUE/PLAN.md`. Status: **live, `nnue` default-ON**
(2026-06-21).

A `(768→256)×2→1` SCReLU net, trained with **bullet** (jw1912/bullet) on the
**M3 Pro's Metal GPU** over ~40 GB of decorrelated Stockfish-binpack data
(~2.7M pos/sec), now beats the tuned HCE **both** per-node and on the clock. The
diagnostic arc and the two engineering phases that made it movetime-viable:

| Stage | vs tuned HCE | budget | verdict |
|---|---|---|---|
| v1–v3 (Go trainer, thin/under-trained data) | −120 to −332 | — | **data-starvation**, not a math bug |
| v4 net, from-scratch float eval | **+171.6 ± 60** | **40 000 fixed nodes** | net is good per-node… |
| v4 net, from-scratch float eval | **−156 ± 95** | **100 ms/move** | …but too slow on the clock |
| **+ Phase A** (incremental float accumulator) | **+177.8 ± 41.5** (H1) | **100 ms/move** | **movetime-positive** |
| **+ Phase B** (int16 quantized, bit-exact) | **+212.2 ± 49.2** (H1) | **100 ms/move** | **SHIPPED** |

**The sign-flip was the whole story, and it was a *speed* problem, not a net
problem.** At equal nodes the float net already won (+172); at movetime it lost
(−156) because a **from-scratch** NNUE eval recomputes the full 768→256 forward
pass at *every* node (HCE ~30–60 ns; from-scratch NNUE ~2.7–7.3 µs — measured
**~100–160× costlier**), so it searched ~10× fewer nodes and lost despite the
sharper eval. Proving the float net beat HCE at equal nodes *first* made that
unambiguous — the loss was plumbing, not training.

### 11.1 Phase A — incremental accumulator (float)
On make-move, update only the ~2–4 features that changed instead of rebuilding all
~32. Design (`internal/nnue/accumulator.go`):
- **Accumulator stored by absolute color** (White-persp + Black-persp), *not*
  stm/opp — so a **null move touches nothing** (`evalFrom` re-orients via
  `pos.SideToMove()` at the output dot). This is the load-bearing simplification:
  plain 768 features (no king-bucketing) → *every* move incl. the king is a small
  delta, **no refresh path ever** (the worst HalfKP accumulator-bug class doesn't
  exist for us).
- **Ply-indexed stack** on the searcher: Push = `copy(parent)+delta`; **Pop = `sp--`**
  (no reverse-delta on unmake). HCE pays zero overhead (gated on `useNNUE`).
- **Gate:** a from-scratch-vs-incremental equality assert run *inside real αβ
  search with null-move + qsearch enabled* (covered 17 966 null-move + 411 552
  qsearch nodes — proven, not assumed). `-race` clean.
- **Result:** NNUE NPS 198k→637k (**3.2×**); node deficit vs HCE 6.9×→**2.1×**;
  **+177.8 ± 41.5 @ movetime, H1**. Shipped, `nnue` flipped default-ON.

### 11.2 Phase B — integer quantization (int16, bit-exact)
Replace the float forward pass with bullet's native integer math: int16
accumulator, int8/int16 weights, int32 SCReLU square, int64 dot, round-to-nearest
descale (QA/QB/Scale = 255/64/400). A new **GNN2** net format stores bullet's ints
**verbatim** (no float round-trip → exact). `internal/nnue/quant.go`.
- **Gates:** int-incremental == int-scratch **exactly** (associative int add, no
  int16 overflow → strictly stronger than Phase A's float-epsilon); int-vs-float
  reference **0 cp** over 14 FENs (bit-exact); int-vs-float A/B SPRT **−0.0 Elo**
  (quantization quality-neutral, confirmed); `-race` clean.
- **Result:** node deficit 2.1×→**1.59×** (int16 = half the memory traffic of
  float32; scalar int arithmetic itself is ~flat vs float). Notably NNUE-int reaches
  **depth 15 vs HCE's 14** despite ~37% fewer nodes — a better eval orders moves
  better, prunes harder, and searches a *narrower, deeper* tree. **+212.2 ± 49.2 @
  movetime, H1.** Shipped.

### 11.3 Pipeline & prod
bullet trains on Metal → `gomachine nnue-import-bullet` imports `quantised.bin` →
**GNN2** net at `data/nnue/net.nnue` (committed, 772 KB; feature indexing identical
to bullet's Chess768, verified). Auto-loads cwd-relative (`NNUE_PATH` overrides),
inert if absent (HCE fallback). Prod `git pull` carries the binary + net together
(keep them in sync — a GNN2 net needs a Phase-B binary). Absolute anchor with NNUE
on: **≈2765 ± 128 vs SF-2800** (even match; bracketed by +241 vs SF-2700 / −241 vs
SF-2900, 10–20 games each — a band, ~2780-class @ 100ms). **This anchor is v4-era;**
v6 later added **+101 Elo @ movetime** (SPRT, §12) and was **directly anchored
2026-06-22 at ≈2882** (band 2847–2935 vs SF-2700/2800/2900, §2.2).

### 11.4 The post-ship ladder — RESOLVED (see §12)
The three levers below were ordered v5 → SIMD → wider net. Outcome: **v5 was a
dud, SIMD shipped, and the wider net (v6, 512) shipped behind it.** Full arc in §12.
1. **v5 maturity net (256-wide) — tried, dud.** A 2400-superbatch retrain floored
   at the **same 0.0317 loss as v4** (the 256 net's capacity ceiling) and SPRT'd
   **−25 ± 31 vs v4 @ fixed nodes (a wash)**. More epochs don't help a saturated
   width — **width, not training length, was the lever.**
2. **SIMD — shipped** (§12). `archsimd`: amd64 AVX2 (Go 1.26.4 **stable**), arm64
   NEON (Go 1.27rc1). Bit-exact to scalar; scalar stays the default build.
   Per-node eval **6.5× (amd64) / 4.16× (arm64)**.
3. **Wider net (512) — shipped as v6** (§12): **+124.5 ± 50 vs v4 @ fixed nodes**,
   recovered at movetime by SIMD. Next width step (1024) is now cheap behind SIMD.

The Go trainer (`internal/nnuetrain`) is now legacy; bullet is the trainer going
forward.

---

## 12. NNUE v6 (512-wide) + SIMD — SHIPPED to prod

The §11.4 ladder, executed. Net-net: **the 256-wide net was capacity-saturated;
doubling to 512 bought +124 Elo of eval quality, and `archsimd` SIMD paid the
inference cost so that edge survives at movetime.** Now live in prod.

### 12.1 v5 (256-wide maturity) — the dud that proved the point
Retrained 256-wide for **2400 superbatches** (7 h 9 m). Training loss floored at
**0.0317 — identical to v4's**, which v4 reached in just 600 SB. v5's stretched LR
schedule merely took 4× longer to the **same capacity ceiling**. SPRT (the new
net-vs-net A/B, §12.3) **v5 vs v4 @ fixed nodes: −25 ± 31 (wash, slightly
negative)**. Reverted (`net.nnue.v5` archived). **Lesson: more epochs cannot
lower a saturated width's floor — go wider.**

### 12.2 v6 (512-wide) — config researched, not guessed
Sourced from real bullet-trained engines, not invented. Also corrected a
long-standing unit confusion: **bullet's canonical superbatch is 6104 batches
(~100 M positions)**; our prior configs used 1020, so old "600/2400" superbatch
counts were ~6× smaller than everyone else's. v6 config: **HIDDEN 512**, batch
16384, **bpsb 6104**, **320 superbatches** (bullet's own 512-wide example),
**`CosineDecayLR` 0.001 → 2.43e-6, no warmup**, **WDL 0.6**, SCReLU, SCALE 400.
Trained 320 SB in 4 h 21 m.

**Results:**
| Test | Budget | Elo | Reading |
|---|---|---|---|
| v6 vs v4 | 40k fixed nodes | **+124.5 ± 50** | eval quality — **width works** |
| v6 vs v4 | 100 ms/move, **scalar** | **+13 ± 53 (wash)** | 512's ~2× eval cost ate the edge → SIMD-gated |
| v6 vs v4 | 100 ms/move, **SIMD** | **+101** | SIMD recovered the edge (firm SPRT) |

**The anneal is everything (loss ≠ strength, hardest proof yet):** the
*un-annealed* lowest-loss early checkpoint (sb121, loss **0.022**) scored **−96 vs
v4**; the *final annealed* v6 (HIGHER loss **0.0229**) scored **+124** — a **+220
Elo swing from the cosine anneal alone**. Never early-stop a cosine run on the loss
plateau: the last low-LR superbatches do the load-bearing work.

### 12.3 The hardcoded-256 bug + dynamic width
Evaluating v6 surfaced a latent bug: **NNUE inference was hardcoded to `L1=256`**
(a `feature.go` const, fixed `[256]int16` accumulator arrays, and the importer). It
**silently mis-read a 512 net as garbage** — `quantised.bin` has no header and the
size check was `<`-only, so an oversized file sailed through reading the first
256-net's worth. Fix = **dynamic hidden width**: `Net.HL` field,
`NewNetSize`/`RandomNetSize`, the per-ply accumulator `w`/`b` are now slices carved
from **one contiguous per-`Stack` backing buffer** (no per-node alloc), the importer
**infers width from file size** (`771·HL + 1` int16s), and the GNN2 loader allocates
per the header's L1. Gates green: bit-exact incremental == from-scratch @ 512,
`-race`, perft, and **256-wide byte-identical** (no regression).

**New tool — net-vs-net A/B.** `bench sprt --new-net X --old-net Y` compares two net
*files* of any width (the param flags only toggle nnue on/off against one global
net). It **forces `--concurrency 1`** — the net is a process global, so each side's
`nnue.SetNet` before its search would race otherwise; `nnueBegin` rebuilds the
accumulator when the net changes. Use fixed-nodes for eval quality, movetime for the
cost-aware verdict.

### 12.4 SIMD (`archsimd`) — both backends bit-exact
A scalar **seam** (`internal/nnue/kernels.go`) exposes the two hot loops as
function vars — `addCol`/`subCol` (int16 add/sub) and `screluDot` (clamp→square→
×weight→int64) — defaulting to scalar. A SIMD file repoints them in `init()` behind
`//go:build goexperiment.simd`, so **the default build (no experiment) stays scalar
and untouched**; SIMD output must be **bit-identical** to scalar (gated by
`TestKernelsMatchScalar` across widths `{1,7,8,15,16,31,256,512,513}`).

| Arch | Go | Vector | Per-node eval @512 | SCReLU dot | backend |
|---|---|---|---|---|---|
| **amd64 (prod)** | **1.26.4 stable** | `Int16x16` AVX2, `GOAMD64=v3` | **4676 → 724 ns (6.5×)** | 7× | `simd/archsimd-avx2-amd64(...)` |
| **arm64 (M3 dev)** | **1.27rc1** | `Int16x8` NEON | **1864 → 448 ns (4.16×)** | 5× | `simd/archsimd-neon-arm64(...)` |

amd64 `archsimd` shipped in **Go 1.26 stable** (no RC needed in prod); arm64 NEON
needed **Go 1.27** (RC1 released 2026-06-18). The amd64 dot is **AVX2-only** by
design — it avoids AVX-512 ops (`MulEvenWiden` + `VPSRLQ` even/odd construction for
the int16→int64 widening multiply) so the binary runs on any AVX2 CPU. `-race`
clean on both.

### 12.5 Shipped to prod
**lairner is amd64 Ubuntu 24.04** (not ARM/Arch, as had been assumed — that
mismatch is why the *laptop* needed Go 1.27rc1 while *prod* runs Go 1.26 stable).
Live: `bin/gomachine` built with `GOEXPERIMENT=simd GOAMD64=v3 ~/go/bin/go1.26.4`,
`net.nnue` promoted to v6 (512), `chessgo-engine`+`chessgo-hub` restarted (healthy,
no SIGILL). `chessgo-deploy()` (in `~/.zshrc`) hardened to build with the SIMD
toolchain so a future deploy doesn't silently revert to the scalar wash. Rollback
backups on the box: `bin/gomachine.scalar-backup`, `data/nnue/net.nnue.v4-prod-backup`.
**The v6 net and the SIMD build must ship together** — v6 on a scalar build is a
movetime wash.

### 12.6 Lessons (process)
- **A `fork` inheriting full context autonomously launched orphan SPRTs** that
  pegged a box and polluted movetime timing. Clean up stray `bench` processes;
  scope subagents tightly.
- **`bench sprt` traps the first SIGINT** for graceful shutdown, so Ctrl-C gets
  swallowed (it once stranded a run that pegged prod and blocked SSH). Stop it with
  **Ctrl-\ (SIGQUIT)** or `pkill -9 -f "gomachine bench"`; cap runs with `--maxpairs`
  + `timeout`.
- **Prod architecture matters for SIMD:** amd64 → Go 1.26 stable `archsimd`; ARM →
  Go 1.27. Verify the box (`uname -m`) before picking a toolchain.

---

## 13. Search-feature wave (2026-06-28) — corrhist + singular + futility shipped

An unattended wave loop (fork implements a default-off flag + config key + tests;
the main loop SPRTs; H1 → flip default + re-baseline). All numbers are **self-play
@ 40k fixed nodes, [0,6] bounds, pentanomial GSPRT** — so they compound, do **not**
sum, and the real-time/absolute gain is smaller (self-play inflation + the per-node
compute cost; §6.4). **A movetime/anchor re-measure of the bundle is still owed** —
the honest estimate is ~+50–70 Elo @ movetime, not the ~+110 the fixed-nodes figures
add to. Gate the *next* eval/net change on a fresh anchor, not on these.

### 13.1 Accepted (all default-on)

| Feature | Flag | Self-play Elo @ 40k | Pairs | What it does |
|---|---|---|---:|---|
| **Correction history** | `corrhist` | **+66.9 ± 22.9** | 174 | learns the per-pattern (pawn + per-color non-pawn) static-eval-vs-search-result bias *within a game* and corrects the static eval by it — sharpens **every** eval-gated decision (RFP, null-move, improving, qsearch stand-pat) |
| **Singular extensions** | `singular` (+`multicut`) | **+22.2 ± 12.2** | 186 | verify the TT move vs all alternatives at reduced depth (`ttScore − 2·depth`, min-depth 8); extend a ply if singular, multi-cut early-return if a second move also beats beta. Conservative — single ply, no double extensions |
| **Frontier futility** | `futility` | **+21.3 ± 12.0** | 495 | skip a late quiet whose `staticEval + depth-margin` can't reach alpha (the fail-low side; distinct from RFP's fail-high) |

- **corrhist is memory-only and per-search**, like the TT — learned tables, not a
  trained net; reset each game. It's the SF18-standard "eval multiplier."
- **The corrhist TT-caching bug (the expensive lesson here).** The first cut cached
  the *corrected* eval into the TT, which broke TTEval's behavior-preservation and
  aspiration exactness (two unit tests went red). Fix = split **`rawEvaluate()`**
  (deterministic, the value cached in the TT) from **`evaluate()`** (applies the
  correction *fresh on every read*). Re-validated at +66.9 on the fixed code — so the
  banked number is the fixed engine vs corrhist-off, not broken-vs-fixed.

### 13.2 Rejected (kept behind default-off flags, dead-but-harmless)

| Feature | Flag | Result | Root cause (verified, not guessed) |
|---|---|---|---|
| Aggressive LMR **+ singular together** | `lmr2`+`singular` | **−67** | anti-synergy: each is positive *alone* (lmr2 **+9.7**, singular +22.2) but toxic together — multicut false-prunes on an LMR2-corrupted verification subtree. Node/firing-count tests **refuted** the "singular over-fires" and "interaction explosion" hypotheses; the multicut-on-over-reduced-verify lead held. `cleanverify` was added to test conservative-LMR-in-verify; the bundle stayed net-negative, so **do not enable `lmr2` on top of `singular`.** |
| Continuation / countermove history | `conthist` | flat → negative | redundant with our mature ordering (history gravity + malus + killers); a wiring-check test (`conthist_wiring_check_test.go`) **proved it does change the tree** (not a no-op), so the flat result is real, not a plumbing bug. Best chance was bundled with lmr2 (better quiet ordering pays off through reductions) — but lmr2 itself doesn't ship. |
| Internal iterative reduction | `iir` | **−33.7** | fired on **all** node types; canonical IIR is PV + expected-cut only → ours over-pruned. Reworked to PV-only → ~flat. Kept off pending selective placement. |
| Capture history | `capthist` | **≈−33** | the ±8192 scaling could override the MVV-LVA base and cross the SEE good/bad split. Diagnosed as a scaling problem (the term must stay ≪ the ~1M tier gap); dropped rather than re-tuned. |
| Extra corrhist keys (minor-piece, continuation) | `corrhistminor`, `corrhistcont` | flat | the pawn + non-pawn keys already capture the signal; extra keys are redundant additive adjustments. |
| ProbCut, razoring | `probcut`, `razor` | flat/negative | over-pruning on a baseline that already runs RFP + LMP + null-move + singular + futility. |

### 13.3 The theme (why the long tail was mostly flat)

Our baseline was **already heavily pruned** (RFP + LMP + null-move + singular +
futility) with **mature move ordering** (history gravity + malus + killers + SEE)
and a **strong NNUE eval**. So the long-tail candidates (conthist, IIR, probcut,
razor, capthist, extra corrhist keys) are largely **redundant or over-pruning** →
flat or negative. The wins were the features that add a *new* kind of information:
corrhist (a per-game eval-error signal nothing else carried) and singular/futility
(SPRT-standard patches we simply hadn't shipped yet). **The *redundant* long tail is
dry** at this baseline — but a later sub-wave of shallow-node SEE/history **pruning**
with retuned margins (HistPrune/SEEQuiet/CaptSEE, §13.5) still paid three more times,
so "no Elo left in pruning" would be too strong. Future search Elo more likely comes
from those retuned margins, reworking the rejected ideas to be selective (PV-only IIR,
properly-scaled capthist, conthist that doesn't double-count our history), or SPSA
tuning the knobs we already have — not from bolting on *more* pruning rules.

### 13.4 Process notes
- **Verify, don't trust** (the user's standing rule, repeatedly load-bearing here):
  every pasted "this is why it's negative" analysis was checked against node/firing
  counts before acting — two singular hypotheses were *refuted* this way, and the
  real cause (multicut on over-reduced verify) only surfaced because we instrumented
  it. `DbgSingular()`/`DbgMultiCut()` counters + the `*_check_test.go` files exist
  for exactly this.
- **Self-play inflation is real and unmeasured here.** Fixed-nodes overstates the
  real-time gain (corrhist adds per-node compute); the bundle owes a movetime SPRT
  and a fresh Stockfish anchor before the "~2880-class" figure (§7) is updated.
- The rejected flags + their toggle plumbing remain in `params.go` /
  `internal/bench/config.go` (default-off, byte-identical off-path) as scaffolding
  for the selective reworks above.

### 13.5 SEE/history late-leaf pruning trio (2026-06-29) — §13.3 was overstated

A follow-on sub-wave landed three more default-on shallow-node pruning patches.
All **self-play @ 40k fixed nodes, [0,6]**, the same ruler as §13.1 — these are
**search** features, so fixed-nodes is valid (§14.4 only indicts *eval* changes).

| Feature | Flag | Self-play Elo @ 40k | Knobs | What it does |
|---|---|---|---|---|
| **History pruning** | `HistPrune` | **+86.8 ± 26.8** (94 pairs, [0 6 41 41 6]) | maxDepth 6, margin −1000 | skip a late quiet whose history score is strongly negative near the leaves — a *magnitude* signal, distinct from LMP's move-count and Futility's static-eval |
| **Quiet-SEE pruning** | `SEEQuiet` | **+75.9 ± 24.8** retuned (150 beats the 50 seed; H1, 205 pairs) | maxDepth 6, margin 150 | skip a quiet that hangs material to the recapture (`SEE < −margin·depth`) |
| **Capture-SEE pruning** | `CaptSEE` | **+77.7 ± 25.2** vs off, then **+97** down the margin chain (`93681ba`) | maxDepth 6, margin 25 | the capture analog — captures were SEE-*ordered* but not SEE-*pruned* in the main search; skip a clearly-losing capture |

Two lessons:

- **Retune the seed.** SEEQuiet shipped +21 at its margin=50 seed but **+76 once
  retuned to 150**; CaptSEE's margin chain (100→50→25) was pure profit. Hand-picked
  margins leave big Elo on the table — which is the concrete case *for* SPSA.
- **Quiets and captures want opposite margins, and CaptSEE *cliffs*.** Quiets want a
  *loose* margin (150: prune only clearly-hanging pieces — 50 over-pruned safe
  quiets and *grew* the tree 45%). Captures want a *tight* one (25: a losing-SEE
  capture genuinely loses material). But aggression has a floor — the full CaptSEE
  sweep was `150<100 (−32.5), 50>100 (+32.8), 25>50 (+64.8), 0≪25 (−86.6)`: **margin
  0 (prune every losing capture) loses −86.6** because it discards real sacrifices.
  **Peak = 25, sweep complete.** The 25→0 gap is steep and unsampled (a candidate
  for a *joint* SPSA pass, not another hand-sweep). *(This corrects a stale
  `params.go` comment that read "peak search ongoing, probing 0" — 0 was tested and
  lost.)*

So §13.3's "the cheap-search-patch well is now mostly dry" was **overstated**: the
*redundant* long tail (conthist/IIR/probcut/razor/capthist-ordering) was dry, but
shallow-node SEE/history **pruning** with retuned margins still had real gains in it.

---

## 14. NPS push + the output-bucket experiment (2026-06-29)

Two threads this session: real NPS wins (banked), and an output-bucket NNUE
experiment that surfaced **the most important measurement finding since §6 —
fixed-nodes self-play inflates *eval* changes, sometimes totally — and nearly
shipped a +90 mirage.**

### 14.1 NPS wins — +23% compounded (shipped, committed)

| Win | Commit | NPS | How |
|---|---|---:|---|
| **PGO build** | `c77ccb5` | **+3%** | `-pgo` from a `BenchmarkSearch` profile, committed at `cmd/gomachine/default.pgo`; **auto-detected by every build**, behavior-identical. |
| **Pin-aware legal movegen** | `a7c4884` | **+20%** | replaced the make/unmake legality filter (DoMove → king-attack test → UndoMove for *every* pseudo-move) with a generator that computes checkers + the pinned set **once** per position (`generateLegalFast`, `internal/chess/movegen_legal.go`; ray tables `rays.go`). |

Compounded ≈ **+23%** (movetime strength gain, **un-anchored** — no fresh
Stockfish re-anchor run yet; the "~2880-class" §7 figure is not updated for it).

The movegen win was **3–4× the +6–9% profiling estimate** because the
make/unmake legality cost was *distributed* across `GenerateLegal` + `DoMove` +
`UndoMove` + `attackedBy` and never appeared as one fat leaf — `GenerateLegal`
sat at **15.7% cumulative** the whole time. Lesson (memory
`dont-trust-dry-well-perf`): a high-**cum%** / low-**flat%** function is cost
hiding in its callees; `pprof list` it, don't dismiss a "no perf left" verdict.

**Correctness:** `generateLegalFast` is differential-tested **order-sensitively**
against the retained make/unmake oracle (`generateLegalSlow`) over every perft
tree + tricky EP/pin/double-check FENs + 400 random games
(`movegen_legal_test.go`) → byte-identical move lists → identical search tree →
the A/B is pure speed. perft stays green.

### 14.2 Lazy/deferred accumulator — TESTED, flat (NOT shipped)

The headline NPS rec from the input analysis (see `ENGINE_ROADMAP.md`): drop the
per-`Push` 2 KB `copy(parent)` + delta, store deltas and resolve lazily from the
nearest computed ancestor (Stockfish-style), skipping the work for
TT-cut/pruned/in-check nodes that never call `Eval`. **Implemented** behind
`NNUE_LAZY` (`accumulator.go`, commit `484685c`), **bit-identical** (proven via
the existing `NNUE_ASSERT` scratch-vs-incremental gate). **Result: flat to
slightly negative — NOT a win.** The deferred path's walk-back cost cancels the
saved copy on our heavily-pruned / high-TT-hit tree. Kept default-off as
scaffolding. (The "−60 last session" recalled at the outset has **no record** in
git/stash/logs/docs — most likely a different experiment; the careful caching
impl breaks even, it does not lose 60.)

### 14.3 Output buckets (v8 net) — +90 fixed-nodes, **≈0 movetime** (a WASH)

Built full output-bucket support (commit `860f3ef`): **8 piece-count buckets**,
bullet's `MaterialCount<8>` selection **`bucket = (popcount − 2) / 4`** (divisor
`ceil(32/N) = 4`; **`−2`, not `−1`** — drops both kings; corrected from the
session handoff), a per-bucket output layer over a **shared trunk**, a new
**GNN3** net format, and an importer `nb` param. NPS-neutral by construction (one
popcount + a slice offset per eval). Pinned by `buckets_test.go` (the
`(popcount−2)/4` formula for every count 2..32, GNN3 round-trip, distinct-head
selection). Trained a v8 net in bullet (v6 config + `.output_buckets(MaterialCount::<8>)`),
imported to `data/nnue/net.nnue.v8`.

**SPRT vs v6** (net-vs-net → forced `--concurrency 1`; 5429-position `book.bin`):

| Regime | Effort | v8 vs v6 | Notes |
|---|---|---:|---|
| **Fixed 100k nodes** | ~depth 11 | **+90 ± 32** | real, ~160 pairs over an independent book |
| **Movetime 100 ms** | ~depth 11, ~100k nodes | **≈ 0 ± 30** | both arms straddle 0 (−19 / +12); the earlier "+5" was an over-read |
| **Fixed depth 11** (completed iters) | depth 11 | **≈0** (arms +1.4 / −1.4) | 240 pairs both arms, perfectly mirror-symmetric → **zero arm bias** — the discriminator |
| Fixed 100k, **endgame** book | pure endgame | **≈ flat** (−17, wide band) | gain is NOT endgame-concentrated; ~41 unique pairs (fixed-nodes is deterministic → seeds just replay) |

**Verdict: v8 is a movetime wash.** The +90 exists only at fixed *nodes*; it
vanishes the moment iterations *complete* (movetime **and** fixed-depth both ≈0).

**v8 was NOT promoted** — `data/nnue/net.nnue` stays **v6** (the proven net). The
value banked is the **infra**: GNN3 format + bucket support in the loader /
importer / kernels (committed, tested), so the *next* net — especially a wider
1024 — can be bucketed for free **if** buckets ever pay at movetime. The v8 file
itself buys nothing at our clock.

### 14.4 Why +90 → 0: fixed-nodes inflates eval changes (THE lesson)

The two regimes are the **same effort**: at movetime 100 ms the engine searches
**~100k nodes at depth 11**, identical to the fixed-100k regime, at **identical
NPS** (~1.3M — v6 and v8 measured equal at fixed depth). So this is **not**
depth-discount and **not** per-node speed — both ruled out by direct measurement.
The cause is **partial-iteration cutoff**:

- **Fixed-nodes** stops at *exactly* node 100,000 — almost always
  **mid-iteration** — and plays whatever the half-finished search currently
  prefers. A better eval *converges to the right move sooner within* that
  iteration, so it wins a photo-finish at an artificial boundary.
- **Movetime and fixed-depth** let the iteration **complete**. Once v6 finishes
  the same iteration it reaches the same move v8 found → the edge evaporates. It
  was never extra strength, only faster convergence to an answer both reach.

**Update your priors:**
- **Fixed-nodes is NOT a valid ruler for EVAL changes on this engine.** It
  inflated a wash to +90 (a ~94% haircut — far outside this engine's real
  eval-discount history: Texel ~21%, NNUE v6 ~0%). Test eval at **movetime** or
  fixed **depth**.
- This is **eval-specific.** Fixed-nodes stays correct for **search** features
  (SEE/RFP/LMP/singular…; §3/§13 numbers stand) — those are genuine
  per-unit-work gains that hold whether or not the iteration completes.
- **The ruler was validated.** A v6-vs-v6 control read ≈ −2.3 clean and the +90's
  two arms agreed (no harness bias) — so +90 was a *correct measurement of the
  wrong thing*, not a bug. When a number looks too good, re-measure under the
  regime that matches prod (movetime) before believing it.

---

## 31. King-bucket horizontal mirror (KB v2) — SHIPPED to prod (2026-07-07)

The KB net's bottleneck was **density**: 16 buckets, no mirror, ~4 epochs on test80.
Every strong KB engine mirrors (SF18 HalfKAv2_hm, Stormphrax KingBucketsMergedMirrored,
Viridithas 16+hm, Renegade 768x14hm) — nobody runs a large non-mirrored KB net.

### 31.1 What the mirror does

When the perspective's king is on the e–h half (file ≥ 4), reflect the board
horizontally (`file ^ 7`) so it always sits on files a–d. Halves the king-square
parameter space → ~2× effective training data per bucket for ~0 extra params.

The canonicalization per perspective P (`orient = P==Black ? 56 : 0`, applied first):
```
ksqO = kingSq(P) ^ orient          // king in P's view
mir  = file(ksqO) >= 4 ? 7 : 0     // reflect if king on e–h half
s_final = s ^ orient ^ mir         // EVERY feature sq: base + threat target
bucket  = mirBucket(ksqO ^ mir)    // ksqO^mir has file 0–3 (32 half-squares → 16)
```

`orient` (^56, rank bits) and `mir` (^7, file bits) are disjoint masks → they compose
and commute. The bucket map is `rank·2 + (file>>1)` — 8 rank levels × 2 file bands,
preserving king-safety rank resolution. Byte-exact parity between Go production and the
Rust bullet trainer, verified by `kb_verify_test.go` (independent Rust replica, 6 checks).

A king move crossing the d/e file boundary now also triggers a full accumulator refresh
(the entire board reflects → every feature square changes). The refresh predicate fires on
bucket-change OR mirror-flip.

### 31.2 Training

Trained `mirror_kbhm_320.bin` (44 MB) on the same test80 Jan–Apr 2024 data as `kbfact_320`,
identical pipeline (ply≥16, ConstantWDL 0.6, 320-sb cosine anneal) — **mirror is the only
variable**. 2h 55m on an RTX 4090 with data in /dev/shm (~2.8M pos/sec).

### 31.3 SPRT results (coalla, AVX-512, fastchess)

| Test | Budget | Result | Games | Notes |
|---|---|---|---:|---|
| Fixed-nodes | 100k nodes/move | **+10.0 ± 5.0** (LLR 1.97) | 1600 | mirror eval vs kbfact_320 |
| Movetime (16-key Finny) | 8+0.08 | **−4.93 ± 7.02** | 634 | d/e-crossing refresh cost ate the eval gain |
| Movetime (32-key Finny) | 8+0.08 | **+4.74 ± 6.27** (LLR 0.55) | 880 | Stormphrax refresh-table pattern recovered the NPS |
| Movetime (32-key + bitboard) | 8+0.08 | **+4.36 ± 6.72** (LLR 0.43) | 796 | bitboard fast path is real but small |

The 16-key→32-key Finny change flipped movetime from −5 to +4.5 — a ~10 Elo swing. The
mirror KB net is now **net positive at movetime** over the old no-mirror KB net and ships
as the default eval.

### 31.4 32-key Finny refresh cache (Stormphrax pattern)

The original Finny cache keyed by `kingBucket` (0–15). With the horizontal mirror, bucket 0
represents BOTH king on a1 (mir=0) AND king on h1 (mir=7) — same bucket, completely disjoint
feature sets. On a d/e crossing, the old Finny cache collided those mirror halves, forcing an
expensive full-diff computation (subtract all ~30 old features, add all ~30 new ones).

The fix: `NumKingRefreshKeys = NumKingBuckets * 2 = 32`, keyed by `kingRefreshKey = bucket*2 + mirHalf`
where `mirHalf = (file(ksq) >= 4) ? 1 : 0`. Each mirror half gets its own cache entry, so the
diff on a revisit is small (only the pieces that actually moved). This is exactly Stormphrax's
`kRefreshTableSize = kBucketCount * 2 = 32`, indexed `bucket*2 + flipped`.

Stormphrax exploration (`~/stormphrax/src/eval/nnue/`) also found:
- They store **piece bitboards** per refresh-table entry (not feature lists) — we adopted this
  as a fast "no change" path (below)
- They batch process 4 features at a time (not directly applicable — our SIMD kernels are
  already compute/uop-bound at 5.5–5.9 IPC)
- They use `MaterialCount<8>` output bucketing (separate lever, not yet shipped)
- No factoriser (our factoriser is a parameter-efficiency advantage)

### 31.5 Bitboard fast path

Added `[12]chess.Bitboard` to each `finnyEntry`. On cache hit, compare the 12 piece bitboards
against the current board: if identical (transposition), copy the cached half directly — skips
`appendEnrichedFeatures` (magic attack generation + feature list build) entirely. If bitboards
differ, fall back to the existing feature-list diff path. Strict bit-exact improvement; too
small to cleanly SPRT-isolate but committed.

### 31.6 Shipped as default

The mirror net ships as `data/nnue/kb-mirror.bin` (formerly `lean.bin`). The default loader
renamed: `LEAN_NET_PATH` → `KB_NET_PATH`, `loadDefaultLeanNet` → `loadDefaultKBNet`. All three
systems (local M3, coalla, lairner) on `main`, consistent. SPRT harness fixed so `--new-lean=X`
without `--old-lean` defaults the old side to the prod net (not embedded v6).

## 15. CCRL Blitz anchor (2026-06-29) — ≈3260 "dirty" (SUPERSEDED, historical record)

> **SUPERSEDED by §20 (2026-07-01):** the bracket is now **3400–3700, floor >3400** (100–0 vs
> a ~3400 engine). The ≈3260 here was a two-blowout "dirty" read; keep it as method/record,
> not as the current strength. Never quote the ≈3200 that a later one-sided loss produced.


For weeks the headline strength figure was **≈2882 on Stockfish's UCI_Elo scale**
(§2.2) — a scale that is *not* logistic-linear, plays erratically when handicapped,
and (we now understand) sits **~390 Elo below** the CCRL scale everyone else quotes.
This section re-anchors against **real, officially-CCRL-rated opponents at full
strength**, which is the honest way to state a CCRL number.

### 15.1 Result

**gomachine ≈ 3260 "dirty" CCRL Blitz.** Two NNUE anchors, prod v6+SIMD build (amd64,
`GOAMD64=v4`), 100 ms/move each side, 100 games, opponent Hash=64:

| Opponent | CCRL Blitz | gomachine score | Estimate |
|---|---:|---:|---:|
| **Starzix 5.0** | ~3622 | 12.0% (W4 D16 L80) | **3276 ± 83** |
| **Viridithas 17.0.0** | ~3708 | 6.5% (W0 D13 L87) | **3245 ± 94** |
| **pooled** | | | **≈3260** |

Two engines **86 Elo apart** giving estimates **31 apart** is genuine convergence —
the internal-consistency check that the single-opponent Stash run (§15.3) lacked.

### 15.2 Why "dirty" (the honest caveats)

- **TC mismatch.** Played at **100 ms/move**, not CCRL's **2′+1″**. Since both sides
  are NNUE (symmetric eval cost), the offset is far smaller than it would be vs HCE,
  but it's nonzero — so this is a *ballpark*, not a list-grade rating.
- **Both scores are blowouts** (6–12%). Tail-of-the-Elo-curve estimates are more
  sensitive to the opponent's exact rating than a 50/50 match. **A below-3622 NNUE
  anchor (target ~3150/3300/3450) for a ~50% match is the pending step** to tighten
  the CI and confirm ~3260 isn't a model-tail artifact.
- **Opponent ratings are "the list's number," not re-measured here.** Confirm each is
  a *ranked* CCRL Blitz entry (not an estimate) before quoting it — see §15.3.

### 15.3 The Stash mistake (what NOT to do)

The first attempt anchored against **Stash** (v25/v36/v37), chosen off a third-party
"calibration ladder" guide. **Two errors, both mine:**
1. **Stash is HCE**, all the way through its latest release (v37 — verified: no
   `nnue` source, only `Hash` as a UCI option, author confirmed no net). gomachine
   (NNUE) beat Stash v36 **20-0**, which looked like ">3399" but is just NNUE
   crushing HCE at fast TC — **non-transitive**, not a rating.
2. **Stash's "3399" was an *unofficial estimate***, flagged "not ranked by CCRL" —
   not a comparable number at all. Mixing an unofficial HCE estimate with an official
   NNUE rating is apples-to-oranges, and produced a contradiction (20-0 vs "3399"
   ⇒ ≥3800; 12% vs 3622 ⇒ 3276) that no single rating can satisfy.

**Lesson:** an anchor is only as good as (a) it being a **ranked** CCRL entry and
(b) **architecture parity** (NNUE-vs-NNUE). Verify both *before* running. The
multi-NNUE-anchor agreement (§15.1) is the trustworthy signal; the Stash domination
is set aside.

### 15.4 Reconciliation with the SF number (it was never wrong)

CCRL ratings run **~390 above** the FIDE/Lichess-ish scale SF's UCI_Elo approximates.
So **2882 (SF-UCI_Elo) + ~390 ≈ 3270 (CCRL)** — the old anchor and the new one *agree*
once put on the same scale. SF wasn't "misleading us for weeks"; we were reading a
lower-scale number as if it were CCRL. The genuinely misleading data point was the
*Stash* run, not Stockfish.

### 15.5 Tooling

`bench vs-stockfish` gained `--full-strength` (run the UCI opponent unhandicapped;
`--sf-elo` becomes *only* the anchor rating) and `--opp-opts "Hash=64,Threads=1,…"`
(fair opponent options / external-net `EvalFile`). Any UCI engine works as the
opponent — `--sf` is just a binary path. Reference engines are built/downloaded on the
prod box (amd64); opponents that ship prebuilt Linux binaries with **embedded** nets
(Starzix, Viridithas, Stormphrax) are drop-in. **Use only *ranked* CCRL Blitz
opponents with NNUE eval, and prefer a spread that brackets us 40–65%.**

## 16. Enriched threats NNUE — the eval is great, the inference is the wall (2026-06-30)

> The push to pass Stormphrax (~3700 CCRL; it beats v6/≈3260 clearly). Full plan +
> state in `ENGINE_ROADMAP.md` (top block) and `docs/NNUE/ENRICHED_MULTILAYER.md`.
> This section is the **measured numbers**.

### 16.1 What we built
A threat-input NNUE: `(768 piece-square + 9216 threat features) → 512 ×2 → … → 1`,
8 output buckets, trained int8-aware (QAT). **Threat feature** = "who attacks whom":
for every piece→occupied-square attack, a feature keyed on `(attackerTypeRel,
victimTypeRel, victimSquareRel)` = `768 + (a*12+v)*64 + tsq` (a/v = relColor*6+type).
bullet has no threats input set — we wrote a custom `SparseInputType` with an attack
generator (`examples/chessgo_enriched.rs`); the Go extractor emits byte-identical
indices (`internal/nnue/enriched.go`, hand-checked + bit-exact incremental==scratch).
Two tails: **multilayer** (`…→pairwise→16→32→1`) and **lean** (v6's single dot).

### 16.2 The decisive numbers (all on lairner / AVX-512 unless noted)
- **Eval quality (fixed depth 8, vs v6):** multilayer enriched **+149 Elo** (weight-QAT
  int8; +71 @ d10 — edge shrinks with depth). The eval is genuinely much better.
- **Movetime (100 ms, vs v6): −160 Elo.** A better eval on a ~13×-slower engine loses
  on the clock. (transitivity holds → enriched is ~3100 now, not 3700.)
- **PTQ cliff + fix:** float +170 → naive int8 **+21** (PTQ leaks ~150 Elo) → **weight-QAT
  `faux_quantise(QB=64)` on L1 → back to +149.** cp-closeness lies (5.8 cp "close" hid the
  150-Elo cliff). **Gate int8 STRENGTH, not closeness, right after training.**
- **Per-node cost (single-thread):**
  | | ns/node | NPS | net |
  |---|---|---|---|
  | v6 (lean, cache-resident) | ~655 | ~1.5 M | 0.78 MB |
  | **Stormphrax (rich threat-net)** | **~2,440** | **~410 k** | **56 MB** |
  | our enriched | ~9,000 | ~110 k | ~10 MB |
- **★ The anchor:** a real 3700 threat-net is only **~3.7× slower than lean** (not 13×)
  and **~3.7× FASTER than ours** despite a bigger net ⇒ **our inference is ~3.7×
  inefficient, fixable.** Target ~2,440 ns/node; there the NPS penalty (~−130) is beaten
  by the eval edge (Elo/NPS-doubling ≈ 70 at blitz; 13× ≈ −260, our eval recovers ~+100
  at the reachable depth → the measured −160).

### 16.3 Inference profile (where the 9 µs goes, AVX-512)
- **Tail ~5 µs** (≈ half): **pairwise activation ~2.4 µs (SCALAR — biggest single item)**
  + L1 GEMV ~1 µs + L2/output/screlu ~1.5 µs. The output-stationary GEMV rewrite
  (`gemvF32`) helped only a little — **the tail is NOT reduction-bound** (the first
  hypothesis was wrong); it's the scalar pairwise + memory. **int8 tail = WASH so far**
  (NEON `dotU8I8` is scalar; AVX-512 maddubs in the old per-row layout was dispatch-bound).
- **Push ~4.5 µs** (≈ half): threat accumulator, **memory-bound** on the ~10 MB table
  (~50 scattered int8 column add/subs/move). Already incremental (count-array multiset
  diff). int8-FT halved it. On the M3 the same push is ~1.9 µs → **memory/hardware-bound**.
- **Built + bit-exact:** `addColI8`/`subColI8`, `gemvF32`, `dotU8I8` (scalar+NEON+AVX2+
  AVX-512), `EnrichedStack` incremental, int8 FT/L1 quantizers.

### 16.4 The two fixes to reach ~2,440 ns/node (what Stormphrax does, we don't)
1. **Real int8 dot** via Go **assembly** (CONFIRMED feasible, ~2–3 days) — `archsimd`
   lacks the int8 dot (amd64-only, only int16 `DotProductPairs`). Hand-write Plan9 asm:
   x86-64 **`VPDPBUSD`** is a **named** Go-asm instruction (`avx512_vnni`, since 1.11);
   ARM64 **`SDOT`/`UDOT`** is `WORD`-encodable (`WORD $0x4E829420`). Prior art ships both:
   **`github.com/camdencheek/simd_blog`** (`dot_amd64.s` + `dot_arm64.s`). Caveat:
   VPDPBUSD is unsigned×signed (+128-bias trick), SDOT is signed×signed. No cgo. Makes
   int8 fast on BOTH the M3 (first-class dev box) and lairner.
2. **Move-aware threat push** — compute only the changed threat edges per move
   (Stormphrax `threatsAdded`/`threatsRemoved`), instead of re-enumerating + diffing.

### 16.5 Strategy verdict (one ladder)
Eval isn't the problem, **NPS is**. Single-layer + threats first (rung 1), int8-asm +
move-aware push to beat v6 at movetime, then width 1024 → king buckets → multilayer tail
(+30–50, last, behind int8) → **self-generated data** (breaks the Stockfish-distillation
ceiling — the lever to the very top). Multilayer is NOT all top engines but is the
expected endgame (~+30–50); threats are the newest frontier lever (2024–25). Go is fine;
don't rewrite. Gate at movetime/fixed-depth, never fixed-nodes.

### 16.6 What's training (2026-06-30 17:00)
`chessgo_lean_threats` (rung 1: lean single-layer + threats + 8 buckets, 64-sb, QAT) on
the M3 Metal GPU; the gate (`lean_gate.sh`) auto-runs fixed-depth + movetime vs v6 when
the annealed `-64` lands (~18:00). The multilayer `chessgo_enriched-64` (+149 fd / −160
mt) is kept for reference (rung 4, deferred until the int8 tail is real). **Both 64-sb
nets are undertrained** — v6 shipped at 320; a full 320-sb anneal is the production step
once an arch wins the movetime gate.

---

## 17. The `--nodes 0` flag bug + what it invalidated (2026-07-01)

**The methodology footgun (write it on the wall):** `bench sprt --movetime N` is
**silently ignored unless `--nodes 0` is ALSO passed** — `nodes` defaults to 25000, and
whenever nodes > 0 the harness runs fixed-nodes and drops `--movetime` on the floor. The
run header tells the truth: it must say **`budget: 100ms/move`**, NOT `budget: 25000
nodes/move`. Every "movetime" SPRT that omitted `--nodes 0` was actually a **fixed-25000-
nodes** run — and fixed-nodes *inflates* eval-heavy features (§14.4). Two of our banked
numbers were contaminated by exactly this:

### 17.1 CorrHistMinor — re-validated, it's a WASH (not +43)
Corrected run (coalla/AVX-512, `--new "" --old "corrhistminor=off" --nodes 0 --movetime
100`, header confirmed `100ms/move`):

| budget | Elo | pairs | LLR | pentanomial | verdict |
|---|---|---|---|---|---|
| **TRUE movetime (100 ms)** | **−4.2 ± 13.6** | 411 | −0.70 | [8 104 200 88 11] | **parity** (CI spans 0) |
| fixed-40k (control) | **−56.6 ± 20.1** | 292 | −2.95 | [19 147 36 90 0] | **H0 REJECT** |

The old "+43.4 ± 16.6 @ 100ms, H1" that justified shipping it was the `--nodes 0` bug —
it ran fixed-25000-nodes. At **true** movetime CorrHistMinor has **no measurable effect**,
and at fixed nodes on today's (reverted) baseline it's a clear loss. **Kept default-ON**
anyway: movetime says wash, so there's no movetime justification to *remove* it either —
acting on the −57 fixed-nodes number would be the §14.4 mistake. It's a standard technique;
it owes a **longer-TC** re-test before we trust it as a positive. (`params.go` comment
updated to match.)

### 17.2 The 5-patch "−77.7 movetime revert" was also contaminated
The day's search-wave re-anchor that read **−77.7 "movetime"** and drove the mass revert
(IIR / ProbCut / Razor / LMR2 back to OFF) **also** omitted `--nodes 0` → it was fixed-
25000-nodes, not movetime. The reverts still stand as *the conservative call* (those
patches never showed a clean movetime win, and the multicut/lmr2 anti-synergy is real),
but the specific "−77.7 at movetime" figure should be read as **fixed-25000-nodes**, not a
movetime verdict. A clean movetime re-anchor of that stack is still owed.

### 17.3 The rule
**A movetime SPRT that doesn't print `100ms/move` in its header is a fixed-nodes SPRT.**
Grep the header before trusting any "movetime" number in this doc. The v6 / lean-threats
(v9) net gates below used scripts that *did* pass `--nodes 0` and were header-verified —
those numbers are movetime-clean.

## 18. Enriched threats net (v9 lean) — movetime PARITY with v6, a speed wall (2026-07-01)

The 320-sb annealed **lean single-layer + threats** net (rung 1, QAT int8, made movetime-
viable by **tail fusion** + **int8-FT** — see `docs/NNUE/ENRICHED_MULTILAYER.md`):

| gate (vs shipped v6, header-verified) | result |
|---|---|
| **fixed depth 8** | **+139 Elo** — the threats eval is genuinely much stronger |
| **vs v9-160** (same arch, half-annealed) | **+156 Elo** — the anneal matters, as expected |
| **movetime (100 ms)** | **−13 … +9 Elo** — dead **parity** (within ±22 noise) |

**Verdict: eval wall cleared, speed wall not.** The threats net is a **much** better
evaluator (+139 fixed-depth) but the per-move threat accumulator (~22 columns/move vs v6's
~4) makes eval ~2.25× costlier, so at equal *time* the extra eval quality is exactly
cancelled by the lost NPS → v9 ≈ v6 at movetime. This is the same shape as v8 buckets
(§14.3): a fixed-depth/fixed-nodes win that evaporates at movetime because the regimes
aren't equal effort. We went **−330 → parity** via tail fusion (fused integer `screluDot`,
+1.87× NPS + a free +40 eval) and int8-FT (halves the threat-accumulator memory traffic);
parity is the floor, not the ceiling. The lever to push *past* v6 is the two Stormphrax
fixes in §16.4 (real int8 dot via Go asm; move-aware threat push), which cut ns/node
without touching eval quality — i.e. buy back the NPS the threats cost.

**Anchor:** since v9 is movetime-parity with v6, it anchors at the **same ≈3260 "dirty"
CCRL Blitz** as v6 (§15) — the +139 fixed-depth does *not* move the movetime anchor. v6
sits ≈363 Elo below Stormphrax undertown on the two-NNUE-anchor agreement; v9 shipping
would need a real movetime win, which waits on the NPS work, not more training.

## 19. Move-aware push — v9 crosses from parity to **+25 vs v6 at movetime** (2026-07-01)

The push (§18) was the wall. A movetime **pprof of the lean net** (new `bench --pprof`
flag, lean-vs-lean both move-aware) settled the internal split that the old §16.3 profile —
taken on the *multilayer* net — had left ambiguous:

- **The accumulator push is ~47% of engine CPU.** Half the node.
- Of that, the per-move **full re-enumeration** of the threat feature set (~11%) and the
  **O(active-features) count-array diff** over the full ~100-200-feature lists (~13%) are
  overhead — only a handful of features actually change per move. The rest (~14%) is the
  irreducible column add/subs (the accumulator genuinely changing). Search (TT.probe,
  selectMove, negamax…) is ~30% but is **shared with v6**, so it never moves the v9-vs-v6 gap.

**The fix (`internal/nnue/enriched_delta.go`):** compute the base+threat delta directly.
Diff the old vs child board (O(64)) for the changed squares `D`; the affected attackers are
the pieces on `D` plus every piece attacking a `D`-square under the old **or** new occupancy
(a discovering slider was the square's blocker in exactly one of the two). Re-enumerate just
those attackers' edges old-vs-new and reuse the existing `applyDiff` count-array to cancel
the unchanged ones. **Bit-exact** vs from-scratch across ~2M nodes covering captures,
castling, en passant, promotions — under scalar *and* AVX-512, int8-FT off and on
(`TestEnrichedMoveAwareBitExact`, gated by the `NNUE_ASSERT` int16-equality check).

| metric (coalla / AVX-512) | value |
|---|---|
| push cost | **1304 → 822 ns** (1.58× faster) |
| whole-engine NPS | **≈1.2×** |
| **movetime (100 ms) vs v6** | **+27.6 ± 24.9 @ 164 pairs** (CI excludes 0) — call it **≈+25** |

**v9 went from movetime parity (§18) to a real positive.** The +139 fixed-depth eval edge
is finally coming through the clock. Default-on for lean nets (`ImportBulletLeanNet` sets
`moveAware`), it's strictly better and bit-exact.

**The push is now tapped (measured, not assumed).** Three attempts to beat the flat
re-enumerate-and-cancel form were all **slower** on AVX-512: (1) single-edge shortcut for
knight/king attackers **935 ns**, (2) exact changed-edges via the XOR of each attacker's
old/new PseudoAttacks **888 ns**. Both add per-attacker probing (extra `AttackersTo` / a
second `PseudoAttacks`) to shrink the sub/add lists — but `applyDiff` is already cheap (SIMD
column ops over an L1-resident count array), so the probing dominates. **The enumeration is
the irreducible cost.** Do not re-derive these.

**Where the remaining lean-specific eval cost lives (all behind a retrain):** the int16 tail
dot (`screluDot`, ~10%) and the int16 base columns (~7%). int8-ing either needs **QAT**
(PTQ int8 has a ~150-Elo cliff, §16.2) plus a hand-written VNNI kernel (`archsimd` has no
VPDPBUSD/SDOT). So the next eval-speed gains fold into the next training run, not more push
surgery. See `ENGINE_ROADMAP.md`.

## 20. CCRL bracket update (2026-07-01) — >3400 hard floor, the "≈3200" was a one-sided artifact

> **Update 2026-07-03 — this band is now a STALE FLOOR with a DEAD CEILING (§28).** It predates
> ~25 Elo of shipped movetime patches (§23/§25/§26.4) and was never triangulated. The **~3700 top is
> stale** (an old blowout the engine has gained past), so treat the band as **open-topped**: floor
> >3400, no valid ceiling, still untriangulated; **re-anchor vs a ranked NNUE opponent — now ~3700+,
> not the old ~3450–3600 — before quoting a number.** The band below stands as the 2026-07-01
> measurement of record.

The ≈3260 read of §15/§18 is **stale and, at the low end, wrong**. Two newer full-strength
matches vs officially-CCRL-rated opponents move the picture up and bracket it:

| Opponent (CCRL Blitz) | gomachine score | What it tells us |
|---|---|---|
| **~3400 engine** | **100W – 0L** (clean sweep) | **hard floor: we are objectively >3400.** A 100–0 sweep is not a 3400-vs-3400 coin-flip; the true gap is large, so the floor is *well* above 3400, not at it. |
| **~3700 engine** (STALE — old match) | lost hard (losses + draws, **0 wins**) | **No longer a valid ceiling.** At the time it read "below ~3700," but this match predates the v9 push (§19/§22), book recompile (§25) and §23/§26.4 search patches — substantial Elo the engine has gained since, so it no longer bounds current strength (§28). The formula estimate off it spat out a garbage **≈3200** (one-sided, all-losses). Do **not** treat 3700 as a current upper bound. |

**The ≈3200 is a garbage number — do not quote it.** It is the anchor formula
(`opponent_Elo + logit(score)`) applied to a **one-sided, near-zero-score** result with **no
wins**. When you score ≈0% the logit term saturates and the formula *must* return something
far below the opponent regardless of true strength — it is mathematically incapable of
returning a triangulated value from an all-losses sample. It is a **lower-bound projection of
a blowout**, not a measurement. The 100–0 sweep at 3400 flatly contradicts it: you cannot be
both "≈3200" and "crushes 3400 100–0." When two anchors disagree, the *sweep* is the harder
evidence — a 3200 engine does not go 100–0 vs a 3400 engine, ever.

**Honest current statement (as of 2026-07-01; now a stale floor AND a dead ceiling per §28):
gomachine's floor is comfortably above 3400** (the 100–0 sweep margin implies real headroom over it),
**and the ~3700 top is stale** — that loss predates the recent gains and no longer bounds the engine.
So the honest bracket is **open-topped: floor >3400, no valid ceiling**, untriangulated. Since even
the 2026-07-01 read, ~25 Elo of movetime patches shipped (§23/§26.4) plus the +33 book recompile
(§25), pushing true strength further above the floor — so read >3400 as a **floor**, treat 3700 as a
**dead** ceiling, and re-anchor (§28) before quoting a point.
We still lack a **~50% opponent inside the band** — the pending step §15.2 already flagged.
Both reference matches remain blowouts in opposite directions (100–0 one way, ~0% the other) — and
the ~0% one is **stale**, so it no longer even fixes the top; a proper single number needs an
opponent we score ~40–60% against (target a ranked **NNUE** CCRL entry — the old ~3450–3600 is now
too weak, use **~3700+**). Until then, quote the **floor**, not a point, and never the ≈3200.

**Engine-ladder rescale (the real fix, not a frontend trick).** `configForRating`'s ladder
(`internal/engine/rating.go`) is now **natively CCRL**: `RatingMax` 2900 → **3500** (full
strength is a single ceiling config — max depth/time/no-noise — so 2900 was only ever a
*label* on the FIDE/human ruler; 3500 is that same ceiling on CCRL), `ratingCleanFloor`
2200 → 2600 (holds the same normalized noise-onset). Full strength now *reads* 3500.

**Human matchmaking is untouched** (Glicko stays FIDE-centered). Human-facing callers — hub
backfill (`bot.go`) and the `/bot` picker (`BotGameService.php`) — route their human-scale
rating through a new `engine.EngineRatingForHuman()` (linear `[700,2900]→[700,3500]`,
strength-preserving) before it hits the ladder, so those bots play **identically** to before
the rescale. Only the admin Engine-vs page speaks raw CCRL (slider 700–3500, straight
through). The public vs-AI difficulty slider stays 700–2900 (human scale) on purpose.

**Stockfish ruler** on the Engine-vs page was also re-scaled to a truthful CCRL-ish display
(SF's raw UCI_Elo runs far below CCRL; UCI 3000 → shows ~3400, top notch → "Unleashed" =
uncapped SF via `elo=0`).

## 21. v10 (pairwise head) — hard NO-GO, and it proves the wall is SPEED not eval (2026-07-01)

**What v10 was.** v9 (lean threats, `(768+9216)→512` single-layer) with the tail head
swapped for **pairwise multiplication**: CReLU each FT half-pair and multiply —
`crelu(l0[0:256])·crelu(l0[256:512])` per perspective, concat → H=512 → single output dot
per bucket (`chessgo_lean_pairwise.rs`; Go inference `internal/nnue/enriched_lean_pairwise.go`,
full-integer `ca·cb` dot). Motivation: a multiplicative nonlinearity (Stormphrax "dual
activation") **and** it halves the tail input (1024→512). FT is byte-identical to v9, so the
accumulator / threat-push / int8-FT / move-aware path is reused untouched — only the tail
differs. Trained standalone **64-sb, fully annealed**. Go path validated bit-close before any
game: arithmetic vs float ref ≤4.6cp, incremental==from-scratch over 346k nodes, symmetric
queen-up evals.

**Baseline caveat (important for reading the numbers).** The A/B baseline `lean_threats_64` is
the **sb64 checkpoint of the single 320-sb v9 run** — i.e. *under-annealed* (LR barely decayed
at 64/320). pairwise-64 is *fully* annealed. So **pairwise had an anneal *advantage*** over the
baseline: a loss here is damning; a modest win would have to be discounted.

**Results (coalla, v4 AVX-512 SIMD build):**

| Gate | Config | Result | Read |
|---|---|---|---|
| pairwise-**32** vs lean_threats_64 | fixed 40k nodes | **−277** (101 pairs) | both under-annealed → understated early read, not a verdict |
| pairwise-**64** vs lean_threats_64 | fixed 40k nodes (eval quality) | **−64.5 ±18** (229 pairs) | lost eval quality **with** the anneal edge → damning |
| pairwise-**64** vs lean_threats_64 | movetime 100ms, int8FT+move-aware both | **−145 ±53** | *worse* than fixed-nodes → also slower |

**Per-node cost (the smoking gun), dense midgame, v4 AVX-512:**

| Net | ns/node | NPS | vs v6 | vs v9 |
|---|---|---|---|---|
| v6 (no threats) | 312 | 3.20M | — | — |
| **v9** (lean threats) | 1041 | 0.96M | **3.3× slower** | — |
| **pairwise (v10)** | 1943 | 0.51M | 6.2× slower | **1.87× slower** |

pairwise is 1.87× slower per node than v9 → ~47% fewer NPS → in a movetime game it searches
~half the nodes, which is exactly why **movetime (−145) came out worse than fixed-nodes
(−65)**: shallower search *on top of* worse eval. Cause: the pairwise tail is a **scalar** int64
loop (branchy clamps), where v9's tail is the fused **SIMD** `screluDot` — the half-width didn't
help, scalar-vs-SIMD *added* ~900 ns/node. Fixable (SIMD-ize it), but **moot**: eval quality is
−65 regardless of speed.

**Verdict: hard NO-GO on both axes** — worse eval AND slower. The pairwise multiplication head
is a regression at 64-sb on our Stockfish data. Not scaled to 320. (Nets kept: `lean_pairwise_32/64.bin`.)

### 21.1 The real lesson — eval quality is NOT the wall, the threat-PUSH is

Two independent signals point at the same thing:
- v9 already has the **eval** (+170 @ fixed depth vs v6) but only **~+25 at movetime** — because
  it is **3.3× slower per node** than v6 (the threat accumulator's memory traffic).
- v10's whole failure was a *speed* failure amplifying a small eval regression.

So the leverage is **not another eval head** — it's making the threat features **cheaper to
carry**. Concretely, the Go-side work that must land **before any v11 retrain** (there are always
improvements to be made):

- **Cut the threat-push cost** — the `EnrichedStack` per-move accumulator update is the 3.3× tax.
  Options: narrower/int8 threat FT (less memory moved per edge), a cheaper affected-attacker
  delta, SoA/prefetch on the threat columns, or dropping low-value threat edge classes entirely.
- **SIMD any scalar eval path** (the v10 tail was a reminder scalar tails silently cost ~900ns).
- Re-anchor v9's **movetime** number after any push speedup — the fixed-depth eval is banked; the
  only question that matters is NPS.

**Gate rule going forward: a threats arch is only worth training if the per-node cost stays
within ~1.5× of v6.** v9 is at 3.3×, v10 was at 6.2× — both are why the big fixed-depth eval
wins don't cash out at movetime. Fix the push first; then a v11 head has room to pay for itself.

## 22. Fixing the push (not the net): geometry enumeration ships **+18 Elo** on v9 (2026-07-01)

Acting on §21's "fix the push first," a 4-agent investigation (our-code self-audit + two Stormphrax
studies + a measurement adjudication) settled three things by numbers, not opinion:

**Push-cost split (v9, AVX-512, dense midgame, 1040 ns/node):** enumeration **382 ns (37%)**,
column-apply **449 ns (43%, memory-bound)**, eval tail **211 ns (20%)**. Both prior audits were
half-right: enumeration is *not* "irreducible" (it re-enumerates full edge sets), and deferral is
*not* a big lever here.

- **Deferral — evidently DISPROVEN, skipped.** Stormphrax defers the column math to `evaluate()`
  and skips it on pruned nodes; but instrumented searches show **only 4.9% of our pushes are
  eval-less** (we compute a static eval nearly everywhere — RFP/futility/null-move + qsearch
  stand-pat). Ceiling ~2-3% NPS for a whole new accumulator-bug surface. Not worth it. Their
  "many nodes pruned before eval" premise is false for gomachine.
- **Geometry / changed-edges enumeration — SHIPPED, +18 Elo.** `appendAttackerEdges` re-enumerated
  every affected attacker's full edge set under old+new occupancy and cancelled; replaced with
  **changed-edges-only** (`pushMoveAwareChanged`): non-sliders skip entirely when unaffected;
  sliders diff only along rays through a changed square via a masked-line full diff (`LineBB`),
  which uniformly handles discovered-slider extend/retract. **Bit-exact** (perft int16 gate,
  int8FT on+off, all move types — no piece-class fell back). Kept the full re-enumeration behind a
  runtime toggle (`SetChangedEdges`, default on) for A/B. Results: **push 817→682 ns (−16.5%),
  node 1051→902 ns (−14% NPS)** on AVX-512; movetime SPRT (geometry on vs off, v9, 100 ms):
  **+18.1 Elo, CI [+2.6, +33.6]** (279 pairs). v9's per-node cost drops **3.37× → 2.89× v6**.
  Pure speed — identical eval, no retrain. `internal/nnue/enriched_delta.go` +
  `internal/chess/rays.go`. *(The scalar arm64 A/B showed only ~3% — pure SIMD-dilution: the
  same ~135 ns saving is 3% of a 4000 ns scalar push but 14% of the 900 ns AVX-512 push. Measure
  speed on the SIMD toolchain.)*

**Corrects the record:** the old "enumeration is the irreducible cost / the push is tapped"
conclusion (from the three reverted move-aware micro-opts) was wrong — those variants *added*
`PseudoAttacks` calls to shrink the already-cheap `applyDiff`; geometry *reduces* them. Enumeration
was 38% of the push and very much reducible.

**Also this pass — B1, a real search bug (fixed).** The LMR2 noisy-move reduction computed
`isCapture`/`SEEGE` on the *post-`DoMove`* (child) position → `isCapture` always true, SEE on the
wrong board. Fixed to use the pre-move `capture` bool + a pre-move SEE (`search.go`, guarded by
`LMR2 && SEE && capture` so it's free on other nodes). **Inert in prod** (LMR2 default-off), but it
had tainted LMR2's rejection: re-SPRT moved LMR2 **−64.9 → −11.9** (movetime, v9) — a ~53 Elo swing,
proving the bug was material. LMR2 itself is now neutral-to-slightly-negative, so it **stays off**;
the fix un-taints future LMR2 work.

**Next on the push:** the untouched lever is the **449 ns column-apply** (memory-bound scatter over
the 4.7 MB int8 threat table). Neither geometry nor deferral touches it — it's a **net-architecture**
axis (narrower threat-FT half, pruned low-value (attacker,victim) classes, or an int8 accumulator to
halve write traffic), i.e. a retrain, gated at movetime. That's the road from 2.89× toward the
≤1.5×-v6 gate.

---

## 23. Stormphrax search-patch mining run (2026-07-01) — nmpgate + qsfut ship (~+5 combined)

A pure **search** pass (no net, no eval change): mine Stormphrax (`~/stormphrax`) for
heuristics/constants we don't have, port the promising ones behind default-off `Params`
flags (byte-identical off), and movetime-SPRT them on coalla. Three research subagents
split the source — one on Go/NPS mechanics, one on search heuristics, one on tuned
constants — vs our `params.go`; **6 candidates** came out and were A/B'd.

**Method / decision policy (a deliberate speed/rigor trade for a queue of small patches):**
all SPRTs on **coalla** (AVX-512 SIMD box, go1.26.4, **100 ms/move**, α=β=0.05,
concurrency 12). Batch policy = **CAP 800 pairs + trend-accept** — accept if `LLR>0`
**AND** the Elo-CI lower bound `>0`; drop otherwise; kill early if clearly negative. This
clears a 6-patch queue in a few hours instead of running each to a formal bound, at the
cost of noisier per-patch point estimates — so the **individual +12s below are cap-800
trend-accepts, and the honest headline is the direct combined-vs-shipped SPRT (~+5), not
the sum.** Winners were carried as explicit flags on *both* SPRT sides so no rebuild was
needed between accepts (rebuild only to introduce a brand-new flag into the binary).

### 23.1 Accepted (shipped default-on, `7ca44e0`, deployed to prod lairner)

| Patch | Flags | Movetime Elo (100 ms) | Pairs | What it does |
|---|---|---|---:|---|
| **nmpgate** | `NmpGate`, `NmpEvalDivisor=200` | **+12.1 ± 10.0** (LLR +1.83, CI lo +2.1) | 890 | null-move pruning now requires `staticEval ≥ beta` **and** scales the reduction: `R += min((staticEval−beta)/200, 3)` — deeper null reductions when we're well above beta |
| **qsfut** | `QSFutility`, `QSFutilityMargin=100` | **+12.4 ± 10.0** (LLR +1.89, CI lo +2.4) | 897 | qsearch **node-level** futility (Stormphrax `qsearchFp`): out of check, skip a non-SEE-winning capture (`!SEEGE(m,1)`) once `standPat+100 ≤ alpha`. **Additive** to our existing per-move delta pruning (delta subtracts the victim value; this is a node floor gated on SEE) |

- The qsfut sample (897 pairs, measured **on top of** nmpgate) is the more robust of the two.
- **Combined winner-stack vs shipped baseline: +5.2 ± 15.3 @ ~400 pairs, stable positive**
  (the running read walked +6.3 → +6.0 → +5.2). This is **SUB-ADDITIVE** vs the summed
  individual reads — expected, since nmpgate and qsfut are two overlapping pruning
  heuristics, and the +12s are noisy cap-800 trend-accepts. **The honest banked gain of
  this run is ~+5 Elo @ movetime, not +24.**

### 23.2 Rejected (kept DEFAULT-OFF behind their flags as scaffolding)

| Patch | Flag(s) | Result | Verdict / root cause |
|---|---|---|---|
| **futbase** | `FutBase` | **WASH** (+0.6 ± 12.2, LLR −0.25) | futility margin `100·depth` → base+slope (`150 + 70·depth`). No movetime win at these constants. **Knob kept for SPSA** (the base/slope split is exactly an SPSA target). |
| **aspdelta** | `AspDelta` | **WASH/slightly neg** (−8.2 ± 28.1, LLR −0.26) | aspiration initial window 25 → 12 cp. A tighter window is not a win at 100 ms on our engine. |
| **negext** | `NegExt` (cutnode plumbing) | **NEGATIVE** (−10.4 ± ~20, LLR −0.64) | thread a `cutnode` flag through negamax + negative extensions (`−2` cutnode / `−3` tt-fail-high) + **SOFT** multicut via `ilerp` toward beta (`T=503/1024`), replacing our hard `return singularBeta`. Implementation is correct and **race-clean** (targeted `-race` passed); it conflicts with our already-SPRT-tuned singular/multicut margins — the delicate area of the historical `lmr2+singular −67` anti-synergy (§13.2). **NOT a dead idea — REVISIT via joint SPSA of the singular margins + negative-extension params together, not a standalone A/B.** The `cutnode` plumbing is byte-identical when `NegExt` off and is now available for future work. |
| **conthist2** | `ContHist2` | **NEGATIVE** (−24 ± 33) | Stormphrax-style continuation history — offsets `1/2/4/6` plies (we had only `1+2`), coupled `updateWithBase` gravity, per-`Searcher` tables, fed into ordering + LMR + histprune. Does **not** rescue continuation history on our heavily-pruned baseline (consistent with the original ContHist rejection, §13.2). |

### 23.3 Process notes
- **The cap-800 trend-accept policy did its job** — it let us clear a 6-patch queue in a
  few hours by killing the washes/negatives fast instead of grinding each to a formal
  bound; the two winners were then confirmed *together* by the combined-vs-shipped SPRT.
  Use it for **queues of small patches**, not for a single high-stakes accept.
- **Flags on both SPRT sides = no rebuild between accepts.** Only a brand-new flag forces
  a rebuild; toggling an already-compiled flag does not.
- **Sub-additivity reminder (again).** Summing individual trend-accepts overstates the
  bundle; the direct **combined-vs-shipped** SPRT is the figure to quote (~+5 here, not the
  +24.5 the two +12s add to). Same discipline as §13's "they compound, don't sum."
- **Follow-ups → SPSA.** `futbase` (base/slope), and `negext` **jointly with** the singular
  margins, are the two SPSA-revisit items this run parks; both stay wired default-off. The
  `cutnode` plumbing landing (inert) is the prerequisite for the negext revisit.

## 24. Aggression style knob (2026-07-02) — a shallow-search crutch, NOT a strength patch

**One-line:** an eval bolt-on that biases toward attacking the enemy king wins **big at
fixed depth 8 (+43.7) but flips to a loss by depth 12 (≈−30) and at movetime (≈−44)** —
its value **decays monotonically with depth**, so it is a *style* lever only, never a
strength gain. The clean, strength-neutral version lives in the net, not the eval; see
`docs/AGGRESSION.md`.

### 24.1 What was built (scaffolding, default-OFF / inert)
- `search.Params.Aggr` (0..100, **default 50 = neutral**). At 50 the term is *never
  evaluated*, so the shipped engine is **byte-identical** (guarded `if s.params.Aggr != 50`
  in `rawEvaluate`, `internal/search/search.go`).
- `eval.AggressionTerm(pos)` (`internal/eval/aggression.go`) — a side-to-move-relative,
  per-side-capped king-attack term added on top of the NNUE/HCE static eval, scaled by
  `(Aggr-50)/50`. Effect range 50→100 = attacking, 50→0 = solid.
- Bench key `aggr=` (`internal/bench/config.go`, parse + diff label).
- Frontend: an "aggression" slider on the admin **Engine vs Engine** page (localStorage,
  default 50), wired end-to-end (React → `engineVsMove` → `EngineMatchController` →
  `GomachineClient` → `server.go` `Limits.Aggr` → `engine.BestMoveForRatingTimedAggr` →
  `Searcher.SetAggr`), **gomachine-side only**, absent→50 everywhere.

### 24.2 The measurements (self-play SPRT, [0,5], v6 net)
Direction = `new` relative to `old`. Fixed **depth** and **movetime** only — this is an
EVAL change, so fixed-nodes is invalid (§14.4). Fixed-depth runs on the scalar local
build (depth-bound, hardware-independent); movetime on the arm64 SIMD build (go1.27rc1).

| Test | Ruler | Elo | Verdict |
|---|---|---:|---|
| `aggr=0` vs `50` | depth 8 | **−10.8 ± 11.7** (787 pr) | ~H0 — mild caution tax |
| `aggr=100` vs `50` | depth 8 | **+43.7 ± 16.6** (190 pr) | **ACCEPT** — looks great |
| `aggr=100` vs `0` | depth 8 | **+97.4 ± 26.4** (95 pr) | **ACCEPT** — monotone `100>50>0` |
| `aggr=100` vs `50` | **depth 12** | **≈ −30 ± 38** (66 pr) | already negative |
| `aggr=100` vs `50` | **movetime 100ms** | **≈ −44 ± 51** (~30 pr) | negative from pair 3 |

### 24.3 The two hypotheses and the diagnostic that settled it
The +44@d8 → −44@movetime flip had two candidate causes:
- **H_cost:** the knowledge is real & depth-robust; movetime lost only on the NPS the term
  burns (it loops every piece calling `pos.AttacksFrom` — magic lookups — every eval node).
- **H_depth:** the *bias itself* helps shallow search (substitutes for tactics it can't yet
  see) but hurts deep search (which sees them, so the bias just pushes unsound sacs).

**Diagnostic = run the real term at a DEEP fixed depth (12).** Depth removes the NPS
variable (both sides search equal depth), so a negative there indicts the *bias*, not the
cost. Result: **≈−30 at depth 12** → **H_depth**. Confirmed independently: a
distance-only **tropism** rewrite (no attack generation, ~free) was **−65.2 ± 22.4 @ depth
8** — i.e. cheapening didn't just fail to help, proximity-without-real-attacks is *actively
harmful*. So (a) the knowledge lives in **real king-zone attacks** (blocker-aware), and
(b) even free-to-compute it would still lose at movetime because the bias is wrong at depth.

### 24.4 Lessons
- **Add this to the fixed-nodes rule (§14.4): fixed *depth* is a valid eval ruler, but a
  *single* fixed depth can still mislead if a term's value is depth-dependent.** Aggression
  read +44 at d8 and −30 at d12 — same valid ruler, opposite sign. **Gate eval across ≥2
  depths (or at movetime), not one.** A one-depth "eval win" can be a shallow-search crutch.
- **A style knob is a legitimate, separate goal from a strength patch** — but this one, as an
  eval bolt-on, can't be *both*. Kept as inert scaffolding (default 50); the frontend slider
  gives sharper-but-weaker play at bot-level depths, which is the correct UX for "play
  aggressively," and is **never** shipped default-on or billed as stronger.
- **Strength-neutral aggression must be baked into the NNUE** (retrain with a sharpness/
  WDL-weighted target), the only route that survives depth. Deferred — plan in
  `docs/AGGRESSION.md`.

## 25. Recompile the opening book after every eval upgrade (2026-07-02) — **+33 Elo, free**

**Recurring maintenance, not a one-off.** `data/book.bin` is a *frozen snapshot of whatever
engine searched it*. It stores, per opening position, that engine's best move + eval — and
`SearchDirect`/serve return the stored move **verbatim, `nodes 0`, at the stored depth**, never
re-searching an in-book position. So every eval/search upgrade after a book compile silently
leaves the entire opening tree (first `maxplies=12` plies) playing the **old, weaker engine's
choices** — in play *and* on the analysis board.

### 25.1 What we found
The shipped book was compiled **2026-06-20**, one day *before* NNUE landed (§11) — i.e. by the
retired **HCE** engine, ~200-300 Elo below current v9. Symptom that surfaced it: the analysis
board showed `3...e5` in the Rossolimo (`r1bqkbnr/pp1ppppp/2n5/1Bp5/4P3/5N2/PPPP1PPP/RNBQK2R b`)
frozen at depth 14 and refused to deepen — because it was a **book hit**, not a search. The live
v9 search flips to `3...g6` by depth ≥12, and Stockfish (d28) agrees (`g6` ≈ +8 cp over `e5`).

Recompiled every position with the current v9 lean-threats net (same recipe: `movetime 3000`,
`maxplies 12`). **The new book disagrees with the old on 44.6% of positions (2421/5429)** — the
HCE→v9 upgrade rewrote nearly half the opening tree.

### 25.2 SPRT (new book vs old, both `book=on`, identical v9 search)
- **Fixed-nodes 40k: +33.0 ± 14.1 Elo, LLR +2.98 → ACCEPT H1** (241 pairs, W76 L30 D376,
  pentanomial `[0 30 135 76 0]`, zero LL).
- Movetime 100ms: sign-confirming, trending **+10..+17** at ~130 pairs (draw-heavy → slow, not
  run to a formal cross; the fixed-nodes H1 is the verdict).

**Fixed-nodes is a valid ruler here** — the rare eval-adjacent change where it doesn't inflate
(§14.4). A book has **zero per-node cost difference**: it's a pre-search lookup, and once out of
book both sides run byte-identical search. All the book changes is *which position the search
starts from*, so a better book ⇒ better start ⇒ better result, monotonically, for any search.
(This also refutes the "maybe our params are co-tuned to the old book" worry: params are tuned
from the opening *suite*, not the engine book, and out-of-book play is book-independent.)

### 25.3 The gotcha that almost baked another weak book
`compile-book` uses `engine.New` (no book — good, it never copies the old book), but it did
**not** load the prod net, so it would have searched with the embedded **v6** (or HCE fallback),
not v9. Fixed: `cmdCompileBook` now calls `loadEnrichedDefault()` (routes eval through
`data/nnue/lean.bin`), same as serve/hub. **Always confirm the compile logs
`routing eval through v9` before trusting the output.**

### 25.4 The routine (do this whenever the default eval changes — new net, big eval patch)
```sh
# 1. recompile with the CURRENT engine (SIMD build so movetime reaches full depth)
GOEXPERIMENT=simd ~/go/bin/go1.27rc1 build -o bin/gomachine ./cmd/gomachine   # arm64; GOAMD64=v4 + go1.26.4 on prod
./bin/gomachine compile-book --out data/book_new.bin --movetime 3000 --maxplies 12
#    → MUST log "enriched eval: lean threats net loaded … routing eval through v9"

# 2. SPRT new vs old (per-side book A/B; fixed-nodes is fine for a book)
./bin/gomachine bench sprt --new "book=on" --old "book=on" \
  --new-engine-book data/book_new.bin --old-engine-book data/book.bin \
  --nodes 40000 --elo0 0 --elo1 5 --concurrency 10

# 3. (optional) see WHERE they differ — diff by move, score each disagreement on one yardstick
./bin/gomachine book-diff --old data/book.bin --new data/book_new.bin --sf stockfish

# 4. accept → wire in (the embed is data/book.bin) and commit
cp data/book_new.bin data/book.bin && rm data/book_new.bin
```
First landed `23bd81e`. Books are per-engine (not a process global like the net), so
`--new-engine-book`/`--old-engine-book` need no `--concurrency 1`.

### 25.4 Book A/B/C — recompile vs Stockfish-compiled (2026-07-12) — shipped C

~100 Elo of net had shipped since the v9 book (§25) with no recompile, so we A/B/C'd
three books over the SAME 5,4xx opening positions, all measured on the prod
full-threats net at 100ms/move self-play (from the start position):

- **A** = shipped v9 book (baseline).
- **B** = `compile-book` on the current full-threats net → **+11.3 ± 9.0 vs A** (SPRT, 800 pairs, trend-accept: LLR +2.06, CI-lb +2.3).
- **C** = `compile-book-sf` — Stockfish 18 @ depth 22, one best move per position → **≈+10 vs B** (SPRT stopped at 519 pairs, converged +10.0 ± 13.3, LLR +0.81).

C shipped as `data/book.bin` (`64331c9`; tool `88b4a2a`). The book is a gomachine
search-cache but only PV[0] is consulted at runtime (a hit short-circuits search), so
`compile-book-sf` just bakes in SF's opening move per position. C-vs-A not measured
directly (SPRT deltas are sub-additive). C is the SF-quality-opening lever and the exact
non-transitivity case — **gate the prod DEPLOY on an Abitur external pass**, not just the
SPRT. Next: `compile-book-sf-tree` (breadth-first SF MultiPV tree — depth + coverage in
one artifact, keeps firing when the opponent leaves theory) vs flat C.

---

## 26. Clock-aware time management (shipped) + the no-retrain NPS/asm push (2026-07-03)

### 26.1 Clock-aware time management — shipped (`c63450a`)
The old budget was a flat per-move `MoveTime` with a single hard deadline (naive
`remaining/30 + inc/2`). Replaced by an adaptive manager (`internal/search/timemanager.go`,
`timemanager_test.go`):

- **Soft/hard split.** A *soft* limit (base allocation from clock + increment) gates
  **iteration starts** — don't begin a new ID iteration you can't finish; a *hard* limit
  (3× base, capped at 50% of remaining) is the absolute **mid-search** cutoff.
- **Best-move stability scaling.** A move stable across iterations shrinks the soft limit
  (0.5× base — stop early when the move is obvious); an unstable one extends it (1.5×).
- **Score-drop extension.** A drop in the root score between iterations further extends,
  to spend more when the position just got worse.
- **Plumbing.** The UCI handler now passes `wtime`/`btime`/`winc`/`binc`/`movestogo`
  through `Limits` instead of flattening to one `movetime`. **Every existing caller
  (bench, serve, hub bots) that passes only `MoveTime`/`Depth`/`Nodes` takes the unchanged
  legacy path** (`soft == hard == MoveTime`) → byte-identical, so all prior SPRT results
  stand and fixed-`--movetime` SPRTs are unaffected.

**Not yet SPRT-anchored.** It only bites when a real clock is supplied (UCI `go wtime …`),
which the in-process self-play harness doesn't do — it passes fixed `MoveTime`. Anchoring
it needs either a UCI-clock self-play mode in `bench` or a cutechess run with real TCs.
Until then it's a shipped-but-unmeasured feature; the design follows the standard modern
recipe (SF-style soft/hard + stability), the Elo is the "+50–100 from TM" the literature
reports but we haven't independently confirmed on our engine.

### 26.2 External-analysis lever triage (what's real, what's spent, what's blocked)
An outside research pass (2026-07-03) surfaced a lever list. Reconciled against the current
engine (v9 lean-threats net, §19; AVX-512 prod on lairner):

| Lever | Status here | Verdict |
|---|---|---|
| Clock-aware time management | **Shipped** `c63450a` (§26.1) | spent — the analysis's headline "biggest easy Elo" is already done |
| Qsearch generates ALL legal moves, filters to captures in-loop | **Confirmed** — `quiescence()` calls `GenerateLegal` (`search.go:1664`) then `continue`s past non-captures out of check | **real NPS, do it** — a captures+promotions (+ check-evasions when in check) generator skips the quiet-move legality cost at the majority of nodes |
| Staged move generation (TT → captures → killers → quiets) | Not present — `scoreMoves` + lazy `selectMove` selection-sort over the full list | real but smaller than the qsearch fix; avoids *generating* quiets when a capture/killer cuts |
| VNNI int8 dot (`VPDPBUSD` x86 / `SDOT` arm64) via Plan9 asm | Not present — int8 path is `DotProductPairsSaturated`→`DotProductPairs` two-step (`archsimd` has no VNNI); `int8QA=127` exists *only* because of this (§16.4) | **do it** — one-instruction u8×i8→i32 accumulate, no pairwise saturation; also lets `QA=255` (2× activation resolution). This is the committed asm work |
| Missing SIMD kernels on some arch | `dotU8I8` scalar on **NEON**; `quantU8I16` scalar on AVX2+NEON; `screluActivateI16` scalar everywhere | real NPS on the int8 path — prod (AVX-512) partly covered, dev M3 (NEON) crippled on int8 |
| Lazy enriched accumulator | v6 lazy path was flat (§14.2); enriched `EnrichedStack` has no lazy path | speculative — enriched push is ~47% CPU, so even a small skip rate *might* pay; measure, don't assume |
| int8 base FT columns (currently int16) | threat columns already int8 (`W0t8`); base 768 still int16 (`W0i`) | **blocked on a QAT retrain** — out of scope for the no-retrain phase |
| Wider v6-style net (1024) / more-data | §7 names 1024 as the next width step | **blocked on training** — deferred; but every §26.3 NPS/asm win *discounts* its 3× eval cost, which is the point |
| SPSA on the ~20 hand-picked margins | §7 lists it | open, medium; not part of the NPS phase |
| SCReLU `(v·w)·v` reorder to stay in narrow regs | our `screluDot` widens to int32/int64 | micro; fold into the kernel rewrite if it helps a SIMD path |

Corrections to the external analysis worth recording: (a) it claimed **no** time management —
false as of `c63450a`; (b) it framed "go wider (1024, no threats)" vs "stay on threats" as the
fork, but our own §19/§21 already resolved that **the threat net wins at movetime and the wall
is the threat-PUSH speed, not eval quality** — which is exactly why the §26.3 NPS/asm work is
the right next move, not a net-architecture change.

### 26.3 The plan — no-retrain, NPS-first (every ns counts; a wider net inherits all of it)
Ordered cheapest-verifiable → hardest. **Two different tests, don't conflate them:**
- **Correctness** — a byte-identical (movegen) or bit-exact (kernel) change is *proven* safe by
  the differential/equality test. That's a proof, stronger than any SPRT sample — so it needs no
  *gate* SPRT (nothing to decide: it can't change results at equal work).
- **Elo magnitude** — the speedup is *invisible at fixed nodes* (same tree by construction, so a
  fixed-nodes SPRT reads exactly 0) but at **movetime** it deliberately diverges: faster → more
  nodes → deeper → stronger. That Elo is real and the way to measure it is a **movetime SPRT**
  (same as Lazy SMP, §4). So we DO movetime-SPRT pure-NPS wins — not to gate them (the proof
  already guarantees they can't hurt) but to **quantify and bank** the Elo. A behavioral change
  (e.g. QSCastling) is the opposite: the SPRT is the *gate*, because it can come back negative.

Caveat on *what's on the live path*: a movetime SPRT only measures a kernel that the default
eval actually calls. The VNNI `dotU8I8` isn't (default is `screluDot`), so it can't be
movetime-SPRT'd until the int8 net is default — that, not "bit-exact", is why it's unmeasured
now.

1. **Qsearch captures-only generator** — a `GenerateCaptures` (captures + promotions; full
   evasions when in check) path so qsearch stops paying for quiet-move legality. Gate: perft
   unaffected (movegen elsewhere unchanged) + identical qsearch node *scores* on a FEN suite +
   NPS before/after.
2. **Fill the scalar-fallback SIMD kernels** — NEON `dotU8I8`, AVX2/NEON `quantU8I16`,
   `screluActivateI16` everywhere. Gate: `TestKernelsMatchScalar` stays green (bit-exact) at
   all widths; NPS before/after per arch.
3. **int8 VNNI/SDOT dot in Plan9 asm** — `VPDPBUSD` (x86-64, named Go-asm op) and WORD-encoded
   `SDOT` (arm64); prior art `camdencheek/simd_blog`. Bit-exact to the current two-step, then
   (separately) evaluate `QA=127→255`. This is the flagged asm work — **we are doing it**.
4. **Staged move generation** in the main search — generate quiets only after TT/captures/
   killers fail to cut. Gate: perft + identical node counts on a suite (ordering must be
   preserved) + NPS.
5. **Lazy enriched accumulator** — measure the eval-less push rate for the enriched net first;
   only wire the skip if it's non-trivial.

Once the NPS/asm wins land, **re-anchor at movetime** (the §14.4 rule: speed shows at movetime,
not fixed nodes) and *then* revisit the 1024-wide net, whose 3× eval cost is now cheaper.

### 26.4 Landed so far (2026-07-03)

**(1) Qsearch captures-only — SHIPPED, +3–8% NPS, node-identical.** New
`Position.GenerateCaptures` (`internal/chess/movegen_captures.go`): a target-mask-restricted
clone of `generateLegalFast` emitting exactly the *noisy* subsequence (captures + push/capture
promotions + en passant + — by the isCapture-on-rook-square quirk — castling), in the SAME
emission order, so it's a **byte-identical subsequence of the filtered legal list**
(`movegen_captures_test.go` differential-tests it against `GenerateLegal` across every perft
tree + tricky FENs + 400 random games). Qsearch (`search.go`) uses it out of check; in check it
still calls `GenerateLegal` (every evasion needed). Because the searched move set is identical,
node counts are unchanged at fixed depth — pure NPS. Measured (fixed-depth-9 `BenchmarkSearch`,
scalar arm64): **startpos +3.0%, kiwipete +5.0%, endgame +8.4%** (endgame is qsearch-heaviest).
Scalar *understates* it — eval dominates each node there; on the SIMD build movegen is a bigger
share. `go vet`, `perft -depth 5`, all chess/search tests green on both arm64 and amd64/v4.
**Movetime SPRT (coalla, v4 SIMD, v6 net auto-loaded, 100 ms/move): +20 Elo** (`qcaps=on` vs
`qcaps=off`, ~+19–21 across the run, decisive). This is the load-bearing measurement: a
byte-identical-at-fixed-nodes change reads **exactly 0 at fixed nodes** (same tree), so its Elo
is only visible at movetime, where the extra nodes buy depth (same principle as Lazy SMP, §4).
The `QCaps` flag (`search.Params`, default-on) exists *only* to A/B it — the win itself is the
default. **This +20 IS the aggregate of everything the session ships** (VNNI is off the live
path; castling-drop was rejected), so there's no separate bigger aggregate number.

**(1b) Drop castling from qsearch — REJECTED.** Castling is a genuinely quiet move that only
slips into qsearch via the `isCapture`-on-rook-square quirk; `genCastling` cost ~3.5% of a
castling-rich search node in the profile. Tested behind `QSCastling` (`search.Params`,
default-on = castling searched = original behavior; off = dropped). Two SPRTs:
- **Fixed-nodes** `--new "qscastling=off" --old "qscastling=on"` trended **+10.7 ± 12** but
  **never crossed H1** — inconclusive (LLR ~+1.2), not a real accept, just a noisy positive lean.
- **Movetime** (the ruler for a speed-touching change, §26.3): **−8.1 ± 17.8** — non-positive.

So the two reads reconcile as **≈ neutral, faintly negative** — *not* the clean win the
fixed-nodes lean suggested — and dropping castling is **not shipped**. `QSCastling` stays
**default-on** (searching castling, the winning side); the flag is kept as harmless scaffolding.
Lesson: a fixed-nodes lean that never crosses H1 is not evidence; the movetime SPRT decides a
change that touches speed. (This is *also* why searching castling in qsearch turned out to be
~free/slightly-good, contra the "quiet move pollutes quiescence" prior.)

**(3) VNNI `VPDPBUSD` int8 dot — SHIPPED (amd64/v4), +18–22% on the int8 L1 matmul,
bit-exact, CPUID-gated.** Hand Plan9 asm (`dotu8i8_vnni_amd64.s`) replacing the archsimd
two-step `VPMADDUBSW`+`VPMADDWD` `dotU8I8` with a single `VPDPBUSD`. Installed by the AVX-512
backend's `init` **only when CPUID leaf-7 ECX bit 11 (AVX512_VNNI) is set** — `GOAMD64=v4`
mandates AVX-512F but *not* VNNI, so a Skylake-SP v4 box would `#UD` without the guard (both
coalla and prod lairner are Zen-4 EPYC 9634 with `avx512_vnni`). **Bit-identical to the maddubs
path on the operating domain**: activations are u8 ∈ [0,int8QA=127], so no maddubs pair can
saturate → both equal the exact int32 sum VPDPBUSD gives (`TestDotU8I8MatchScalar` is the gate;
it feeds a∈[0,127]). The one out-of-domain divergence (a=255 → maddubs clamps 64770→32767, VNNI
doesn't) is made backend-aware in `TestDotU8I8Consistency` and documented as harmless (a=255
can't occur).

- **The latency trap (the lesson).** A *naive* single-accumulator VPDPBUSD kernel was **~50%
  SLOWER** than maddubs (15.8 vs 9.2 ns @ n=512). VPDPBUSD *fuses* the accumulate, so `acc +=
  dp(...)` chains `acc` through the op's full ~4–5c latency; the archsimd maddubs wins with one
  accumulator because its multiply-reduce sits OFF the acc critical path (only a latency-1
  `VPADDD` chains). Fix = **4 independent accumulators**, 256 bytes/iter, so the loop runs
  throughput-bound. After that: n=512 **+22%**, n=1024 **+22%**, n=2048 **+18%** (coalla, Zen 4).
- **Scope.** `dotU8I8` is the L1 matmul of the **int8/enriched-int8 path** (opt-in, needs a QAT
  net), NOT the current default eval (which is the fused `screluDot`, already SIMD everywhere).
  So this is **banked for the int8/wider-net phase** — it's the inference speedup that makes a
  3×-cost wider net movetime-viable, exactly per §26 intent. `QA=127→255` (the activation-
  resolution bump VNNI unlocks) still needs a QAT config change + retrain — deferred.

**Not the current-prod hot path (verify-first correction to the external analysis).** The
analysis led with the missing SIMD kernels (`quantU8I16`/`screluActivateI16`/NEON `dotU8I8`)
and VNNI as prod NPS wins. Profiling the default eval showed the prod v9-lean hot kernel is
`screluDot` (already SIMD on all arches), and the flagged kernels are on the int8/float-tail
path that isn't the default and can't run without QAT. So items (2)/(3) are **future-net levers**
(correctly banked), while the current-prod NPS wins are the arch-independent search/movegen ones
— **(1) captures-only shipped (+20 movetime); (1b) castling-drop rejected; VNNI shipped but
banked; staged-movegen still pending.**

**Optimal config (shipped defaults, `search.DefaultParams`):** `QCaps=true` (captures-only),
`QSCastling=true` (search castling — the winning side), VNNI auto-on via CPUID. All three are
already the defaults; the SPRTs *confirmed* the shipped config rather than changing it.

---

## 27. Time-odds vs full-strength ("Unleashed") Stockfish — ⚠️ CORRECTED: the "~2× rule" was a COLD-Stockfish artifact (2026-07-03, corrected 2026-07-08)

> **⚠️ RETRACTED — READ §27.5 FIRST. The entire "~2× time-odds / equal-TC parity /
> ~70-Elo gap" story below was measured through the admin frontend Engine-vs-Engine
> view, which drives Stockfish via `server.handleStockfishMove` — a *fresh SF process
> every move* (empty 16 MB hash, no move history, cold). A controlled bench
> (§27.5) shows that cold-per-move spawn handicaps SF by ~235 Elo vs a warm,
> persistent, full-history SF. Against a WARM full-force SF at equal 100 ms TC,
> Gomachine scores ~12.5% (W0 D15 L45 / 60) ≈ −335 Elo — a rout, NOT parity. The
> "parity milestone" and "~2× rule" do not survive contact with a warm opponent.
> §27.1–27.4 are preserved as the (mistaken) record; do NOT quote them as current.**

**Original (now-retracted) one-line: mid-game, Gomachine needs only ≈ 2× Stockfish's movetime to beat
*full-strength, uncapped* SF — and at equal TC (100ms vs 100ms) it sometimes wins
outright.** This was the maintainer's eyeballed reference state from the frontend
Engine-vs-Engine view — which we now know pits Gomachine against a **cold-per-move
Stockfish** (§27.5), so the observation flatters Gomachine by *at least* ~235 Elo.

**The ratio has been dropping steadily** as the engine improves: ~3.7× (2026-07-03,
original measurement) → ~2× (long-standing, 200ms Gomachine reliably beats 100ms
SF) → **parity** (2026-07-08: 100ms Gomachine sometimes beats 100ms SF — not
reliably, but it's crossing the equal-TC line for the first time). This is a real
milestone: the engine no longer needs a time handicap to compete with full-force
Stockfish at blitz.

**"Full strength / Unleashed" = uncapped SF** (`elo=0`, no `UCI_Elo`/`Skill`
handicap — the top notch of the Engine-vs ruler, §20), i.e. the real
~4080-CCRL-Blitz monster, not a handicapped setting.

### 27.1 The empirical anchors (mid-game, maintainer observation)

| Full-strength SF movetime | Gomachine movetime | Result | Ratio |
|---|---|---|---|
| 20 ms | ~70 ms | roughly even | ~3.5× |
| 20 ms | 300 ms | **Gomachine rout** | — |
| 40 ms | ~80 ms | roughly even | ~2× |
| 60 ms | ~120 ms | roughly even | ~2× |
| 100 ms | 100 ms | **Gomachine sometimes wins** | **1× — parity!** |
| 100 ms | 200 ms | **Gomachine reliably wins** | 2× |

So: **Gomachine@(≈2 × T) reliably beats SF_full@T**, and at equal TC it crosses
into winning territory some of the time. The ratio has halved since the original
§27 measurement (~3.7× → ~2×), driven by the mirror KB net (§31), the v12 data
upgrade (§29), the §30 perf push, and the accumulated search-stack improvements.

### 27.2 What it means — the equal-time gap is TINY down here (~70 Elo, not ~500)

A constant ~2× ratio ⇒ at equal time SF is ahead by only `70 × log2(2) ≈ 70
Elo` (at the ~70-Elo/doubling blitz slope, §16.2) — and at parity (1×) the gap is
**~0 Elo at blitz movetimes**. That is **far below** the CCRL bands (SF 4080 vs
our 3400–3700, §20). Same two reasons as before, now confirmed by direct
observation:
- **Full-strength SF at tiny movetimes is disproportionately weak** — 20–100 ms
  is deep below any TC SF's 4080 was earned at; its scaling curve is steeper at
  the bottom, so it sheds Elo fast as the clock shrinks.
- **Our time-scaling is steeper than 70/doubling down here** — a good eval +
  heavy pruning cashes extra nodes into depth efficiently at short TC, and the
  accumulated improvements (mirror KB, v12 data, §30 perf, search stack) have
  pushed the crossover point all the way to equal TC.
Either way, the CCRL 4080-vs-3550 gap does **not** apply at blitz movetimes; the
measured ~0–70 Elo equal-time gap does.

### 27.3 Correction of record — do NOT extrapolate the CCRL band as a constant 70/doubling

Earlier in this conversation the first-instinct estimate was **"~3 s/move to beat SF@20 ms"**
— derived by plugging the CCRL band (ΔE ≈ 530) into `Tg = 20 ms × 2^(ΔE/70)`. **Wrong by ~40×:
300 ms already beats SF@20 ms hard.** The error was assuming (a) the equal-time gap is the full
CCRL band and (b) both engines share a flat 70-Elo/doubling slope down to 20 ms. Neither holds:
the gap collapses to ~130 Elo at these movetimes. **The `Tg = 20 ms × 2^(ΔE/70)` formula is only
as good as ΔE, and at tiny TC the right ΔE is ~130, not ~530.** For any near-future
"how much time does Gomachine need vs SF" question, **use the measured ~2× ratio**, not the
CCRL-band formula.

### 27.4 Caveats (so it isn't over-trusted either)
- **Eyeballed, not an SPRT/cutechess crossover sweep.** These are maintainer mid-game
  observations, directional and firm on the *ratio*, but the exact crossover ms are ±.
  A formal `bench vs-stockfish --full-strength` movetime sweep (SF pinned at fixed
  `movetime`, Gomachine swept until it brackets 50%) still owes the precise number and a
  check that ~2× holds as SF's clock grows (it likely *rises* — SF's curve steepens with
  time, so the ratio may widen at, say, 500 ms+ SF).
- **Mid-game specifically.** Endgames (TB/horizon, §10) and openings (book, §25) are separate
  regimes; the ratio is a middlegame read.
- **The ratio is a middlegame band, the point estimates are illustrative** — quote "≈2×
  SF's movetime to win reliably, sometimes wins at equal TC," not exact ms numbers.

### 27.5 CORRECTION OF RECORD — the frontend Stockfish is COLD-per-move; the ~2× rule dies (2026-07-08)

The §27.1–27.4 observations were all taken through the admin **Engine-vs-Engine** page, which
gets Stockfish's move from `server.handleStockfishMove`: it **spawns a brand-new Stockfish
process for every move**, feeds it only `position fen <current>` with **no move history**, and
searches with an **empty 16 MB hash** each time (`defer sf.Close()` — it's torn down after one
move). The honest bench harness (`bench vs-stockfish`) instead runs **one persistent SF per game**
with `ucinewgame` at the start, the full `position fen <open> moves …` history, and a **warm hash
that accumulates across the game**. Those are different-strength opponents.

**Controlled measurement** (coalla, `GOEXPERIMENT=simd GOAMD64=v4` build, KB net loaded, commit
`b80da65`; 60 games, **100 ms vs 100 ms**, full-strength/uncapped SF; the only variable flipped is
warm↔cold, via the new `bench vs-stockfish --sf-cold` flag that replicates the frontend spawn):

| Stockfish mode | Record (our POV) | Score | Elo diff |
|---|---|---|---|
| **Warm** (persistent, warm hash, full history — the honest bench) | **W0 D15 L45** | **12.5%** | **≈ −335** |
| **Cold** (fresh process/move, bare FEN, no history — the frontend path) | **W4 D35 L21** | **35.8%** | **≈ −102** |

**The cold-per-move spawn is worth ≈ 235 Elo of Stockfish strength.** At short TC the fresh process
loses its hash carryover *and* all game context, and the proportional hit at 100 ms is far larger
than the ~50–80 Elo one might guess for "clear hash each move." So:

- **There is no equal-TC parity.** Against a warm full-force SF at 100 ms Gomachine scores ~12.5%
  (0 wins in 60), ≈ −335 Elo. Even at **3× time-odds** (300 ms vs 100 ms warm — the maintainer's
  original bench) Gomachine still wins ~0 and mostly loses/draws. The "~2× ratio / ~70-Elo gap /
  parity milestone" of §27.1–27.4 were all reading the crippled cold opponent.
  **⚠️ CONTESTED (2026-07-09, §33):** a later two-machine warm run (lairner + coalla, efs28 net, many
  games) put warm full-strength SF at **~33% / −120**, not 12.5% / −335 — a ~215 Elo gap the +19 net
  can't explain. This −335 warm row is **under reconciliation** (SF thread/hash config unpinned, or a
  60-game low-sample read); see §33.1. Don't quote −335 as settled until a pinned-`--opp-opts` rerun resolves it.
- **The frontend is still MORE optimistic than the cold bench reproduces.** The cold run lands at
  35.8% (W4:L21 among decisives), but the maintainer eyeballs the live frontend closer to ~60:40
  W:L. So cold-per-move SF explains the *bulk* of the frontend-vs-bench gap but **not all of it** —
  a residual factor still flatters the frontend Gomachine, currently unquantified. Net: the frontend
  Engine-vs-Engine view overstates Gomachine by **at least** ~235 Elo and is **retired as a strength
  signal** — use `bench vs-stockfish` (warm, default) for any SF-relative read.

**What survives:** nothing about warm-SF strength was wrong in the bench — the bench was right all
along; the frontend was weakening the *opponent*. This does **not** touch the §20 CCRL v6 result (a
real external engine, not this cold path). It **does** delete "beats full-force SF at blitz" as
evidence for current strength, and makes the §28 re-anchor the *only* path to a defensible number.

---

## 28. The 3400–3700 band is a STALE FLOOR with a DEAD CEILING (2026-07-03) — re-anchor before quoting a number

The §20 band (3400–3700 CCRL Blitz, measured 2026-07-01) is stale **two independent ways**, and
neither is a matter of opinion:

**1. It predates ~25 Elo of shipped movetime patches.** Everything below landed *after* the band
was measured; **none of it is reflected in the 3400–3700 figure**:

| Patch | Gain | Ruler | Why it's real, post-band |
|---|---|---|---|
| §25 recompiled opening book | **+33** | fixed nodes | the HCE→v9 book left ~half the opening tree (44.6% of positions) playing the retired weaker engine's choices; a better book is monotonic Elo for *any* search (§25.2) |
| §26.4 qsearch captures-only | **+20** | movetime | byte-identical at fixed nodes → the Elo is only visible at movetime (extra nodes → depth) |
| §23 nmpgate + qsfut | **~+5** | movetime | combined-vs-shipped SPRT, sub-additive-honest |

That's **~+25 Elo at movetime** plus the book's fixed-nodes +33. Sub-additive per §13, so don't
literally sum — but the direction is unambiguously **up**, and *zero* of it is in the band.

**2. It was never triangulated, and the top of the band is stale.** Both §20 reference matches are
**opposite-direction blowouts** — 100–0 vs ~3400, ~0% vs ~3700 — so the band is a *bracket*, not a
measurement. And **the ~3700 loss is an OLD datapoint**: it predates the v9 threat-net movetime push
(§19/§22), the recompiled opening book (§25), and the nmpgate/qsfut + captures-only search patches
(§23/§26.4) — substantial movetime Elo the engine has gained since. So **~3700 is no longer a valid
ceiling**: it bounded an *earlier, weaker* gomachine and does not tell us where the current engine
tops out. The honest bracket is now **open-topped** — a conservative floor (>3400) with **no
established ceiling** (the true upper bound is unknown, and higher than that stale blowout implies).
The ~50% NNUE anchor that **§15.2 and §20 both flag** as the missing step was never run.

**Verdict:** the 3400–3700 band is a **stale floor with a dead ceiling**. The floor (>3400) still
holds as a conservative bound; the ~3700 top does **not** — it's an old blowout, and the engine has
gained materially since. True strength is **above the floor with no measured upper bound**, still
**untriangulated**. Do **not** quote an updated point number off it, and do **not** read 3700 as a
current ceiling. **Re-anchor against a ranked NNUE opponent — the old ~3450–3600 target is now too
weak; use a stronger one (~3700+) and let the score place us** (§15.5 rules: ranked, NNUE eval,
brackets us 40–65%), scoring ~50% before publishing any new figure. Until that match exists, the
only honest statement is: **"comfortably above the old floor, no valid ceiling, untriangulated —
re-anchor pending."**

(~~Consistent with §27: at short movetimes the effective gap to full-strength SF is only ~70 Elo /
a ~2× time-odds ratio — another sign the old CCRL band understates where we actually sit.~~
**RETRACTED — §27.5:** that "~70 Elo at short TC" was a cold-per-move frontend-Stockfish artifact;
vs a *warm* full-force SF the equal-100 ms gap is ~335 Elo. This line is **no longer** support for
"the band understates us" — the re-anchor is the only evidence that can move the number.)

## 29. v12 — the DATA lever wins: +24 movetime from a better teacher (2026-07-04)

**Result in one line: v12 (= v9's *exact* lean 512+threats config, retrained on test80-2024)
beats v9 by +24.0 ± 22.5 Elo @ 100ms/move (CI excludes 0, 176→250 pairs, coalla AVX-512).**
Same architecture, same node cost, same everything — **only the training data changed.** This is a
free movetime upgrade and the cleanest confirmation yet of the distillation-ceiling thesis (§16.5):
we are below the teacher's ceiling, so a stronger teacher cashes directly as Elo.

### 29.1 The data insight (the whole point)
The shipped v9 was trained on `pool.binpack` — a **37.5 GB Oct-2021 Stockfish-14-era distillation
binpack** (joost.vandevondele's set). **test80-2024 = Leela Chess Zero T80 self-play, rescored to
binpack** — a *stronger, more diverse* teacher; it's literally a component of the current SF recipe.
**Provenance correction (2026-07-08):** the score field is **Leela's own search eval** (Q→cp,
`--nnue-best-score`), NOT "modern-SF scores" — the lc0 "rescore" is **syzygy 7-piece TB on the
*outcome*** (Z), not an SF-search relabel of the score (`DATA_RECIPE_SF_2026.md:19–21`). So both
training targets (eval Q + result Z) are **Leela-grade**, from the same self-play — which is why
`ConstantWDL 0.6` (60% Z) is defensible: it sits near the top of the Leela-data band (result-weight
0.25 SF-on-Leela → 0.5 lczero-final), not the outlier it'd be against a deep-SF eval teacher. The
lower loss on the 2021 pool (0.0209 floor,
§12/Q3) was **weakness, not quality** — it fits easily *because* it's older/narrower/weaker-labeled.
test80's higher loss (~0.029 at 320sb) is expected and correct. **Cross-dataset loss is not
comparable; strength is the SPRT.**

### 29.2 What v12 is
`chessgo_lean_threats`, H=512, NB=8, single-layer + threats, int16 tail — **byte-identical config to
v9**, 320-sb cosine anneal, ConstantWDL 0.6, on test80. Trained on a rented GPU (~4h, saved
`data/nnue/v12.bin`, md5 `c26333e3…`; insurance `-240` checkpoint saved too). Prod default
(`loadEnrichedDefault`) already applies **int8-FT** (`QuantizeFTInt8`, bench.go:261) — so shipping v12
= swap `data/nnue/lean.bin → v12.bin`, nothing else. int8-FT cancels in the v12−v9 delta (same per-net
effect), so the +24 measured without it transfers to the prod config.

### 29.3 The flag sweep — nothing durable stacked on top (SPRT discipline lesson)
Hunted a movetime add-on on v12; **the engine's search is already tuned tight enough that nothing
survived.** All movetime @100ms, on v12 both sides:
- **capthist:** early +48/+68 @ ~15–40 pairs → **regressed to 0.0 ± 34 @ 184 games.** A textbook
  small-sample-noise false positive — do **not** trust <60-pair reads.
- **conthist:** **−47** (real drag; anti-synergy, poisoned the naive stack).
- **probcut / razor / negext / conthist2:** washes (−3…+6). probcut/razor confirm their §13 stack
  rejection holds *individually* at movetime too.
- **int8-FT:** +11…+28 on-v12 — but **already on in prod**, so not a new win.
- Naive stack (capthist+conthist+int8-FT): **−23 vs v12** — the classic stack anti-synergy.

### 29.4 Checkpoint: take-final confirmed
`-240` (near the running-loss minimum) vs `-320` (annealed final): **−56 Elo** — the final is
*stronger* despite its higher running loss. The center-minimum-then-tail-rise in the loss curve is a
**t/T-keyed optimizer/schedule artifact, benign for strength** (mechanism unresolved: NOT data
ordering — refuted by length-invariance, min at ~62–66% of T regardless of length; NOT WDL-lambda
ramp — our `ConstantWDL 0.6` is flat; leading suspects = Adam flat-basin wander + the ±1.98 QAT weight
clamp; bullet AdamW default `decay=0.01`; the wd=0 control run is the discriminator, unrun). **Rule
stands: take the final annealed checkpoint.**

### 29.5 Bottom line
The lever that paid this session was **data, not search and not width** (enriched-512 abandoned §6/
ARCH_DIRECTION; 512→1024 not a win at 32sb: −30 fixed-depth, ~parity movetime, 1.7× cost). **Ship v12
(+24 movetime). The next real gains are more/better data** (a 640-sb run on test80 — the loss was
still descending pre-anneal, so it likely had more to give — and eventually self-generated data, the
ceiling-breaker), not another flag.

## 30. Coalla SIMD single-thread NPS baseline (2026-07-06) — the anchor for the KB-net perf push

**Baseline: `605,009` NPS single-thread**, measured on **coalla** (AMD EPYC 9634, Zen 4; AVX-512 incl.
VNNI/GFNI, fast BMI2/PEXT) with the current **factorized-king-bucket net** (`data/nnue/lean.bin`, 44 MB,
`H=512 NB=8`, 16 king-buckets: `PsqSize=12288`, `ThreatBlock=9216`, `InputDim=21504`; no v6 fallback).
Build: `GOEXPERIMENT=simd GOAMD64=v4 ~/go/bin/go1.26.4`. Command:
`bench nps -baseonly -depth 20 -iters 10 -warmup 3 -lean data/nnue/lean.bin,512,8` (5.84M nodes, deterministic).
Endgame reference (depth 22): **~1.11M** NPS. This is the number to A/B every no-retrain perf patch against.

**Where the single thread goes** (CPU profile, `bench nps -baseonly -cpuprofile`, mid/endgame):
- **NNUE accumulator apply + readout ≈ 50% / 40%** — `EnrichedStack.Push`/`pushMoveAware`/`applyDelta`/
  `applyDiff` + the `addColI8SIMD`/`subColI8SIMD`/`addColSIMD`/`screluDotSIMD` kernels.
- **`buildAcc` from-scratch rebuild ≈ 10.9%** — and profiling showed it is **100% the king-bucket refresh
  path** (`buildSlotFrom`), doing a full *dual* rebuild on every bucket-crossing king move. This is the
  top no-retrain lever (§30.1).
- **`TT.probe` 9.7% / 12.1%** (single biggest flat — dependent-load stall), move-ordering
  `selectMove(Legacy)` 8.8% / 4.3%, threat feature-gen `computeDelta` ~10%, chess attacks/SEE + the
  accumulator `memmove` ~10–13%.

### 30.1 In-flight no-retrain perf work (measured against the 605k baseline)
Prioritised, all bit-exact / node-count-neutral unless tagged SPRT; each shipped behind a flag, A/B'd
via `bench nps` (identical node count = bit-exact gate) then a movetime SPRT on coalla:
1. **Split the king-bucket refresh** — rebuild only the *moving* side's half, delta the opponent half
   (its king bucket is unchanged). Targets the 10.9% `buildAcc`. Est **+4–7% NPS**. *(in progress)*
2. **Finny accumulator-refresh cache** — diff-update the moving-side rebuild from a cached
   `(persp, bucket)` accumulator. Est +2.5–4% on top of #1.
3. **Staged/lazy move ordering** — try the TT move before scoring the whole list (hash-move fail-highs
   currently pay a full SEE+contScore scan). Est +5–10% NPS.
4. **contScore dedup** (reuse the ordering history value in LMR/pruning), **screluDot zmm-widen**,
   **`see_ge` early-out**, **PEXT sliders** (Zen 4) — smaller bit-exact wins.
5. **Bucketed TT** (4 slots/64 B line) — strength lever (+5–15 Elo via hit-rate), SPRT-gated.

Fixed en route: `batchApply` used `off := InputDim` (768) as the threat boundary — wrong on a KB net
(threats start at `PsqSize=12288`) → crash; corrected to `off := PsqSize`.

### 30.2 Results — the no-retrain bit-exact perf push (2026-07-06)
All via `bench nps` (node count identical = bit-exact gate) on coalla, KB `lean.bin`. Ratios are the
reliable signal (interleaved medians cancel box drift); the absolute base wanders ±3% between runs.

**SHIPPED (bit-exact, default-on in the prod loader, committed on `perf/nnue-bitexact`):**
- **splitRefresh** (split KB refresh, only the moving half rebuilt): **+2.3%** isolated. `741d404`.
- **directApply** (re-bench of finding A4 on the KB net — the 43 KB counts array is now > L1, so skipping
  it wins where the pre-KB verdict said "noise"): **+2.5%** isolated. `741d404`.
- **screluDot 256→512-bit widen** (eval readout kernel, v4): **+2.0%**. `54d0271`.
- **qsearch SEE dedup** (`SEEReuseQS`, finding B4): reuse the SEE sign already encoded in the ordering
  score instead of recomputing `pos.SEE` in the qsearch prune (qsearch ≈ half the tree, SEE is
  `attackersTo`+magic-heavy). **+2.78%**, node-identical (1 574 334 both sides). Bit-exact because SEE is
  position-deterministic (no history/mutable-table coupling — the trap that killed #3/#4). Default-on.
- **PEXT slider attacks** (finding C2): replace the magic multiply-shift in `rookAttacksBB`/`bishopAttacksBB`
  with a `PEXTQ` asm stub + dense tables on amd64 (build-tag split; arm64/M3 stays on magic via `nopext`).
  **+2.37%** (581 642 vs magic 568 194, nodes identical, perft + exhaustive equiv green). Both prod boxes
  (coalla, lairner) are **EPYC 9634 / Zen 4** = 3-cycle hardware PEXT, so it's safe as the amd64 default.
  Tables are the same size as our fancy-magic — the win is purely dropping the `imul`+shift, not cache.
- **Combined shipped ≈ +11–12% single-thread NPS**, every config node-count-identical.

**MEASURED, ONE LATER SHIPPED:**
- **finny** (accumulator-refresh cache, option-a = cache the feature *list* + `applyDiff`): **WASH on
  2026-07-06** — 604 426 vs splitRefresh's 605 310 (−0.15%), node-identical; root cause: option-a still
  re-enumerates the current feature set (`appendEnrichedFeatures`) and only saves the column-sum, so after
  splitRefresh the residual moving-half rebuild is enumeration-bound. **RE-MEASURED +2.3% AND SHIPPED on
  2026-07-07** (§30.4): 3 interleaved reps `finny/splitRefresh` = +1.5/+3.3/+2.3%, all positive, still
  node-identical. The `enriched_acc`/`kingbucket` edits between the two dates made option-a pay (the cache
  now short-circuits enough of the refresh to clear the enumeration cost). Now `SetFinny(true)` in
  `loadDefaultLeanNet` (disjoint from `directApply`'s incremental path → additive). Lesson: a "wash" on one
  baseline is not permanent — re-bench the flag-gated scaffolds after the surrounding code moves.
- **prefetch / batchApply**: net-negative on the KB net (0.97–0.98) — the doc'd +17.6% prefetch number is
  **stale** (pre-KB); do not enable.
- **bucketed TT** (4 slots/64 B line, `TTBucketShift`, `20a4c0f`): **−5.8 ± 8.6 Elo** at 100 ms / 16 MB
  (902 pairs, LLR −2.15 → H0). NOT a NPS win — it *costs* probe NPS (scan 4 slots on the #1 hot function)
  to buy TT retention it can't cash at blitz/low-pressure. Kept flag-gated default-off; only a
  long-movetime / high-pressure (CCRL) build could flip it — untested, deferred. Contrast the shipped
  levers, which are pure bit-exact NPS (identical nodes) and so can't lose.

**DROPPED (not bit-exact — search-ordering reads globally-mutated history/conthist/killers):**
- **staged TT-first ordering** (#3) and **contScore reuse** (#4): both perturb move order → node counts
  diverge. Only viable as SPRT-gated tree changes, not free speed. Parked.

**Multi-thread anchor (rough):** aggregate NPS scales ~9.6× at 12 threads (~3.8M), tapering past 8
(per-core 605K→320K, memory-bandwidth bound). Prod runs 2 threads, in the near-linear region.

### 30.3 Why the accumulator-kernel well is dry on amd64 — *measured*, not asserted (2026-07-07)

Re-run at HEAD `b5ac57e` (coalla, KB `lean.bin`, `bench nps -depth 18 -iters 12`, node-exact
1 574 334 both sides). The §30.2 "net-negative, don't enable" verdicts on batch/prefetch were
correct but had **no mechanism** behind them. This pins it down and the mechanism generalises:
*any* memory-traffic-reducing kernel rewrite (batch, fuse, lazy-apply) is dead on this arch.

**Refreshed A/B (interleaved ratios vs prod base 549 830 NPS):**
`prefetch` 0.978 · `batchApply` **0.9999** · `directApply` 1.008 · `splitRefresh` **1.043** · `finny` **1.055**.
(batchApply is now a *wash* whole-engine, not the §30.2 0.97 — the AVX-512 `applyThreatBatchSIMD`
widened to 32-lane since. `finny` re-measures **+1.1% over splitRefresh** here, contradicting the
§30.2 wash — either the intervening `enriched_acc`/`kingbucket` edits helped option-a or it's
run-noise. **CONFIRMED +2.3% and SHIPPED** (§30.4): a dedicated high-iteration run, 3 interleaved reps
`finny/splitRefresh` = +1.5/+3.3/+2.3%, all positive → `SetFinny(true)` in `loadDefaultLeanNet`.)

### 30.4 finny confirmed + shipped (2026-07-07) — the post-kernel lever sweep's one win

A full post-kernel NPS lever sweep (`docs/PROFILING/amd/6Jul2026.md` "NPS lever sweep") tried every
remaining eval/search speed lever under the uop-throughput-bound framing; **all measured ≤0 except
finny**: batchApply (−6%/wash), the base/threat feature **partition** (−2.5% — trades a per-feature
branch for append bookkeeping, net more uops on the retirement-bound path), **BCE** kernel hoists
(−1.5%/neutral — Go's predicted bounds-check branches issue on integer ports off the vector-bound
critical path, so removing them frees nothing; verified against the disassembly), **staged movegen**
(−2.5% — the node-neutral selection-scan slice; true staging isn't node-neutral here because move
ordering reads *global* history tables that mutate mid-search), and **TT child-prefetch** (killed by
the gate: search is branch-miss-bound, not TT/LLC-bound). **finny** re-benched **+2.3%** (above) and
shipped. Instruction-level tail: `objdump` confirms `archsimd` emits optimal kernel code (clean
5-op loop, no spills) — no hand-asm headroom. **Conclusion: the pre-retrain NPS well is dry; the
~280 Elo is in the data retrain, not movetime.**

**The decisive new datapoint — an *isolated* amd64 kernel A/B.** The existing microbench
(`batchapply_bench_test.go`) is `//go:build …&& arm64` — so no isolated amd64 kernel number ever
existed, only whole-engine NPS. Added `batchapply_amd64_bench_test.go` (amd64 twin: `applyThreatBatchSIMD`
one-load/store-per-32-lane-block vs the sequential `addColI8SIMD` per-column path, same K columns → identical acc):

| K (features/move) | Seq (per-column) | Batch (one pass) | Δ |
|---|---|---|---|
| 20 | ~337 ns | ~380 ns | **Batch +13% slower** |
| 40 | ~666 ns | ~730 ns | **Batch +10% slower** |

Batch does **fewer** acc load/stores yet **loses** → loads were never the bottleneck. `perf stat`
(K40, `perf_event_paranoid=1`) confirms the resource: both **L1-resident** (L1-dcache miss 1.5% Seq /
0.2% Batch, LLC `cache-misses`=0) and running at **5.5–5.9 IPC** — at Zen 4's ~6-wide retirement
ceiling. Batch trades 3.3B (free, L1-resident) loads for ~7B *more* index-math instructions
(`(f-off)*h` + bounds per feature per block); at peak IPC total-uop-throughput is the binding
constraint, so the trade loses.

**Conclusion:** the amd64 accumulator apply is **compute/throughput-bound, L1-resident, near-peak
IPC — NOT memory-bound.** Halving memory traffic optimises a non-bottleneck. This *refutes* the
standing "a leaner fused kernel could still win" hypothesis on amd64: fusion's only lever is fewer
loads, loads aren't the constraint, and any fused variant still pays the index uops. Kernel-level
speed (batch / fuse / lazy-apply) is **structurally dead on the shipping arch** — the only
arch-transferable eval-speed lever left is **fewer features-per-move** (algorithmic; helps both
arches, and is the switch that could revive lazy), and the real Elo is in the data retrain
(Elo-per-node), which this profile cannot see. cf. [[arm64-vs-amd64-speed-divergence]].

**Note:** arm64/M3 profiles make `addColI8SIMD` look like a fat concentrated ~20%-flat target and
batch wins +50% there — that concentration is an arm64 artifact (weaker/narrower vector units vs
its huge L1 + HW prefetch). On amd64 the same kernel is spread + L1-resident + near-peak IPC. Never
conclude an eval-kernel win from arm64 alone.

## 32. efs28 + 640-sb data-pipeline retrain — **+19 movetime, SHIPPED** (2026-07-09)

**Result in one line: the mirror-KB arch retrained on the FIXED data pipeline beats the prod
`kb-mirror` net by +18.8 ± 13.8 Elo @ 100ms/move** (443 pairs, W199 L151 D536, LLR +1.64, CI lower
bound **+5.0**, coalla movetime SPRT[0,5], tt=64, int8-FT + move-aware both sides). Accepted on a
stable-positive lower bound over a 400+-pair sample (not a low-pair spike) and file-swap shipped.

### 32.1 What changed (vs kb-mirror: ply≥16 / 320-sb / ConstantWDL 0.6)
Two pipeline knobs, arch byte-identical:
- **early-fen-skipping `ply≥16 → ply≥28`** — SF master-net cutoff (`nn-60fa44e376d9`, PR #4314). The
  "single biggest lever" in the recipe audit: opening positions are book-driven, near-equal, and
  massively over-represented, so a fixed training budget spent on them is wasted; skipping them
  reallocates capacity to decisive midd/endgames. The loader already did smart-fen-skipping
  (capture/promo best-move drop) — efs28 stacks on it.
- **superbatches `320 → 640`** — v12's 320 loss was still descending pre-anneal.
- **WDL kept `ConstantWDL 0.6`** — settled by a two-AI debate (§ retrain-efs28-wdlanneal.md): the
  test80 eval field is **Leela's own search eval** (Q→cp), NOT a deep-SF relabel (the lc0 "rescore"
  is syzygy-TB on the *outcome* Z only — §29.1 corrected). Both targets are Leela-grade, so the
  optimum sits mid-band (result-weight 0.25 SF-on-Leela → 0.5 lczero-final); 0.6 is a hair above,
  not the 2.4×-SF outlier it looks like against a deep-SF teacher. A blind drop to 0.4 was rejected
  as an overcorrection; the WDL anneal is deferred to its own single-variable run.

### 32.2 Net + provenance
`chessgo_efs28_wdl06_640`, 44 MB (md5 `92294de3…`), H=512 NB=8 mirror-KB + threats. Trained on a
rented vast RTX 4090 (~7.5h for 640 sb; slowed mid-run by shared-host CPU contention — GPU never
throttled). Final running loss 0.02646 (the benign §29.4 center-min-then-tail-rise; final annealed
`-640` taken per rule, `-560` saved as insurance). Ships by file-swap over `data/nnue/kb-mirror.bin`
(no code change — `loadEnrichedDefault` applies int8-FT + move-aware automatically).

### 32.3 Notes
- **`--new-lean` forces concurrency 1** (the NNUE net is a process global), so the SPRT ran one game
  at a time (~130 pairs/hr) — accepted on trend at 443 pairs rather than waiting for the formal
  LLR=+2.9 cross. Lower bound was stably positive (+3.0 @ 338 → +5.0 @ 437).
- Lesson reaffirmed: our hand-set data-pipeline defaults go stale as the engine evolves; the recipe
  audit (`docs/NNUE/DATA_RECIPE_SF_2026.md`) cashed directly as movetime Elo, same as v12's data win.
- Found+guarded a pre-existing panic: illegal FENs (side-not-to-move in check) fed to the raw `uci`
  entry crash the search (king-capture → empty king bitboard → index 64). Prod entries (server/hub/
  bots) already guard with `pos.Legal()`; only `uci` handleGo didn't — now guarded (`internal/uci`).

## 33. Warm-SF gauntlet on the efs28 net — −120/−140 Elo at 100/100 ms, two-machine agreement (2026-07-09)

**gomachine (efs28 net) scores ~31–35% vs full-strength WARM Stockfish at 100 ms/100 ms — a
head-to-head of −120 to −140 Elo — measured independently on lairner AND coalla over many games,
both boxes converging on the same band.** Warm = the honest bench path (persistent SF, warm hash,
full move history; NOT `--sf-cold`), confirmed by the maintainer. The cross-machine agreement is the
strongest part: it rules out a single-box config fluke. Also added `bench vs-stockfish --save-wins
<dir>` (PGN per won game) so these wins can actually be reviewed, not just counted.

### 33.1 Open reconciliation with §27.5 — flagged, NOT resolved
§27.5 (2026-07-08, coalla, `b80da65`, 60 games) put warm full-strength SF at **12.5% / −335**. This
is **~33% / −120** warm — a **~215 Elo swing** under the same nominal "warm full-strength 100/100,"
on (among others) the same coalla box. The efs28 net gained only **+19**, so the net does NOT explain
it. Candidates: (a) §27.5's 60-game **W0 was a low-sample/unlucky read**; (b) an **SF-config
difference** — `--opp-opts` Threads/Hash: SF's 100 ms strength swings hugely with both, and
"full-strength" pins *skill*, not threads/hash, so the two runs may have faced different-strength warm
SFs; (c) a real change in the warm bench path across the 18 commits since `b80da65`. **A single
warm-vs-warm run with pinned `--opp-opts` + matched net on both boxes settles which** (~20 min on
coalla). Until then §27.5's −335 and this −120 are treated as measured against **possibly
different-strength warm SFs** — do not silently overwrite one with the other.

### 33.2 The absolute stays pending (§28 holds)
−120/−140 is a solid, reproducible **relative** diff. Mapping it to "≈3780–3980" assumes warm SF at
100 ms ≈ 3900–4100 — but that band is SF's **long-TC / many-thread CCRL** rating, NOT its **100 ms /
few-thread** strength (materially lower). So:
- **Quote:** "≈ −120 to −140 Elo vs warm full-strength Stockfish at 100/100 ms, agreed across lairner + coalla."
- **Do NOT** convert it to a point Elo (≈3900) — that pins our number to SF's wrong-TC rating, the exact
  §28 trap. A CCRL-rated NNUE opponent (Stash/Viridithas/Starzix, `--full-strength --sf-elo <its real CCRL>`)
  remains the only defensible absolute.

**Net:** the most encouraging warm-SF read to date and reproducible across two machines — a real signal
the efs28 engine is strong. The absolute waits on a proper anchor; the §27.5 gap wants one clean run.

## 34. Long-run direction: the SF-grade DATA PIPELINE is our biggest untapped lever — a TWO-TRACK program (2026-07-10)

**Source:** user pulled the *current* SF pipeline (SFNNv10+ `threats.yaml`, PRs #4295/#4314, the nnue-pytorch
wiki, linrock's `relabel-BT4-tf13tune` nets). Extends `docs/NNUE/DATA_RECIPE_SF_2026.md` (the *recipe*) with the
*strategy* — what to build, in what order, and the honest ceiling. Prompted by the "for-fun" `-352` mid-checkpoint
SPRTs (a NAIVELY-trained net read −124 MT / −140 FN vs prod-lean, un-annealed): our nets are built by a **naive
pipeline** (one source, one stage, constant lambda, no rescore, no relabel, 4 raw months), so **most of our
remaining Elo is pipeline *maturity*, not architecture.** We have been polishing width/tail while training on ~10%
of the field's data breadth.

### 34.1 The scale gap — we're undertrained AND under-diversified
- **Us:** ~100M pos/superbatch (≈ one nnue-pytorch "epoch"), 640 sb ⇒ ~640 epoch-equiv, on **test80 Jan–Apr 2024 ONLY**.
- **SF from-scratch:** ~4 stages, **~3,800–4,800 epoch-equiv** (est), on **~3 years** of Leela (test60→test80-2024-**06**)
  INTERLEAVED with SF self-play (`dfrc_n5000`), TB positions (`tb5dtm.binpack`), UHO book — with much of the OLD data
  **relabeled with BT4** (a stronger later Leela net, `relabel-BT4-tf13tune`), syzygy-rescored + deduped.
- ⇒ we're at **~15% of SF's training VOLUME on ~10% of its data DIVERSITY**. **The compute is NOT the constraint:**
  SF-scale volume is only **~72–90 GPU-hours on the 4090 (~$25–32)**. The constraint is **pipeline engineering.**
  (Volume/epoch figures are user estimates from the PRs/wiki — order-of-magnitude, not exact.)

### 34.2 The levers, ranked (evidence-backed; detail in DATA_RECIPE_SF_2026.md)
1. **Data breadth + syzygy rescore + MULTI-SOURCE.** The wiki finding "training *solely* on Lc0 data is worse" —
   **we violate it.** SF-generated / DFRC data at λ=1.0 gives broad off-distribution positions that regularize
   pretraining before specializing on Leela. Cheapest high-EV fix (pull community `dfrc_n5000`/UHO, or generate our
   own gomachine self-play for breadth). Rescore = 6/7-piece syzygy during conversion (endgame label upgrade).
2. **Lambda schedule** (SF anneals eval-weight 1.0→0.7–0.75). Most evidence-backed knob we're NOT turning — **but
   COUPLED to relabeling, see §34.3.** Don't blind-copy 0.7.
3. **Early-fen skipping across stages** (SF ramps 12→24→27/28; we run ply≥28 flat — already have the biggest single
   piece, per DATA_RECIPE lever #1).
4. **Multi-stage CURRICULUM** — the real structural unlock, not a knob: broad+SF-gen @ λ=1.0 → high-quality Leela →
   fine-tune relabeled, with per-stage LR/lambda/fen-skip.
5. **Filtering** (depth-N multipv capture-drop, PR #4295/#4314) — real but ~5-Elo-range; do LAST.

### 34.3 ⚠ The lambda↔relabel COUPLING (nuance — do NOT just copy SF's 0.7)
SF runs eval-heavy (λ 1.0→0.7 = 70%+ eval) **because they relabel with BT4** — distilling a strong, clean net, not
raw self-play Q. Our `ConstantWDL 0.6` (bullet convention = **60% RESULT**, far more result-heavy than SF's *end*
state) was deliberately calibrated by the §32 two-AI debate to **noisy, un-relabeled test80-Q.** Pushing toward SF's
eval-heavy end on our RAW labels risks **fitting Leela's noise harder** — exactly what 0.6 hedges. **Sequence:
relabel (or a deeper teacher) FIRST, THEN go eval-heavy — or run lambda-anneal as a true single-variable SPRT.**
They rise together; 0.7 does not transfer to raw labels.

### 34.4 The phased roadmap (each phase gated on a ≥250-pair movetime SPRT vs current best)
- **Phase 1** (~1 wk, mostly data work + one ~12 h run): expand to **test80 2023-01 → 2024-06** + **6-piece syzygy
  rescore** + dedup + ply≤28 at load. Same 640 sb. Measure. *(Highest-EV, matches our own "data is the live lever".)*
- **Phase 2** (24–48 h GPU): same data, **1,280–2,560 sb**, stretched LR. **Rides on Phase 1** — 4× on the same 4
  months just overfits; length pays only once the data is broad enough to hold that much signal.
- **Phase 3** (biggest expected jump if not done): **lambda anneal 1.0→0.7**, two-stage (broad λ=1.0 → recent
  λ=0.7). Measure per stage. Heed §34.3.
- **Phase 4** (later): **relabel** the data with our best net once it clearly beats the labels (BT4-style). Not before.
- **Prereq infra:** make `internal/tune` + the bullet recipe **STAGE-AWARE** (ordered stages, per-stage
  LR/lambda/fen-skip) — one engineering task that unblocks Phases 1–4.

### 34.5 The honest ceiling — the TWO-TRACK thesis (the actual long-run answer)
Matching SF's *net* pipeline closes maybe **HALF** the gap. SF total strength = **net × search × ~a decade of
fishtest-tuned search params** — and that half comes from no dataset.
- **Track A (net):** the pipeline above — reachable, cheap-ish, mostly engineering + a few hundred GPU-hrs. **Move
  fast here.**
- **Track B (search):** SPSA/margin re-tuning (the §31-era +38.7 was real, well NOT dry), NPS/kernels, selective
  search patches. **Slow** — accumulated SPRT volume we can't shortcut, only grind (SF got it from a decade of
  fishtest we can't replay).
- **Verdict:** the net track can take a big bite (the "<200 on the AVX-512 box" goal is plausible net-side); **full
  parity needs Track B sustained.** The trap: nail Track A, think we're done — a great net on under-tuned search
  leaves Elo on the floor, the same shape as a great eval eaten by node cost.

### 34.6 Immediate implication
Finish + measure `-640` — it answers the **arch** question (is the multilayer tail worth it), a clean *separate*
axis. But the **next program after it is NOT width or the asm-tail**; it's **standing up the stage-aware,
multi-source, syzygy-rescored, lambda-annealed pipeline** (§34.4). That is the SF-shaped path, and it's where the
hundreds of Elo we're missing actually live.

## 35. Step-B result: the 512 multilayer-tail net (`chessgo_ml_efs28`, 640-sb) — **+22 movetime, SHIPS** (2026-07-10)

> **⚠️ SUPERSEDED 2026-07-11 → prod is now the SF full-threats net** (`chessgo_threats_sf_640`,
> `data/nnue/kb-mirror.bin`, +10 over efs28). This supersedes BOTH the efs28 net (§32) and this
> multilayer ml640 net: the "+22 ship" below was later found ≈lean and **did not remain prod**.
> Kept here as history.

The step-B multilayer net trained (640 sb on test80 Jan–Apr, efs28 inputs + pairwise-CReLU→L1(16)→L2(32)→out int8
tail, QAT). Measured on coalla (SIMD, `main` binary, conc=1) vs the shipped prod-lean net (`data/nnue/kb-mirror.bin`).

### 35.1 Results
| SPRT | Elo | pairs | note |
|---|---|---|---|
| **MT `-640` vs prod-lean** (movetime 100ms) | **+21.9 ± 16.9, LB +5.0** | 300 | **WIN — ships** |
| FN `-640` vs prod-lean (fixed 40k nodes) | −9.8 ± 19.0 | 300 | wash / marginally negative |
| MT `-560` vs prod-lean (movetime 100ms) | +0.7 ± 13.1 | ~300 | wash |
| anneal `-640` vs `-560` (movetime, `--old-enriched`) | −36.3 ± 19.6 | 200 | **ANOMALOUS — discard, see §35.3** |

### 35.2 The headline: a MOVETIME win at fixed-nodes parity
`-640` **beats prod-lean by +22 Elo at movetime (LB +5, stably positive) — but is a wash at fixed nodes (−10).**
Because **MT > FN**, the win is NOT eval-per-node quality (there it's ~parity); it's a **real-time-control edge**
(the multilayer net reaches effectively better play in 100 ms — a speed / search-depth interaction that the equal-
node FN test hides). This also means the earlier "tail cost ≈ 0" mid-checkpoint read was right that cost isn't the
story — but the *direction* flipped: the net is actually *stronger* at movetime than at fixed nodes, not equal.
**The anneal swing from the un-annealed valley was huge** (FN −140 at mid `-352` → −10 at `-640`, ~+130) —
confirming the anneal-trap thesis emphatically; the mid-checkpoint pessimism (§ the −124/−173 "for-fun" reads) was
entirely the un-annealed valley, exactly as predicted.

### 35.3 ⚠️ The `-560` over-anneal red herring + the transitivity lesson
The anneal SPRT read `-640` vs `-560` = **−36** (implying `-560` was +36 *better* — an "over-anneal" story). But the
two **direct vs-prod** SPRTs contradict it: `-640` = +22, `-560` = +0.7, so `-640` is **+21 better** than `-560`,
NOT −36. A ~57-Elo inconsistency. The odd one out is the anneal run — the only one using the **two-multilayer
`--new-enriched`/`--old-enriched` per-side swap on coalla's PRE-concurrency-refactor `main` binary** (the exact
fragility the branch `nnue-int8-tail-then-width` refactor removes). **Treat the −36 as a harness artifact; trust the
direct vs-prod reads.** *So `-640` (final annealed) IS the ship candidate — the normal "ship the annealed final"
rule holds; there was no real over-anneal.*
**Lesson:** measure each ship candidate **directly vs prod**; do NOT infer strength through transitive chains across
intermediate nets — especially two-multilayer swaps on the pre-refactor binary. Re-run `-640` vs `-560` with the
refactor binary (conc>1, per-Searcher net) to confirm the −36 vanishes. (Verifying `-560` directly instead of
trusting the +58 transitive inference is what caught this.)

### 35.4 SHIP
**Ship `-640`** by file-swap: `data/nnue/kb-mirror.bin` → the `-640` net (local `gomachine/data/nnue/ml640.bin`,
also on coalla; md5 `e7f524093727dace72c5ce9288fd8d7d`, 44,323,392 bytes). The prod loader (§4A `loadDefaultKBNet`)
**auto-detects the multilayer arch by size** and applies the `--enriched-int8` config — **no code change**. NOT
auto-deployed here — user pulls the trigger. Full `-640`/`-560` checkpoints (weights + optimiser) preserved on
coalla `~/chessgo-nnue-backup`; training log local.

### 35.5 Retrospective + next
- **Multilayer arch: a modest movetime win (+22).** Worth shipping, but small — it did NOT unlock a big gain, and
  it's ~parity on eval-per-node. `ConstantWDL 0.6` + single-source test80-Jan-Apr were fine for this run (not the
  bottleneck). The int8 dense tail is cheap (no sparse/asm needed — MT≥FN, no cost gap).
- **The bigger lever is still §34** — the SF-grade data pipeline (breadth + syzygy-rescore + multi-source +
  lambda-anneal + multi-stage). +22 from an arch change is small next to the pipeline's headroom.
- **Bet (FN/MT wager, me FN+30/MT+5 vs user FN+80/MT+30):** FN = −9.8 → **both missed** (over-predicted the eval
  gain). MT = +21.9 → **user wins** (+30 within CI; my +5 was exactly the lower bound — lowballed). **User takes the
  bet** on the MT leg. The lesson we both under-weighted: an FN-wash net can still be a clear movetime win.
- **Next:** ship `-640`; adopt "SPRT several late checkpoints (e.g. −560/−600/−640) directly vs prod, not just the
  final" for future runs (cheap insurance against a genuine over-anneal); use the refactor binary for net-vs-net
  SPRTs; then pursue §34.

## 36. THE METHODOLOGY LESSON: self-play SPRT gates, Abitur decides — and the full-threats regression that proved it (2026-07-11)

**Ground truth (owner-confirmed, identical method throughout):** the full-threats net
`chessgo_threats_sf_640` scored **+10 Elo vs efs28 in self-play SPRT** but **draws/loses
vs cold Stockfish** — the same cold SF that **efs28 beat ~90%**. Same search, same
movetime, only the net changed. This is the canonical failure mode this doc has warned
about since §1, now caught in the act.

### 36.1 Why self-play SPRT could not see it
Self-play SPRT measures strength **relative to your sparring partner** (the previous
gomachine). Chess strength is **non-transitive**: `B beats A`, `A beats SF`, `SF beats B`
is a fully self-consistent cycle. "+10 vs the last net" has **never** meant "stronger
against everyone." A ~300-Elo swing vs a third party while only +10 vs A is far more
non-transitivity than benign style-cycling — it signals a **systematic eval distortion**
that both gomachines share (so self-play is blind) but a strong external engine punishes.

### 36.2 What we RULED OUT by measurement (so the process is repeatable, not vibes)
- **Not speed.** `bench nps-ft`, same tool/box/session, depth 16: coalla **461k
  (full-threats) vs 469.6k (efs28), −1.75%**; M3 **213k vs 212k, +0.6%**. The
  79,856-col threat FT is ~free (only ~70–112 cols touched per push; int16 costs
  1.5–3% over int8). `docs/PROFILING/{amd,arm}/11Jul2026.md`. **NOTE:** the 9 Jul
  baseline (537k/573k) was a `bench nps` LEAN-loader number — NOT comparable to the
  enriched net; always re-measure the before-net with the SAME enriched tool.
- **Not deployment quantization.** `TestEnrichedInt8Closeness` on the real net: int8
  tail vs float **mean 8.7 cp / max 31 cp** (PASS); int16 threat-FT = zero clamp loss.
  Deployed net ≈ trained float net.
- **Not king-bucket/mirror/Finny** (bit-exact, pinned to the Rust trainer) **nor int16
  overflow** (accumulator range [−3016, +2894], 9× headroom).

### 36.3 Live suspects (see `docs/open_tasks/fullthreats-vs-sf-regression.md`)
- **H1 (top): Go threat-feature inference ≠ the Rust trainer.** `threats_sf.go:175`
  same-type-edge dedup + the mir=0 path are **never pinned** against the trainer (both
  green cross-check FENs have zero same-type non-pawn edges). A wrong directed edge →
  weights applied to the wrong feature → self-play-invisible bias, SF-punished,
  **8.7× more load-bearing in full-threats** than efs28's coarse block. Decisive test:
  Rust `cross_check_dump` vs the Go dump on a rook-standoff position.
- **H2: threat overvaluation / eval noise** (full-threats needed 2× the nodes to reach
  depth 16 on the test FEN → possibly shallower at movetime). Needs a suite.

### 36.4 THE RULE (now in CLAUDE.md)
1. **SPRT filters, Abitur decides.** Self-play SPRT stays the cheap first pass, but the
   **ship gate for any NET / eval / margin change is `gomachine bench abitur`** — the
   external multi-engine gauntlet (`docs/ABITUR.md`). A change that is +N in self-play
   but flat-or-worse in Abitur does **not** ship.
2. **Be smart with Abitur — don't read Elo off a 100L rail.** Every engine from 0 to
   3400 Elo loses ~100/100 to a 3500 engine, so a full-strength-SF-at-equal-TC score of
   0% estimates **nothing**. Use the **time-odds ladder** (ABITUR.md's core rationale):
   give gomachine a movetime advantage to land both nets in a scoreable band
   (~[15%,85%]), read the **before/after** there, then walk the odds down toward parity.
   Triangulate across ≥2 opponents/strengths (Stockfish + Stormphrax/Reckless, and
   several UCI_Elo/skill points), never a single anchor.
3. **Always re-measure the before-net with the identical enriched tool** — cross-tool
   comparisons (lean-loader vs enriched, cold vs warm SF) silently mislead.

### 36.5 Harness state
`bench abitur` now streams **live per-pair progress** (running W/D/L + pentanomial Elo
estimate) so a long match is observable, not silent until it finishes; the driver
line-buffers for live `tail -f`. An old-vs-new time-odds ladder vs SF18 (full-strength,
UCI_Elo 2800, 2400) is the first application — results pending.
