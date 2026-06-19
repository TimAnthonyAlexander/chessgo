package chess

import "testing"

// Benchmark positions: the opening, the tactical "kiwipete" middlegame (lots of
// pieces and legal moves), and a sparse endgame. Together they bracket the
// movegen/make-unmake cost across game phases.
var benchFENs = map[string]string{
	"startpos": StartFEN,
	"kiwipete": "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1",
	"endgame":  "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1",
}

// BenchmarkGenerateLegal measures full legal move generation (the per-position
// cost behind every move-legality check the hub performs).
func BenchmarkGenerateLegal(b *testing.B) {
	for name, fen := range benchFENs {
		pos, err := ParseFEN(fen)
		if err != nil {
			b.Fatalf("%s: %v", name, err)
		}
		b.Run(name, func(b *testing.B) {
			var ml MoveList
			for i := 0; i < b.N; i++ {
				ml.count = 0
				pos.GenerateLegal(&ml)
			}
		})
	}
}

// BenchmarkMakeUnmake measures a do/undo round-trip over every legal move from a
// position (the search's innermost operation).
func BenchmarkMakeUnmake(b *testing.B) {
	for name, fen := range benchFENs {
		pos, err := ParseFEN(fen)
		if err != nil {
			b.Fatalf("%s: %v", name, err)
		}
		var ml MoveList
		pos.GenerateLegal(&ml)
		b.Run(name, func(b *testing.B) {
			b.ReportMetric(float64(ml.count), "moves/op")
			for i := 0; i < b.N; i++ {
				for j := 0; j < ml.count; j++ {
					var u Undo
					pos.DoMove(ml.moves[j], &u)
					pos.UndoMove(ml.moves[j], &u)
				}
			}
		})
	}
}

// BenchmarkPerft measures bulk movegen throughput and reports nodes/sec — the
// cleanest single number for the raw rules core (matches the `perft` CLI).
func BenchmarkPerft(b *testing.B) {
	const depth = 4
	pos, err := ParseFEN(StartFEN)
	if err != nil {
		b.Fatal(err)
	}
	var nodes uint64
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		nodes += Perft(pos, depth)
	}
	b.StopTimer()
	b.ReportMetric(float64(nodes)/b.Elapsed().Seconds()/1e6, "Mnps")
}
