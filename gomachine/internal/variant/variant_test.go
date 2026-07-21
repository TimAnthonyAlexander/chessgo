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
		if st.Extras() != nil {
			t.Errorf("%q: Extras() = %v, want nil (no auxiliary state)", id, st.Extras())
		}
		if st.BoardFEN() != st.FEN() {
			t.Errorf("%q: BoardFEN should equal FEN for standard", id)
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
	if st.Extras()["duck"] != "" {
		t.Errorf("fresh duck square = %q, want empty (unplaced)", st.Extras()["duck"])
	}
	next, san, ok := st.Apply("e2e4:e5")
	if !ok || san == "" {
		t.Fatalf("Apply(e2e4:e5) = (%q, %v), want a SAN and true", san, ok)
	}
	if next.Extras()["duck"] != "e5" {
		t.Errorf("duck square after move = %q, want e5", next.Extras()["duck"])
	}
	if next.PrimaryUCI("e2e4:e5") != "e2e4" {
		t.Errorf("PrimaryUCI(composite) = %q, want e2e4", next.PrimaryUCI("e2e4:e5"))
	}
	if next.History() != nil {
		t.Error("duck carries no repetition history")
	}
}

// Crazyhouse plugs in as a Tier-2 variant: its canonical FEN carries the pocket,
// the board FEN is standard-shape, the pocket rides in Extras, and it self-searches.
func TestCrazyhouseRuleset(t *testing.T) {
	st, err := New(Crazyhouse, chess.StartFEN)
	if err != nil {
		t.Fatalf("New(crazyhouse): %v", err)
	}
	if st.Extras()["pocket"] != "" {
		t.Errorf("fresh pocket = %q, want empty", st.Extras()["pocket"])
	}
	if st.BoardFEN() == st.FEN() {
		t.Error("Crazyhouse BoardFEN (standard) should differ from the canonical FEN (has [pocket])")
	}
	next, san, ok := st.Apply("e2e4")
	if !ok || san != "e4" {
		t.Fatalf("Apply(e2e4) = (%q, %v), want (e4, true)", san, ok)
	}
	if next.Side() != chess.Black {
		t.Errorf("side after e4 = %v, want Black", next.Side())
	}
	// A canonical FEN with a pocket must reconstruct (self-describing).
	if _, err := New(Crazyhouse, "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR[Pn] w KQkq - 0 1"); err != nil {
		t.Errorf("New(crazyhouse, pocketed FEN): %v", err)
	}
}

// Antichess plugs in as a Tier-2 variant: no auxiliary wire state (Extras is
// nil like standard), no repetition history exposed (threefold is internal to
// its own Status), plain UCI (including the Antichess-only king-promotion
// suffix), and it self-searches.
func TestAntichessRuleset(t *testing.T) {
	st, err := New(Antichess, chess.StartFEN)
	if err != nil {
		t.Fatalf("New(antichess): %v", err)
	}
	if st.Extras() != nil {
		t.Errorf("Extras() = %v, want nil (no pockets, no duck square)", st.Extras())
	}
	if st.BoardFEN() != st.FEN() {
		t.Error("Antichess BoardFEN should equal FEN (standard-shape, self-describing)")
	}
	if len(st.LegalMoves()) != 20 {
		t.Errorf("%d opening moves, want 20 (no captures available yet)", len(st.LegalMoves()))
	}
	next, san, ok := st.Apply("e2e4")
	if !ok || san != "e4" {
		t.Fatalf("Apply(e2e4) = (%q, %v), want (e4, true)", san, ok)
	}
	if next.Side() != chess.Black {
		t.Errorf("side after e4 = %v, want Black", next.Side())
	}
	if next.PrimaryUCI("e2e4") != "e2e4" {
		t.Error("PrimaryUCI should be identity for plain UCI")
	}
	if next.History() != nil {
		t.Error("antichess carries no exposed repetition history (internal to its own Status)")
	}
	if !next.CanMate(chess.White) || !next.CanMate(chess.Black) {
		t.Error("CanMate must always be true for antichess")
	}

	// A pawn one step from queening onto an empty square may also promote to
	// a KING — the Antichess-only promotion choice.
	kp, err := New(Antichess, "4k3/P7/8/8/8/8/8/4K3 w - - 0 1")
	if err != nil {
		t.Fatalf("New(antichess, king-promo fen): %v", err)
	}
	if _, _, ok := kp.Apply("a7a8k"); !ok {
		t.Error("king promotion a7a8k must be a legal Apply")
	}
}

func TestSelfSearches(t *testing.T) {
	for _, id := range []string{Duck, Crazyhouse, Antichess} {
		if !SelfSearches(id) {
			t.Errorf("%q must self-search (Tier 2)", id)
		}
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
	if _, err := New(Antichess, "not a fen"); err == nil {
		t.Error("New(antichess) with a bad FEN must error")
	}
}
