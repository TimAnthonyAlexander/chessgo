> ## STATUS (updated after the endgame push) — read this first
>
> The diagnosis below was acted on. Full write-up with SPRT numbers in
> `docs/ENGINE_STRENGTH.md §10`. Summary:
>
> **Shipped (all default-on, SPRT-gated, live in prod via the auto-loaded TB):**
> - **WDL-in-search** (`tbsearch`) — `tb_probe_wdl` at internal nodes, lock-free,
>   cursed/blessed→draw, gated off for weakened bots. **+32.7 Elo** (endgame book),
>   +29 standard-book non-reg. This was "the biggest single gap" in the brief.
> - **KingProx** (`kingprox`) — EG-only, rank-weighted, *centered* king-to-passer
>   distance (priority-1 term below). **+30.5 Elo**, per-class rook +33 / minor +36
>   / K+P +24 (no class regressed). Shipped with the **seeded** weight.
> - **PawnRace** (`pawnrace`) — EG-only **knight-aware unstoppable-passer / race**
>   term (priority-2 below — the "do I queen first?" over-optimism killer).
>   **+17.4 Elo** (mixed endgame book, TB on both sides). Acts in 6–10-man positions
>   *above* the 5-man TB boundary, so it isn't TB-masked; returns exactly 0 on the
>   diagnosed symmetric position. Seeded `PawnRaceEG=700`, not a tuner feature.
>
> **Tried and REJECTED:** the joint re-tune to fit `KingProxEG`+`PassedEG`+PSQT
> together (priority-4 plumbing). The fit was clean (`KingProxEG 4→13`,
> `PassedEG 42→57`) but the re-tuned **table** A/B'd at **≈0 vs +30** — it gave back
> the gain, most likely **TB-label over-optimism** (perfect-play 1.0 labels teach
> winnability the eval can't realize). Controls confirmed the B/R MG drift was
> data/K-refit, not KingProx. So we kept the seeded weight on the existing table.
> If revisited: **MG-anchored** re-tune (freeze piece values, tune only EG terms).
>
> **Built and kept:** the point-symmetric endgame SPRT book
> (`scripts/gen_endgame_book.py`, `data/endgame_book*.fen`), the TB-WDL EPD
> generator (`gomachine gen-tb-epd`), and EG-only taper gating.
>
> **Built but NOT shipped:** (5) EG drawishness **scale factors** (`scalefactor`,
> Stockfish-classical port) — correct + safety-guarded, but SPRT'd ~neutral with
> the TB attached (`+2.7 ± 5.4`, inconclusive): the drawish configs it fixes are the
> ≤5-man endings the TB already decides, so it only acts in a thin 6–10-man slice.
> Kept **default-off** (zero-overhead, scaffolding for a future MG-anchored re-tune).
> Lesson: **the TB masks any eval term whose payoff lives ≤5 men** — which is why
> PawnRace (acts above the boundary) registered and scale factor didn't.
>
> **NNUE — SHIPPED, default-on, +212 Elo @ movetime.** A `(768→256)×2→1` SCReLU
> net (bullet on the M3 Pro's Metal GPU, ~40 GB SF data) replaced the HCE as the
> default eval. The arc: +172 vs HCE @ fixed nodes but −156 @ movetime (a
> non-incremental float accumulator, ~100–160× HCE's eval cost) → **Phase A**
> incremental accumulator (absolute-color halves so null-move is free, ply-stack,
> Pop=`sp--`; 3.2× faster, deficit 6.9×→2.1×) → **+177.8 ± 41.5 @ movetime, H1,
> shipped default-on** → **Phase B** int16 quantization (GNN2 net, bullet ints
> verbatim, bit-exact gate; deficit →1.59×, reaches depth 15 vs HCE's 14) →
> **+212.2 ± 49.2 @ movetime, H1, shipped.** Net committed at `data/nnue/net.nnue`,
> auto-loads. Anchor with NNUE v6 on (2026-06-22): **≈2882** — band 2847–2935 vs
> SF-2700/2800/2900 (30 games @ 100ms); confirms the v6-vs-v4 +101 movetime SPRT.
>
> **NNUE v6 (512-wide) + SIMD — SHIPPED to prod.** The post-NNUE ladder
> (v5-maturity → SIMD → wider net) is now resolved, and **width was the lever**:
> - **v5 maturity net (256, 2400 SB) = dud.** Loss floored at 0.0317 = the 256
>   net's **capacity ceiling** (v4 hit it in 600 SB; v5 just took 4× longer to the
>   same floor). v5-vs-v4 @ fixed nodes **−25 ± 31 (wash)**. Reverted. More epochs
>   don't help a saturated width.
> - **v6 (512-wide)** = same arch, doubled hidden. @ fixed nodes **+124.5 ± 50 vs
>   v4** (width works). **The anneal is everything:** the un-annealed lowest-loss
>   early checkpoint scored **−96**, the final annealed v6 (HIGHER loss) **+124** —
>   a **+220 swing from the cosine anneal alone** (loss≠strength; never early-stop a
>   cosine run). @ movetime *scalar* it was a **wash (+13 ± 53)** — 512's ~2× eval
>   cost ate the edge → SIMD-gated.
> - **SIMD (`archsimd`) unlocked it.** Scalar seam (`kernels.go`) with bit-exact
>   NEON/AVX2 backends repointed in `init()`; default build stays scalar. amd64
>   AVX2 (Go 1.26.4 **stable**, `GOAMD64=v3`): per-node eval **6.5×**, dot 7×.
>   arm64 NEON (Go 1.27rc1): **4.16×**, dot 5×. With SIMD the +124 survives at
>   movetime: the v6-vs-v4 movetime SPRT firmed to **+101 Elo @ 100 ms/move**.
> - **A latent bug fixed en route:** NNUE inference was hardcoded `L1=256` (silently
>   mis-read a 512 net as garbage). Now **dynamic width** (`Net.HL`, slice
>   accumulator, importer infers width from file size) — 256 path byte-identical.
> - **Live on prod** (lairner, **amd64** Ubuntu — not ARM as once assumed):
>   `net.nnue`→v6, binary built with `GOEXPERIMENT=simd GOAMD64=v3 go1.26.4`,
>   `chessgo-deploy` hardened to the SIMD toolchain. **Net + SIMD build must ship
>   together** (v6 is a movetime wash without SIMD). Full write-up:
>   `docs/ENGINE_STRENGTH.md §11–12`, `docs/NNUE/PLAN.md`, `docs/NNUE/BULLET_SETUP.md`.
>
> **Search-feature wave — SHIPPED (2026-06-28, default-on, full write-up
> `docs/ENGINE_STRENGTH.md §13`).** Three SPRT-gated search patches landed:
> **correction history** (`corrhist`, **+66.9 @ 40k nodes** — per-pattern
> eval-error correction), **singular extensions** (`singular`, **+22.2**), and
> **frontier futility** (`futility`, **+21.3**). Fixed-nodes self-play; the bundle
> owes a movetime SPRT + fresh anchor before "~2880-class" moves (self-play
> inflation + corrhist's per-node cost). **Tried and REJECTED** (default-off): the
> cheap long tail mostly washed on our already-heavily-pruned baseline — conthist
> (flat, wiring-verified), IIR (−33.7, fired on all node types), capthist (≈−33,
> scaling), probcut/razor (flat), extra corrhist keys (flat), and **aggressive LMR
> stacked on singular (−67 anti-synergy** — each positive alone: lmr2 +9.7,
> singular +22.2). Lesson: the cheap-search-patch well is mostly dry here; the next
> search Elo is reworked-selective versions of the rejects or SPSA, not more pruning.
>
> **Still open (priority order):** (2) NMP **verification** / verified-null in
> low-material zugzwang (the simple no-non-pawn-material gate already ships; the
> re-search-on-fail-high variant does not); (7) LMP **`non_pawn_material` gate**
> (don't move-count-prune the critical pawn move in pure pawn endings) + passed-pawn
> **push extension** (6th/7th rank); (6) 50-move-clock eval damping. (The NNUE
> post-ship ladder — v5 maturity → SIMD → wider net — is now **resolved**: v5 was a
> dud, SIMD shipped, v6 512-wide shipped; next NNUE width step is 1024, now cheap
> behind SIMD.) Standalone EG centralization was dropped (folded into KingProx); the passed-pawn
> race + knight-aware rule-of-the-square (was priority-4) **shipped** as PawnRace.
>
> **Net on the original lost position vs full Stockfish:** 1.0/5 → 60% draw-hold at
> baseline, **83% with SMP+time**. The residual losses are horizon, not eval — more
> nodes ⇒ more holds. It can't *win* a dead draw, but it no longer walks into mate.
>
> ---

The lost position is point-symmetric: rotate it 180° and White maps exactly onto Black (Ke1↔Kd8, Nd1↔Ne8, a2/b2/c2↔h7/g7/f7). Two knights, two kings, each side with three connected passers on opposite wings. White even has the move. That is a dead draw, and going 0W-3L-2D *as the side with the tempo* means the engine isn't just failing to win, it's walking into lost pawn races. That points at eval and horizon, not at the tablebase.

Note first what the tablebase can and can't do here. The position has 10 pieces. Your 5-piece Syzygy is completely inert until seven pieces come off the board, and you only probe DTZ at the root, so it contributes nothing to this game until the actual board hits ≤5 men, which is long after it's decided. So this loss is not a TB problem. It's the classic classical-engine endgame problem, which the literature is blunt about: in the endgame chess programs usually have quite a lot of difficulties.

## Why HCE engines suck at endgames

Four root causes, all of which apply to a PeSTO + linear-terms eval like yours:

1. Eval blindness. HCE has almost none of the specialized endgame knowledge that decides these positions (king activity relative to pawns, fortresses, rule-of-the-square, drawishness). The result is statically wrong scores. In Stockfish's own issue tracker, dead-drawn endgames were evaluated around +1 to +3 even at depth 50-60 with 6-man tablebases, while Leela correctly saw them as dead drawn. Your eval almost certainly scores the symmetric start ~0.0 and then can't tell the move that keeps the king on the winning trajectory from the one that drops a tempo.

2. Horizon. Endgame wins are long thin lines. A connected-passer race resolves 15-25 plies out, past where even your pruned search reaches under a 100ms clock, and your aggressive forward pruning (LMR/LMP/RFP) is most likely to chop exactly the precise king march or knight blockade that holds.

3. Zugzwang breaks null-move. Null move produces very bad results in zugzwang positions, where not moving would be best. These are rare in the middlegame but not in endgames, especially king-and-pawn endings. Once your knights trade off and you're in a pure K+P race, NMP makes a passed move look fine when you're actually in zugzwang. Crafty's answer: no non-pawn pieces means no null move, with the material threshold tuned over the years from a queen down to one minor piece.

4. TB coverage gap. Even with tablebases, 5-piece only and root-only leaves the entire 6-to-10-piece "dead zone" to eval and search, which is where most endgames are actually decided.

## What strong engines do

WDL probing inside the search, not just DTZ at the root. This is the big one and it's your largest single gap. Stockfish integrates tablebases at two levels: internal-node probing and root filtering. During search, if piece count is at or below the max, it calls probe_wdl, and on a hit the search immediately returns a value adjusted for the distance to the current ply. This effectively turns the tablebase into a perfect evaluation function for endgames. The WDL files are the ones accessed during search; the DTZ files only need to be accessed at the root. You're doing the root half and skipping the search half. Adding `tb_probe_wdl` at internal nodes (Fathom exposes it) extends your effective horizon all the way to the 5-piece boundary: the search can then *see*, 15 plies deep, that a trade-down is won/drawn/lost. It won't fix the 10-piece position directly, but it fixes the whole conversion phase the moment trades start.

Specialized endgame eval and scale factors. Stockfish scales the endgame score down toward a draw for drawish material: scale factor 0 when the strong side has no pawns and at most a bishop's advantage, a factor based on the number of pawns of the strong side, reduced when pawns are on a single flank, plus opposite-colored-bishop scaling (those endings are drawn even a pawn or two up). This stops the engine trading into "won on paper, drawn in reality" positions.

Passed-pawn and king-activity knowledge. Concrete numbers from MadChess's HCE: endgame passed-pawn bonus by rank 0/4/18/42/75/118/170, free passed pawn 0/8/34/77/138/216/311, king-escorted passer 11, and an unstoppable-passer (rule-of-the-square) bonus of 775. That unstoppable-passer term is exactly what lets eval judge the race in your lost position without searching to promotion. Plus king-pawn tropism: average Manhattan distance from the king to the pawns, weighted higher for passers (a 6:3:2 weighting for passed, backward, and remaining pawns), the closer the better. That is the term that makes the king race to the correct wing instead of centralizing generically.

NNUE. The real long-term answer, already on your roadmap. NNUE carries implicit endgame knowledge and isn't blind in the dead zone the way linear HCE is (the Leela-vs-SF gap above). Weeks of work, so not the first move.

## Where you specifically lose Elo

Mapping the above onto gomachine: root-only DTZ (no WDL-in-search), a PeSTO+4-term eval with no king-pawn tropism, no rule-of-the-square, weak passed-pawn scaling, and no drawishness scale factors, plus NMP that's almost certainly still firing in low-material zugzwang. The 1.0/5 is the eval blindness (drifts in the symmetric draw) and the losses specifically are the horizon problem (walks into a lost race it can't see resolving).

One testing note that gates all of this: measure endgame patches from an endgame start-position book, not your normal opening book. From the opening, the overwhelming majority of self-play pairs are decided or drawn before reaching the thin endgames these patches touch, so the signal is buried and SPRT either runs forever or reports H0 on a real gain. The framework convention is to use more biased books to reduce the draw rate; for endgame work that means seeding from low-piece-count FENs (filter your Lichess positions to ≤7-9 men, or a known endgame suite as start positions) and running at movetime, since both the TB and horizon effects are real-time.

Priority order, each behind a flag, Texel-tuned where applicable, SPRT-gated from an endgame book at movetime:

1. WDL probing at internal search nodes (`tb_probe_wdl`), return a bounded TB score on hit, map cursed-win/blessed-loss to draw and pass the rule50 counter. Biggest gap, directly extends horizon to the 5-piece edge.
2. Disable NMP when the side to move has no non-pawn material (start threshold; tune up to ≤1 minor), or switch to verified null-move that re-searches on fail-high to catch zugzwang. Fixes the pure K+P phase.
3. King-pawn tropism term, endgame-only, weighted toward passers. This is the term that loses the shown position.
4. Stronger passed-pawn terms: steep rank scaling, free-passer bonus, king-escorted bonus, and rule-of-the-square unstoppable-passer detection (large, ~700cp).
5. Endgame scale factors / drawishness detection: no-pawn + ≤bishop → scale to 0, single-flank reduction, opposite-bishop scaling. Stops bad trades into drawn endings.
6. 50-move awareness in eval: dampen the score toward 0 as the halfmove clock approaches 100, so it stops believing in unconvertible wins and shuffling.
7. Soften LMR/LMP at very low material and add a passed-pawn push extension (6th/7th rank). Low branching in endgames means you can afford to prune less and search deeper.
8. NNUE, when you're ready to spend the weeks. The traced-coefficient dataset from your tuner is the data step.


1. The eval is over-optimistic in pawn-race endgames. gomachine's own UCI eval of the start is cp +50 — it thinks White is half a pawn up. Stockfish says +1. Believing it's winning, it commits to a race it can only draw, over-extends, and gets mated. It also only reaches depth 18 in 2s here — barely enough to see a ~6-push promotion race resolve.
2. The evaluator has almost no real endgame knowledge. internal/eval/terms.go has exactly one passer term:
if passed:  mg += PassedMG*adv;  eg += PassedEG*adv   // linear by rank, nothing else
There is no:
- King distance to passed pawns (own king escorting a passer, enemy king blocking it)
- "Rule of the square" / unstoppable-passer detection
- King activity/centralization beyond the static PSQT
- Connected/protected passed-pawn bonus

This means:
Your +50 isn't really wrong in magnitude. The true value is 0.00 (dead draw), and both engines overshoot it: gomachine +50, SF +100. The difference is that SF doesn't lose, because its search reaches the promotion and collapses the score back toward 0; yours can't at depth 18, so the optimism never gets corrected and the engine acts on it. So this is two coupled failures, not one: the eval over-commits, and the search is too shallow to veto it. A 6-push race with king moves is north of 24 plies, well past 18. That matters for ranking the terms, because the highest-value eval terms here are the ones that let a depth-18 eval reach the right verdict without searching to ply 30.

On your ranking: agreed, king-proximity is the highest-value smooth term, and it's the one tied straight to "never escorts, never stops." A king that stays near its pawns survives even if the eval stays a bit hopeful, so it breaks the loss chain (optimism → over-extend → king mispositioned → mated) at the link least likely to break. Two refinements to it:

Weight the proximity by the passer's rank. distance(king, 6th-rank passer) has to dominate distance(king, 3rd-rank passer). Escorting an almost-queen is worth far more than nudging a home pawn, and a flat distance term will under-react in exactly the sharp positions that decide the game.

Pure EG centralization (your third term) is the weakest of the three and can mislead here. In an opposite-wing race you don't want the king centralized, you want it on the wing that matters, and your PSQT already supplies generic centralization. Fold "activity" into proximity-to-passers plus king mobility rather than adding a separate center bonus.

What else I found, beyond your three terms:

1. Passed-pawn race comparison, distinct from rule-of-the-square. The term that actually kills the +50 over-optimism is one that counts both races: plies until my fastest passer queens vs his, accounting for whose move it is and who gets caught. Rule-of-the-square only asks "is my passer unstoppable." The race term asks "do I queen first." In a symmetric race that nets to ~0 and the eval stops believing it's winning. This is the single term most directly responsible for stopping the over-commitment that gets you mated.

2. The unstoppable-passer detector must account for the knight, not just the king. This is a correctness trap precisely in K+N+P, which is the game you lost. A king-only square rule will flag passers as unstoppable that the enemy knight catches and hand you wrong +700s. The check has to be "no enemy piece can reach the promotion path in time," not "enemy king is outside the square."

3. WDL-in-search is the other half of the horizon fix, and it is not an eval term, so your eval-term plan will never produce it. Don't let it get crowded out. It's inert at 10 pieces, but the moment trades start it returns exact leaf values and is worth far more per ply than any heuristic. Run it as a parallel track.

4. Don't bolt the new terms onto the existing PassedEG. Re-tune the passer terms jointly with the new king-distance and race terms. This is your own §6 lesson: bolt-on terms over a frozen baseline double-count and produce compensating wrong-signed weights, which is the −148 path. King-distance overlaps the linear passer term (an escorted passer is already partly scored by PassedEG), so they have to be fit together or the tuner will fight itself.

5. The terms won't tune or SPRT-register on your current data and book. Two separate problems:
   Tuning data: a generic quiet Lichess set is mostly middlegames, so the king-distance feature is active and decisive in too few positions. The gradient is weak and the weight comes out under-determined. Oversample low-piece-count positions in the tuning EPD.
   SPRT book: from the standard opening book, most pairs never reach a decisive king-and-pawn race, so these terms read as noise and the test runs forever or returns H0 on a real gain. SPRT them from an endgame start book (filter to ≤7-9 men), ideally pawn-race positions, at movetime. This is the difference between reading +40 Elo and reading 0.

6. Gate every new term to the EG side of the taper so it doesn't leak into the middlegame and get washed out there.

7. Connected/protected-passer bonus: correct knowledge, but both sides' passers are connected in this position, so it nets ~0 and won't move this result. Add it for general strength, not as a fix for these losses.

8. Side check worth one look: depth 18 in 2s at 10 pieces is low. Branching collapses in the endgame, so something is capping effective depth on the critical line, most likely over-aggressive LMR/LMP or null-move still firing in the race (a pass looks fine, so it prunes the line where it should be defending). The eval shortcuts only half-fix a search that's pruning away the king march.

Priority:
1. King-proximity, rank-weighted. The sturdiest fix for king placement, tied to the failure you saw.
2. Passed-pawn race comparison, with knight-aware unstoppable detection folded in. The fix for the over-optimism that drives the over-commit.
3. WDL-in-search. Parallel track, biggest per-ply value once pieces drop.
4. The plumbing that makes 1 through 3 real and measurable: re-tune passers jointly, EG-only gating, endgame-heavy tuning data, endgame SPRT book.

Drop standalone EG centralization. Connected-passer and the search-pruning audit are secondary.
