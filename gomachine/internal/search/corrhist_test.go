package search

import (
	"testing"

	"github.com/timanthonyalexander/gomachine/internal/chess"
	"github.com/timanthonyalexander/gomachine/internal/eval"
)

var corrFENs = []string{
	chess.StartFEN,
	"r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3",
	"4k3/5ppp/8/8/8/8/PPP5/4K3 w - - 0 1",
	"4k3/8/2p5/3p4/8/3Q4/8/4K3 w - - 0 1",
	"r3k2r/pppq1ppp/2np1n2/2b1p3/2B1P3/2NP1N2/PPPQ1PPP/R3K2R b KQkq - 0 1",
}

// With CorrHist off, evaluate() must be byte-identical to the raw HCE eval — the
// flag-gated correction block may not perturb the off path at all.
func TestCorrHistOffByteIdentical(t *testing.T) {
	p := DefaultParams()
	p.Nnue = false // exercise the HCE path (no net dependency in the test)
	p.CorrHist = false
	s := NewWithParams(16, p)
	for _, fen := range corrFENs {
		pos, err := chess.ParseFEN(fen)
		if err != nil {
			t.Fatalf("ParseFEN(%q): %v", fen, err)
		}
		got := s.evaluate(pos)
		want := eval.Evaluate(pos, s.ec)
		if got != want {
			t.Errorf("%s: evaluate=%d, raw eval=%d (corrhist off must not perturb)", fen, got, want)
		}
	}
}

// The blended correction is bounded to ±corrMaxApply even with saturated tables.
func TestCorrHistCorrectionBounded(t *testing.T) {
	p := DefaultParams()
	p.Nnue = false
	p.CorrHist = true
	s := NewWithParams(16, p)
	// Saturate every entry to the max magnitude in both directions and check bounds.
	for _, sign := range []int32{+corrMaxEntry, -corrMaxEntry} {
		for i := range s.corr.pawn[0] {
			s.corr.pawn[0][i], s.corr.pawn[1][i] = sign, sign
			s.corr.wnp[0][i], s.corr.wnp[1][i] = sign, sign
			s.corr.bnp[0][i], s.corr.bnp[1][i] = sign, sign
		}
		for _, fen := range corrFENs {
			pos, _ := chess.ParseFEN(fen)
			c := s.correction(pos)
			if c > corrMaxApply || c < -corrMaxApply {
				t.Errorf("%s: correction %d out of bounds ±%d", fen, c, corrMaxApply)
			}
		}
	}
}

// Feeding a consistent positive (search > static) signal must push the corrected
// eval up; a negative signal must push it down. Cold tables contribute 0.
func TestCorrHistDirection(t *testing.T) {
	p := DefaultParams()
	p.Nnue = false
	p.CorrHist = true

	for _, fen := range []string{corrFENs[0], corrFENs[2], corrFENs[3]} {
		pos, err := chess.ParseFEN(fen)
		if err != nil {
			t.Fatalf("ParseFEN: %v", err)
		}

		// Up: search consistently beats static by +120cp.
		sUp := NewWithParams(16, p)
		base := sUp.evaluate(pos) // cold → no correction
		static := base
		for i := 0; i < 64; i++ {
			sUp.updateCorrHist(pos, static, static+120, 8)
		}
		up := sUp.evaluate(pos)
		if up <= base {
			t.Errorf("%s: positive signal did not raise eval (base=%d up=%d)", fen, base, up)
		}

		// Down: search consistently falls short of static by 120cp.
		sDn := NewWithParams(16, p)
		base2 := sDn.evaluate(pos)
		for i := 0; i < 64; i++ {
			sDn.updateCorrHist(pos, base2, base2-120, 8)
		}
		dn := sDn.evaluate(pos)
		if dn >= base2 {
			t.Errorf("%s: negative signal did not lower eval (base=%d dn=%d)", fen, base2, dn)
		}
	}
}

// ClearTT() must wipe the correction tables (they are per-game state).
func TestCorrHistClearedByClearTT(t *testing.T) {
	p := DefaultParams()
	p.Nnue = false
	p.CorrHist = true
	s := NewWithParams(16, p)
	pos, _ := chess.ParseFEN(corrFENs[0])
	static := s.evaluate(pos)
	for i := 0; i < 64; i++ {
		s.updateCorrHist(pos, static, static+120, 8)
	}
	if s.correction(pos) == 0 {
		t.Fatalf("expected a non-zero correction after training")
	}
	s.ClearTT()
	if c := s.correction(pos); c != 0 {
		t.Errorf("ClearTT did not reset correction history (got %d)", c)
	}
}
