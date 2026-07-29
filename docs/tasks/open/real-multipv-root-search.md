# Real MultiPV: N lines from ONE search (kill `/candidates`' fake multi-PV)

**What.** Give `Search` a real SF-style root move list + MultiPV loop, so a single
iterative-deepening search returns the top N lines at the *same* depth. Then serve the
analysis board off `/bestmove`'s lines and delete the per-move-search hack behind
`/candidates`.

**Status (2026-07-29).** All five phases landed. Gates green: byte-identity at multiPV=1,
mate suite (UCI + HTTP), perft, golden 37/38 (the 1 failure is a pre-existing kingless FEN in
`golden_eval.txt` that segfaults the NNUE king-bucket lookup; a clean HEAD build fails the same).

### Decision: which eval a book line reports

`analysis_lines()` normalizes the multi-line list to ONE source — every line, including the
book's, carries the ENGINE's eval/pv/depth. The book still decides that it is line 1; it just
doesn't supply the number. Mixing the book's depth-22 Stockfish score with depth-12 engine
scores made line 1 read as worse than line 2 purely from provenance (`+0.33` vs `+0.61` at the
start position) — which looks like a broken board. Normalized, the same position reads
`+0.96` vs `+1.03`: a real 7cp engine-vs-book disagreement on a comparable scale. The
predecessor did the same thing for the same reason ("the book move gets an engine search too so
its eval is at the same depth as the other lines").

The book's own eval is not lost: `/bestmove` reports it as the **top-level** eval/pv/depth (the
eval bar), matching what the `multipv <= 1` short-circuit already returned, so the bar reads
identically whether or not the caller asked for lines. Only the list is normalized.

Note the list can still be non-monotone at lines 1–2 on a book position, because the book move
is pinned above a move the engine scores higher. That is the intended trade and is inherent to
"book is never re-ranked" — not an ordering bug.

### Finding: the emitted-prefix sort is what makes lines monotone

First MultiPV build reported non-monotone scores at `multiPV>=3` (line 3 better than line 2).
It was diagnosed as an artifact of zug's root `DEPTHDROP`, but `DEPTHDROP=0` was non-monotone
too — and SF18 on the same FEN is strictly descending, so it was our bug, not an artifact.

Cause: **SF `search.cpp:424` was not ported.** SF sorts twice per line —
`stable_sort(begin+pvIdx, begin+pvLast)` (`:383`, the remaining candidates) *and*
`stable_sort(begin+pvFirst, begin+pvIdx+1)` (`:424`, **the already-emitted prefix**). Only the
first was in. Line k is searched with its own aspiration window and its exact score can land
above line k-1's, because line k-1's search ranked the remaining moves off shallow reduced
estimates (root LMR, DEPTHDROP) and under-rates them. The prefix sort is what lets a line
promote past an earlier one. Added as `sort_emitted_lines()`; no-op at `pvIdx==0`, so identity
is untouched. The `NNUE_ASSERT` root-ttMove-drift check was scoped to `multiPV==1` — under
MultiPV, `rootMoves[0]` legitimately stops tracking the scalar `rootBestMove`, exactly as in SF.

Lesson, again: a "washed"/odd-looking SF behaviour is our incomplete port, not the technique.

---

## Why the current thing is wrong (structurally, not just the mate bug)

`multi_pv()` (`zugzwang/src/serve_handlers.cpp:159`) is not multi-PV. It:

1. Pre-ranks all legal moves by **static eval**, keeps the top 12, throws the rest away.
   A static eval cannot see checkmate, so `Be5#` in
   `r4rk1/ppq2pBp/2pbp3/8/2B5/2nP3P/PPPnRP2/6RK w - -` (the bishop hangs) ranked ~last of
   39 and never got searched. `/bestmove` found the mate in 9,812 nodes. Patched
   2026-07-29 with terminal-child detection — **a workaround, deleted by this task.**
2. Runs **12 independent `start_group()` searches**, one per move, each with
   `movetime/39`. Cold window, cold root ordering, TT reseeded per move.
3. Therefore every line lands at a **different depth** (observed: 12, 7, 8, 7, 9, 12, 6…)
   and the evals are not comparable to each other or to the eval bar.
4. Costs ~12 full ID searches for a *worse* answer than one search would give.

The eval bar (`/analyze` → `/bestmove`) and the move list (`/candidates`) are two
separate searches of the same position that can and do disagree. That is the actual
complaint.

## What SF/Lichess do (`~/sf18-arm/src/search.cpp`, verified against tag `sf_18`)

One search. A persistent `RootMoves` list carried across every ID iteration
(`search.h:85`). Inside the ID loop, a MultiPV loop (`search.cpp:341`):

```
for (pvIdx = 0; pvIdx < multiPV; ++pvIdx)
    aspiration window seeded from rootMoves[pvIdx].averageScore   (355-358)
    search<Root> restricted to rootMoves[pvIdx..pvLast]           (1019)
    stable_sort(rootMoves.begin()+pvIdx, ...)                     (383)
```

Key details worth copying exactly:

- **Root move filter** (`1019`): `if (rootNode && !count(rootMoves.begin()+pvIdx, ..., move)) continue;`
  — the already-emitted PV moves are excluded from later lines. No separate search.
- **Per-root-move bookkeeping** (`1305-1352`): each root move stores `score`, a running
  `averageScore`, and its own `pv`; a move that fails to beat alpha is set to
  `-VALUE_INFINITE` so the **stable** sort keeps the previous ordering.
- **TT store suppressed for pvIdx > 0** (`1465`): `if (!excludedMove && !(rootNode && pvIdx))`.
  Without this, line 2+ poisons the TT with narrow-window bounds.
- **`ttMove` at root is `rootMoves[pvIdx].pv[0]`** (`707`), not a global best move.
- All N lines complete at the same `rootDepth`, so they are directly comparable.

Cost of multipv 5 vs 1 at equal depth is roughly 1.5–2.5×, not 5×, because the TT and the
root ordering are shared. Today's `/candidates` pays ~12× for worse output.

---

## Phase 1 — RootMoves + MultiPV in the search core

Files: `zugzwang/src/search.h`, `zugzwang/src/search.cpp`.

1. `search.h`: add
   ```cpp
   struct RootMove { Move move; int score, prevScore, avgScore; int64_t effort;
                     std::vector<Move> pv; };
   struct Line     { int score, depth, selDepth; std::vector<Move> pv; };
   ```
   `Limits::multiPV = 1`; `Result::lines` (`std::vector<Line>`, always ≥1 entry).
   `Result.bestMove/score/pv` stay as-is and equal `lines[0]` — no caller breaks.
2. `Context` (`search.cpp:1193` region): `std::vector<RootMove> rootMoves; int multiPV, pvIdx;`.
   Fold the existing `rootMoveEffort` map (NODEEFFORT) into `RootMove::effort`.
3. Build `rootMoves` from `Rules::generate_legal` at `start()` entry; clamp
   `multiPV = min(limits.multiPV, rootMoves.size())`.
4. Root node in `negamax` (`search.cpp:2237` / move loop at `~3150-3200`):
   - skip moves outside `rootMoves[pvIdx..]` (SF `1019`)
   - update the move's `RootMove` after `undo_move` (SF `1305-1352`)
   - `ttMove = rootNode ? rootMoves[pvIdx].pv[0] : …` (SF `707`), replacing `C.rootBestMove`
   - TT store guard `!(rootNode && pvIdx)` (SF `1465`)
5. ID loop (`search.cpp:3911`): wrap the aspiration block in the `pvIdx` loop;
   `stable_sort` after each line; publish `Result::lines` at the end of each completed
   iteration (so a timeout still returns the last fully-completed depth, as now).

### Byte-identity constraint (non-negotiable)

`multiPV == 1` must produce **the exact same tree** as today. Every SPSA-tuned margin, the
whole SPRT baseline, and `docs/CCRL.md` depend on it. The design above is a no-op at
`pvIdx == 0`:

- root filter: `count()` over the whole list is always 1 for a legal move → never skips
- TT guard: `pvIdx == 0` → stores exactly as now
- **keep zug's `prevScore` aspiration seeding for line 0.** Do NOT adopt SF's
  `averageScore`/`meanSquaredScore` seeding — that changes every window on every
  iteration. Per-line `avgScore` seeding is for `pvIdx > 0` only. (Switching line 0 to
  SF seeding is a separate SPRT'd experiment, not part of this task.)
- `ttMove` at root: `rootMoves[0].pv[0]` must track today's `C.rootBestMove` exactly —
  assert this in the ASSERT build.

**Gate:** fixed-depth sweep over the golden FEN set — `nodes` and `bestmove` must be
*identical* to `main`, not merely close. Plus `test/golden_check.sh` and `make perft`.

## Phase 2 — SMP and the root short-circuits

- **Lazy SMP:** each worker runs its own MultiPV loop. Keep the existing best-thread vote
  (it only looks at line 0) and return **that worker's whole line set** — never merge
  lines across workers.
- **Root DTZ** (`search.cpp:4142`) returns one move before any search. Under `multiPV > 1`,
  skip the short-circuit and search normally; WDL-in-search still scores the lines right.
- `Result::lines` is populated on every path, size 1 when `multiPV == 1`.

## Phase 3 — UCI parity

`setoption name MultiPV`, and `info depth D multipv i score … pv …` in `print_pv`. Makes
MultiPV testable in any GUI/fastchess, and is the CCRL-facing correct behaviour.

## Phase 4 — HTTP serve layer

`zugzwang/src/serve_handlers.cpp`:

- `/bestmove` with `limits.multipv = N`: **one** `start_group()` call, `lines` built from
  `r.lines`. Delete the `multi_pv()` call at `:485`.
- `/candidates`: same single search (`multipv = N`, default 12). Response schema unchanged
  (`uci`/`san`/`eval`/`pv`/`depth`/`opening`) so the opening explorer keeps working.
- **Delete `multi_pv()` and the terminal-child workaround** — the real search finds mates
  because it searches, not because of a special case.
- **Book handling: the book stays authoritative, line 1, always.** `book.bin` is not an
  opening book in the usual sense — it is a Stockfish-computed best-move cache (hours of
  search per entry, `{score, mate, depth, pv}`) and it is worth ~100 Elo over our own
  engine. So when a book entry exists, line 1 **is** the book move, with the book's eval,
  PV and depth — never re-ranked against engine scores.
  Mechanics under real MultiPV: run the engine at `multipv = N`, drop the book move from
  the engine lines if it appears there (no duplicate first moves), take the first `N-1` of
  the rest, prepend the book line. `multipv == 1` keeps today's instant book short-circuit
  unchanged (`serve_handlers.cpp:455`).

## Phase 5 — Analysis board: one search per position

`frontend/src/pages/Analysis.tsx` already runs the depth ladder with
`analyze(fen, { depth, movetime, multipv: 5 })` (`:427`) and gets back `lines`
(`api/client.ts:216`). It just doesn't use them.

- Lift `lines` into Analysis state; pass to `OpeningPanel`; **delete OpeningPanel's own
  `/candidates` fetch** (`OpeningPanel.tsx:69`). Result: one search per position instead
  of two, and the move list *deepens with the ladder* instead of being frozen at a 350ms
  budget.
- OpeningPanel needs the per-move opening name it currently gets from `/candidates` →
  add `opening` to `/bestmove`'s lines (pure book lookup, no search).
- `BotGame.tsx:956` and `EngineVsEngine.tsx:784` also mount OpeningPanel without the
  ladder — keep the `/candidates` path as the fallback for those (now backed by the real
  search, so quality is the same).
- `LiveGame.tsx:1196` uses `multipv: 1` — unaffected.

---

## Verification

1. **Byte-identity** at `multiPV=1`: fixed-depth node counts + bestmove vs `main`. Hard gate.
2. `make perft`, `test/golden_check.sh`.
3. **Mate suite:** the `Be5#` FEN plus a set of sacrificial mate-in-N. Line 1 must be the
   mate at every `multipv` setting, and `/candidates` must agree with `/bestmove`.
4. **Line sanity:** `score[0] >= score[1] >= …`, all lines at the same reported depth, no
   duplicate first moves, every `pv[0]` legal.
5. Short movetime SPRT vs `main` at `multiPV=1` — expect exactly 0 (byte-identical); it is
   a sanity check on the byte-identity claim, not a strength gate.
6. Wall-clock: multipv 5 at fixed movetime should reach within ~1–2 ply of multipv 1, and
   `/candidates` total latency should *drop* vs the 12-search version.
