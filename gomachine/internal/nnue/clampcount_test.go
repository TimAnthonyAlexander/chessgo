package nnue

import (
	"os"
	"testing"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// TestKBNetClampCount measures how many FOLDED, deployed threat-FT weights the int8
// path (QuantizeFTInt8) has to clamp to ±127 — the real #2 check. It imports a
// bullet checkpoint's quantised.bin (already folded: merge_factoriser is applied in
// save_format, so l0w threat rows are real+V1+V2+V3, the SUM that actually deploys),
// then QuantizeFTInt8 returns the clamp count over ThreatBlock*H weights. Run at the
// FIRST checkpoint (sb 8): a material clamp fraction means intervene (split base/
// threat affine + clip_pass_through_grad on threat rows) BEFORE the full anneal, not
// after. Set KB_NET_PATH to the quantised.bin; skips otherwise.
func TestKBNetClampCount(t *testing.T) {
	path := os.Getenv("KB_NET_PATH")
	if path == "" {
		t.Skip("set KB_NET_PATH to a folded quantised.bin to measure int8 threat-FT clamping")
	}
	n, err := LoadKBNet(path, 512, 16, 32, 8)
	if err != nil {
		t.Fatalf("LoadKBNet(%s): %v", path, err)
	}
	if n.IsLean() {
		t.Fatalf("%s imported as LEAN — expected the multilayer threats net", path)
	}
	total := ThreatBlock * n.H
	clamped := n.QuantizeFTInt8()
	frac := float64(clamped) / float64(total) * 100
	t.Logf("CLAMP: %d / %d threat-FT weights clamped to ±127 (%.4f%%)", clamped, total, frac)

	// Non-crash eval sanity on a couple positions (per #4: sanity, NOT a strength read).
	for _, fen := range []string{chess.StartFEN, "r1bq1rk1/pp2bppp/2n1pn2/2pp4/3P1B2/2NBPN2/PPP2PPP/R2Q1RK1 w - - 0 8"} {
		pos, err := chess.ParseFEN(fen)
		if err != nil {
			t.Fatal(err)
		}
		ev := n.Eval(pos)
		if ev < -3000 || ev > 3000 {
			t.Fatalf("insane eval %d cp for %s", ev, fen)
		}
		t.Logf("eval(%s) = %d cp", fen, ev)
	}
	// Advisory threshold: >0.5%% of deployed threat weights clamped is worth an intervention look.
	if frac > 0.5 {
		t.Logf("WARNING: clamp fraction %.4f%% > 0.5%% — consider split-affine + clip_pass_through_grad on threat rows", frac)
	}
}
