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

**Latest reading (2026-06-29, CCRL Blitz anchor — this is now the headline strength
figure, superseding the SF-UCI_Elo number):** **≈3260 "dirty" CCRL Blitz.** Measured by
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

Current strength: **≈3260 "dirty" CCRL Blitz** (2026-06-29, §15) — anchored against
full-strength, officially-CCRL-rated **NNUE** opponents at 100 ms/move (Starzix 5.0
**3276 ± 83** / Viridithas 17.0.0 **3245 ± 94**, pooled **≈3260**). This is the headline
strength figure, **superseding** the old SF-UCI_Elo "~2880-class" reading — which wasn't
wrong, just on a ~390-lower scale (2882 + ~390 ≈ 3270, §15). For reference the SF-UCI_Elo
anchor read **≈2882** (band 2847–2935 vs SF-2700/2800/2900, 2026-06-22, §2.2); the
**trustworthy relative** figure remains the self-play SPRT (**+212 ± 49 vs HCE @
movetime**, §11), not any absolute anchor. Full-strength Stockfish 17.1 (**~4080 CCRL
Blitz**) is still **~800 CCRL above us** — the NNUE width/data levers (§11.4) are how
that gap narrows.

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

## 15. CCRL Blitz anchor (2026-06-29) — ≈3260 "dirty", replacing the SF-UCI_Elo number

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
