package eval

import (
	"testing"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

func mustFEN(t *testing.T, fen string) *chess.Position {
	t.Helper()
	pos, err := chess.ParseFEN(fen)
	if err != nil {
		t.Fatalf("ParseFEN(%s): %v", fen, err)
	}
	return pos
}

// The start position is symmetric, so the base eval is just the tempo bonus, and
// mobility must not break that symmetry (it contributes 0).
func TestStartposSymmetric(t *testing.T) {
	pos := mustFEN(t, chess.StartFEN)
	base := Evaluate(pos, Config{})
	withMob := Evaluate(pos, Config{Mobility: true, W: DefaultWeights()})
	if base != Tempo {
		t.Errorf("startpos base eval = %d, want %d (tempo only)", base, Tempo)
	}
	if withMob != base {
		t.Errorf("mobility broke startpos symmetry: %d vs %d", withMob, base)
	}
	if mg, eg := mobility(pos, DefaultWeights()); mg != 0 || eg != 0 {
		t.Errorf("startpos mobility = (%d,%d), want (0,0)", mg, eg)
	}
}

// With positive mobility weights, a central knight (8 moves) gives the active
// side a positive mobility term vs a cornered knight (2 moves). Uses explicit
// weights so the test verifies the mechanism, not the (tuned) default values.
func TestMobilityFavorsActivePiece(t *testing.T) {
	pos := mustFEN(t, "n3k3/8/8/4N3/8/8/8/4K3 w - - 0 1")
	w := &Weights{MobMG: [4]int{4, 4, 4, 4}, MobEG: [4]int{4, 4, 4, 4}}
	mg, eg := mobility(pos, w)
	if mg <= 0 || eg <= 0 {
		t.Errorf("mobility = (%d,%d), want White-positive", mg, eg)
	}
}

// The same board scored from each side to move must sum to 2·Tempo: Evaluate
// returns whitePersp+Tempo for White and -whitePersp+Tempo for Black, so the
// position-dependent part cancels. Weight-independent perspective check.
func TestEvaluatePerspective(t *testing.T) {
	cfg := Config{Mobility: true, Pawns: true, KingSafety: true, BishopPair: true, W: DefaultWeights()}
	wtm := mustFEN(t, "r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 0 1")
	btm := mustFEN(t, "r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R b KQkq - 0 1")
	sw := Evaluate(wtm, cfg)
	sb := Evaluate(btm, cfg)
	if sw+sb != 2*Tempo {
		t.Errorf("eval perspective not symmetric: wtm=%d btm=%d sum=%d want %d", sw, sb, sw+sb, 2*Tempo)
	}
}
