package search

import (
	"testing"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// TestSingularFiringUnderLMR2 checks the interaction hypothesis: does aggressive
// LMR (lmr2) make the singular VERIFICATION search reduce alternatives so hard
// that far more moves get flagged "singular" -> extension explosion -> shallower
// real depth at fixed nodes? It compares singular firings + node counts for
// singular-alone vs lmr2+singular at a fixed depth. Deterministic (counts, not
// timing), so it is safe to run alongside a live SPRT.
func TestSingularFiringUnderLMR2(t *testing.T) {
	mk := func(lmr2, singular bool) Params {
		p := DefaultParams()
		p.LMR2, p.Singular = lmr2, singular
		return p
	}
	for _, fen := range wave3FENs {
		pos, err := chess.ParseFEN(fen)
		if err != nil {
			t.Fatalf("parse %q: %v", fen, err)
		}
		sSingOnly := NewWithParams(16, mk(false, true))
		rSingOnly := sSingOnly.Search(pos, Limits{Depth: 12}, nil)
		sBoth := NewWithParams(16, mk(true, true))
		rBoth := sBoth.Search(pos, Limits{Depth: 12}, nil)
		t.Logf("%-50.50s  singular-only: nodes=%-9d ext=%-5d mc=%-4d | lmr2+singular: nodes=%-9d ext=%-5d mc=%-4d  | ext x%.1f",
			fen,
			rSingOnly.Nodes, sSingOnly.DbgSingular(), sSingOnly.DbgMultiCut(),
			rBoth.Nodes, sBoth.DbgSingular(), sBoth.DbgMultiCut(),
			float64(sBoth.DbgSingular()+1)/float64(sSingOnly.DbgSingular()+1))
	}
}
