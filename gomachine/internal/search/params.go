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
}

// DefaultParams returns the engine's current full-strength configuration.
//
// Accepted improvements (SPRT-gated, then made default here), all self-play @ 40k
// nodes, [0,6] bounds, 2026-06-18:
//   - SEE:        +66.2 ± 22.9 Elo (468 pairs)
//   - DeltaPrune: +22.0 ± 12.2 Elo (473 pairs, on top of SEE)
//
// Next under test (each: implement behind a flag, SPRT-gate on vs off, then flip
// the default here): aspiration windows → RFP/futility/LMP/razoring → countermove
// → TT static eval.
func DefaultParams() Params {
	return Params{
		UseTT:          true,
		NullMove:       true,
		NullMoveR:      2,
		LMR:            true,
		CheckExtension: true,
		SEE:            true,
		DeltaPrune:     true,
	}
}
