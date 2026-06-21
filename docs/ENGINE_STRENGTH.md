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
- **Fixed nodes** (`--nodes`) → reproducible, hardware-independent. (Use
  `--movetime` only for time-dependent features like Lazy SMP, §4.)
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

**Latest reading (2026-06-19, post-tuned-eval):** **≈2720 ± 79** — 100 games vs
**SF-17.1 @ UCI_Elo 2500**, scoring **78%** (W75 D6 L19, +220 head-to-head). Up
from ~2600 before the tuned eval; the anchor's ~+90 jump independently
corroborates the eval's +101-Elo movetime SPRT (§5).

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
   the honest real-world check.

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
| Remaining search patches | +50–80 | low | futility, countermove, singular ext, TT-static-eval |
| **NNUE** (learned non-linear eval) | **+172 @ nodes, −156 @ movetime today** | high | net **beats HCE per node** (bullet on Metal, §11) but the non-incremental float eval is ~20–80× costlier/node → loses at movetime; **blocked on the incremental accumulator** (Phase 4), not on net quality |
| SPSA (Elo-in-the-loop weight tuning) | modest | medium | the *correct* way to tune the few params with no static objective |

Current strength: **≈2782 ± 84** on Stockfish's UCI_Elo scale (100 games vs
SF-17.1 @ UCI_Elo 2500, **83.5%**, +282 head-to-head, `tb=on`), up from ~2720
pre-TB (within the anchor's noise — the +18.8 movetime SPRT is the real figure for
the tablebase; see §9). The anchor is noisy: a band, not a number; sweep `--sf-elo`
to triangulate, and gate patches on SPRT. Full-strength Stockfish 17.1/18
(~3650 CCRL) is still ~870 Elo above us — that gap needs NNUE.

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

## 11. NNUE — net clears HCE per-node, but is NOT movetime-viable yet

Full build log + phased plan: `docs/NNUE/PLAN.md`. Status as of 2026-06-21:

A `(768→256)×2→1` SCReLU net, trained with **bullet** (jw1912/bullet) on the
**M3 Pro's Metal GPU** over ~40 GB of decorrelated Stockfish-binpack data
(~2.7M pos/sec), **decisively beats the tuned HCE per node**:

| Net | vs tuned HCE | book | budget |
|---|---|---|---|
| v4, 60-superbatch (6 min, uncalibrated) | **+171.6 ± 60** (W110 L35 D15) | standard | **40 000 fixed nodes** |
| v4, same net | **−156 ± 95** (W6 L22 D6, H0-trending) | standard | **100 ms/move** |

**The sign flips with the clock — and that is the whole story.** The +172 is a
*search-quality* result (equal nodes, better eval per node). The −156 is what
happens when **speed counts**: the net is a **non-incremental float accumulator**
— it recomputes the full 768→256 forward pass at *every* node (HCE is ~30–60 ns;
a from-scratch NNUE eval is ~1–5 µs, ≈20–80× costlier), so at a real time budget
it searches an order of magnitude fewer nodes than HCE and loses badly despite the
sharper eval.

**Therefore NNUE is NOT shipped and the `nnue` flag stays default-off.** Shipping
it now would *regress* prod (prod runs at movetime). This is exactly the sequencing
the plan locked in: prove the float net beats HCE at equal nodes (done, +172)
**before** the accumulator surgery — so the movetime loss is unambiguously a
*speed* problem, not a net/training problem.

**The gate to prod is the incremental accumulator** (Phase 4): on make/unmake,
update only the ~2–4 features that changed instead of recomputing all ~32 → NNUE
NPS approaches HCE NPS → the +172 per-node edge survives into movetime. Quantized
int16 inference compounds it. Only then re-SPRT **at movetime**; flip the default
on H1. Net-quality levers (longer training — a 600-superbatch run is in progress;
wider 512/1024 nets; more data) raise the per-node ceiling but do **not** fix the
speed wall — the accumulator does. Until then the staged net at
`data/nnue/net.nnue` is inert (flag off).
