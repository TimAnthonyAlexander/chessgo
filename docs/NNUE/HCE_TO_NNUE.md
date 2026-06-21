The thing to hold onto: converting HCE to NNUE barely touches your search. Alpha-beta, pruning, move ordering, transposition table, tablebases all stay. The eval's *interface* stays too: a function from a position to a centipawn score. What changes is the eval's internals, plus you grow a whole offline training pipeline next to the engine. And one structural thing breaks that's worth flagging up front: the eval stops being stateless.

**1. The interface contract stays, the internals get replaced**

Your HCE is `eval(pos) -> cp`, computed as a sum of named terms (material, PSQT, mobility, king safety, your passer terms). NNUE keeps the same signature and return units. Everything downstream of eval is untouched. So this is a swap behind a stable boundary, which is what makes it tractable: you can keep HCE compiled in as a fallback and a correctness oracle while you build the replacement.

**2. Representation: from terms you wrote to features data fills in**

HCE encodes knowledge as coefficients on features you hand-picked. NNUE encodes the position as a giant sparse binary vector and lets training pick the coefficients. The classic feature set, HalfKP, indexes every `(your king square, piece type, piece square)` triple: 64 × 10 × 64 = 40,960 features per side, of which ~30 are ever 1 (one per non-king piece). You build it twice, once from each side's perspective. Modern Stockfish uses HalfKAv2_hm (kings included as pieces, board horizontally mirrored so the king's half folds in) with 82,672 features in SFNNv13, of which only a tiny fraction are active at any time. The whole point of the design is input sparsity around 0.1%, which is what lets the first layer be enormous yet fast.

**3. The forward pass, as math**

The first layer ("feature transformer") is an affine map `a = A₀·x + b₀`, but because `x` is sparse you never do the full matmul. `A₀·x` is just the sum of the columns of `A₀` for the active features, so the layer output is "bias plus the weight-columns of the on-features." Call that the **accumulator**. It has a white-king half and a black-king half, each a vector of int16 (256 wide in the classic net), equal to the sum of the active feature weights plus a bias vector. You concatenate the two halves with side-to-move first, giving a "me vs them" frame regardless of whose turn it is.

After that: ClippedReLU (clamp to [0,1] in float, [0,127] in int), then 2-3 tiny dense layers. The classic Stockfish shape is 256-per-side accumulator, transformed to a 512-wide int8 vector, then 512×32, 32×32, 32×1, ending in one scalar you rescale to centipawns. Modern nets keep this skeleton but widen the first layer into the thousands, add **output buckets** (pick one of several small head sub-networks by piece count, so the heads specialize by game phase), and a **PSQT side output**: a piece-square-table-style value read straight off the accumulator and added to the result, giving a fast material baseline that survives from the HCE world conceptually.

**4. The stateful accumulator: the real intrusion into your engine**

This is the part with no HCE analogue and the main engineering cost. Because the first-layer output is a sum of active-feature columns, and a move flips only a few features, you don't recompute it. You carry the accumulator forward: `a' = a + Σ columns(added features) − Σ columns(removed features)`. A quiet move is one add and one subtract, a capture ~three. So the eval now has state that the search must maintain: make-move pushes the delta, unmake pops it, exactly mirroring how you already push/pop board state. The exceptions are king moves: since features are king-relative, moving your own king flips every feature on that side, so you can't patch and must **refresh** (recompute that half from scratch), which is why people add accumulator-refresh caches. Build a hard invariant test: the incrementally-maintained accumulator must equal a from-scratch recompute at every node. Getting this wrong produces silent eval corruption that looks like a search bug.

**5. Quantization: the Stockfish scheme, exactly**

You run in integers for two reasons: int8/int16 SIMD throughput, and determinism (float deltas would accumulate rounding error across millions of make/unmake on a persistent running sum). The scheme:

- Feature transformer: since it's a purely additive process, multiply weights and biases by 127, store int16. The accumulator is int16 because it sums up to ~30 rows and must not overflow.
- Hidden layers: scale weights by 64 and store int8, so the max float weight is 127/64 ≈ 1.984, and you must clamp weights during training so they stay in range. Dot products accumulate in int32, then scale back.
- ClippedReLU does the int32/int16 → int8 conversion, clamping to [0,127]. For the multiply layers you'd divide by 127 to preserve range, but in practice divide by 128, producing [0,126].
- PSQT outputs: int32, scaled by 9600 = 600 × 16 (the Ponanza constant times FV_SCALE).
- Final scalar is divided by FV_SCALE (16) and mapped to centipawns.

Pragmatically, do float first. A float NNUE eval is simpler to get correct; quantize only once it plays and the invariant holds, then re-verify.

**6. The training loop replaces your Texel/SPRT tuning loop**

HCE tuning fits a handful of coefficients. NNUE training fits the whole net offline on tens of millions of positions. Each position gets a target that blends a teacher evaluation (a centipawn score from a deep search, squashed to a win probability by a sigmoid) with the actual game result, mixed by λ: `target = λ·sigmoid(cp_teacher/scale) + (1−λ)·result`. The model's scalar is also pushed through a sigmoid, and the loss is MSE or cross-entropy in win-probability space. Optimize the float net with Adam in any trainer (PyTorch, Bullet), clamping weights to the quantization ranges and using feature factorization (virtual coarse features that many real features share, coalesced back in before serialization, so inference pays nothing). Then quantize and serialize to a net file the engine memory-maps at load. Fitting win-probability rather than raw cp is the same lesson as good HCE tuning generalized: eval-fit is not strength.

**7. The order a conversion actually goes**

Keep HCE compiled in. Add a float NNUE eval and wire the accumulator into make/unmake; verify the recompute invariant. Train a first net (your own search or HCE can be the initial teacher, or use Stockfish-labeled data or a public dataset). SPRT NNUE-float vs HCE. Quantize to int8/int16, re-verify, re-SPRT. Then grow: bigger first layer, richer features (HalfKA, then mirroring, then threat inputs), output buckets, PSQT side output. Last, SIMD the two hot loops, accumulator update and the first dense layer, which are where nearly all the runtime lives.

**8. What dies, what survives**

Material, PSQT, mobility, term-by-term tuning, and your MG/EG taper all dissolve into the net (phase handling becomes the net plus piece-count buckets; PSQT survives as the side output). Untouched: search, move ordering, transposition table, tablebase probing, time management. You're replacing the judge, not the calculator.
