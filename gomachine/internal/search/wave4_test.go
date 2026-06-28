package search

import (
	"testing"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// Wave-4 cheap top-ups: IIR, frontier futility, ProbCut, razoring. Each is behind
// a default-off flag and must (a) leave the default engine byte-identical when off
// and (b) actually change the search tree when on (proving it is wired, not a
// no-op — we had a no-op scare with conthist).

// TestWave4OffPathDeterministic confirms the default engine (all four flags off)
// is unchanged: two searches give identical nodes/move/score. Since the flags
// default off and every read is gated, this is the byte-identical off-path check.
func TestWave4OffPathDeterministic(t *testing.T) {
	for _, fen := range wave3FENs {
		pos, err := chess.ParseFEN(fen)
		if err != nil {
			t.Fatalf("parse %q: %v", fen, err)
		}
		a := NewWithParams(16, DefaultParams()).Search(pos, Limits{Depth: 11}, nil)
		b := NewWithParams(16, DefaultParams()).Search(pos, Limits{Depth: 11}, nil)
		if a.Nodes != b.Nodes || a.BestMove != b.BestMove || a.Score != b.Score {
			t.Fatalf("%s: non-deterministic default search: (%d,%v,%d) vs (%d,%v,%d)",
				fen, a.Nodes, a.BestMove, a.Score, b.Nodes, b.BestMove, b.Score)
		}
		// The DEFAULT-OFF flags (IIR/ProbCut/Razor — futility is now default-ON, +21
		// banked) must be no-ops when explicitly set off: setting them off equals the
		// default engine. (Futility is left at its default so this stays meaningful.)
		p := DefaultParams()
		p.IIR, p.ProbCut, p.Razor = false, false, false
		c := NewWithParams(16, p).Search(pos, Limits{Depth: 11}, nil)
		if c.Nodes != a.Nodes {
			t.Fatalf("%s: explicit-off node count %d != default %d", fen, c.Nodes, a.Nodes)
		}
	}
}

// TestWave4FlagsAreWired confirms each flag, turned on individually, changes the
// searched tree on at least one position — i.e. it is actually doing something.
func TestWave4FlagsAreWired(t *testing.T) {
	flags := []struct {
		name string
		set  func(*Params)
	}{
		{"iir", func(p *Params) { p.IIR = true }},
		{"futility", func(p *Params) { p.Futility = true }},
		{"probcut", func(p *Params) { p.ProbCut = true }},
		{"razor", func(p *Params) { p.Razor = true }},
	}
	for _, f := range flags {
		changed := false
		for _, fen := range wave3FENs {
			pos, err := chess.ParseFEN(fen)
			if err != nil {
				t.Fatalf("parse %q: %v", fen, err)
			}
			// Build explicit OFF and ON variants of just this flag (robust to whether
			// the flag is default-on or default-off — futility is now default-on).
			poff := DefaultParams()
			pon := DefaultParams()
			f.set(&pon)
			switch f.name {
			case "iir":
				poff.IIR = false
			case "futility":
				poff.Futility = false
			case "probcut":
				poff.ProbCut = false
			case "razor":
				poff.Razor = false
			}
			off := NewWithParams(16, poff).Search(pos, Limits{Depth: 12}, nil).Nodes
			on := NewWithParams(16, pon).Search(pos, Limits{Depth: 12}, nil).Nodes
			t.Logf("%-9s %-50.50s off=%d on=%d delta=%+d", f.name, fen, off, on, int64(on)-int64(off))
			if on != off {
				changed = true
			}
		}
		if !changed {
			t.Errorf("flag %q changed no node counts on any FEN — likely a no-op (wiring bug)", f.name)
		}
	}
}
