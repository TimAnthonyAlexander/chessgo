NNUE is a neural network co-designed with the search so that almost all the work is reused from one position to the next. It's an architecture that takes advantage of having minimal changes in the network inputs between subsequent evaluations. Everything about its shape is dictated by one constraint: it has to run as a real-time CPU evaluation at millions of evals per second per thread, which forces sparsity and integer math. Three ideas make that possible.

**1. The input: a giant sparse binary feature vector**

A position isn't fed as 64 squares. It's fed as a huge binary vector where each index is one specific fact like "piece of type T sits on square S, given my king is on square K." The classic feature set is HalfKP. All 64 king positions, 10 piece types (own/opponent queen, rook, bishop, knight, pawn) and their 64 squares give 40,960 input bits per side, 81,920 total. Kings are excluded from the "piece" list because they're the anchor. Of those ~41k bits, only ~30 are ever 1 at once (one per non-king piece). Current best architectures have input sparsity on the order of 0.1%.

Why king-relative and binary: it bakes the single most important positional reference (your king's location) straight into the encoding, and the extreme sparsity is exactly what lets the first layer be enormous yet cheap.

**2. The architecture, and the accumulator trick**

The net is deliberately shallow, 2 to 4 layers. The first layer (the "feature transformer") maps the 41k-wide sparse input to a dense vector, 256 in the original Stockfish, roughly 1024 to 3072 per side in modern nets. That layer holds ~99% of the weights and almost all the chess knowledge. After it sit 2 to 3 tiny fully-connected layers shrinking down to a single scalar, the eval.

Each layer is just `y = Ax + b`. Between layers the nonlinearity is **ClippedReLU**, `clamp(x, 0, 1)`. Without a nonlinearity the linear layers would collapse into one matrix; the upper clamp at 1 also keeps values in a tiny range so they fit in int8.

The "efficiently updatable" part: a linear layer on a sparse input is just "for every input bit that's on, grab that column of the weight matrix and add it." So the first-layer output is a running sum of the weight-columns of the active features. Call that sum the **accumulator**. When a piece moves only a few input neurons change, so instead of recomputing the whole layer you maintain the accumulator and incrementally update it. A quiet move flips 2 features (off old square, on new), a capture ~3, so you do `accumulator += column(added) − column(removed)`: a few vector adds instead of a full matrix multiply, pushed and popped on make/unmake.

Two caveats worth knowing. The updatable property only applies to the first layer, because once a nonlinear activation is applied you can't reuse the intermediate values. The small downstream layers are recomputed every eval, which is cheap. And because features are king-relative, moving your own king flips every feature on your side, so that perspective's accumulator can't be patched and must be fully "refreshed." King moves are the expensive case (hence accumulator-refresh caches).

One more structural point: you build the input twice, once from the side-to-move's view and once from the opponent's, and concatenate them with side-to-move first. That gives the net a consistent "me vs them" frame regardless of whose turn it is, using the same weight matrix fed mirrored inputs.

**3. Integer quantization**

It runs in integers, not floats, for two reasons. Speed (int8/int16 SIMD throughput), and determinism: engine developers avoid floating point partly to avoid floating point error, because each make/unmake incrementally updates the accumulator, so tiny rounding errors would compound across a persistent running sum. The Stockfish-style scheme: feature-transformer weights and accumulator in **int16**, hidden-layer weights in **int8**, activations clipped to [0,1] mapped onto **[0,127]**. Weights are pre-scaled by fixed constants (activation scale 127, weight scale 64) so products land in int32 without overflow, and the final scalar is rescaled back to centipawn space. The whole net is trained in float, then quantized with clamping so nothing overflows.

**Training: where the knowledge comes from**

Nothing in the eval is hand-written. You fit tens of millions of positions, each labeled with a target that blends two things: a teacher score (a centipawn eval from a deep search) passed through a sigmoid to become a win probability, and the actual game result (W/D/L). You mix them with a weight λ, then minimize MSE or cross-entropy in win-probability space with Adam. Squashing cp through a sigmoid is the point: the engine only needs the win-probability ranking right, not "+3.0 vs +3.4," so the sigmoid stops blowout scores from dominating the loss and concentrates capacity on positions where the outcome is genuinely in doubt. This is the generalized version of the cp-vs-WDL lesson: fitting the eval is not the same as gaining strength.

There's a training-only trick called **feature factorization**. HalfKP features are so specific that each is seen rarely, so learning is slow and noisy. You add coarser "virtual" features (piece-on-square ignoring the king, etc.) that many real features share, so gradient flows across related positions faster, then coalesce the virtual weights back into the real ones so inference pays nothing extra.

**Why it beats HCE**

HCE is a sum of human-named terms, so it's blind wherever nobody wrote a term and wherever the truth is nonlinear. NNUE learns an implicitly nonlinear function from data, so it carries knowledge no one programmed, including the dead zones HCE misses. The architecture is the price for running that learned function at HCE-like speed: sparsity plus the incremental first layer plus integer SIMD. The early Stockfish NNUE prototype roughly halved raw nodes per second because inference costs more than handcrafted rules, yet still produced a large Elo gain.

**Current shape, so you're not picturing the 2020 version**

Modern nets add: a much wider first layer; output bucketing (pick one of several small head sub-networks by piece count, so the late layers specialize by game phase); a PSQT side-output read straight off the accumulator and added to the result as a fast material baseline; and the **HalfKAv2_hm** feature set, which includes kings as pieces (A = all) and horizontally mirrors the board so the king's half folds in, roughly halving the feature count. The newest nets also add threat-based input features.
