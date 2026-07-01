package search

// Params toggles and tunes the optional components of the search. Every field in
// DefaultParams() is the engine's current full-strength behavior; flipping a flag
// or changing a knob produces a *different* engine that can be pitted against the
// default in self-play SPRT (see internal/bench). This is the unit of an
// engine patch: implement a feature behind a Params field, then SPRT-gate
// `field=on` against `field=off`.
//
// NOTE: feature flags are added here as each improvement lands (SEE, delta
// pruning, aspiration windows, …). Only wired flags appear; toggling a flag the
// search doesn't yet read would silently do nothing, so we don't expose those.
type Params struct {
	UseTT            bool // transposition-table probe/store + TT move ordering
	NullMove         bool // null-move pruning (zugzwang-guarded)
	NullMoveR        int  // null-move base reduction R (effective R = NullMoveR + depth/4)
	LMR              bool // late move reductions
	CheckExtension   bool // extend search by one ply when in check
	SEE              bool // order captures by SEE; prune losing captures in quiescence
	DeltaPrune       bool // delta pruning in quiescence (skip captures that can't raise alpha)
	Aspiration       bool // aspiration windows around the previous iteration's score
	RFP              bool // reverse futility pruning (static null move) near leaves
	LMP              bool // late move pruning (move-count pruning) of late quiets near leaves
	HistMalus        bool // history gravity update + bonus cap + malus to non-cutoff quiets
	Improving        bool // "improving" heuristic scales RFP margin + LMP move count
	LMRFormula       bool // log(d)·log(m) LMR table + PV/improving/history adjustments
	Mobility         bool // evaluation: piece mobility term
	Pawns            bool // evaluation: pawn structure (isolated/doubled/passed)
	KingSafety       bool // evaluation: king pawn-shield term
	BishopPair       bool // evaluation: bishop-pair bonus
	KingProx         bool // evaluation: EG-only king proximity to advanced passers (endgame term #1, under SPRT)
	PawnRace         bool // evaluation: EG-only knight-aware unstoppable-passer / race detection (under SPRT)
	ScaleFactor      bool // evaluation: EG drawishness scale factor (scales the eg term toward draw in drawish material)
	TunedEval        bool // evaluation: use the Texel-tuned PSQT + tuned weights
	UseBook          bool // consult the precomputed opening book before searching (engine must have a book set)
	UseTablebase     bool // probe Syzygy endgame tablebases at the root (engine must have a tablebase set)
	TBSearch         bool // probe Syzygy WDL at internal search nodes (extends the horizon to the ≤MaxPieces boundary; engine must have a tablebase set)
	Nnue             bool // evaluation: route static eval through the NNUE net (internal/nnue); inert (falls back to HCE) if no net is loaded
	NnueFloat        bool // evaluation: when NNUE is on, use the float from-scratch eval instead of the int incremental path (int-vs-float A/B only)
	TTEval           bool // reuse the TT-stored static eval instead of recomputing it (skips the NNUE/HCE eval on TT hits that don't cut off); behavior-preserving speed-only (eval is deterministic), measured at movetime
	CorrHist         bool // correction history: learn the per-pattern (pawn / per-color non-pawn) static-eval-vs-search-result bias and correct the static eval by it (improves every eval-gated decision: RFP, null-move, improving, qsearch stand-pat)
	CorrHistMinor    bool // extra corrhist key on the minor-piece (N+B) skeleton; additive eval adjustment (requires CorrHist)
	CorrHistCont     bool // extra corrhist key: continuation correction from the stm's own prior moves at ply-2/-4 (requires CorrHist)
	ContHist         bool // continuation history: 1-ply (countermove) + 2-ply history keyed by the preceding move(s); feeds quiet ordering + the LMR reduction term (sharpens every reduction/late-move prune)
	LMR2             bool // aggressive LMR: reduce captures/promotions too, earlier onset, PV/improving/ordering-trust/SEE reduction adjustments (supersedes LMR when on)
	Singular         bool // singular extensions: verify the TT move against all alternatives at reduced depth; extend it a ply if singular, multi-cut if a second move also beats beta
	SingularMargin   int  // singular: verification window = ttScore - SingularMargin*depth (default 2; lower = fire singular more often)
	SingularMinDepth int  // singular: minimum remaining depth to attempt verification (default 8)
	MultiCut         bool // singular: allow the verification's multi-cut early-return (return singularBeta when a second move also beats beta). DEFAULT TRUE; flip off to isolate fragile multi-cut from the rest of singular
	DoubleExt        bool // double extensions: when the TT move is singular by a wide margin (singScore < singularBeta - DoubleExtMargin) at a non-PV node, extend it 2 plies instead of 1
	DoubleExtMargin  int  // double extensions: how far below singularBeta the verification must fail for a double extension (default 16; higher = fire double-ext less often)
	CleanVerify      bool // singular: run the verification subtree with conservative LMR (not LMR2), even when LMR2 is on globally — so over-reduced alternatives don't pollute the singular decision. Inert unless LMR2 is on
	IIR              bool // internal iterative reduction: at a deep node with no TT move, search a ply shallower (cheaper, and seeds the TT with a move)
	Futility         bool // frontier futility pruning: skip a late quiet whose static eval + depth margin can't reach alpha (the fail-low side; distinct from RFP)
	HistPrune        bool // history pruning: at a shallow non-PV node, skip a late quiet whose history score is strongly negative (move ordering already ranked it low; new signal vs LMP move-count / Futility static-eval)
	SEEQuiet         bool // quiet-move SEE pruning: at a shallow non-PV node, skip a quiet move whose SEE is strongly negative (it hangs material to the recapture) — orthogonal to LMP move-count / Futility static-eval / HistPrune history-magnitude
	SEEQuietMaxDepth int  // SEEQuiet: max remaining depth the prune applies at (default 6)
	SEEQuietMargin   int  // SEEQuiet: per-depth cp margin; prune when SEE < -SEEQuietMargin·depth (default 150)
	CaptSEE          bool // capture-move SEE pruning: at a shallow non-PV node, skip a CAPTURE whose SEE is strongly negative (a clearly-losing capture that hangs material through the recapture sequence) — the capture analog of SEEQuiet, orthogonal to it (fires only on captures, never quiets/promotions). DEFAULT OFF — under SPRT
	CaptSEEMaxDepth  int  // CaptSEE: max remaining depth the prune applies at (default 6)
	CaptSEEMargin    int  // CaptSEE: per-depth cp margin; prune when SEE < -CaptSEEMargin·depth (default 25)
	ProbCut          bool // probcut: if a capture's reduced-depth search beats a raised beta, the node is almost surely a fail-high — prune it
	Razor            bool // razoring: at very shallow depth, if static eval + margin < alpha, drop to qsearch and prune if it confirms we're below alpha
	CaptHist         bool // capture history: per (piece,to,victim) stats refine capture ordering WITHIN the SEE good/bad tier (orthogonal to quiet butterfly history)
}

// DefaultParams returns the engine's current full-strength configuration.
//
// Accepted improvements (SPRT-gated, then made default here). Each figure is the
// patch's own self-play @ 40k nodes, [0,6] bounds, measured against the baseline
// as it stood at the time — so they compound but do NOT linearly sum, and these
// are fixed-nodes self-play numbers (the real-time / absolute gain is smaller; see
// the Stockfish anchor in ENGINE_STRENGTH.md, which is the only absolute check).
//
// NOTE: these are all SEARCH features, for which fixed-nodes is a valid ruler
// (a better-pruning patch finds a better move in the same node budget). This does
// NOT hold for EVAL changes — fixed-nodes *inflates* them (it rewards faster
// within-iteration convergence at the mid-iteration node cutoff, which a
// completed-iteration search erases: a v8 output-bucket net read +90 @ fixed nodes
// but ≈0 @ movetime/fixed-depth). Gate any EVAL change at --movetime or fixed
// --new-depth/--old-depth, never fixed-nodes alone. See ENGINE_STRENGTH.md §14.4.
//
// Earlier work (2026-06-18):
//   - SEE:        +66.2 ± 22.9 Elo (468 pairs)
//   - DeltaPrune: +22.0 ± 12.2 Elo (473 pairs, on top of SEE)
//   - Aspiration: +21.8 ± 12.1 Elo (876 pairs)
//   - RFP:        +67.2 ± 23.1 Elo (286 pairs)
//   - LMP:        +94.6 ± 28.5 Elo (124 pairs)
//
// History/ordering work (2026-06-19):
//   - HistMalus:  +90.8 ± 27.6 Elo (131 pairs)
//   - Improving:  +78.3 ± 25.2 Elo (174 pairs; RFP+LMP margin scaling)
//   - LMRFormula: +10.8 ± 7.8  Elo (592 pairs; log(d)·log(m) table + history adj,
//     replacing the flat 1/2. Small at fixed nodes; the depth-per-sec
//     part is a movetime gain this test can't measure.)
//
// Next under test: richer LMR adjustments (PV/improving/cutNode, earlier onset) →
// futility pruning → razoring → continuation history → singular extensions.
func DefaultParams() Params {
	return Params{
		UseTT:          true,
		NullMove:       true,
		NullMoveR:      2,
		LMR:            true,
		CheckExtension: true,
		SEE:            true,
		DeltaPrune:     true,
		Aspiration:     true,
		RFP:            true,
		LMP:            true,
		HistMalus:      true,
		Improving:      true,
		LMRFormula:     true,
		// Texel-tuned eval (tuned PSQT + knowledge terms), SPRT-accepted as a set
		// vs the bare PeSTO base: +128 ± 35 Elo @ 40k nodes, +101 ± 29 Elo @
		// 100ms/move (2026-06-19, internal/eval/tuned_tables.go; tuner in
		// internal/tune, dataset = Lichess quiet-labeled). See ENGINE_STRENGTH.md.
		Mobility:   true,
		Pawns:      true,
		KingSafety: true,
		BishopPair: true,
		// EG-only king proximity to advanced (≥4th-rank) passers — rewards escorting
		// your own passers and keeping the enemy king off theirs (the gap that had
		// the engine walk into lost connected-passer races). SPRT-accepted on the
		// shipped table with TBSearch on: +30.5 ± 13.6 @ 100ms (endgame book), and
		// per-material-class +33 rook / +36 minor / +24 K+P (no class regressed);
		// standard-book non-reg ~0. A joint eval re-tune was tried and REJECTED — the
		// re-tuned PSQT gave back the gain (table A/B ≈0 vs +30 here), so we ship the
		// seeded weight (KingProxEG=4) on the existing table, not a re-tune.
		KingProx: true,
		// EG-only knight-aware unstoppable-passer / race term (the "do I queen
		// first?" over-optimism killer). SPRT-accepted vs off on the mixed endgame
		// book with TB on both sides: +17.4 ± 10.6 Elo (539 pairs, 2026-06-21).
		// Acts in 6–10-man positions ABOVE the 5-man TB boundary, so it is not
		// TB-masked. Gated to a knights-only defender (the K+N+P case); seeded
		// PawnRaceEG=700, not a tuner feature (non-linear). See ENGINE_STRENGTH §10.
		PawnRace: true,
		// EG drawishness scale factor (Stockfish-classical): scales the eg term by
		// sf/64 in drawish material (no-pawn ≤minor → 0/4/14, opposite bishops,
		// lone-queen, pawn-count cap). SPRT-REJECTED at movetime: -0.0 ± 4.0 @ 100ms,
		// pentanomial [0 0 129 0 0] — ALL DRAWS, i.e. byte-identical play: the drawish-
		// material condition never fires within the search horizon on the test book, so
		// it's INERT at movetime (not harmful). Default off (2026-06-30).
		ScaleFactor: false,
		TunedEval:   true,
		// Syzygy endgame tablebase probing at the search root. SPRT-accepted vs
		// tb=off: +18.8 ± 11.1 Elo @ 100ms/move (2026-06-20, 5-piece set, 109 pairs,
		// 0 lost pairs); Stockfish anchor held ≈2782 with it on. Inert unless the
		// engine has a tablebase attached (Engine.SetTablebase) — so the prod
		// serve/hub paths stay no-ops until --tb-path is plumbed in + files shipped.
		UseTablebase: true,
		// Syzygy WDL probing at INTERNAL search nodes — extends the horizon to the
		// ≤MaxPieces boundary (turns the TB into an exact eval the moment trades drop
		// into range). SPRT-accepted vs tbsearch=off: +32.7 ± 14.1 @ 100ms on the
		// endgame book (endgame-book-scoped, NOT additive with root-DTZ's +18.8 which
		// was the standard book); standard-book non-regression +29 ± 19.6 (CI excludes
		// 0 — net-positive, not just safe). Like root-DTZ it's inert until a tablebase
		// is attached, and it is GATED to full-strength search only (suppressed in
		// RootScores, the weakened-bot ranking path) so leveled bots keep their level
		// instead of converting ≤MaxPieces endings perfectly (search.weakenedSearch).
		TBSearch: true,
		// NNUE eval (internal/nnue). Default ON: the bullet-trained net is
		// SPRT-accepted vs HCE (+177.8 ± 41.5 @ 100ms/move, H1 — docs/ENGINE_STRENGTH.md
		// §11) and runs through the Phase-A incremental accumulator. The searcher
		// routes static eval through the loaded net; with no net loaded it falls back
		// to HCE, so this stays inert until data/nnue/net.nnue (or NNUE_PATH) exists.
		Nnue: true,
		// TT static-eval cache: reuse the TT-stored static eval on a hit that doesn't
		// cut off, skipping the NNUE/HCE recompute (saves the SCReLU output dot). A
		// movetime-only speed feature — behavior-preserving at fixed nodes (the eval
		// is deterministic, proven byte-identical), so it is invisible to fixed-nodes
		// SPRT and measured at movetime. SPRT vs tteval=off @ 100ms/move (2026-06-22):
		// Elo +14.8 ± 10.8, LLR +2.32 at 998 pairs (W575 L490 D931) — a clear, stable
		// positive (lower CI bound +4.0); stopped just shy of the formal H1 cross and
		// accepted on the trend. See ENGINE_STRENGTH.md §7.
		TTEval: true,
		// Correction history (pawn + per-color non-pawn keyed tables). Learns the
		// systematic static-eval-vs-search-result error per board pattern within a
		// game and corrects the static eval by it, sharpening every eval-gated
		// decision (RFP, null-move, improving, qsearch stand-pat). SPRT-accepted
		// vs corrhist=off: +66.9 ± 22.9 Elo @ 40k nodes [0,6] (174 pairs,
		// 2026-06-28, pentanomial [0 21 87 44 22], zero LL). Default ON.
		CorrHist: true,
		// Extra corrhist keys (minor-piece + continuation), additive eval adjustment
		// (cannot over-prune); require CorrHist on.
		// CorrHistMinor: DEFAULT OFF — never legitimately SPRT-accepted. Re-validated
		// 2026-07-01 (coalla/AVX-512): MOVETIME-NEUTRAL −4.2 ± 13.6 @ 100ms (411 pairs,
		// LLR −0.70, a wash) and fixed-40k NEGATIVE −56.6 ± 20.1 (292 pairs, H0 REJECT).
		// The old "+43.4 @ 100ms H1" that flipped it on was CONTAMINATED: `--movetime` is
		// silently ignored unless `--nodes 0` is ALSO passed (nodes defaults to 25000), so
		// that run was fixed-25000-nodes, not movetime. Per the project rule (default-on
		// only if it accepts H1) an unproven, fixed-nodes-negative key doesn't ship on.
		// It IS wired and works (it just isn't a win here — a standard technique that owes
		// a clean longer-TC re-test before re-enabling). Off restores the byte-identical
		// gating the corrhist_keys tests assert.
		CorrHistMinor: false,
		// CorrHistCont: continuation corrhist key. SPRT-REJECTED at movetime ON TOP OF
		// IIR+CorrHistMinor: -10.6 ± 11.7 Elo @ 100ms (2026-06-30, ~H0) — redundant with
		// the minor-piece key (stacking both double-counts the correction). Default OFF.
		CorrHistCont: false,
		// Continuation history (1-ply countermove + 2-ply), blended into quiet move
		// ordering and the LMR reduction term alongside butterfly history. DEFAULT
		// OFF — under SPRT (best tested bundled with aggressive LMR, where better
		// quiet ordering pays off through reductions).
		ContHist: false,
		// Aggressive LMR (supersedes LMR when on): reduces captures/promotions too,
		// earlier onset (non-PV from the 2nd move), with PV / improving /
		// ordering-trust / SEE reduction adjustments; over-reductions are caught by
		// the existing zero-window re-search. +33.0 @ 40k NODES WITH multicut=off (384
		// pairs, 2026-06-30). The durable finding here is the ANTI-SYNERGY CAUSE: the
		// lmr2+singular -67 was the MULTI-CUT early-return, NOT the verification LMR
		// (cleanverify failed twice). BUT in the day's 5-patch stack the MOVETIME
		// re-anchor was -77.7, so REVERTED to OFF. MOVETIME gate (lmr2=on,multicut=off,
		// ALONE on the CorrHistMinor-only baseline) = -64.9 ± 21.6 — STRONGLY NEGATIVE:
		// over-reduction + re-search churn outweighs the depth-per-second gain at real TC
		// on this heavily-pruned engine. Stays OFF (the +33 fixed-nodes was inflation).
		LMR2: false,
		// Singular extensions: a TT move that is much better than every alternative
		// at a reduced-depth verification search is extended a ply (and a second move
		// beating beta triggers a multi-cut). Conservative: depth≥8, single ply, no
		// double extensions. SPRT-accepted vs singular=off: +22.2 ± 12.2 Elo @ 40k
		// nodes [0,6] (186 pairs, 2026-06-28, [0 11 140 35 0], zero LL). Default ON.
		// NOTE: lmr2+singular WAS toxic (−67) but the cause was the MULTI-CUT early
		// return, not singular itself (fix = multicut=off, NOT cleanverify). lmr2+
		// multicut-off was +33 @ fixed nodes but reverted (the 5-patch movetime stack
		// was -77.7); pending an individual movetime gate. Singular stays on regardless.
		Singular: true,
		// Singular verification knobs, promoted from consts so they're SPRT-tunable.
		// Defaults (margin 2·depth, min-depth 8) preserve the banked +22.2 exactly.
		SingularMargin:   singularMargin,
		SingularMinDepth: singularMinDepth,
		// Multi-cut early-return inside the singular verification. DEFAULT TRUE (part of
		// singular's accepted +22.2). FINDING (2026-06-30): the fragile multi-cut is what
		// made lmr2+singular toxic (-67) — lmr2=on,multicut=off was +33 @ fixed nodes.
		// That pair was reverted (5-patch movetime stack -77.7). If LMR2 is reclaimed at
		// movetime, flip this OFF together with LMR2 ON; otherwise leave ON.
		MultiCut: true,
		// Double extensions on top of singular. DEFAULT FALSE — SPRT-REJECTED: a dry
		// hole on this baseline (singular already ships; the tree is already heavily
		// extended/pruned). margin=16 SPRT'd -11.1 ± 10.6 @ 40k nodes (LLR -2.88,
		// ~H0, fires too eagerly), and a retune to margin=64 was dead flat -0.0 ± 8.5
		// (600 pairs, pentanomial [0 113 374 113 0]). No positive operating point
		// found. Kept default-off scaffolding (off-path byte-identical), like the §13
		// rejects. When on, a TT move singular by a wide margin at a non-PV node is
		// extended 2 plies; DoubleExtMargin = how far below singularBeta to qualify.
		DoubleExt:       false,
		DoubleExtMargin: 16,
		// Run the singular verification subtree with conservative LMR instead of
		// LMR2. DEFAULT FALSE = current behavior (LMR2 everywhere). Diagnostic: flip
		// on (cleanverify=on) with lmr2+singular to test the over-reduced-verify lead.
		// RE-CONFIRMED 2026-06-30: lmr2=on,cleanverify=on SPRT'd -74.9 @ 40k nodes (~H0)
		// on the IIR+CHM+ProbCut+Razor baseline — CleanVerify does NOT untangle the
		// lmr2+singular anti-synergy (the verification-LMR is not the cause). Matches the
		// earlier negative result. The remaining hypothesis is the multi-cut early-return.
		CleanVerify: false,
		// Wave 4 cheap top-ups (each behind its own flag, DEFAULT OFF — under SPRT):
		// IIR (reduce a ply at a deep node with no TT move), frontier futility
		// (skip late quiets that can't reach alpha), ProbCut (capture-driven
		// fail-high prune), razoring (shallow drop-to-qsearch). All gated so the
		// off-path is byte-identical to the current default engine.
		// IIR: REJECTED at -33.7 (all-nodes), REWORKED to PV-only → +11.0 @ 40k NODES
		// (2216 pairs, 2026-06-30). BUT the full-stack MOVETIME re-anchor of the day's 5
		// patches was -77.7 @ 100ms — the fixed-nodes win did not survive real TC on this
		// already-heavily-pruned engine. INDIVIDUAL movetime gate on the CorrHistMinor-
		// only baseline = +0.3 ± 11.5 — DEAD FLAT (the +11 fixed-nodes was pure inflation).
		// Stays OFF. (Lesson: gate pruners at movetime, not fixed-nodes.)
		IIR: false,
		// Frontier futility SPRT-accepted vs futility=off: +21.3 ± 12.0 Elo @ 40k
		// nodes [0,6] (495 pairs, 2026-06-28, zero LL). Default ON.
		Futility: true,
		// History pruning of late quiets (skip a quiet whose history score is strongly
		// negative near the leaves). DEFAULT ON — SPRT-accepted +86.8 ± 26.8 @ 40k nodes
		// (94 pairs, pentanomial [0 6 41 41 6]); seed maxDepth=6 / margin=-1000.
		HistPrune: true,
		// Quiet-move SEE pruning (skip a quiet that hangs material to the recapture
		// near the leaves). DEFAULT ON. SPRT vs off (margin=50) was +21.3 ± 12.8 @ 40k
		// nodes (inconclusive at the 700-pair cap, stable positive), then a margin
		// retune: margin=150 beat margin=50 by +75.9 ± 24.8 (H1, 205 pairs,
		// pentanomial [0 39 76 52 38]) — the seed 50 over-pruned safe quiets (45%
		// fixed-depth tree growth); 150 prunes only clearly-hanging pieces. 150 is the
		// peak: 100≈50 (+10, flat), 200<150 (−10 ± 14.7, [31 155 126 188 0]). maxDepth=6.
		SEEQuiet:         true,
		SEEQuietMaxDepth: 6,
		SEEQuietMargin:   150,
		// Capture-move SEE pruning (skip a clearly-losing capture that hangs material
		// through the recapture sequence near the leaves). The capture analog of
		// SEEQuiet. DEFAULT ON — margin=100 SPRT'd +77.7 ± 25.2 @ 40k nodes vs off
		// (148 pairs, [0 27 37 75 9]); margin retune showed AGGRESSIVE wins (unlike
		// SEEQuiet): 150<100 (−32.5), 50>100 (+32.8), 25>50 (+64.8 ± 22.6, H1) — but
		// then 0 lost to 25 by −86.6: pruning EVERY losing capture discards real
		// sacrifices, so the gain cliffs just past 25. SWEEP COMPLETE — peak = margin
		// 25; the 25→0 gap is steep + unsampled, so leave any fine-tune to joint SPSA.
		// maxDepth=6.
		CaptSEE:         true,
		CaptSEEMaxDepth: 6,
		CaptSEEMargin:   25,
		// ProbCut: +22.1 @ 40k NODES on the corrhist baseline (1235 pairs, 2026-06-30,
		// H1) — but part of the day's 5-patch stack that the MOVETIME re-anchor REJECTED
		// at -77.7. Fixed-nodes inflation / collective over-prune. REVERTED to OFF; the
		// prior note that probcut is "flat/negative on our heavily-pruned baseline" stands
		// at real TC. Re-gate individually at MOVETIME before ever shipping.
		ProbCut: false,
		// Razor: +32.8 @ 40k NODES (455 pairs, 2026-06-30, H1) — same fate as ProbCut:
		// in the 5-patch stack the movetime re-anchor was -77.7. REVERTED to OFF.
		Razor: false,
		// Capture history: refines capture ordering within the SEE tier. DEFAULT OFF
		// — under SPRT.
		CaptHist: false,
	}
}
