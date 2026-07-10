package nnue

import (
	"os"
	"testing"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// TestLoadKBNet_DetectsLeanVsMultilayer gates the size-based auto-detect the prod
// loader (loadDefaultKBNet) relies on: the lean single-layer net and the multilayer
// net must be distinguished by file size alone, and each must then load + eval. Skips
// when the gitignored net sidecars aren't present (CI / a fresh checkout).
func TestLoadKBNet_DetectsLeanVsMultilayer(t *testing.T) {
	pos, err := chess.ParseFEN(chess.StartFEN)
	if err != nil {
		t.Fatalf("parse start fen: %v", err)
	}
	cases := []struct {
		path     string
		wantLean bool
	}{
		{"../../data/nnue/kb-mirror.bin", true},        // prod lean net
		{"../../data/nnue/ml_efs28_smoke.bin", false},  // multilayer (efs28 smoke)
	}
	any := false
	for _, c := range cases {
		if _, statErr := os.Stat(c.path); statErr != nil {
			t.Logf("net %s absent (gitignored) — skipping", c.path)
			continue
		}
		any = true
		n, err := LoadKBNet(c.path, 512, 16, 32, 8)
		if err != nil {
			t.Fatalf("LoadKBNet(%s): %v", c.path, err)
		}
		if n.IsLean() != c.wantLean {
			t.Fatalf("%s: IsLean()=%v, want %v (size auto-detect misfired)", c.path, n.IsLean(), c.wantLean)
		}
		// Apply int8 exactly as the prod loader does for the detected arch, then a
		// from-scratch eval must produce a finite, sane cp value.
		if n.IsLean() {
			n.QuantizeFTInt8()
		} else {
			n.QuantizeForInt8()
		}
		ev := n.Eval(pos)
		if ev < -3000 || ev > 3000 {
			t.Fatalf("%s: start-pos eval %d cp out of sane range", c.path, ev)
		}
		t.Logf("%s: lean=%v startEval=%dcp", c.path, n.IsLean(), ev)
	}
	if !any {
		t.Skip("no net sidecars present — nothing to detect")
	}
}
