# FT weight permutation for our own net — does not apply

Idea's origin: `docs/sfnet-wave7.md` §2, which ported Stockfish's load-time
`PackusEpi16Order` weight permutation to the *SF-net backend* (`src/sfnet_*`),
worth +4.1% NPS on amd64 there. This doc answers the same question for **our
own production net** (`src/nnue_eval.cpp` / `nnue_accumulator.cpp` /
`nnue_net.cpp`) — a file set the SF-net campaign has deliberately left
untouched until now.

**Verdict: does not apply. No code changed, no flag added.**

## Why SF needs the permutation

SF's feature-transformer combine narrows two int16 vectors into one uint8
vector with `packus` (`vpackuswb`/`_mm512_packus_epi16`). `packus` physically
interleaves 128-bit sub-blocks from its two source vectors in a fixed hardware
order that is not the sequential order the rest of the net expects, so SF
pre-shuffles its FT weights/biases once at load (`PackusEpi16Order`) so that
running the accumulator through `packus` lands the output back in natural
order — free at runtime, paid once at load. Wave 7 confirmed all of this by
reading `~/sf18-arm/src/nnue/nnue_feature_transformer.h` directly, and ported
it correctly for `src/sfnet_*`.

## What our own kernel actually does

Our own net's narrowing step lives in exactly one place:
`pairwise_u8_block()` in `src/nnue_eval.cpp:174-299` (the `uint8_t aq[H]`
build, `H=512`, gated behind the `PAIRSIMD` env flag — see below for whether
that even matters). Per tier:

| Tier | Narrow instruction | Class |
|---|---|---|
| AVX512 (`__AVX512VNNI__`) | `_mm512_cvtepi16_epi8` → `vpmovwb` | **truncating convert**, sequential lanes |
| NEON (`__ARM_NEON`/`__aarch64__`) | `vmovn_u16` → `xtn.8b` | **truncating narrow**, sequential lanes |
| WASM SIMD128 | `wasm_u8x16_narrow_i16x8` | narrow, but every lane is already in `[0,127]` so its saturation branch never fires — a plain truncation on our data |
| scalar fallback | plain C++ `static_cast<uint8_t>` per element | no vector op at all |

None of these is `packus`. `vpmovwb`/`vpmovdb` (AVX512BW's "move packed
word/dword to byte", used by `_mm512_cvtepi16_epi8`/`_mm512_cvtepi32_epi16`)
and NEON's `xtn`/`xtn2` are **truncating converts of a single source vector**,
with lane-sequential output by construction — there is no second source
vector to interleave against, so there is no lane-crossing quirk to correct
for. `packus` (`vpackuswb`, AVX512's `_mm512_packus_epi16`) is a *different*
instruction class: it takes **two** source vectors and narrows both into one,
which is exactly the operation that has the fixed hardware interleave SF's
permutation compensates for. Our kernel never reaches for it, because our
narrow only ever has one live source vector at a time (`prod`, after the
clamp/mul/add/shift chain) — there's nothing to interleave.

`grep -niE 'permut|scrambl|packus' src/nnue_net.cpp src/nnue_accumulator.cpp
src/nnue_eval.cpp` returns nothing, confirming this isn't merely absent from
that one function — none of the three files touch the concept anywhere.
`dot_u8i8` (the int8 L1 dot, our fc_0 analogue) doesn't narrow at all; it
*widens* via `_mm512_dpbusd_epi32`/`vdotq_s32`, consuming `aq[]` in the
natural order the pairwise step already produced.

## Verified against the actual emitted code, both arches

Per the task's own instruction not to trust source-reading alone, all three
live code paths were checked at the instruction level.

**1. Explicit AVX512 intrinsics tier**, cross-compiled standalone with
`clang++ -target x86_64-apple-darwin -mavx512bw -mavx512vl -O3 -S` (this
Mac's clang has an x86_64 backend registered even though the host is arm64;
this checks instruction selection, not runtime behavior — no amd64 timing is
implied anywhere in this doc):

```
vpmaxsw / vpminsw   (clamp)
vpmullw             (exact 16-bit product)
vpaddw               (+256)
vpsrlw $9            (>>9)
vpmovwb              (narrow 32×u16 -> 32×u8)   <- the only narrow, sequential
```

Zero `vpackuswb`, `vperm*`, `vpshufb`, or any other lane-crossing/shuffle
instruction anywhere in the function body.

**2. The real, shipped arm64 binary** (`objdump -d --demangle ./zugzwang`,
this Mac's actual native `-mcpu=native` build), inside
`NNUE::eval_from_halves`:

```
smax.8h / smin.8h    (clamp)
mla.8h                (multiply-accumulate: prod + 256 in one op)
ushr.8h $9            (>>9)
xtn.8b                (narrow 8×u16 -> 8×u8)     <- sequential truncating narrow
```

This is the explicit NEON `pairwise_u8_block` tier (only live when
`PAIRSIMD=1`; the disassembly shows it compiled in and reachable via the
runtime `pairsimd_enabled()` branch, matching the source exactly, op for op).

**3. The scalar fallback** (what actually ships by default — see below) —
found immediately after the NEON tier in the same disassembled function,
autovectorized by the compiler from the plain per-element `pairwise_u8()`
loop. This one is worth calling out explicitly because it's *not* a hand-
written SIMD tier — the compiler built it unprompted, the same phenomenon
Wave 7 §1 found for the SF backend's scalar loops on amd64/GCC:

```
umin.8h / cmge.8h+and   (clamp, compiler's own idiom for it)
mul.8h                   (16-bit product)
uaddw/uaddw2.4s          (widening +256, into 32-bit lanes)
ushr.4s $9                (>>9, now at 32-bit width)
tbl.16b  {v16,v17,v18,v19}, v2   (narrow 16×i32 -> 16×u8 across 4 registers)
```

The `tbl` here IS a general-purpose table-lookup/permute instruction — but
it is being used to implement a **sequential** narrow (byte 0 of each 32-bit
lane, in original order), driven by a fixed compile-time constant mask
(loaded from `.rodata` at a fixed offset, not data-dependent). It has to
exist because NEON has no single instruction that narrows 4 separate 128-bit
int32 registers into one 128-bit int8 register the way `xtn`/`xtn2` chains
do for a 2-register case — the compiler reached for `tbl` as its narrowing
primitive at this width, not to reorder anything. That it produces the
*same* output as the byte-for-byte scalar loop is guaranteed by
autovectorization correctness, and is exactly what `test/golden_check.sh`
(38/38) and the `ASSERT=1` accumulator oracle would catch if it weren't true.
Cross-checked the same way on x86_64 (`clang++ -target x86_64-apple-darwin
-mavx512bw -O3 -S` on the plain scalar loop, no explicit intrinsics): the
autovectorizer there also widens to 32-bit lanes and narrows via `vpmovdb`
("move packed dword to byte") — again a truncating convert, not `vpackuswb`.
Full instruction histogram from that build: `vpmovzxwd`, `vpminuw`,
`vpandnq`, `vpmullw`, `vpaddd`, `vpsraw`/`vpsrld`, `vpmovdb`,
`vextracti64x4` — zero occurrences of `vpackuswb`/`vperm*`/`vpshufb`.

## The arm64-is-inert caveat, stated as the task asked

Per the task's own framing: SF's `PackusEpi16Order` itself returns the
identity permutation on non-AVX2/AVX512 builds, because NEON's narrowing ops
don't have x86's lane-crossing quirk. Everything found above is consistent
with that — but it means the arm64 evidence in §2 and §3 above, while
confirming "no packus-class narrow exists here," would say **nothing** about
whether the optimization pays even if our kernel *did* use `packus`, since
NEON never needed correcting for it in the first place. That's not the
reason this doesn't apply, though — the reason is structural (single-source
truncating narrow throughout, on both arches, confirmed by the x86_64
cross-compiled AVX512 evidence in §1 and §3's tail, not merely inferred from
the arm64-only binary). No amd64 timing was run or is claimed anywhere here.

## One more reason it wouldn't be a win even if adopted

Wave 7 explains why SF's own AVX512 tier (and the SF-backend's original,
pre-Wave-7 tier) benefits: `packus` narrows **two** source vectors into one
in a single instruction — SF's own combine gets ~15 vector ops per 64 output
elements. Our `pairwise_u8_block` already narrows from a **single** source
vector per call (`_mm512_cvtepi16_epi8`, 32 outputs per call) using a
cheaper truncating instruction than `packus` would even need — counting the
full AVX512 tier body: 2 loads + 4 clamp ops + mul + add + shift + narrow +
store = 11 ops for 32 output elements (~0.34 ops/element), close to SF's own
ratio already. There's no `packus`-shaped inefficiency here to recover in
the first place — unlike the SF backend's *old* tier (Wave 6's
`_mm512_cvtepi32_epi16`/`_mm512_cvtepi16_epi8` int32-widen round trip, ~18
ops for 16 elements), which is what made porting `packus`+permutation a real
win there.

## Whether PAIRSIMD is even the hot path

Worth noting since it affects how much any of this matters even
hypothetically: `PAIRSIMD` defaults **off**
(`docs/PROFILING/amd/20Jul2026.md` records it measured sub-noise/negative in
that session's SPRT), so the *default* shipped binary runs the plain scalar
`pairwise_u8()` loop, autovectorized by the compiler as shown in §3 above —
not the hand-written SIMD tier at all. Either way, neither path narrows via
`packus`.

## Conclusion

No lane-order-dependent narrowing step exists anywhere in our own net's
inference path, on any of the three live code paths (explicit AVX512
intrinsics, explicit NEON intrinsics, or the autovectorized scalar
fallback), confirmed by reading the actual emitted instructions rather than
inferring from source. Stockfish's load-time weight permutation exists
specifically to compensate for `packus`'s two-source interleave; our kernel
never uses `packus`, has no interleave to compensate for, and its existing
single-source truncating narrow is already close to `packus`'s own
elements-per-instruction ratio. Step 2 (implement the permutation behind a
default-off flag, satisfy the two-loader/browser/netweb_writer hazards, run
the byte-identical/golden/ASSERT/perft/web-format gates) was not started,
per the task's own instruction to stop here when the optimization doesn't
apply. `src/sfnet_*`, `zugzwang/spsa/`, `test/sfnet_corpus*`, and
`~/sf18-arm` were not touched.
