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
	UseTT          bool // transposition-table probe/store + TT move ordering
	NullMove       bool // null-move pruning (zugzwang-guarded)
	NullMoveR      int  // null-move base reduction R (effective R = NullMoveR + depth/4)
	LMR            bool // late move reductions
	CheckExtension bool // extend search by one ply when in check
	SEE            bool // order captures by SEE; prune losing captures in quiescence
	DeltaPrune     bool // delta pruning in quiescence (skip captures that can't raise alpha)
	Aspiration     bool // aspiration windows around the previous iteration's score
	RFP            bool // reverse futility pruning (static null move) near leaves
	LMP            bool // late move pruning (move-count pruning) of late quiets near leaves
	HistMalus      bool // history gravity update + bonus cap + malus to non-cutoff quiets
	Improving      bool // "improving" heuristic scales RFP margin + LMP move count
	LMRFormula     bool // log(d)·log(m) LMR table + PV/improving/history adjustments
	Mobility       bool // evaluation: piece mobility term
	Pawns          bool // evaluation: pawn structure (isolated/doubled/passed)
	KingSafety     bool // evaluation: king pawn-shield term
	BishopPair     bool // evaluation: bishop-pair bonus
	KingProx       bool // evaluation: EG-only king proximity to advanced passers (endgame term #1, under SPRT)
	TunedEval      bool // evaluation: use the Texel-tuned PSQT + tuned weights
	UseBook        bool // consult the precomputed opening book before searching (engine must have a book set)
	UseTablebase   bool // probe Syzygy endgame tablebases at the root (engine must have a tablebase set)
	TBSearch       bool // probe Syzygy WDL at internal search nodes (extends the horizon to the ≤MaxPieces boundary; engine must have a tablebase set)
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
// History/ordering work (2026-06-19):
//   - HistMalus:  +90.8 ± 27.6 Elo (131 pairs)
//   - Improving:  +78.3 ± 25.2 Elo (174 pairs; RFP+LMP margin scaling)
//   - LMRFormula: +10.8 ± 7.8  Elo (592 pairs; log(d)·log(m) table + history adj,
//                 replacing the flat 1/2. Small at fixed nodes; the depth-per-sec
//                 part is a movetime gain this test can't measure.)
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
		KingProx:   true,
		TunedEval:  true,
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
	}
}
