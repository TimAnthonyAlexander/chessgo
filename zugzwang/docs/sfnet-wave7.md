# SF-net Wave 7 — the autovectorization puzzle, and a load-time weight permutation

Wave 6 shipped NEON on arm64 (+11-16% NPS) but left amd64 on Wave 5's plain scalar
code, because every hand-written AVX2/AVX512/VNNI tier it tried came out flat-to-
negative on coalla and it couldn't say why. This wave had two jobs: (1) find out
whether GCC autovectorizing the scalar loops explains that puzzle, and (2) if so, stop
fighting the autovectorizer and go after something it can't already do for free — a
load-time weight-layout change. Both are done. What's NOT done, and why, is in §4.

## 1. Confirming the autovectorization hypothesis

Coalla (AMD EPYC 9634, Zen4) has AVX512 including VNNI — `-march=native` there defines
`__AVX512BW__`/`__AVX512VL__`/`__AVX512VNNI__` even with zero `SFNET_X86_SIMD`
intrinsics in the source. Two checks, both done on real coalla hardware over SSH
(compile-only / correctness-only — no timing runs, per this wave's benchmarking
restriction):

**a) `-fopt-info-vec` on the shipped default** (`SFNET_X86_SIMD` undefined, plain `-O3
-march=native`, Wave 5's textually-inline scalar loops — no `-flto` needed for this
check, since none of these loops carry cross-TU information): every hot loop in the
accumulator and forward pass reports `optimized: loop vectorized using 64 byte
vectors` (AVX512) or `32 byte vectors` (AVX2, where a chunk is too narrow for 512-bit):

| loop | file:line | width |
|---|---|---|
| `build_base`'s `h.accumulation[j] += w[j]` | sfnet_accumulator.cpp:103 | 64B |
| `build_threat`'s threat column add | sfnet_accumulator.cpp:130 | 64B |
| `delta_base`'s sub / add | sfnet_accumulator.cpp:168 / :180 | 64B / 64B |
| `delta_threat_apply`'s sub / add | sfnet_accumulator.cpp:216 / :232 | 64B / 64B |
| `forward_pass`'s pairwise combine | sfnet_eval.cpp:212 | 64B |
| `forward_pass`'s fc_0 dot (1024-wide) | sfnet_eval.cpp:239 | 64B |
| `forward_pass`'s fc_1 dot (32-wide) | sfnet_eval.cpp:264 | 32B |
| `forward_pass`'s fc_2 dot (32-wide) | sfnet_eval.cpp:276 | 32B |

Every one of these is Wave 6's own hottest-profiled code (`delta_threat_apply` 886
samples, `forward_pass` 1210). Zero hand-written intrinsics — this is `g++ 13` doing
it unprompted from plain C++ `for` loops.

**b) Symbol-level `objdump` on the actual shipped binary** (`zugzwang_sfnet`, the one
this session measured at 362,720 NPS): 2,694 zmm/VNNI instructions total (matches the
number reported at the top of this task exactly), and mapping them to symbols shows
they land specifically in the hot functions above — `AccStack::delta_threat_apply`
288, `evaluate_raw` 131, `AccStack::build_threat` 128×2 (two `constprop` clones),
`forward_pass` 106. (`NNUE::evaluate`, our OWN net's scalar loops, shows 705 — GCC
autovectorizes those too, for what it's worth as a sanity cross-check that this isn't
SF-backend-specific.)

**Verdict: confirmed, not refuted.** GCC is already saturating these loops with
AVX512/AVX2 from the scalar C++ alone. This fully explains Wave 6's core puzzle —
every hand-written tier was competing against an autovectorizer already doing the
same job, and a hand-written sequence that schedules differently (more register
pressure, different tail handling) can easily lose to whatever GCC picked. Proceeding
to §2 per the task's own instruction.

**One thing this did NOT cleanly resolve**: Wave 6's specific "-27%, refactored into
`simd::`'s scalar fallback, zero intrinsics" data point isn't reproducible from a
commit — it was measured ad hoc on a now-gone coalla build and never landed in git.
Reconstructing the closest equivalent (`-DSFNET_X86_SIMD` with the AVX512/AVX2 target
macros explicitly `-U`ndefined, forcing the call sites through `simd::`'s scalar
fallback while `-march=native` stays otherwise active) at plain `-O3` still
autovectorizes those same loops to 64-byte width — the refactor-into-a-header-function
step alone does NOT visibly lose vectorization at that level. That leaves Wave 6's own
speculation (icache/code-layout or `-flto` LTRANS-partition-specific effects) as the
more likely explanation for that one number, still unresolved, and not something this
wave chased further given the "don't benchmark on coalla" constraint makes it
unconfirmable either way this round.

## 2. Lead 1 — load-time weight permutation for the pairwise combine

Read `~/sf18-arm/src/nnue/nnue_feature_transformer.h:39-145,228-410` and
`~/sf18-arm/src/nnue/simd.h`'s `vec_packus_16`/`MaxChunkSize` definitions before
writing anything, per the task.

**What SF actually does, and why.** SF's own feature-transformer combine
(`transform()`) uses a `shift(7) + mulhi + packus` sequence — clamp, left-shift by 7,
take the high 16 bits of a 16×16→32 multiply (which is `floor(product/65536)`, i.e.
the `/512` this net's formula needs once combined with the shift), then narrow two
int16 vectors to one uint8 vector with a single `packus`. That's it — no manual
widen-to-int32/narrow-back round trip. Two things make it fast: `packus` narrows AND
saturates negative values to 0 in one instruction, and only ONE of the two combined
operands needs the full symmetric `[0,255]` clamp (the other only needs an upper
clamp, `min(x,255)`, and packus's own saturation supplies the missing lower bound for
free — see the file's own comment at line 284).

The catch: `packus` physically interleaves 128-bit sub-blocks from its two source
vectors in a fixed hardware order that is NOT the sequential order the rest of the
net expects. SF's fix is `permute_weights()` (called once, at load): it pre-shuffles
`biases`, `weights` and `threatWeights` by `PackusEpi16Order` (`{0,2,4,6,1,3,5,7}`
AVX512, `{0,2,1,3,4,6,5,7}` AVX2, chosen so packus's own interleave exactly cancels
it), so the accumulator built from those pre-shuffled columns is *itself* in the
permuted order, and running it through `packus` lands the OUTPUT back in natural
order — free at runtime, paid once at load.

**Why this codebase's own AVX512 tier didn't need it (and left something on the
table).** Wave 6's `pairwise_combine_sf` used `_mm512_cvtepi32_epi16`/
`_mm512_cvtepi16_epi8` — TRUNCATING narrows with sequential lane semantics, not
`packus`'s interleaving pack — specifically to avoid needing this permutation at all.
Correct, but ~18 vector ops per 16 output elements (widen to int32, add, clamp ×2,
narrow ×2) versus SF's ~15 ops per **64** output elements — over 4x worse
elements-per-instruction. SF's own AVX512 path uses `packus` too (not the
truncating-narrow route this codebase picked), which is why the permutation is a real,
not merely theoretical, lever here.

**What was implemented** (`src/sfnet_simd.h`, `src/sfnet_load.cpp`):

- `SFNET_FT_PERMUTE` — new macro, 1 exactly when a packus-based tier will run
  (`__AVX512BW__ && __AVX512VL__ && SFNET_X86_SIMD`, or `__AVX2__ && SFNET_X86_SIMD`),
  0 for scalar/NEON (permuting there would be correct but pointless — no packus to
  compensate for).
- `kFtPermOrder[8]` — `PackusEpi16Order`, transcribed verbatim per tier.
- `ft_permute<T>()` — generic port of SF's `permute<BlockSize>()`, operating on typed
  elements (int16 for biases/weights, int8 for threatWeights) in 64-element chunks (8
  sub-blocks of 8 elements each, reordered by `order`) — HalfDimensions=1024 is a
  multiple of 64, so applying this to the FLAT concatenated array is identical to
  applying it independently per 1024-wide feature column, which is the thing that
  actually has to stay self-consistent.
- `ft_perm_order_self_check()` — proves the order table is a genuine permutation (no
  duplicate/out-of-range entry) AND that permuting by it then by its own inverse
  recovers a synthetic `[0..1023]` array exactly. Runs unconditionally at load time,
  BEFORE any real array is touched — a mistranscribed table refuses the load with a
  clear error instead of silently shipping a plausible-but-wrong eval. This is the
  "prove it's correctly inverted" gate the task called for.
- `sfnet_load.cpp`'s `load()` calls the self-check, then permutes `biases`, `weights`,
  `threatWeights` in place, once, right before `g_net.ok = true` — gated entirely on
  `SFNET_FT_PERMUTE`, so scalar/NEON builds compile this block out and keep reading
  the file in natural order exactly as before.
- `pairwise_combine_sf`'s AVX512BW+VL and AVX2 tiers were REWRITTEN (not
  kept-alongside) to SF's shift+mulhi+packus sequence, consuming the now-permuted
  accumulator. Two bit-exactness arguments are in the code comments: (1) the
  asymmetric-clamp trick is algebraically equal to this net's symmetric-clamp
  reference (re-derived independently, not just trusted because SF ships it — see the
  comment block in `sfnet_simd.h`), and (2) `shift(7)+mulhi` computes the same
  `floor(a*b/512)` the reference's widen/clamp/multiply/`>>9` does.

**Why nothing else needed to change.** The permutation only relabels the 1024-wide
`j` (`HalfDimensions`) index, identically across `biases`/`weights`/`threatWeights` —
so `col_add_i16`/`col_sub_i16`/`col_add_i8widen_i16`/`col_sub_i8widen_i16` (used by
`build_base`, `build_threat`, `delta_base`, `delta_threat_apply` — the WHOLE
incremental-accumulator machinery) need zero changes: `acc[j] +=/-= col[j]` is correct
regardless of what "j" means, as long as accumulator and every column that ever
touches it agree on the same relabeling, which they do by construction. `fc_0`'s
weights are untouched and still expect natural order, which is exactly what the
permuted `packus` sequence hands back.

### Gates (all on real coalla hardware, compile+run only — no timing)

```
$ g++ ... -march=native -DSFNET_X86_SIMD -o sfnet_eval_test_permuted ...   # AVX512BW+VL+VNNI tier
$ ./sfnet_eval_test_permuted ~/sf18/src/nn-c288c895ea92.nnue test/sfnet_corpus.epd
  -> diffed against test/sfnet_corpus_ref.tsv columns 1-4: 0 differences (560/560 exact)

$ g++ ... -march=native -mno-avx512f -DSFNET_X86_SIMD -o sfnet_eval_test_avx2 ...   # AVX2-only tier
$ ./sfnet_eval_test_avx2 ~/sf18/src/nn-c288c895ea92.nnue test/sfnet_corpus.epd
  -> diffed against test/sfnet_corpus_ref.tsv columns 1-4: 0 differences (560/560 exact)

$ g++ ... -march=native -DSFNET_X86_SIMD -DSFNET_BACKEND -o sfnet_acc_test_permuted ...
$ ./sfnet_acc_test_permuted ~/sf18/src/nn-c288c895ea92.nnue test/sfnet_corpus.epd
  -> sfnet_acc_test: 11089304 nodes checked, 0 drift failures — RESULT: PASS

$ (arm64, this Mac) make sfnet_eval_test && ./test/sfnet_eval_test ~/sf18-arm/.../nn-c288c895ea92.nnue test/sfnet_corpus.epd
  -> 560/560 exact (SFNET_FT_PERMUTE compiles out on NEON — sanity check nothing broke)

$ (arm64) make sfnet_acc_test && ./test/sfnet_acc_test ... -> 11089304 nodes, 0 drift, PASS

$ (arm64) make -j8 && ./test/golden_check.sh ./zugzwang
  -> === golden: 38/38 pass (tol 5), 0 fail === (own net untouched, as expected —
     none of src/nnue_*, src/eval.cpp, src/position.*, src/search.cpp were touched)
```

Also linked and smoke-ran the FULL playable `zugzwang_sfnet` binary on coalla with
`-DSFNET_X86_SIMD` (AVX512 tier), UCI handshake + `go depth 6` from startpos —
produces a sane PV (`e2e4 e7e5 g1f3 b8c6 f1b5 ...`), no crash, no assert. No timing
number is reported from this run or anywhere else in this wave — see §5.

**Involution self-check, standalone**: both order tables (`{0,2,4,6,1,3,5,7}` and
`{0,2,1,3,4,6,5,7}`) pass `ft_perm_order_self_check()` — confirmed implicitly by every
successful load above (a failed self-check refuses the load with
`"FT permutation order failed its own involution self-check"`, which never fired).

## 3. Lead 2 — fc_0 int8×uint8→int32 (VNNI)

Read `~/sf18-arm/src/nnue/layers/affine_transform_sparse_input.h` before writing
anything, per the task.

**Finding: this codebase already has the literal instruction the task named.**
`dot_u8i8_sf`'s `AVX512VNNI` tier (`sfnet_simd.h`, written in Wave 6) already uses
`_mm512_dpbusd_epi32` — VNNI's `vpdpbusd` — for fc_0/fc_1/fc_2. It's dead code (gated
behind the same non-default `SFNET_X86_SIMD`), not missing code.

**What actually makes SF's fc_0 fast is a different, bigger thing than instruction
selection: it isn't a dense dot product at all.** SF's fc_0 is
`AffineTransformSparseInput` — after the pairwise-combine's `clamp(...,0,255)`, a
large fraction of the 1024 activations are exactly zero (this is inherent to a
clamped-ReLU-like transform, not net-specific). SF's `find_nnz()` locates the nonzero
4-byte-grouped input chunks and `propagate()` only visits THOSE, broadcasting each
active input across a `vpdpbusd`-accumulated dot against ALL 16 output neurons at
once. The weight matrix is stored via `get_weight_index_scrambled()` — a load-time
reindex that makes "all 16 outputs' weights for input-chunk i" physically contiguous,
which is what makes the nonzero-chunk-driven access pattern fast rather than a
scatter. This is genuinely a load-time layout transform, same spirit as §2 — but it
changes the LOOP STRUCTURE (input-chunk-driven instead of output-neuron-driven, with a
runtime-dependent trip count from `find_nnz`), not just the weight file's byte order.

**Deliberately not implemented this wave.** Three reasons, stated rather than
guessed around:

1. It's a materially larger and riskier change than §2 — a new loop nest, a new
   scramble function, and a `find_nnz` implementation, versus a pure data-reorder
   that left every existing loop's C++ untouched. The bit-exactness risk profile is
   worse for the same reason: more moving parts between "loads" and "the 560/560
   gate", and the task singled out a wrong-but-plausible permutation as the outcome
   to avoid above all else.
2. This wave's remaining budget was better spent finishing §2 correctly and gate-
   testing it on real hardware than starting a second large port and leaving BOTH
   half-verified.
3. Unlike §2, whether it pays here depends on how sparse `ft[]` actually is on real
   positions from THIS net (a different net than SF's own, even though it's SF's
   architecture) — worth measuring before investing in the port, and measuring
   requires either instrumenting a real search (needs coalla time when it's free) or
   a standalone sparsity probe over the existing corpus (cheap, and the natural next
   step, not attempted this wave).

Flagged here rather than left unmentioned, per this repo's own convention for
scoped-out work: **the next wave should start by measuring `ft[]` zero-fraction over
`test/sfnet_corpus.epd`** (a `printf`-and-count instrument needs no new SIMD code) —
if it's low (this net trained differently from SF's, no guarantee the sparsity
transfers), the sparse-input rewrite isn't worth the risk and fc_0 stays dense-VNNI
(already written, in `dot_u8i8_sf`'s AVX512VNNI tier) as the ceiling for this lever.

## 4. What shipped vs what didn't, and why

**Written, bit-exact-gated on real amd64 hardware (AVX512 AND AVX2), NOT default-on:**
- FT weight permutation (`SFNET_FT_PERMUTE`, `sfnet_load.cpp`) + the rewritten
  `pairwise_combine_sf` AVX512BW+VL/AVX2 tiers using SF's shift+mulhi+packus sequence.
  Both pass 560/560 bit-exact and the 11,089,304-node/0-drift incremental-accumulator
  gate. Kept behind the SAME `SFNET_X86_SIMD` flag Wave 6 left off by default — this
  wave could not benchmark on coalla (busy with an SPRT the whole session; the task
  explicitly forbids it), so there is NO NPS claim for this change, honest or
  otherwise. It replaces Wave 6's non-permuted AVX512/AVX2 `pairwise_combine_sf`
  entirely (not kept side by side — the old version is in git history at `dbcaac7` if
  a future A/B needs it).
- `dot_u8i8_sf`'s AVX512VNNI tier (`_mm512_dpbusd_epi32`) — unchanged from Wave 6,
  still gated off, still the ceiling for "dense fc_0 with the right instruction."

**Confirmed, not shipped as code (it's an explanation, not a patch):** the
autovectorization finding in §1 — GCC already vectorizes the entire SF-backend hot
path to AVX512/AVX2 width from plain scalar C++, which is why Wave 6's hand-written
tiers were fighting an already-solved problem rather than an unsolved one.

**Not attempted:** the fc_0 sparse-input/VNNI-scramble rewrite (§3) — scoped, reasoned
about against SF's actual source, and deliberately deferred rather than rushed, with a
concrete cheap first step (`ft[]` sparsity probe) named for whoever picks it up next.

## 5. Honest performance status

**No amd64 NPS number is reported anywhere in this wave.** Coalla ran an SPRT the
entire session; the task explicitly prohibited benchmarking there and forbade ssh for
timing runs specifically. Every coalla interaction this wave was either read-only
(`~/sf18-arm` — not touched, `~/sfwork` state inspection), a compile-only
`-fopt-info-vec` diagnostic, or a correctness gate (bit-exact diff / node-count
drift / UCI smoke test) — none of which measure or imply speed. The remaining amd64
NPS ratio versus §-of-record numbers (SF 737,142 / own net 584,796 / sfnet 362,720,
i.e. 2.03x slower than SF on the same net) is **unmeasured, not improved-and-
unclaimed** — whether §2's permutation+packus rewrite is a win, a wash, or a
regression on Zen4 is not yet known and should be the first thing measured once
coalla frees up, using the SAME fixed-depth-18 wall-clock method Wave 6 defined
(`tools/fixed_depth_bench.py`), A/B against this session's own `zugzwang_sfnet`
(362,720 NPS, `SFNET_X86_SIMD` undefined) as the baseline.

arm64 is unaffected by this wave (`SFNET_FT_PERMUTE` is 0 there; Wave 6's shipped NEON
tier for `pairwise_combine_sf` was not touched) — confirmed by the unchanged 560/560
and 11,089,304/0-drift results on this machine.

## 6. Files

- `src/sfnet_simd.h` — `SFNET_FT_PERMUTE`, `kFtPermOrder`, `ft_permute<T>()`,
  `ft_perm_order_self_check()` (new); AVX512BW+VL and AVX2 `pairwise_combine_sf`
  rewritten to SF's shift+mulhi+packus sequence (replaces Wave 6's widen/clamp/
  narrow versions). NEON and scalar tiers untouched.
- `src/sfnet_load.cpp` — `load()` now self-checks and applies the FT permutation to
  `biases`/`weights`/`threatWeights`, gated on `SFNET_FT_PERMUTE`; includes
  `sfnet_simd.h` for the first time (previously only `sfnet_eval.cpp`/
  `sfnet_accumulator.cpp` did).
- `docs/sfnet-wave7.md` — this file.
