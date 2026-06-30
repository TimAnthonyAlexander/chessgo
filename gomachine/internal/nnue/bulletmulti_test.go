package nnue

import (
	"os"
	"testing"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// TestImportSmokeMultiNet loads the bullet multilayer SMOKE net (trained by
// examples/chessgo_ml_smoke.rs) and evaluates a few positions — the end-to-end
// validation that bullet→Go import + the MultiNet forward agree on a real net.
// Skips if the smoke net hasn't been trained on this machine. The net is barely
// trained (2 superbatches), so the cp values are rough; the gate is that they're
// finite, sane-ranged, and that the start position is roughly balanced.
func TestImportSmokeMultiNet(t *testing.T) {
	path := os.Getenv("HOME") + "/nnue-training/bullet/checkpoints/chessgo_ml_smoke-2/raw.bin"
	if _, err := os.Stat(path); err != nil {
		t.Skipf("smoke net not present (%s) — run examples/chessgo_ml_smoke.rs", path)
	}
	n, err := ImportBulletMultiNet(path, 256, 16, 32)
	if err != nil {
		t.Fatal(err)
	}
	fens := []string{
		startFEN,
		"rnbqkbnr/ppp2ppp/8/3pp3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 3", // open center
		"r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3",
		"rnbqkb1r/pppp1ppp/5n2/4p3/4P3/8/PPPPQPPP/RNB1KBNR w KQkq - 2 3", // white up nothing, dev
		"8/8/8/4k3/8/4K3/4P3/8 w - - 0 1",                                // K+P endgame
	}
	for _, fen := range fens {
		pos, err := chess.ParseFEN(fen)
		if err != nil {
			t.Fatal(err)
		}
		cp := n.Eval(pos)
		t.Logf("%-62s -> %+5d cp", fen, cp)
		if cp < -30000 || cp > 30000 {
			t.Fatalf("insane eval %d for %s (import/scale bug?)", cp, fen)
		}
	}
	// Start position should be roughly balanced for any sane net (not a hard gate
	// on a 2-superbatch net, but a wild value flags an import bug).
	start, _ := chess.ParseFEN(startFEN)
	if cp := n.Eval(start); cp < -300 || cp > 300 {
		t.Logf("WARNING: start eval %+d cp is large for a balanced position (barely-trained net, but worth a look)", cp)
	}
}
