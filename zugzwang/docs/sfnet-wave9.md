# SF-net Wave 9 — deferred-apply accumulator (SFNETLAZYACC)

Wave 8 chased `fc_0` (block-sparse dot product) and it did not pay — see
`docs/sfnet-wave8.md` §4: `fc_0` runs once per **eval**, but the accumulator runs once
per **move**, and it's the accumulator that scales with the tree. This wave ports our
own net's `LAZYACC` deferred-apply scheme onto the SF backend's `SFNet::AccStack`.

**Result: a real win. +7.8% NPS on arm64 (fixed-depth-18, well above the run-to-run
noise floor), bit-exact on 11,089,304 nodes with 0 drift on BOTH arm64 and amd64,
ASSERT-clean on both. Shipped in the tree, gated by `SFNETLAZYACC` (env, default
OFF) — amd64 TIMING is unmeasured (coalla was running a 30h SPSA all session; only
correctness gates were run there, per the task's own restriction), so the default
stays off until that's confirmed. Recommendation: flip to default-on once an amd64
fixed-depth check lands — see §5.**

## 1. What SF actually does, re-read before writing anything

Per `zugzwang/CLAUDE.md`'s cross-reference rule: `~/sf18-arm/src/nnue/nnue_accumulator.h`
and `nnue_accumulator.cpp:165-198`. Each `AccumulatorState` carries `computed[COLOR_NB]`.
`AccumulatorCaches`/`updateAccumulatorIncremental` don't touch the 8KB working set on
every `do_move` — they mark the new state dirty and only materialize it (walk back to
`find_last_usable_accumulator`, then `forward_update_incremental` rolls forward through
the dirty plies, or `backward_update_incremental` fills backwards from a fresher
refresh) at the point an **eval** is actually requested. A cut node's accumulator is
never built at all.

## 2. Why our own net's LAZYACC was the right model to port, not SF's code

`nnue_accumulator.cpp`'s `lazy_acc_enabled()`/`materialize()` (LAZYACC, shipped
2026-07, +7.2% NPS / +17.8 Elo on our own net) already solves this against the
*exact* `Position`/`AccStack` interface (`reset`/`push`/`push_delta`/`pushNull`/`pop`/
`eval`) `SFNet::AccStack` has to match (`src/engine_backend.h`'s `EngineAccStack`
alias needs both backends' six methods to line up). The task named this directly:
reusing LAZYACC's shape is faster and safer than transliterating SF's
`computed[COLOR_NB]`/state-graph machinery, which is built around SF's own
`AccumulatorStack` object lifetime, not ours.

**The one real difference, and why it's not a copy-paste job.** Our own net's
`NNUE::AccStack::Slot` has ONE `clean` flag — `w[]`/`b[]` always refresh or delta
together, because our net has one feature set. `SFNet::AccStack::Slot` has **two
independently-gated feature sets** (`sfnet.h`'s class comment):

- **base** (`psq[]`, HalfKAv2_hm): refreshes on **any king move** of that
  perspective — SF's own coarser rule, no bucket-aware cheap path.
- **threat** (`thr[]`, FullThreats): refreshes on the **mirror bit only** — a
  king move that crosses a king-bucket boundary without crossing the mirror line
  keeps threats on the delta path even though base just got rebuilt.

So a slot can be clean for `thr[WHITE]` while still dirty for `psq[WHITE]` at the
same ply. `Slot` therefore carries **four** independent `clean`/`ref` flag pairs
(`cleanPsq`/`cleanThr` × `refPsq`/`refThr`, each `[COLOR_NB]`) instead of one, and
`materialize(k)` walks each of the four halves back to **its own** nearest clean
ancestor independently rather than one shared walk.

## 3. What was built

`src/sfnet.h` (`AccStack::Slot`) and `src/sfnet_accumulator.cpp`. Every existing
eager function was **split into an enumeration half and an apply half** rather than
rewritten, so the eager (`SFNETLAZYACC` off) path is exactly the pre-existing
composition of the two and stays byte-for-byte identical:

| eager function | split into | what's deferred |
|---|---|---|
| `build_base` | `base_indices` (existing, unchanged) + new `apply_base_refresh` | the weight-column streaming (`net.weights`, ~46 MB) |
| `build_threat` | new `threat_indices` + new `apply_threat_refresh` | the weight-column streaming (`net.threatWeights`, ~82 MB) |
| `delta_base` | new `compute_base_delta` (the D-loop, now filling sub/add lists instead of applying in place) + new `apply_base_delta` | the column sub/add streaming |
| `delta_threat_apply` | unchanged — it was already apply-only; `NNUE::changed_edges_delta`'s call site just stores its output instead of consuming it immediately | the column sub/add streaming |

`push()`/`push_delta()`/`pushNull()` under `SFNETLAZYACC=1` call only the enumeration
halves now (cheap — attack-gen and the D-loop's board scan, and the boards involved
are live at that exact call site regardless) and record `ref{Psq,Thr}[c]` +
`{psq,thr}{Feats,Sub,Add}[c]` into the new top `Slot`, marking `clean{Psq,Thr}[c] =
false`. `eval_pair()` calls `materialize(sp_)` on demand — the only place a dirty
half's `psq[]`/`thr[]` is ever actually read — which is why `eval_pair()` had to lose
its `const` (it now writes into `slots_`; its one caller, `test/sfnet_acc_test.cpp`,
already held a non-const reference, so this is not an API break in practice).

**Bit-exactness argument** (same one this codebase uses everywhere for this class of
change, and stated explicitly in both files): every recorded list is a pure function
of boards that were live at push time (`base_indices`/`threat_indices` off the live
child, `compute_base_delta`/`changed_edges_delta` off `(oldb, child)`, both boards
still live at that exact call site) — recomputing nothing later, just applying it
later. int16/int32 column add/sub commute and associate, so replaying a slot's
recorded refresh/delta on top of whatever the parent's materialized half turns out to
be, whenever that happens, is identical to applying it immediately. `apply_base_delta`
additionally reorders `delta_base`'s original interleaved-per-square sub/add into two
separate passes (sub-then-add) — the same reordering `delta_threat_apply` already
does, safe for the same ring-arithmetic reason.

`pushNull()` records an **empty** delta (`ref=false`, empty sub/add) rather than
copying the parent's `HalfAcc` structs immediately — that copy IS weight-column-sized
work relative to nothing, so deferring it (materialize applies a no-op diff, which is
just `dst = src` + two empty loops) is free and correct, mirroring
`NNUE::AccStack::pushNull`'s LAZYACC branch exactly.

## 4. Gates — every one, with the flag ON explicitly stated (per the task's warning
about a prior wave that gated code behind a flag left undefined by default)

**arm64 (this Mac, M3), flag ON (`SFNETLAZYACC=1`) unless noted:**

```
$ make sfnet_eval_test && ./test/sfnet_eval_test sfnet.nnue test/sfnet_corpus.epd \
    | cut -f1-4 | diff - <(cut -f1-4 test/sfnet_corpus_ref.tsv)
  -> 0 differences (560/560 bit-exact) — unaffected by this wave, re-run as a sanity check

$ make sfnet_acc_test
$ ./test/sfnet_acc_test sfnet.nnue test/sfnet_corpus.epd                    # flag OFF
  -> 11089304 nodes checked, 0 drift failures — RESULT: PASS
$ SFNETLAZYACC=1 ./test/sfnet_acc_test sfnet.nnue test/sfnet_corpus.epd     # flag ON
  -> 11089304 nodes checked, 0 drift failures — RESULT: PASS

$ make ASSERT=1 sfnet_acc_test
$ ./test/sfnet_acc_test sfnet.nnue test/sfnet_corpus.epd                    # flag OFF, ASSERT
  -> 11089304 nodes checked, 0 drift failures — RESULT: PASS
$ SFNETLAZYACC=1 ./test/sfnet_acc_test sfnet.nnue test/sfnet_corpus.epd     # flag ON, ASSERT
  -> 11089304 nodes checked, 0 drift failures — RESULT: PASS

$ make sfnet_load_test && ./test/sfnet_load_test sfnet.nnue
  -> RESULT: PASS

$ make -j8 && ./test/golden_check.sh ./zugzwang
  -> === golden: 38/38 pass (tol 5), 0 fail === (own net untouched — sfnet_accumulator.cpp
     isn't in the default zugzwang binary's SRC list at all; confirms nothing leaked)
```

**amd64 (coalla, Zen4), correctness ONLY — no timing runs, per the task's restriction
(a 30h SPSA was running the whole session).** Coalla's `~/sfwork` worktree was sitting
at `0aa277e` (one commit behind this wave, but `sfnet.h`/`sfnet_accumulator.cpp` are
byte-identical between `0aa277e` and `09d4797` — Wave 8 touched only
`sfnet_simd.h`/`sfnet_eval.cpp`/`sfnet_internal.h`, confirmed via `git diff --stat`).
This wave's two changed files were copied over (no `make` — direct `g++`, same
"no make binary exists there" method Waves 6/7 used) and built/run there, then the
worktree was `git checkout --`-reverted and the temp binaries removed afterward so
nothing was left dirty on a machine mid-SPRT:

```
$ g++ ... -march=native -Isrc -o /tmp/sfnet_eval_test_w9 test/sfnet_eval_test.cpp ...
$ /tmp/sfnet_eval_test_w9 ~/sf18/src/nn-c288c895ea92.nnue test/sfnet_corpus.epd | cut -f1-4 \
    | diff - <(cut -f1-4 test/sfnet_corpus_ref.tsv)
  -> 0 differences (560/560 bit-exact)

$ g++ ... -DSFNET_BACKEND -o /tmp/sfnet_acc_test_w9 test/sfnet_acc_test.cpp ...
$ /tmp/sfnet_acc_test_w9 ~/sf18/src/nn-c288c895ea92.nnue test/sfnet_corpus.epd            # OFF
  -> 11089304 nodes checked, 0 drift failures — RESULT: PASS
$ SFNETLAZYACC=1 /tmp/sfnet_acc_test_w9 ~/sf18/src/nn-c288c895ea92.nnue test/sfnet_corpus.epd  # ON
  -> 11089304 nodes checked, 0 drift failures — RESULT: PASS

$ g++ ... -DNNUE_ASSERT -DSFNET_BACKEND -o /tmp/sfnet_acc_test_w9_assert ...
$ /tmp/sfnet_acc_test_w9_assert ... (OFF)  -> 11089304 nodes, 0 drift, PASS
$ SFNETLAZYACC=1 /tmp/sfnet_acc_test_w9_assert ... (ON) -> 11089304 nodes, 0 drift, PASS
```

Every gate the task listed passes, with the flag explicitly ON where that matters, on
both architectures this net runs on.

## 5. Performance — arm64 measured, amd64 correctness-only

Method: `tools/fixed_depth_bench.py` (fixed `go depth 18`, byte-identical node count
every run since the search is deterministic — the lower-noise cross-check Wave 6
defined), `zugzwang_sfnet` built plain (`make sfnet`, `SFNET_X86_SIMD`/
`SFNET_FC0_SPARSE` both undefined — this wave isolates the accumulator change from
Waves 7/8's still-off SIMD/sparsity levers). 3 independent runs (6 positions × 2 reps
each) per flag setting, on this M3:

| | run 1 | run 2 | run 3 | mean | stdev |
|---|---|---|---|---|---|
| `SFNETLAZYACC` off (baseline) | 345,272 | 342,865 | 342,919 | 343,685 | 1,122 (0.33%) |
| `SFNETLAZYACC=1` | 370,272 | 368,844 | 372,465 | 370,527 | 1,489 (0.40%) |

**+7.81% NPS.** Run-to-run spread inside each group is ~0.3-0.4% — nowhere near the
delta, so this isn't noise. Corroborated by the noisier `go movetime 2000` method
(`tools/sfnet_nps_bench.py`, median-of-8-positions, search depth itself varies with
speed so it's not a clean A/B but points the same direction): OFF median 393,798 /
395,130 across two runs (mean 394,464) vs ON median 432,449 — **+9.6%**.

**amd64 is correctness-clean (§4) but has no timing number** — coalla ran a 30h SPSA
the entire session and the task explicitly prohibited timing runs there (only
compile+correctness). This is an honest gap, not a hidden one: unlike Wave 7's
SIMD/permutation levers (whose payoff is genuinely architecture-dependent — different
vector widths, different autovectorizer behavior, proven to regress on one arch and
help another in that wave), this optimization's mechanism — skip weight-column
streaming for pushes whose accumulator is never read — has no plausible
architecture-dependent failure mode: the bookkeeping it adds (a handful of small
`std::vector<int>` list stores per push, a short back-walk in `materialize`) is tiny
relative to what it removes (megabyte-scale column streams out of `net.weights`/
`net.threatWeights`), on any architecture. The direct analog on our own net
(`LAZYACC`) measured its win **on coalla specifically** (+7.2% amd64, `nnue_accumulator.cpp`'s
comment), not just on arm64. That's a reason to expect this transfers, not proof that
it does.

**Recommendation, stated rather than acted on unilaterally given the task's own
restriction:** flip `SFNETLAZYACC` to default-on once a `tools/fixed_depth_bench.py`
run confirms it on coalla when the SPSA frees up — same bar Wave 7 set for its own
amd64-unmeasured lever. Until then it ships **default OFF**, env-gated, zero cost to
the shipped default path (identical to the pre-wave9 eager composition — see §3's
table).

## 6. Files

- `src/sfnet.h` — `AccStack::Slot` gained the four `clean{Psq,Thr}[COLOR_NB]` /
  `ref{Psq,Thr}[COLOR_NB]` flag pairs and their backing `{psq,thr}Feats`/
  `{psq,thr}{Sub,Add}` lists; `AccStack` gained `threat_indices`,
  `apply_base_refresh`, `apply_threat_refresh`, `compute_base_delta`,
  `apply_base_delta`, `materialize`; `eval_pair()` lost `const`. Class comment
  extended with the SFNETLAZYACC design note.
- `src/sfnet_accumulator.cpp` — `sfnet_lazyacc_enabled()` (env `SFNETLAZYACC`,
  default OFF); `build_base`/`build_threat`/`delta_base` refactored into
  enumerate+apply pairs (eager path byte-identical); `push`/`push_delta`/`pushNull`
  gained the lazy-record branch; `materialize()` implemented; `eval_pair()` calls it
  on demand.
- `docs/sfnet-wave9.md` — this file.
