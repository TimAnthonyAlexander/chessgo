package openings

import (
	"strings"
	"testing"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// keysForSANs replays a SAN line from the start position and returns the Zobrist
// key of every position along the way (root→leaf, inclusive of the start).
func keysForSANs(t *testing.T, sans []string) []uint64 {
	t.Helper()
	pos, err := chess.ParseFEN(chess.StartFEN)
	if err != nil {
		t.Fatalf("parse start: %v", err)
	}
	keys := []uint64{pos.Key()}
	for _, san := range sans {
		var ml chess.MoveList
		pos.GenerateLegal(&ml)
		var mv chess.Move
		found := false
		for i := 0; i < ml.Len(); i++ {
			m := ml.Get(i)
			clean := strings.NewReplacer("+", "", "#", "").Replace(pos.SAN(m))
			if clean == san {
				mv, found = m, true
				break
			}
		}
		if !found {
			t.Fatalf("no legal move for SAN %q", san)
		}
		var u chess.Undo
		pos.DoMove(mv, &u)
		keys = append(keys, pos.Key())
	}
	return keys
}

func TestClassifyKnownLines(t *testing.T) {
	cases := []struct {
		sans    []string
		wantECO string
		wantSub string // substring the name must contain
	}{
		{[]string{"e4", "c5", "Nf3", "d6", "d4", "cxd4", "Nxd4", "Nf6", "Nc3", "a6"}, "B90", "Najdorf"},
		{[]string{"e4", "e5", "Nf3", "Nc6", "Bb5"}, "C60", "Ruy Lopez"},
		{[]string{"d4", "d5", "c4", "e6"}, "D30", "Queen's Gambit Declined"},
		{[]string{"e4", "e6"}, "C00", "French"},
		{[]string{"g4"}, "A00", "Grob"},
	}
	for _, c := range cases {
		keys := keysForSANs(t, c.sans)
		o, ok := Classify(keys)
		if !ok {
			t.Errorf("%v: no opening matched", c.sans)
			continue
		}
		if o.ECO != c.wantECO || !strings.Contains(o.Name, c.wantSub) {
			t.Errorf("%v: got %s %q, want %s containing %q", c.sans, o.ECO, o.Name, c.wantECO, c.wantSub)
		}
	}
}

// The deepest match must win: the full Najdorf line resolves to the specific
// Najdorf, not the generic Sicilian its prefix would match.
func TestClassifyDeepestWins(t *testing.T) {
	keys := keysForSANs(t, []string{"e4", "c5", "Nf3", "d6", "d4", "cxd4", "Nxd4", "Nf6", "Nc3", "a6"})
	o, ok := Classify(keys)
	if !ok || !strings.Contains(o.Name, "Najdorf") {
		t.Fatalf("deepest-match failed: got ok=%v %q", ok, o.Name)
	}
}

func TestTableNonEmpty(t *testing.T) {
	if Len() < 3000 {
		t.Fatalf("opening table looks unpopulated: %d entries", Len())
	}
}
