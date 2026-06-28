package search

import (
	"testing"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// mkParams returns DefaultParams with the listed Wave-3 / diagnostic flags set.
func mkParams(lmr2, singular, multicut, cleanVerify bool) Params {
	p := DefaultParams()
	p.LMR2, p.Singular, p.MultiCut, p.CleanVerify = lmr2, singular, multicut, cleanVerify
	return p
}

// TestCleanVerifyInertInDefaultEngine confirms the default engine (Singular on,
// LMR2 off) is unaffected by CleanVerify: the gate is `LMR2 && CleanVerify && ...`,
// so with LMR2 off it can never fire. Node counts must be byte-identical.
func TestCleanVerifyInertInDefaultEngine(t *testing.T) {
	for _, fen := range wave3FENs {
		pos, err := chess.ParseFEN(fen)
		if err != nil {
			t.Fatalf("parse %q: %v", fen, err)
		}
		def := DefaultParams() // MultiCut true, CleanVerify false, LMR2 false, Singular true
		cv := def
		cv.CleanVerify = true
		a := NewWithParams(16, def).Search(pos, Limits{Depth: 11}, nil)
		b := NewWithParams(16, cv).Search(pos, Limits{Depth: 11}, nil)
		if a.Nodes != b.Nodes || a.BestMove != b.BestMove || a.Score != b.Score {
			t.Fatalf("%s: CleanVerify changed the default engine (nodes %d/%d best %v/%v score %d/%d)",
				fen, a.Nodes, b.Nodes, a.BestMove, b.BestMove, a.Score, b.Score)
		}
	}
}

// TestMultiCutToggleSuppresses confirms the multicut gate is live: with
// lmr2+singular, MultiCut=on fires multicuts (counter > 0 somewhere) and
// MultiCut=off suppresses them entirely (counter == 0 everywhere).
func TestMultiCutToggleSuppresses(t *testing.T) {
	var firedOn uint64
	for _, fen := range wave3FENs {
		pos, err := chess.ParseFEN(fen)
		if err != nil {
			t.Fatalf("parse %q: %v", fen, err)
		}
		sOn := NewWithParams(16, mkParams(true, true, true, false))
		sOn.Search(pos, Limits{Depth: 12}, nil)
		firedOn += sOn.DbgMultiCut()

		sOff := NewWithParams(16, mkParams(true, true, false, false))
		sOff.Search(pos, Limits{Depth: 12}, nil)
		if mc := sOff.DbgMultiCut(); mc != 0 {
			t.Fatalf("%s: MultiCut=off still multicut %d times", fen, mc)
		}
	}
	if firedOn == 0 {
		t.Fatalf("MultiCut=on never fired across all FENs — test position set can't exercise the gate")
	}
}

// TestCleanVerifyLiveUnderLMR2 confirms CleanVerify actually changes the search
// when LMR2 is on (the verification subtree reduces differently), on >=1 FEN.
func TestCleanVerifyLiveUnderLMR2(t *testing.T) {
	differs := 0
	for _, fen := range wave3FENs {
		pos, err := chess.ParseFEN(fen)
		if err != nil {
			t.Fatalf("parse %q: %v", fen, err)
		}
		off := NewWithParams(16, mkParams(true, true, true, false)).Search(pos, Limits{Depth: 12}, nil)
		on := NewWithParams(16, mkParams(true, true, true, true)).Search(pos, Limits{Depth: 12}, nil)
		if off.Nodes != on.Nodes {
			differs++
		}
	}
	if differs == 0 {
		t.Fatalf("CleanVerify changed nothing under LMR2 on any FEN — toggle is not wired")
	}
}
