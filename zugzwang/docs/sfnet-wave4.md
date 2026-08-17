# SF-net Wave 4 — incremental accumulator + compile-time backend wiring, as-built notes

Implements `SFNet::AccStack` (`src/sfnet_accumulator.cpp`, declared in `src/sfnet.h`) and
the `#ifdef SFNET_BACKEND` compile-time wiring (`src/engine_backend.h` + the five sites
`docs/tasks/open/sf-net-experiment.md`'s Wave 4 task spec named) per that spec and
`docs/sfnet-wave2.md`. Scalar only — no SIMD (Wave 6), no eval cp-scale fit (Wave 5).
This file records what the written spec got wrong or left incomplete, and is honest
about what this wave did and did not verify.

## 1. The wiring

`src/engine_backend.h` is the one-line compile-time switch the spec asked for:
`using EngineAccStack = SFNet::AccStack` under `-DSFNET_BACKEND`, else
`NNUE::AccStack`. The five sites the spec named needed **less editing than
written** — most of them needed no body change at all, only enough for the compiler
to see a complete type:

- `position.h` — the only site that actually changes *text*: the forward-declare
  swaps `NNUE::AccStack` for `#include "engine_backend.h"` (`NNUE::BoardSnapshot` stays
  a plain forward-declare, unrelated to the backend switch), and the member/accessors
  become `EngineAccStack*`.
- `position.cpp` — **zero body changes.** Every call site (`nnueAcc->push_delta(...)`,
  `->pop()`, etc.) already spells only method names, never the type — exactly as the
  spec predicted. It needed one *new* conditional include
  (`#ifdef SFNET_BACKEND #include "sfnet.h" #endif`) so `EngineAccStack` is a complete
  type where `nnueAcc->method()` is called.
- `eval.cpp:514` — needed real logic, not just a type swap (see §3).
- `search.cpp` — of the three cited lines, only **one** (`1385`,
  `NNUE::AccStack accStack;`, a Context member declared *by value*) is actual text to
  change. `4423` and `4867` call methods on `C.accStack`/`pos.nnue_acc()` without
  spelling the type, so they compile unchanged once `EngineAccStack` is in scope.
- `zug_tb.cpp:178-179,266` — **zero changes of any kind**, not even an include.
  `auto* savedAcc = pos.nnue_acc(); pos.set_nnue_acc(nullptr); ... pos.set_nnue_acc(savedAcc);`
  never names the type and never dereferences the pointer, so it compiles against
  either backend as an incomplete type. Confirmed by grep: no `AccStack` token appears
  in this file at all.

**One site the spec's five-item list omitted, and it's a real compile error without
it:** `Eval::begin_search` (`eval.cpp`) also declares `NNUE::AccStack* a =
rootPos.nnue_acc();` for the HCEBLEND root-gate. Under `SFNET_BACKEND`,
`rootPos.nnue_acc()` returns `EngineAccStack*` = `SFNet::AccStack*`, so this line
fails to compile unless it's also switched to `EngineAccStack*`. Functionally the fix
is inert: `hce_blend()` (the only reader of the flag this function sets) is called only
from `Eval::evaluate`'s non-`SFNET_BACKEND` branch, so `begin_search`'s work is dead
computation on the SF path — it just has to *compile*.

**A second gap the written spec flagged in prose but didn't put in the site list, and
is NOT inert if missed:** RULE50DAMP. `SFNet::post_process` (§2 below) already applies
SF's own `v -= v * rule50_count() / 199`. `search.cpp`'s `corrected_eval` applies a
second, independent `rule50Damp` term (`Tune::rule50Damp`, **shipped default-ON**) on
top of *whatever* `Eval::evaluate` returned — with no backend awareness at all. Left
alone, every SF-backend eval would be rule50-damped twice. Fixed by making
`Tune::rule50Damp`'s *default* backend-conditional (`false` under `SFNET_BACKEND`,
`true` otherwise), still overridable either way via the existing `RULE50DAMP=0/1` env
convention (added the missing `on("RULE50DAMP")` case — only `off(...)` existed before,
since flipping an always-true default off was the only direction anyone needed). No
other correction term needed the same treatment: SATFIX/HCEBLEND/MATGRAD are all called
only from `Eval::evaluate`'s `#else` branch, so they structurally never run on the SF
path — RULE50DAMP is unique in living one call-frame further out, in search.cpp's own
correction-history pipeline, invisible from `eval.cpp`.

**Verified byte-identical with `SFNET_BACKEND` undefined**, per the hard requirement,
after a clean rebuild (`make clean && make -j8`):

```
./test/golden_check.sh ./zugzwang   ->  38/38 pass (tol 5), 0 fail
./perft_test                        ->  ALL PERFT TESTS PASSED (6 positions)
```

**Verified the `SFNET_BACKEND` build actually compiles and links**: every translation
unit in `SRC` (Makefile) plus `sfnet_load.cpp`/`sfnet_eval.cpp`/`sfnet_accumulator.cpp`
compiles clean under `-DSFNET_BACKEND` and links into a working binary; a UCI smoke
test (`position startpos`, `go movetime 200`) returns a legal `bestmove` with no crash.
It falls back to `hce_evaluate` the whole time, which is expected and explained in §5 —
no startup path loads an SF net in this wave.

## 2. Post-processing — cross-checked against SF source directly, not just the task spec

The written spec's formula (`nnue = (125*psqt+131*positional)/128`, complexity shrink,
`material = 534*pawns + nonPawnMaterial`, `v = nnue*(77871+material)/77871`,
`v -= v*rule50/199`, optimism = 0) was checked line-by-line against
`~/sf18-arm/src/evaluate.cpp`'s `Eval::evaluate` and matches exactly — including the
easy-to-doubt detail that the material term's pawn coefficient is **534**, not
`PawnValue` (208, defined in `types.h` and used elsewhere for `simple_eval`/small-net
routing, an unrelated purpose). `Position::non_pawn_material(Color)` in this codebase
returns a `bool` (a bitboard OR-check) — deliberately not used; `post_process`
recomputes material piece-by-piece with SF's own N/B/R/Q values (781/825/1276/2538).

Independently re-verified against `test/sfnet_corpus_ref.tsv`'s 5th ("full") column —
the same private-SF-oracle-derived reference Wave 2/3 validated `evaluate_raw`
against — via a throwaway program (not shipped, not a Makefile target):
**560/560 exact match, zero mismatches.**

## 3. `Eval::evaluate`'s SF-backend branch

```cpp
#ifdef SFNET_BACKEND
    if (!SFNet::loaded()) return hce_evaluate(pos);
    EngineAccStack* a = pos.nnue_acc();
    return a ? a->eval(pos) : SFNet::evaluate(pos);
#else
    ... untouched original body ...
#endif
```

No SATFIX/HCEBLEND/MATGRAD/EVALCOMPLEXITY — all four are calibrated to our own net's
saturation, and none of them are reachable from this branch. The `!SFNet::loaded()`
guard isn't in the spec's five sites either; added defensively (mirrors the existing
`!NNUE::loaded()` pattern) so calling `Eval::evaluate` before any net is loaded returns
HCE instead of hitting `evaluate_raw`'s hard `die()`/abort.

## 4. The accumulator's refresh rules — what got exercised, and how the base-space
   confusion was avoided

Two invariants had to hold simultaneously and are easy to get backwards, since the
spec explicitly warns our own net's `changed_edges_delta` base-768 loop is in the
**wrong basis** for HalfKAv2_hm:

- **Threat**: reused wholesale. `NNUE::changed_edges_delta(oldb, pos, doW, subW, addW,
  doB, subB, addB, baseSkipW=true, baseSkipB=true)` — `baseSkip*` skips the caller's
  base-768 D-loop entirely (that machinery is never touched by this file), leaving only
  the threat loops, which are bit-identical to SF's `FullThreats` (proven Wave 2/3).
  Refresh gate is `NNUE::perspective_mirror(ksq, persp)` — our own net's mirror bit,
  which Wave 2's orientation proof already established **is** SF's `FullThreats` mirror
  bit too (both canonicalise to files a-d the same way).
- **Base**: entirely new code (`delta_base` in `sfnet_accumulator.cpp`). Refresh is
  coarser than our own net — *any* king move of a perspective forces a full rebuild of
  that perspective's base half (no bucket-aware cheap path, matching HalfKAv2_hm's real
  behaviour). The non-king-move delta is derived from `D` (XOR of every
  per-(color,type) occupancy bitboard, old vs new) — the **technique**
  `nnue_features.cpp`'s own base-768 D-loop uses, reapplied to `make_base_index`
  (HalfKAv2_hm's own index formula, from `sfnet_internal.h`) instead of our net's
  `base_index`. No touch-plan/move-classification logic is needed here (unlike the
  threat delta's castling/en-passant handling) — PSQ features have no ray/discovery
  interactions, so a raw D-diff is correct for every move type including castling, en
  passant and promotion, without decoding move flags at all.

`forward_pass` (the FT pairwise-combine through the fc0/fc1/fc2 tail) is **shared code**
between the from-scratch oracle (`evaluate_raw`) and the incremental path
(`AccStack::eval`/`eval_pair`) — moved into `sfnet_internal.h`/`sfnet_eval.cpp` rather
than re-derived, specifically so there is exactly one implementation of that arithmetic
to get right. This refactor (linkage change only — code moved out of a private
anonymous namespace into named `SFNet` scope) was verified NOT to have altered any
value: after the move, `sfnet_eval_test --self-check` still passes 560/560, and a full
column-by-column diff of `evaluate_raw`'s (bucket, psqt, positional) output against
`test/sfnet_corpus_ref.tsv` shows zero mismatches.

## 5. Known scope gaps — honest, not absence-claims

- **Nothing loads an SF net at engine startup.** `serve.cpp`/`uci.cpp`/`ratingtest.cpp`
  were not in the wave's site list and were not touched. `search.cpp`'s `useAcc =
  NNUE::loaded()` gate (the line immediately above the cited `4423`, itself never named
  in the spec) is unchanged and still asks whether **our own** net loaded — under
  `SFNET_BACKEND` that's false unless something else also loads `net.nnue`, so even
  once a future wave calls `SFNet::load()` at startup, this gate will need its own
  follow-up before the accumulator is ever actually attached during a real search. The
  accumulator itself is proven correct in isolation (`sfnet_acc_test` attaches it to a
  `Position` directly, exactly as `Search::start` would), but nothing end-to-end
  connects "an SF net file is configured" to "search uses it" yet.
- **No SIMD** (Wave 6) — every loop here is the plain scalar form; `delta_threat_apply`
  doesn't even use our own net's count-array duplicate-cancellation trick
  (`apply_diff`), relying instead on the fact that int16/int32 wraparound add/sub is a
  ring (so a duplicate sub-then-add nets back to the exact original value regardless of
  overflow) — correctness-argued, not measured, and not a claim about performance.
- **No eval cp-scale fit** (Wave 5) — `AccStack::eval()`/`SFNet::evaluate()` return the
  raw post-processed SF `Value`, unscaled.
- **No NPS/movetime numbers were gathered.** There is nothing to time yet — see the
  first bullet; the accumulator has never run inside an actual timed search.
- Wave 2/3's own proofs (HalfKAv2_hm orientation tables, `FullThreats` bit-identity)
  were not independently re-derived this wave; they were reused as already-tested. The
  11M-node accumulator gate (§6) is strong indirect evidence they still hold under
  real move sequences, not a re-audit of the proofs themselves.

## 6. The gate — `test/sfnet_acc_test.cpp` / `make sfnet_acc_test`

Must be built with `-DSFNET_BACKEND` (the Makefile target does this) so
`Position::set_nnue_acc(&stack)` accepts an `SFNet::AccStack*`. Attaches a real
`SFNet::AccStack` to a `Position` exactly the way `Search::start` does, then lets the
engine's own `do_move`/`undo_move` drive `push`/`push_delta`/`pop` — this is not a
reimplementation of the accumulator's call discipline, it is `position.cpp`'s actual
code path. At every interior node (skipping in-check positions, matching
`evaluate_raw`'s documented precondition and `sfnet_eval_test`'s existing skip
convention) it compares `AccStack::eval_pair()` (a new test-only accessor — the
pre-post-processing `(psqt, positional)` pair, not one of the six methods
`EngineAccStack` depends on) against `SFNet::evaluate_raw()`'s from-scratch oracle, and
separately calls the shipped `AccStack::eval()` path once per node as a smoke check.

Coverage: all 560 `test/sfnet_corpus.epd` FENs, full-width (every legal move) to depth
3, plus 6 targeted FENs (kept OUT of `sfnet_corpus.epd`, which stays audited/stable —
hardcoded in the test instead) to depth 4, covering castling (both sides, both
colors), en passant, quiet + capture promotion, and king moves that cross the a-d/e-h
mirror line vs. stay within it (bucket-only crossing) for both the base and threat
refresh rules:

```
$ make sfnet_acc_test && ./test/sfnet_acc_test ~/sf18-arm/src/nn-c288c895ea92.nnue test/sfnet_corpus.epd --depth 3
sfnet_acc_test: 560 corpus FENs, 6 targeted FENs, depth 3 (+1 for targeted)
sfnet_acc_test: 11089304 nodes checked, 0 drift failures
RESULT: PASS
```

**11,089,304 interior nodes, 0 failures.** Also re-ran at `--depth 2` (381,502 nodes)
built with `make sfnet_acc_test ASSERT=1` (`-DNNUE_ASSERT`), which additionally
exercises `AccStack::eval()`'s own internal from-scratch abort-on-drift check (a second,
independent mechanism from the test's explicit `eval_pair()` comparison) — zero aborts,
consistent with the explicit-comparison result.

## 7. Full re-run, all gates

```
./test/sfnet_load_test  <big> <small>          -> RESULT: PASS (Wave 1, unaffected)
./test/sfnet_eval_test --self-check <big> <fens.epd>  -> self-check: 560 positions, 0 failed / RESULT: PASS
./test/golden_check.sh ./zugzwang              -> 38/38 pass (tol 5), 0 fail
./perft_test                                   -> ALL PERFT TESTS PASSED
./test/sfnet_acc_test <big> <fens.epd> --depth 3  -> 11089304 nodes checked, 0 drift failures / RESULT: PASS
```
