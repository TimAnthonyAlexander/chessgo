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
  *identical* moves to a full-window search (pure speed).
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

## 5. The Texel tuner (`gomachine tune`)

Optimizes the evaluation's knowledge-term weights (`internal/eval` `Weights`) to
minimize the mean-squared error between the engine's sigmoided eval and a target.

```sh
# target = game result (classic Texel):
gomachine tune --games 1500 --nodes 3000 --target result

# target = Stockfish's eval per position (knowledge distillation):
gomachine tune --games 1500 --target stockfish --sf /opt/homebrew/bin/stockfish --sf-depth 8
```

Pipeline (`internal/tune`): self-play generates labeled positions → (optionally)
Stockfish labels each position's eval in parallel → fit the sigmoid scale `K` →
coordinate-descent (±1 per weight) over all weights → print tuned weights as a Go
literal. MSE is computed in parallel across cores.

**Distillation is the better *target***: tuning to dense per-position Stockfish
evals produced correctly-signed weights where game-result tuning got king-safety
and doubled-pawn signs *backwards* (one noisy win/loss label smeared across 60
positions is a weak signal). But better target ≠ better player — see §6.

---

## 6. Key findings (the expensive lessons)

1. **Eval-fit ≠ playing strength.** The distillation tune had the *lowest* MSE we
   measured (best match to Stockfish's eval) and **lost −148.4 Elo** in actual
   games. The MSE-optimal weights were play-catastrophic (e.g. `MobEG[Q] = -21`
   → a ~−420cp penalty for an active queen in the endgame, because losing
   positions statistically have a scrambling queen). This is the textbook reason
   position-test/eval-matching is *not* a strength measure — measured in our own
   numbers. **The eval terms are off by default.**

2. **Bolt-on linear eval terms over an already-tuned PSQT don't help.** Mobility
   et al. overlap with the PeSTO piece-square tables, so a static-MSE optimizer
   either zeroes them out (untuned mobility SPRT'd at ~0) or produces compensating
   wrong-signed weights. Real eval Elo needs SPSA (Elo-in-the-loop) or NNUE (§7).

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
| Ship SMP to prod + higher threads | delivers +97 to the live bot | small | server/hub threads config |
| Remaining search patches | +50–80 | low | futility, countermove, singular ext, TT-static-eval |
| **NNUE** (learned non-linear eval) | +200–400 | high (weeks) | the real eval answer; the distillation pipeline (§5) is its training-data step |
| SPSA (Elo-in-the-loop weight tuning) | modest | medium | the *correct* way to tune eval/search params with no static objective |

Current strength: **~2600** on Stockfish's UCI_Elo scale; we **beat SF-2500**
(67.5%) where before this session's work we lost to it (37.5%). Full-strength
Stockfish 17.1/18 (~3650 CCRL) is ~1000 Elo above us — unreachable without NNUE.

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
