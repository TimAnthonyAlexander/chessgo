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
	CleanVerify      bool // singular: run the verification subtree with conservative LMR (not LMR2), even when LMR2 is on globally — so over-reduced alternatives don't pollute the singular decision. Inert unless LMR2 is on
	IIR              bool // internal iterative reduction: at a deep node with no TT move, search a ply shallower (cheaper, and seeds the TT with a move)
	Futility         bool // frontier futility pruning: skip a late quiet whose static eval + depth margin can't reach alpha (the fail-low side; distinct from RFP)
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
		// lone-queen, pawn-count cap). UNDER SPRT — default off until accepted.
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
		// Extra corrhist keys (minor-piece + continuation), behind their own flags.
		// DEFAULT OFF — under SPRT. Additive eval adjustment (cannot over-prune);
		// require CorrHist on.
		CorrHistMinor: false,
		CorrHistCont:  false,
		// Continuation history (1-ply countermove + 2-ply), blended into quiet move
		// ordering and the LMR reduction term alongside butterfly history. DEFAULT
		// OFF — under SPRT (best tested bundled with aggressive LMR, where better
		// quiet ordering pays off through reductions).
		ContHist: false,
		// Aggressive LMR (supersedes LMR when on): reduces captures/promotions too,
		// earlier onset (non-PV from the 2nd move), with PV / improving /
		// ordering-trust / SEE reduction adjustments; over-reductions are caught by
		// the existing zero-window re-search. DEFAULT OFF — under SPRT, coupled with
		// Singular (aggressive reductions need singular extensions to re-extend the
		// forced moves they over-cut).
		LMR2: false,
		// Singular extensions: a TT move that is much better than every alternative
		// at a reduced-depth verification search is extended a ply (and a second move
		// beating beta triggers a multi-cut). Conservative: depth≥8, single ply, no
		// double extensions. SPRT-accepted vs singular=off: +22.2 ± 12.2 Elo @ 40k
		// nodes [0,6] (186 pairs, 2026-06-28, [0 11 140 35 0], zero LL). Default ON.
		// NOTE: toxic in combination with LMR2 (lmr2+singular SPRT'd −67 although each
		// is positive alone: lmr2 +9.7, singular +22.2) — an anti-synergy under
		// investigation; do NOT enable LMR2 on top of this without fixing it.
		Singular: true,
		// Singular verification knobs, promoted from consts so they're SPRT-tunable.
		// Defaults (margin 2·depth, min-depth 8) preserve the banked +22.2 exactly.
		SingularMargin:   singularMargin,
		SingularMinDepth: singularMinDepth,
		// Multi-cut early-return inside the singular verification. DEFAULT TRUE =
		// current behavior. Diagnostic: flip off (multicut=off) to test whether the
		// fragile multi-cut is what makes lmr2+singular toxic (research lead).
		MultiCut: true,
		// Run the singular verification subtree with conservative LMR instead of
		// LMR2. DEFAULT FALSE = current behavior (LMR2 everywhere). Diagnostic: flip
		// on (cleanverify=on) with lmr2+singular to test the over-reduced-verify lead.
		CleanVerify: false,
		// Wave 4 cheap top-ups (each behind its own flag, DEFAULT OFF — under SPRT):
		// IIR (reduce a ply at a deep node with no TT move), frontier futility
		// (skip late quiets that can't reach alpha), ProbCut (capture-driven
		// fail-high prune), razoring (shallow drop-to-qsearch). All gated so the
		// off-path is byte-identical to the current default engine.
		// IIR REJECTED: -33.7 Elo as implemented (fires on ALL node types — standard
		// IIR is PV + expected-cut only; ours over-prunes). Kept off; rework to
		// selective placement before retrying.
		IIR: false,
		// Frontier futility SPRT-accepted vs futility=off: +21.3 ± 12.0 Elo @ 40k
		// nodes [0,6] (495 pairs, 2026-06-28, zero LL). Default ON.
		Futility: true,
		ProbCut:  false,
		Razor:    false,
		// Capture history: refines capture ordering within the SEE tier. DEFAULT OFF
		// — under SPRT.
		CaptHist: false,
	}
}
