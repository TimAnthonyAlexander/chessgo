package search

// SetAggr overrides the aggression style knob (0..100; 50 = neutral) on this
// searcher's params for subsequent searches. Out-of-range values are clamped.
//
// This is the ONLY mutable entry point for Params.Aggr — every other construction
// path (DefaultParams / NewWithParams / the SPRT harness) sets it at build time and
// never touches it again, so this method is inert unless a caller opts in. The
// engine layer sets it per-search and restores 50 afterwards (see
// BestMoveForRatingTimedAggr), so a pooled engine is always neutral at rest and the
// shared eval path stays byte-identical for every non-aggression caller.
//
// Lazy-SMP workers copy s.params when they spawn (newWithSharedTT), so a value set
// here propagates to them on the next search.
func (s *Searcher) SetAggr(aggr int) {
	if aggr < 0 {
		aggr = 0
	}
	if aggr > 100 {
		aggr = 100
	}
	s.params.Aggr = aggr
}
