# Run Stockfish's NNUE net inside zugzwang — our code, our search

Goal: evaluate with SF18's net inside **our** search, so we can measure how much of
the gap is net and how much is search. **No Stockfish code is linked, copied or
vendored.** We write an SF-format loader and an SF-architecture forward pass
ourselves, as a second backend selected by a switch on the loaded net file.

Sources studied: `~/sf18-arm` @ tag `sf_18` (the official SF18 release) and
`zugzwang/src/nnue_*`.

**§3 is executable, not a claim.** `zugzwang/tools/sfnet_parse.py` is a stdlib-only
reference parser that recomputes the FT hash, the arch hash and the top-level hash from
SF's rules — nothing is read out of the file and compared to itself — then walks the
whole net. Both nets pass with zero remainder:

```
$ python3 tools/sfnet_parse.py ~/sf18-arm/src/nn-c288c895ea92.nnue          # big
      feature-transformer hash           0x8f2344b8
      layer-stack (arch) hash            0x63336a4a
      top-level network hash             0xec102ef2
consumed 108,919,594 of 108,919,594 bytes; remainder 0    RESULT: PASS

$ python3 tools/sfnet_parse.py ~/sf18-arm/src/nn-37f18f62d772.nnue --small  # small
      0x7f234db8 / 0x6333712a / 0x1c103c92
consumed 3,519,630 of 3,519,630 bytes; remainder 0        RESULT: PASS
```

`--full` additionally LEB128-decodes the 23M-entry weights array (~5s). That is step 1
of §6 already banked; the C++ loader has a byte-exact oracle to be diffed against.

## 1. Shape of the change

One engine, two NNUE architectures, chosen at load time:

- `nnue_net.cpp:367` already sniffs the first bytes to pick between our web format
  (`ZUGWNNQ1`) and the headerless float32 bullet export. Add a third branch: first
  `u32 == 0x7AF32F20` → SF backend. So pointing `net.nnue` at
  `nn-c288c895ea92.nnue` is the whole user-facing switch. No env flag needed.
- `Eval::evaluate` (`eval.cpp:514`) is the single **NNUE-dispatch** point — the only
  function that runs a forward pass — so the backend branch lives there and nowhere
  else. It is *not* the only source of a node's score: since 2026-08-14 a ≤5-man node
  returns a WDL-derived value directly (`search.cpp:2769-2790`, default-on `TBWDLSF`,
  parsed `search.cpp:1166`) without calling either backend, and a DTZ-ranked root's
  *reported* score is overridden for output only (`reported_score()`,
  `search.cpp:1604-1610`). Neither needs a backend branch; both are listed so the
  single-dispatch claim isn't misread.
- Our net's code paths stay **compile-time constant and byte-identical** (see §5:
  template on an arch traits struct, instantiate ours exactly as today).

## 2. What we already have — the threat half is free

Our threat block was ported from SF and is **bit-identical to `FullThreats`**, verified
line by line:

- exclusion table: our `excl[NPT]` (`nnue_features.cpp:74-81`) ≡ SF's `map[6][6]`
  (`full_threats.h:60-67`) row for row; `numValidTargets` ≡ our `2*nvtHalf[atk]`.
- same-type dedup: SF's `semi_excluded` (`full_threats.cpp:167`) ≡ ours
  (`nnue_features.cpp:163`).
- orientation: our `make_xform` (`nnue_features.cpp:197-203`) mirrors the king into
  files a–d — identical to `FullThreats::OrientTBL` (`full_threats.h:49-58`).
- active-set enumeration: both are `attacks ∩ occupied` over both colours with the
  same pawn handling and the same own-piece-defends edges.
- refresh gate: SF's `FullThreats::requires_refresh` is the mirror bit only
  (`(ksq&0b100) != (prevKsq&0b100)`, `full_threats.cpp:331`); our `THREATGATE` path
  is the same test on the same bit, and our own header already says so
  (`nnue_features.h:96-101`).

So `active_features()`'s threat half **and** the `changed_edges_delta()` / THREATDELTA
incremental machinery drive the SF net's threat weights unchanged. The only edit is
the `+PsqSize` offset (12288 for our net; SF's threat block is its own 0-based
79856-wide space with its own weight array) — make it arch-dependent.

**Watch out:** SF uses **two opposite mirror conventions**. `FullThreats` canonicalises
the king to files a–d (what we do); `HalfKAv2_hm` canonicalises it to files e–h
(`half_ka_v2_hm.h:92-101`). The new base half must use the opposite sense from our
existing transform. Sharing one `PerspXform` across both blocks — which is correct for
our net — is wrong for SF's.

## 3. What must be written (SF backend)

### 3.1 File format — exact, validated

Header, 96 bytes: `u32 version = 0x7AF32F20`, `u32 hash = 0xEC102EF2`,
`u32 descLen = 84`, then 84 description bytes.

LEB128 framing, per call: 17 ASCII bytes `COMPRESSED_LEB128` (no NUL — the source's
`sizeof(literal)-1`), `u32 byteCount`, then that many bytes of signed-LEB128 payload.
One call can fill several arrays back to back from one bitstream with no re-framing.
Decode loop (`nnue_common.h:185-207`), note `shift % 32`:

```
result = 0; shift = 0
byte = next()
result |= (byte & 0x7f) << (shift % 32)
shift += 7
if !(byte & 0x80):
    value = (shift >= 32 || !(byte & 0x40)) ? result : result | ~((1 << shift) - 1)
```

Feature transformer (big net, `HalfDimensions = 1024`), in order. "payload" is the
LEB128 byte count the frame declares; a framed array costs `payload + 21` on disk
(17 magic + 4 length):

| # | array | type | count | encoding | payload | on disk |
|---|---|---|---|---|---|---|
| — | sub-header hash `0x8F2344B8` | u32 | 1 | raw | — | 4 |
| 1 | `biases` | i16 | 1024 | LEB128 | 1,245 | 1,266 |
| 2 | `threatWeights` | **i8** | 79856×1024 = 81,772,544 | **raw LE, uncompressed** | — | 81,772,544 |
| 3 | `weights` | i16 | 1024×22528 = 23,068,672 | LEB128 | 25,529,964 | 25,529,985 |
| 4 | `threatPsqtWeights` **then** `psqtWeights` | i32 | 638,848 + 180,224 | LEB128, **one call, one blob** | 1,474,558 | 1,474,579 |

Measured value ranges, useful as a loader sanity check: `biases` [−207, 162],
`threatWeights` [−128, 127], `weights` [−719, 900], `threatPsqtWeights`
[−4575, 4749], `psqtWeights` [−45382, 43060].

The FT sub-header hash is not a magic number to hardcode — it is
`FullThreats::HashValue ^ (HalfDimensions * 2)` = `0x8F234CB8 ^ 2048` = `0x8F2344B8`
(`nnue_feature_transformer.h:126-130`, `full_threats.h:41`). The small net's is
`HalfKAv2_hm::HashValue ^ 256` = `0x7F234CB8 ^ 256` = `0x7F234DB8`. The header hash is
`FT hash ^ arch hash`, so it moves with either.

Then 8 layer stacks, each: `u32 hash = 0x63336A4A`, then raw little-endian
(never LEB128):

| layer | in | out | padded in | biases | weights |
|---|---|---|---|---|---|
| `fc_0` | 1024 | 16 (= L2+1) | 1024 | 16×i32 | 16×1024 i8 |
| `ac_0` | — | — | — | 0 bytes | 0 bytes |
| `fc_1` | 30 | 32 | 32 | 32×i32 | 32×32 i8 |
| `ac_1` | — | — | — | 0 bytes | 0 bytes |
| `fc_2` | 32 | 1 | 32 | 1×i32 | 1×32 i8 |

Per stack 17,640 bytes; ×8 = 141,120. Total `96 + 108,778,378 + 141,120 = 108,919,594`.

`ac_sqr_0` is in neither the read chain nor the **hash** chain — `Arch::get_hash_value`
(`nnue_architecture.h:74-86`) folds fc_0, ac_0, fc_1, ac_1, fc_2 and skips it, even
though `propagate` runs it. Ignore `permute_weights()` /
`PackusEpi16Order` and `get_weight_index_scrambled()` entirely — both are in-memory
SIMD layout tricks; the file is always natural row-major, and `write_parameters`
un-permutes before writing, so this holds regardless of which CPU produced the file.

### 3.2 Base features — new code

```
flip  = 56 * perspective
index = (s ^ OrientTBL_e2h[ksq] ^ flip)
      + PieceSquareIndex[perspective][pc]
      + KingBuckets32[ksq ^ flip]
```
- `OrientTBL_e2h`: files a–d → 7 (mirror), e–h → 0. Opposite of ours.
- `KingBuckets32[64]`: 32 buckets, `B(v) = v*704`, indexed by the **un-mirrored**
  `ksq ^ flip` (ours buckets on the already-mirrored square — different basis, not
  just a different count).
- `PieceSquareIndex`: 11 planes of 64 = 704, with **one shared king plane for both
  colours** (ours has 12 full planes).
- refresh: SF rebuilds the base on **any** king move of that perspective, no
  bucket-aware cheap path. Coarser than ours; don't port our bucket-key logic here.

### 3.3 Accumulators — new shapes

Per perspective, **two** feature sets each with their own state:
`accumulation int16[1024]` and `psqtAccumulation int32[8]`, once for PSQ and once for
threats. Row strides: 1024 for `weights`/`threatWeights`, 8 for both psqt arrays.

- PSQ accumulation seeds from `biases[]`. **Threat accumulation seeds from zero — there
  is no threat bias array.** Both psqt accumulators seed from zero; there is no psqt
  bias at all.
- Excluded threat features legitimately return the sentinel `79856`; skip them
  (`if (idx < 79856)`), never index with it.

### 3.4 Forward pass — scalar reference

```
bucket = (popcount(occupied) - 1) / 4                      # 0..7, picks psqt column AND layer stack
persp  = [side_to_move, ~side_to_move]

for p in 0,1:                                              # own block first, bytes [0,512)
  for j in 0..511:
    s0 = clamp(acc[persp[p]][j]       + thr[persp[p]][j],       0, 255)   # BIG net: 0..255
    s1 = clamp(acc[persp[p]][j+512]   + thr[persp[p]][j+512],   0, 255)
    ft[512*p + j] = uint8( unsigned(s0*s1) / 512 )

psqt = psqtAcc[persp[0]][bucket] - psqtAcc[persp[1]][bucket]
psqt = (psqt + thrPsqt[persp[0]][bucket] - thrPsqt[persp[1]][bucket]) / 2

fc0[i] = b0[i] + Σ_{j<1024} w0[i][j] * ft[j]               # i = 0..15, int8 × uint8 → int32
sq[i]  = min(127, (fc0[i]*fc0[i]) >> 19)                   # 2*WeightScaleBits+7
cr[i]  = clamp(fc0[i] >> 6, 0, 127)
in1    = [ sq[0..14] , cr[0..14] ]                         # 30 values, padded to 32 with 0
fc1[o] = b1[o] + Σ_{i<30} w1[o][i] * in1[i]                # o = 0..31
a1[o]  = clamp(fc1[o] >> 6, 0, 127)
fc2    = b2 + Σ_{i<32} w2[i] * a1[i]
fwd    = fc0[15] * 9600 / 8128                             # = *150/127, one mul then one truncating div
positional_raw = fc2 + fwd

return ( psqt / 16 , positional_raw / 16 )                 # OutputScale = 16
```

Neuron 15 of `fc_0` is the linear bypass: its activations are computed and thrown
away, only its raw pre-activation value feeds `fwd`. Only neurons 0–14 enter `fc_1`.

### 3.5 Eval post-processing

The net returns a **pair**, and the blend is part of its strength — port it
(`evaluate.cpp:53-90`):

```
nnue = (125*psqt + 131*positional) / 128
complexity = |psqt - positional|
optimism += optimism * complexity / 476
nnue     -= nnue * complexity / 18236
material  = 534*pawnCount + nonPawnMaterial          # SF units, PawnValue = 208
v = (nnue*(77871+material) + optimism*(7191+material)) / 77871
v -= v * rule50 / 199
```

Then convert SF `Value` units to our cp. Our search margins (RFP, razoring, futility,
aspiration) all read `Eval::evaluate` directly, so the scale has to land on ours.
Fit `zug_cp = k · v` on a corpus and check residuals at large |v| — if a single `k`
doesn't hold, that is itself a result about our net's railing, not a fitting problem.
Do **not** use SF's `to_cp` (phase-dependent cubic divisor) — it would make the eval
scale move with material under margins that assume it doesn't.

**Three** of these terms already exist on our side, all applied in `corrected_eval`
(`search.cpp:1856-1871`) — don't port any of them twice:

- `RULE50DAMP` (default **on**, parsed `search.cpp:1133`, applied `1865`):
  `v -= v * rule50_count() / 199` — already exactly SF's formula.
- `OPTIMISM` (default **off**, parsed `search.cpp:1146`, `optimism_term` at
  `1839-1849`, applied `1867`):
  `optimism = scale*avg/(|avg|+stretch)`, then a material-weighted term.
- `EVALCOMPLEXITY` (default **off**, parsed `search.cpp:1135`, applied `1863`):
  `v -= v*|corr|/2600`, using the correction-history residual as a complexity proxy
  **because our single-scalar net has no `psqt`/`positional` pair to difference**.
  With the SF backend we get the real `|psqt - positional|` for the first time — so
  this is the one term to reimplement rather than reuse, and `EVALCOMPLEXITY` must
  stay off for that backend.

Start with `optimism = 0`, then port SF's `142*avg/(|avg|+91)` from our root average
score as a second step.

Unrelated but easy to misread: `zug_tb.cpp:234-237` remaps SF's tbScore magnitudes
onto our pawn=100 scale. That code never touches `Eval::evaluate`, so it has no
interaction with the `k` fit above — nothing to coordinate.

## 4. What SF's net has that ours doesn't — the reason to do this

| | ours | SF18 big |
|---|---|---|
| FT width | 512 | 1024 |
| base | 16 buckets × 768 | HalfKAv2_hm, 32 × 704, shared king plane |
| threats | 79856, **i16** weights | 79856, **i8** weights |
| **psqt head** | **none** | **8-bucket i32, twice (base + threats), averaged** |
| tail | D2=16 → D3=32 → 1 | 15 outputs **+ a 16th linear bypass to the output**, sqr-relu‖relu → 32 → 1 |
| output | one cp scalar | pair `(psqt, positional)` |

Our eval goes blind once a side is up about a piece — the D2=16 SCReLU rails and the
output becomes a per-bucket constant, which is why `SATSOFT`/`SATFIX`/`MATGRAD` exist
at all. The psqt head and the fc_0 bypass are **linear channels that cannot
saturate**: when SF's deep path rails, its eval still moves with material. If that is
the mechanism, this experiment proves it before the August retrain, and the fix is an
architecture change to our own net rather than more mitigations.

## 5. Our-side refactor (minimum churn)

Every dimension is currently a namespace-scope `constexpr` in `nnue_arch.h:11-21`
(`InputDim=768`, `NumKingBuckets=16`, `PsqSize=12288`, `ThreatBlock=79856`,
`InputTotal=92144`, `H=512`, `D2=16`, `D3=32`, `NB=8`) — that file is what the traits
struct replaces. They are used as array bounds throughout: `Slot::w[H]/b[H]`
(`nnue_accumulator.h:97-98`), `FinnyEntry::acc[H]` (`:222`), `Net`'s vectors sized
`InputTotal*H`, `NB*D2*H`, … (`nnue_net.h:13-24`), and `constexpr half = H/2`, `float
l1[D2]`, `uint8_t aq[H]`, `int16_t accW[H]` in the kernels (`nnue_eval.cpp:211,237,
267,295,618-634,694,767-768`), plus `static_assert(H%8==0)`
(`nnue_accumulator.cpp:163,172`).

Wrap them in an arch traits struct and template `Net`, `AccStack::Slot` and the
kernels on it:

```cpp
struct ArchZug { static constexpr int H=512,  D2=16, D3=32, NB=8,
                                      PsqSize=12288, InputTotal=92144,
                                      PsqtBuckets=0; };
struct ArchSF  { static constexpr int H=1024, L2=15, L3=32, NB=8,
                                      PsqSize=22528, ThreatDim=79856,
                                      PsqtBuckets=8; };
```

`AccStack<ArchZug>`/`Net<ArchZug>` generate the same code as today (single
instantiation with fully-constexpr bounds), so our net stays byte-identical and the
ASSERT oracle (`nnue_accumulator.cpp:750-768`) comes along per instantiation for free.
`ArchSF` adds the psqt lanes ours doesn't have.

**How `Position` holds either accumulator is the one real design question, and the
sketch above doesn't answer it.** `position.h:88-89` declares a concrete
`NNUE::AccStack* nnueAcc`, but `AccStack<ArchZug>` and `AccStack<ArchSF>` are
different types and the backend is a *load-time* choice. Do **not** solve it with a
virtual base: `nnueAcc` is touched on every `do_move`/`undo_move`, and an indirect
call there taxes our net's hot path to serve an experiment. Carry two typed pointers
instead, exactly one non-null — a perfectly-predicted branch per move, no indirect
call, and our net's generated code is unchanged.

Dispatch points that need a backend branch:

- `load_net()` third magic branch — `nnue_net.cpp:367-376` (our 8-byte ASCII
  `ZUGWNNQ1` can't collide with SF's 4-byte LE `0x7AF32F20`)
- `Eval::evaluate` — `eval.cpp:514`. Keep `SATFIX` (`eval.cpp:480-483,521-529`),
  `HCEBLEND` (`:385-391,531`) and `MATGRAD` (`:344-347,530`) **off** for the SF
  backend — they are calibrated to our net's saturation. `SATSOFT` needs no
  switch: it lives inside our own forward-pass kernel (`nnue_eval.cpp:135-141,
  641-712`), which the SF backend never calls.
- `Position`'s accumulator pointer — `position.h:88-89`, and the seven call sites
  that drive it: `position.cpp:496-499, 503, 584, 588, 618, 622`
- `zug_tb.cpp:178-179, 266` — `TB::rank_root_moves` saves `nnue_acc()`, nulls it,
  walks the root moves with real `do_move`/`undo_move`, then restores. Added
  2026-08-14. Backend-agnostic as written, but it has to keep compiling against
  whatever `nnueAcc` becomes.
- startup loads — `serve.cpp:190`, `uci.cpp:306`, `ratingtest.cpp:81`
- `fill_board_snapshot` (`position.cpp:324`) is board-state only — no branch needed

## 6. Validation ladder — pass each before the next

1. **Parse** — **DONE**, and reproducible: `python3 tools/sfnet_parse.py <net>` consumes
   exactly 108,919,594 bytes with zero remainder and matches all three recomputed
   hashes; `--small` does the same for the 3,519,630-byte small net. The C++ loader's
   test is "agree with this script array for array", not a fresh investigation.
2. **Per-position numbers**: `stockfish`'s `eval` prints a per-bucket table with
   Material (psqt) and Positional (layers) columns, taken straight from
   `trace_evaluate` *before* any post-processing. Those printed values pass through
   `to_cp`, a material-dependent cubic divisor, and are rounded to whole centipawns —
   so reimplement `win_rate_params`/`to_cp` for the comparison, and accept ±1cp. For
   bit-exact checking, patch a **private throwaway copy** of SF to dump the raw ints;
   don't touch `~/sf18-arm`.
3. **From-scratch eval over a FEN corpus** agrees position by position.
4. **Incremental** (our AccStack + reused threat delta) is byte-identical to
   from-scratch under `ASSERT=1`.
5. Only then wire it into search.

## 7. SPRT matrix

Both nets are on disk: `~/sf18-arm/src/nn-c288c895ea92.nnue` (big, 104 MB) and
`nn-37f18f62d772.nnue` (small, 3.4 MB), plus a built arm64 `stockfish`.

| # | match | regime | answers |
|---|---|---|---|
| 1 | zug+SFnet vs zug+ournet | fixed depth (d8) | net quality alone, speed removed |
| 2 | zug+SFnet vs zug+ournet | movetime / real TC | net quality net of its cost |
| 3 | zug+SFnet vs `stockfish` | matched TC, 1 thread | search vs search on the same net |
| 4 | zug+ournet vs `stockfish` | matched TC, 1 thread | the total gap (baseline) |

3 and 4 decompose the gap. Confounds to state alongside any number:

- SF's search consumes the pair plus complexity and optimism natively; ours consumes
  one rescaled scalar under margins tuned to our own distribution. Test 3 is
  directional.
- SF switches to the small net at `|simple_eval| > 962` and re-evaluates with the big
  net when the small one returns `|nnue| < 277` (`evaluate.cpp:49,66-72`). We start
  big-net-only; say so with the numbers, and add the small net later. Its shape is
  parsed and confirmed: HalfKAv2_hm only, `HalfDimensions = 128`, no threat arrays,
  same 15/32/8 tail, `fc_0` in 128 → out 16, 3,304 B per stack. Two differences that
  are not optional — the FT clamp is `0..127*2` instead of `0..255`, and
  `scale_weights(true)` doubles `weights` and `biases` on read. Both fire **only** in
  the `!UseThreats` branch and must never touch the big net.
- SF's net was trained on SF self-play for SF's search. "Stronger in SF" does not
  imply "stronger in ours" — the difference between tests 1 and 3 is exactly that.
- Speed: ~128 MB of weights touched (82 MB int8 threats + 46 MB int16 base) against
  our 512-wide net. Expect a real NPS loss; that is part of the answer, not a flaw.

## 8. Order of work (~4–7 days)

1. Loader + scalar from-scratch forward pass, validated to steps 1–3 above. This is
   the bulk of the new code and is testable with no search involvement. Step 1 is
   already banked (`tools/sfnet_parse.py`), so the loader starts against a working
   oracle rather than against the spec.
2. Arch templating of `Net`/`AccStack`/kernels; our net proven byte-identical.
3. Incremental path: reuse the threat delta as-is, write the base half's refresh
   (SF's coarser any-king-move rule), prove step 4 under `ASSERT=1`.
4. Eval post-processing + scale fit; then tests 1–4 on coalla.
5. Feed the result into the August retrain: if the psqt head and the bypass explain
   the rail collapse, that is an architecture change to *our* net — which was the
   point.

## 9. Note

The `.nnue` weights are GPLv3 data from the Stockfish project. Loading one locally
for measurement is unencumbered; shipping one in prod would be a distribution
question, and shipping SF's net was never the goal.
