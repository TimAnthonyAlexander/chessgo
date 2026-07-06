package variant

import (
	"testing"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// Standard and Chess960 share the standard ruleset: both build a live position
// that plays a plain UCI move, flips the side, and carries no auxiliary token.
func TestStandardRuleset(t *testing.T) {
	for _, id := range []string{Standard, Chess960, "unknown-falls-back"} {
		st, err := New(id, chess.StartFEN)
		if err != nil {
			t.Fatalf("New(%q): %v", id, err)
		}
		if st.Side() != chess.White {
			t.Errorf("%q: side = %v, want White", id, st.Side())
		}
		if st.Duck() != "" {
			t.Errorf("%q: Duck() = %q, want empty", id, st.Duck())
		}
		if len(st.LegalMoves()) != 20 {
			t.Errorf("%q: %d opening moves, want 20", id, len(st.LegalMoves()))
		}
		next, san, ok := st.Apply("e2e4")
		if !ok || san != "e4" {
			t.Fatalf("%q: Apply(e2e4) = (%q, %v), want (e4, true)", id, san, ok)
		}
		if next.Side() != chess.Black {
			t.Errorf("%q: side after e4 = %v, want Black", id, next.Side())
		}
		if next.PrimaryUCI("e2e4") != "e2e4" {
			t.Errorf("%q: PrimaryUCI should be identity for plain UCI", id)
		}
		if _, _, ok := st.Apply("e2e5"); ok {
			t.Errorf("%q: an illegal move must be rejected", id)
		}
	}
}

// Immutability: Apply returns a new state and leaves the receiver untouched.
func TestApplyIsImmutable(t *testing.T) {
	st, _ := New(Standard, chess.StartFEN)
	if _, _, ok := st.Apply("d2d4"); !ok {
		t.Fatal("Apply(d2d4) rejected")
	}
	if st.Side() != chess.White || len(st.LegalMoves()) != 20 {
		t.Error("Apply mutated the receiver")
	}
}

// Duck builds its own ruleset: a composite move places the duck, PrimaryUCI keeps
// only the piece portion, and the variant self-searches (Tier 2).
func TestDuckRuleset(t *testing.T) {
	st, err := New(Duck, chess.StartFEN)
	if err != nil {
		t.Fatalf("New(duck): %v", err)
	}
	if st.Duck() != "" {
		t.Errorf("fresh duck square = %q, want empty (unplaced)", st.Duck())
	}
	next, san, ok := st.Apply("e2e4:e5")
	if !ok || san == "" {
		t.Fatalf("Apply(e2e4:e5) = (%q, %v), want a SAN and true", san, ok)
	}
	if next.Duck() != "e5" {
		t.Errorf("duck square after move = %q, want e5", next.Duck())
	}
	if next.PrimaryUCI("e2e4:e5") != "e2e4" {
		t.Errorf("PrimaryUCI(composite) = %q, want e2e4", next.PrimaryUCI("e2e4:e5"))
	}
	if next.History() != nil {
		t.Error("duck carries no repetition history")
	}
}

func TestSelfSearches(t *testing.T) {
	if !SelfSearches(Duck) {
		t.Error("Duck must self-search (Tier 2)")
	}
	for _, id := range []string{Standard, Chess960, "unknown"} {
		if SelfSearches(id) {
			t.Errorf("%q must use the engine pool (Tier 1), not self-search", id)
		}
	}
}

func TestNewRejectsBadFEN(t *testing.T) {
	if _, err := New(Standard, "not a fen"); err == nil {
		t.Error("New with a bad FEN must error")
	}
	if _, err := New(Duck, "not a fen"); err == nil {
		t.Error("New(duck) with a bad FEN must error")
	}
}
