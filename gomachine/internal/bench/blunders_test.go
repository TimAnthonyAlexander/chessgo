package bench

import (
	"strings"
	"testing"
)

// TestWinProb checks the cp→win-prob mapping is centered and monotone, and that a
// "mate → still winning" swing is small while an "equal → losing" swing is large —
// the whole reason we measure blunders in win-prob, not raw centipawns.
func TestWinProb(t *testing.T) {
	if got := winProb(0); got < 0.49 || got > 0.51 {
		t.Errorf("winProb(0) = %.3f, want ~0.5", got)
	}
	if winProb(100) <= winProb(0) || winProb(-100) >= winProb(0) {
		t.Error("winProb not monotone around 0")
	}
	// mate(19999) → still-winning(913): a huge cp swing but a tiny win-prob drop.
	mateToWinning := winProb(19999) - winProb(913)
	if mateToWinning > 0.10 {
		t.Errorf("mate→winning win-drop = %.3f, want small (<0.10)", mateToWinning)
	}
	// equal(0) → losing(-400): the case we care about, a large win-prob drop.
	equalToLosing := winProb(0) - winProb(-400)
	if equalToLosing < 0.30 {
		t.Errorf("equal→losing win-drop = %.3f, want large (≥0.30)", equalToLosing)
	}
}

// TestIsTrainable exercises the EPD-emission gate: only quiet, blind-spot, genuinely
// bad (not still-winning) positions qualify, with the confirm-loss filter optional.
func TestIsTrainable(t *testing.T) {
	base := Blunder{Class: "blind_spot", EvalAfter: -300, Quiet: true, OurWon: false}
	cfg := BlunderConfig{TrainMaxCp: 0, QuietOnly: true}

	if !isTrainable(base, cfg) {
		t.Error("a quiet blind-spot losing position should be trainable")
	}

	horizon := base
	horizon.Class = "horizon"
	if isTrainable(horizon, cfg) {
		t.Error("horizon losses are search problems, not eval-trainable")
	}

	stillWinning := base
	stillWinning.EvalAfter = 250 // gomachine still winning after the "blunder"
	if isTrainable(stillWinning, cfg) {
		t.Error("a still-winning position must not be labelled with a loss")
	}

	live := base
	live.Quiet = false
	if isTrainable(live, cfg) {
		t.Error("a non-quiet (mid-tactic) position is a noisy training label")
	}
	// ...unless QuietOnly is off.
	if !isTrainable(live, BlunderConfig{TrainMaxCp: 0, QuietOnly: false}) {
		t.Error("non-quiet should be allowed when QuietOnly is off")
	}

	won := base
	won.OurWon = true
	if isTrainable(won, BlunderConfig{TrainMaxCp: 0, QuietOnly: true, ConfirmLoss: true}) {
		t.Error("confirm-loss must exclude blunders in games gomachine won")
	}
}

// TestWriteEPD checks the emitted lines are the resulting (bad) FEN labelled by the
// game RESULT (not cp), deduped, and in the c9 format the tuner already parses.
func TestWriteEPD(t *testing.T) {
	fenA := "rn1qkb1r/pp1b1ppp/3p4/4p3/2B1n3/5N2/PPP2PPP/RNBQK2R w KQkq - 0 8"
	blunders := []Blunder{
		{Class: "blind_spot", EvalAfter: -380, Quiet: true, FENAfter: fenA, GameResult: "1-0"},
		{Class: "blind_spot", EvalAfter: -380, Quiet: true, FENAfter: fenA, GameResult: "1-0"}, // dup FEN
		{Class: "horizon", EvalAfter: -380, Quiet: true, FENAfter: "8/8/8/8/8/8/8/8 w - - 0 1", GameResult: "0-1"},
	}
	var sb strings.Builder
	n, err := WriteEPD(&sb, blunders, BlunderConfig{TrainMaxCp: 0, QuietOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("wrote %d lines, want 1 (dedup + horizon excluded)", n)
	}
	want := fenA + ` c9 "1-0";` + "\n"
	if sb.String() != want {
		t.Errorf("EPD line = %q, want %q", sb.String(), want)
	}
}
