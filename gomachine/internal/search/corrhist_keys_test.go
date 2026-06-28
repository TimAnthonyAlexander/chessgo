package search

import (
	"testing"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// TestCorrHistExtraKeysOffPathIdentical: with both new keys OFF (default), the
// search is byte-identical to the current default engine — the new keys are fully
// gated.
func TestCorrHistExtraKeysOffPathIdentical(t *testing.T) {
	for _, fen := range wave3FENs {
		pos, err := chess.ParseFEN(fen)
		if err != nil {
			t.Fatalf("parse %q: %v", fen, err)
		}
		a := NewWithParams(16, DefaultParams()).Search(pos, Limits{Depth: 11}, nil)
		p := DefaultParams() // explicitly pin the new keys off
		p.CorrHistMinor, p.CorrHistCont = false, false
		b := NewWithParams(16, p).Search(pos, Limits{Depth: 11}, nil)
		if a.Nodes != b.Nodes || a.BestMove != b.BestMove || a.Score != b.Score {
			t.Fatalf("%s: off-path not identical: nodes %d/%d move %v/%v score %d/%d",
				fen, a.Nodes, b.Nodes, a.BestMove, b.BestMove, a.Score, b.Score)
		}
	}
}

// TestCorrHistExtraKeysWired: each new key, turned on individually, changes the
// searched tree (proving it's actually applied, not a no-op).
func TestCorrHistExtraKeysWired(t *testing.T) {
	base := DefaultParams()
	variants := []struct {
		name string
		mut  func(p *Params)
	}{
		{"minor", func(p *Params) { p.CorrHistMinor = true }},
		{"cont", func(p *Params) { p.CorrHistCont = true }},
	}
	for _, v := range variants {
		changed := 0
		for _, fen := range wave3FENs {
			pos, _ := chess.ParseFEN(fen)
			off := NewWithParams(16, base).Search(pos, Limits{Depth: 12}, nil).Nodes
			p := base
			v.mut(&p)
			on := NewWithParams(16, p).Search(pos, Limits{Depth: 12}, nil).Nodes
			if on != off {
				changed++
			}
		}
		if changed == 0 {
			t.Fatalf("CorrHist key %q changed nothing on any FEN — no-op (wiring bug)", v.name)
		}
		t.Logf("CorrHist key %q changed the tree on %d/%d FENs", v.name, changed, len(wave3FENs))
	}
}

// TestContMoveMaintainedWithoutContHist: the continuation move-stack must be kept
// even with ContHist OFF (CorrHistCont depends on it). With CorrHistCont on (and
// ContHist off) a search must run and differ from CorrHistCont off — which can
// only happen if ply-2/-4 lookups see real moves.
func TestContMoveMaintainedWithoutContHist(t *testing.T) {
	pos, _ := chess.ParseFEN(chess.StartFEN)
	off := DefaultParams()
	off.ContHist = false
	on := off
	on.CorrHistCont = true
	rOff := NewWithParams(16, off).Search(pos, Limits{Depth: 12}, nil)
	rOn := NewWithParams(16, on).Search(pos, Limits{Depth: 12}, nil)
	if rOff.Nodes == rOn.Nodes {
		t.Fatalf("CorrHistCont had no effect with ContHist off — contMove stack not maintained (nodes %d)", rOff.Nodes)
	}
}
