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
