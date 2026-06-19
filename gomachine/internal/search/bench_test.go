package search

import (
	"testing"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// BenchmarkSearch measures full-strength fixed-depth search throughput (nodes/
// sec) — the number that determines how fast a bot move or an /analyze position
// resolves. Each iteration searches from a cold transposition table so the NPS
// reflects a fresh position (the realistic case for distinct game positions);
// the TT clear is excluded from the timer.
//
// Depth is fixed (not time) so results are hardware-comparable across runs and
// machines, the same discipline the SPRT harness uses.
func BenchmarkSearch(b *testing.B) {
	const depth = 9
	positions := map[string]string{
		"startpos": chess.StartFEN,
		"kiwipete": "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1",
		"endgame":  "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1",
	}
	for name, fen := range positions {
		pos, err := chess.ParseFEN(fen)
		if err != nil {
			b.Fatalf("%s: %v", name, err)
		}
		b.Run(name, func(b *testing.B) {
			s := New(64)
			var nodes uint64
			var depthReached int
			for i := 0; i < b.N; i++ {
				b.StopTimer()
				s.ClearTT()
				b.StartTimer()
				r := s.Search(pos, Limits{Depth: depth}, nil)
				nodes += r.Nodes
				depthReached = r.Depth
			}
			b.ReportMetric(float64(nodes)/b.Elapsed().Seconds()/1e6, "Mnps")
			b.ReportMetric(float64(depthReached), "depth")
		})
	}
}
