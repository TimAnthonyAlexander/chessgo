package bench

import (
	"testing"

	"github.com/timanthonyalexander/gomachine/internal/search"
)

// TestParseSingularIntParams confirms the new tunable int keys parse onto Params.
func TestParseSingularIntParams(t *testing.T) {
	p, err := ParseParams(search.DefaultParams(), "singularmargin=1,singulardepth=6")
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if p.SingularMargin != 1 {
		t.Fatalf("SingularMargin = %d, want 1", p.SingularMargin)
	}
	if p.SingularMinDepth != 6 {
		t.Fatalf("SingularMinDepth = %d, want 6", p.SingularMinDepth)
	}
	// aliases
	p2, err := ParseParams(search.DefaultParams(), "smargin=3,sdepth=10")
	if err != nil {
		t.Fatalf("parse aliases: %v", err)
	}
	if p2.SingularMargin != 3 || p2.SingularMinDepth != 10 {
		t.Fatalf("alias parse = %d/%d, want 3/10", p2.SingularMargin, p2.SingularMinDepth)
	}
}
