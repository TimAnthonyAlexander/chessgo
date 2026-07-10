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
	t.Skip("pending full-threats Rust port — the on-disk net sidecars are the old threat scheme; their sizes no longer match the (much larger) full-threats InputDim — see docs/open_tasks/threats-richness-build.md")
	pos, err := chess.ParseFEN(chess.StartFEN)
	if err != nil {
		t.Fatalf("parse start fen: %v", err)
	}
	// Canonical net file sizes (docs/open_tasks HANDOFF §4A): the multilayer layout is
	// strictly larger, which is exactly what the size auto-detect keys off. Ground-truth
	// the expected arch from the file's actual size so this test is robust to WHICH net
	// is currently deployed at kb-mirror.bin (lean vs multilayer are file-swapped).
	const (
		leanSize  = 44075072 // single-layer int16 tail
		multiSize = 44323392 // multilayer 16→32 tail
	)
	paths := []string{
		"../../data/nnue/kb-mirror.bin",       // whichever net is currently shipped
		"../../data/nnue/ml_efs28_smoke.bin",  // multilayer (efs28 smoke fixture)
	}
	any := false
	for _, path := range paths {
		fi, statErr := os.Stat(path)
		if statErr != nil {
			t.Logf("net %s absent (gitignored) — skipping", path)
			continue
		}
		var wantLean bool
		switch fi.Size() {
		case leanSize:
			wantLean = true
		case multiSize:
			wantLean = false
		default:
			t.Logf("net %s size %d is neither known arch — skipping", path, fi.Size())
			continue
		}
		any = true
		n, err := LoadKBNet(path, 512, 16, 32, 8)
		if err != nil {
			t.Fatalf("LoadKBNet(%s): %v", path, err)
		}
		if n.IsLean() != wantLean {
			t.Fatalf("%s (size %d): IsLean()=%v, want %v (size auto-detect misfired)", path, fi.Size(), n.IsLean(), wantLean)
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
			t.Fatalf("%s: start-pos eval %d cp out of sane range", path, ev)
		}
		t.Logf("%s: lean=%v startEval=%dcp", path, n.IsLean(), ev)
	}
	if !any {
		t.Skip("no net sidecars present — nothing to detect")
	}
}
