**Reckless is the same paradigm as Stockfish.** It's NNUE eval plus alpha-beta search, a strong independent implementation, not a new idea. What it actually shows is that the current paradigm still has headroom: a small team can land within a few Elo of SF on equal hardware through search and engineering alone, no architectural break. Useful, because it means "NNUE + alpha-beta" isn't exhausted yet.

**Leela is the genuinely different idea.** A deep network predicting both a position value and a move-policy, MCTS instead of alpha-beta, GPU instead of CPU, the AlphaZero lineage. These engines use large networks that predict not only an evaluation but also a policy vector, a distribution over moves used to guide the search. It trades NNUE's cheap-per-eval design for a far bigger, smarter net. On equal commodity hardware SF generally leads, but Leela contests and sometimes wins top events. The honest framing is that SF-vs-Leela is partly a CPU-vs-GPU comparison, so it's a hardware-class question as much as an "is this idea better" one.

On whether something beats NNUE itself:

NNUE is a local optimum under one constraint: be a real-time evaluation on a CPU at millions of evals per second. It's the right answer to a hardware question, and that question can change. Three places a better answer comes from.

1. **NNUE mutating until it stops being NNUE.** Nets keep growing, inputs keep changing (Stockfish 18 added "threat" input features), and as nets get bigger the incremental-update trick matters less and the line between NNUE and a small GPU net blurs. The community is actively reworking inputs, loss functions and the whole design right now, with serious threads through late 2025 and early 2026 on alternative inputs, ML approaches to eval, and even why the loss is MSE. This is the most likely near-term "better," and it won't arrive as one clean replacement, it'll just drift.

2. **Searchless transformers.** DeepMind's *Grandmaster-Level Chess Without Search* (2024) reached GM level with a large transformer trained on datasets annotated by Stockfish, with no search at all. A 2025 follow-up, the Chessformer, outperforms AlphaZero in playing strength and puzzle solving with 8x less computation. These don't beat full search engines yet and they're slow-per-eval GPU models, but they prove the knowledge ceiling sits well above what NNUE currently extracts. The open question is whether that knowledge can be squeezed into something CPU-fast.

3. **Cross-pollination, which is the realistic mechanism.** Leela and these transformers mostly help by acting as teachers: their evals and games become training data for stronger NNUE nets. "Other ideas do a lot" partly by feeding the mainline rather than replacing it.

The real swing factor is hardware. NNUE exists because the assumed target is a CPU with no GPU and a tight per-node budget. If consumer GPUs or NPUs become the default engine target, the optimum shifts straight toward the Leela/transformer side and NNUE's whole reason for being weakens.

Bottom line: NNUE is the current equilibrium, not the last word. Most likely it keeps getting bigger and borrows from the transformer/Leela side until the boundary dissolves, rather than getting knocked out by one successor overnight.
