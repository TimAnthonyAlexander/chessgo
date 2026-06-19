package eval

import (
	"testing"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// BenchmarkEvaluate measures the static evaluation cost (called at every
// quiescence leaf). Default Config = material + PSQT only (knowledge terms are
// off by default, mirroring the shipped engine).
func BenchmarkEvaluate(b *testing.B) {
	fens := map[string]string{
		"startpos": chess.StartFEN,
		"kiwipete": "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1",
		"endgame":  "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1",
	}
	cfg := Config{}
	for name, fen := range fens {
		pos, err := chess.ParseFEN(fen)
		if err != nil {
			b.Fatalf("%s: %v", name, err)
		}
		b.Run(name, func(b *testing.B) {
			var sink int
			for i := 0; i < b.N; i++ {
				sink += Evaluate(pos, cfg)
			}
			_ = sink
		})
	}
}
