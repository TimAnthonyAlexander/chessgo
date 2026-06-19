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

This session's gains were almost entirely **search** (the cheap, reliable Elo).
The **eval** frontier turned out to be a dead end for hand-tuned linear terms (§6)
— its real answer is SPSA or NNUE (§7).

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
mobility pawns kingsafety bishoppair eval` (`eval` toggles all knowledge terms).

### 2.2 `bench vs-stockfish` — absolute Elo anchor

Plays our engine (in-process) against **Stockfish** (a UCI subprocess) limited via
`UCI_Elo`/`Skill Level`, our rules as arbiter. Estimates our absolute Elo as the
opponent's Elo plus the head-to-head difference.

```sh
gomachine bench vs-stockfish --sf /opt/homebrew/bin/stockfish --sf-elo 2500 \
  --movetime 100 --games 60 --threads 4
```

**Caveat (important):** this anchor is *noisy and biased*. Stockfish's UCI_Elo
scale isn't logistic-linear and it plays erratically when handicapped, so two
reference points disagree (we measured ≈2361 vs SF-2200 *and* ≈2627 vs SF-2500 in
the same run — intervals that don't overlap). Use it for a rough band
(~2600-ish), **never to gate a patch.** SPRT is the ruler; this is the tape
measure you eyeball.

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

> **Not yet shipped to production.** The engine *supports* threads, but the engine
> HTTP service (`serve`) and the hub's bot still call it single-threaded. Plumbing
> a threads config into those (a `workers × threads` balance on the prod box) is
> the remaining step to deliver this to the live website bot.

---

## 5. The Texel tuner (`gomachine tune`) — **shipped, +101 Elo**

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
| Richer HCE terms (Phase 2) | +30–80 | medium | king-safety attack-units, rook files, passed-pawn blockers/king-dist, threats — each behind a flag, Texel-tuned + SPRT'd |
| Ship SMP to prod + higher threads | delivers +97 to the live bot | small | server/hub threads config |
| Remaining search patches | +50–80 | low | futility, countermove, singular ext, TT-static-eval |
| **NNUE** (learned non-linear eval) | +200–400 | high (weeks) | the eventual eval answer; the tuner's traced-coefficient dataset is a training-data step |
| SPSA (Elo-in-the-loop weight tuning) | modest | medium | the *correct* way to tune the few params with no static objective |

Current strength: **≈2720 ± 79** on Stockfish's UCI_Elo scale (100 games vs
SF-17.1 @ UCI_Elo 2500, **78%**, +220 head-to-head), up from ~2600 before the
tuned eval — the anchor's ~+90 jump independently corroborates the eval's +101
movetime SPRT gain. (Anchor is noisy: a band, not a number; sweep `--sf-elo` to
triangulate, and gate patches on SPRT.) Full-strength Stockfish 17.1/18
(~3650 CCRL) is still ~900 Elo above us — that gap needs NNUE.

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
