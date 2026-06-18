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
}

// DefaultParams returns the engine's current full-strength configuration. A
// Searcher built with these plays identically to the pre-Params engine.
func DefaultParams() Params {
	return Params{
		UseTT:          true,
		NullMove:       true,
		NullMoveR:      2,
		LMR:            true,
		CheckExtension: true,
	}
}
