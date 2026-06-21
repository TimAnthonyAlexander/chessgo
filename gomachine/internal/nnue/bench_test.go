package nnue

import (
	"testing"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// BenchmarkNetEval measures the full (non-incremental) NNUE forward pass cost,
// to compare against eval.BenchmarkEvaluate (HCE) on the same positions.
func BenchmarkNetEval(b *testing.B) {
	net, err := LoadNet("../../data/nnue/net.nnue")
	if err != nil {
		b.Skipf("no net at data/nnue/net.nnue (%v) — skipping", err)
	}
	fens := map[string]string{
		"startpos": chess.StartFEN,
		"kiwipete": "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1",
		"endgame":  "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1",
	}
	for name, fen := range fens {
		pos, err := chess.ParseFEN(fen)
		if err != nil {
			b.Fatalf("%s: %v", name, err)
		}
		b.Run(name, func(b *testing.B) {
			var sink int
			for i := 0; i < b.N; i++ {
				sink += net.Eval(pos)
			}
			_ = sink
		})
	}
}
