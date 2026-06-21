package eval

import (
	"testing"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// w returns weights with the race bonus active.
func raceW() *Weights { return DefaultWeights() }

// TestKnightDist sanity-checks the BFS distance table.
func TestKnightDist(t *testing.T) {
	b1 := int(chess.MakeSquare(1, 0)) // b1
	c3 := int(chess.MakeSquare(2, 2)) // c3
	a1 := int(chess.MakeSquare(0, 0))
	h8 := int(chess.MakeSquare(7, 7))
	if knightDist[b1][c3] != 1 {
		t.Errorf("b1→c3 = %d, want 1", knightDist[b1][c3])
	}
	if knightDist[a1][a1] != 0 {
		t.Errorf("a1→a1 = %d, want 0", knightDist[a1][a1])
	}
	if d := knightDist[a1][h8]; d != 6 {
		t.Errorf("a1→h8 = %d, want 6", d)
	}
}

func TestPawnRace(t *testing.T) {
	cases := []struct {
		name     string
		fen      string
		wantPos  bool // term favors White (>0)
		wantNeg  bool // term favors Black (<0)
		wantZero bool
	}{
		// White pawn on a7, lone kings, Black king far in the corner → unstoppable.
		{"white runner unstoppable", "7k/P7/8/8/8/8/8/K7 w - - 0 1", true, false, false},
		// Same but Black king right next to the promotion square → king catches.
		{"king catches", "1k6/P7/8/8/8/8/8/K7 w - - 0 1", false, false, true},
		// White a7 runner, but a Black knight on c7 already attacks a8 → caught.
		{"knight catches", "7k/P1n5/8/8/8/8/8/K7 w - - 0 1", false, false, true},
		// White a7 runner, Black knight stuck in the far corner (h-file) → too far.
		{"knight too far", "7k/P7/8/8/8/8/8/K6n w - - 0 1", true, false, false},
		// Black has the unstoppable runner, White does not → term penalizes White.
		{"black runner", "k7/8/8/8/8/8/p7/7K w - - 0 1", false, true, false},
		// Defender has a rook → out of scope, term stays 0 even with a runner.
		{"rook defender out of scope", "r6k/P7/8/8/8/8/8/K7 w - - 0 1", false, false, true},
	}
	for _, c := range cases {
		pos, err := chess.ParseFEN(c.fen)
		if err != nil {
			t.Fatalf("%s: bad fen: %v", c.name, err)
		}
		got := passedPawnRace(pos, raceW())
		switch {
		case c.wantPos && got <= 0:
			t.Errorf("%s: race = %d, want > 0", c.name, got)
		case c.wantNeg && got >= 0:
			t.Errorf("%s: race = %d, want < 0", c.name, got)
		case c.wantZero && got != 0:
			t.Errorf("%s: race = %d, want 0", c.name, got)
		}
	}
}

// TestPawnRaceSymmetricRunnersCancel checks that when both sides have an equally
// unstoppable runner (180° rotation), the White-minus-Black term roughly cancels —
// it is not exactly 0 because the side to move queens one tempo sooner, but it must
// stay small (no false "I'm winning the race" signal in a drawn race).
func TestPawnRaceSymmetricRunnersCancel(t *testing.T) {
	// White Ka1 Pa7 ↔ Black Kh8 Ph2: each runner is unstoppable, kings far.
	pos, err := chess.ParseFEN("7k/P7/8/8/8/8/7p/K7 w - - 0 1")
	if err != nil {
		t.Fatalf("bad fen: %v", err)
	}
	got := passedPawnRace(pos, raceW())
	if got < -raceDecay*2 || got > raceDecay*2 {
		t.Errorf("symmetric runners race = %d, want within ±%d", got, raceDecay*2)
	}
}

// TestPawnRaceDiagnosedPositionIsZero verifies the term adds no false optimism in
// the symmetric K+N+3P position the whole endgame push was triggered by: every
// passer is caught by the nearby enemy king, so the term must be exactly 0.
func TestPawnRaceDiagnosedPositionIsZero(t *testing.T) {
	pos, err := chess.ParseFEN("3kn3/5ppp/8/8/8/8/PPP5/3NK3 w - - 0 1")
	if err != nil {
		t.Fatalf("bad fen: %v", err)
	}
	if got := passedPawnRace(pos, raceW()); got != 0 {
		t.Errorf("diagnosed position race = %d, want 0 (no unstoppable passer)", got)
	}
}
