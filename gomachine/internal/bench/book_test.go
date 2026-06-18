package bench

import (
	"testing"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// All embedded openings must produce a legal, parseable position.
func TestEmbeddedBookLegal(t *testing.T) {
	book, err := EmbeddedBook()
	if err != nil {
		t.Fatalf("EmbeddedBook: %v", err)
	}
	if len(book) < 8 {
		t.Fatalf("expected a real book, got %d openings", len(book))
	}
	for _, o := range book {
		pos, err := chess.ParseFEN(o.FEN)
		if err != nil {
			t.Errorf("%s: FEN %q does not parse: %v", o.Name, o.FEN, err)
			continue
		}
		if !pos.Legal() {
			t.Errorf("%s: opening position is illegal: %s", o.Name, o.FEN)
		}
		var ml chess.MoveList
		pos.GenerateLegal(&ml)
		if ml.Len() == 0 {
			t.Errorf("%s: no legal moves from opening (terminal): %s", o.Name, o.FEN)
		}
	}
}
