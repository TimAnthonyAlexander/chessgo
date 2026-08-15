# SF-net Wave 2 — from-scratch forward pass, as-built notes

Implements `src/sfnet_eval.cpp` (`SFNet::evaluate_raw`, `SFNet::self_check`) per
`docs/tasks/open/sf-net-experiment.md` §3.2-3.4 and the Wave 2 task spec. Scalar
reference only — no incremental accumulator, no SIMD, no search wiring. This file
records what the written spec got wrong or left ambiguous, resolved against
`~/sf18-arm/src` directly (read-only reference, never modified).

## 1. The `KingBuckets` table's prose contradicted its own example

The task spec described the 32-bucket table as "read rank 8 down to rank 1
(...where the first row is a1..h1)" — that sentence is self-contradictory (rank 8
first, but "first row is a1..h1" is rank 1). It also gave an unambiguous fallback:
"Transcribe it so `KingBuckets[A1] == 28*704`."

Checked directly against `~/sf18-arm/src/nnue/features/half_ka_v2_hm.h:75-85`:
`KingBuckets[SQUARE_NB]` is indexed by SF's raw `Square` enum, numbered identically
to ours (`SQ_A1=0 .. SQ_H8=63`). The literal table's first listed row
(`28,29,30,31,31,30,29,28`) is therefore indices 0-7, i.e. squares A1..H1 — so the
"first row is a1..h1" / `KingBuckets[A1]==28*704` framing is the correct one, and
the "rank 8 down to rank 1" phrase should be ignored. Implemented as a direct
row-major transcription of the literal table (`sfnet_eval.cpp`'s `bucketOf[]`),
confirmed against the source file rather than re-derived.

## 2. `BB::init()` / `Zobrist::init()` are a silent prerequisite, not mentioned anywhere

Neither the experiment doc nor the Wave 2 task spec mentions that constructing and
`set()`-ing a `Position` requires `BB::init()` (magic-bitboard attack tables) and
`Zobrist::init()` (hash keys) to have run first. Wave 1's `sfnet_load_test` never
constructs a `Position`, so this never came up there. Omitting it here produced a
segfault inside `Position::set_check_info()` → `attackers_to()` →
`BB::rook_attacks()` reading through a null `Magic::attacks` pointer — not a bug in
the forward pass itself, just an uninitialized global table. Fixed by calling both
in `sfnet_eval_test.cpp`'s `main()`, mirroring `nnue_web_format_test.cpp` and
`secretqueen_test.cpp`'s existing convention. Worth flagging for whatever wave wires
this backend into `serve`/`uci`/`ratingtest`, since those already call `BB::init()`
at startup for the existing net — nothing new is needed there, but a future
*standalone* SFNet tool would need the same reminder this test needed.

## 3. The `fwd` bypass multiply is genuinely int32, overflow and all — confirmed, not fixed

The spec says `fwd = fc0[15] * 9600 / 8128`, "one multiply then one truncating
divide, in that order, in int32." That is worth double-checking because the
multiply *can* overflow int32 in the worst case (`fc0[15]` bounded by
`1024 * 127 * 255 ≈ 3.3e7` in the extreme, `× 9600 ≈ 3.2e11`, ~150× int32 range).
Checked `~/sf18-arm/src/nnue/nnue_architecture.h:133-137`: SF computes this exact
expression as `std::int32_t fwdOut = (buffer.fc_0_out[FC_0_OUTPUTS]) *
(600 * OutputScale) / (127 * (1 << WeightScaleBits));` — plain 32-bit arithmetic,
in shipped production Stockfish. Reproduced verbatim rather than "fixed" to int64:
matching SF's actual arithmetic (including its latent overflow behaviour on an
adversarial net) is the point of a byte-exact reimplementation, and in practice a
trained net's `fc0[15]` sits nowhere near the extreme bound. If a comparison against
a private SF oracle ever shows a Value-unit mismatch on a real FEN, this line is the
first place to check.

## 4. Everything else matched the written spec on direct verification

Cross-checked against source and found no other discrepancies:
- `PieceSquareIndex[COLOR_NB][PIECE_NB]` plane layout and the "W = us, B = them"
  convention (`half_ka_v2_hm.h:44-58`) — matches exactly.
- `OrientTBL` = 7 for files a-d, 0 for files e-h, indexed by the *raw* (un-flipped)
  king square, used together with `KingBuckets[ksq ^ flip]` in `make_index`
  (`half_ka_v2_hm.cpp:31-34`) — matches; built the orient table programmatically
  (file-only) rather than transcribing 64 entries, since it's provably rank-
  independent from the source table itself.
- Feature-transformer pairwise clamp+multiply (`clamp(sum+sumT,0,255)`,
  `unsigned(s0*s1)/512`) and the psqt own-minus-enemy-then-average-with-threats
  formula (`nnue_feature_transformer.h:229-403`) — matches exactly, scalar branch.
  used the `UseThreats` scalar path as the reference (not the SIMD path, which is
  provably equivalent per the comments explaining the packus/shift trick).
- `bucket = (popcount(pieces())-1)/4` selecting both the psqt column and the layer
  stack, and the final `/OutputScale` split (`network.cpp:184-188`) — matches.
- `sq[i] = min(127, (int64)fc0[i]^2 >> 19)`, `cr[i] = clamp(fc0[i]>>6, 0, 127)`, and
  neuron 15 being computed only for `fwd` and never entering `fc_1`'s `in1` — matches
  `layers/{sqr_clipped_relu,clipped_relu}.h` and `nnue_architecture.h`'s `propagate()`
  exactly.

## What this wave does NOT establish

No comparison against Stockfish's own numbers was done or claimed — that needs an
independent SF-side oracle (private throwaway SF patch dumping raw ints, per
§6 step 2 of the experiment doc), which is a separate task. `self_check()` verifies
only structural invariants (feature counts, index bounds, forward pass completes) —
it cannot and does not claim the *numbers* are correct.
