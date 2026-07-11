package search

import (
	"testing"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// TestSingularParamsPreserveDefault confirms promoting the singular consts to
// Params fields didn't change the default engine: the defaults equal the old
// const values, so the banked +22.2 singular behavior is byte-identical.
func TestSingularParamsPreserveDefault(t *testing.T) {
	d := DefaultParams()
	if d.SingularMargin != singularMargin {
		t.Fatalf("SingularMargin default %d != const %d", d.SingularMargin, singularMargin)
	}
	if d.SingularMinDepth != singularMinDepth {
		t.Fatalf("SingularMinDepth default %d != const %d", d.SingularMinDepth, singularMinDepth)
	}
}

// TestPrunerParamsPreserveDefault confirms the shallow-pruner depth caps + shape
// constants promoted to Params fields keep DefaultParams byte-identical (each
// default equals the old hardcoded const / literal), so no playing behavior moves.
func TestPrunerParamsPreserveDefault(t *testing.T) {
	d := DefaultParams()
	cases := []struct {
		name string
		got  int
		want int
	}{
		{"RFPMaxDepth", d.RFPMaxDepth, rfpMaxDepth},
		{"FutilityMaxDepth", d.FutilityMaxDepth, futilityMaxDepth},
		{"LMPMaxDepth", d.LMPMaxDepth, lmpMaxDepth},
		{"HistPruneMaxDepth", d.HistPruneMaxDepth, histPruneMaxDepth},
		{"HistPruneMargin", d.HistPruneMargin, histPruneMargin},
		{"LMPBase", d.LMPBase, 3},
		{"LMPMultX10", d.LMPMultX10, 10},
		{"NMPDepthDiv", d.NMPDepthDiv, 4},
		{"NMPEvalCap", d.NMPEvalCap, 3},
		{"LMRMinMoves", d.LMRMinMoves, 4},
	}
	for _, c := range cases {
		if c.got != c.want {
			t.Errorf("%s default %d != expected const %d", c.name, c.got, c.want)
		}
	}
}

// TestIIRPVOnlyWired confirms the reworked (PV-only) IIR is still wired: turning
// it on changes the searched tree. (It now fires only on PV nodes, so the change
// is smaller than the old all-nodes variant, but must be non-zero.)
func TestIIRPVOnlyWired(t *testing.T) {
	on, off := DefaultParams(), DefaultParams()
	on.IIR = true
	off.IIR = false
	changed := 0
	for _, fen := range wave3FENs {
		pos, err := chess.ParseFEN(fen)
		if err != nil {
			t.Fatalf("parse %q: %v", fen, err)
		}
		non := NewWithParams(16, on).Search(pos, Limits{Depth: 12}, nil).Nodes
		noff := NewWithParams(16, off).Search(pos, Limits{Depth: 12}, nil).Nodes
		t.Logf("%-50.50s  iir-on=%d iir-off=%d  delta=%+d", fen, non, noff, int64(non)-int64(noff))
		if non != noff {
			changed++
		}
	}
	if changed == 0 {
		t.Fatal("IIR(PV-only) on==off on all FENs — not wired")
	}
}
