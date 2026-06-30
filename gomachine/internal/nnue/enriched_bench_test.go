package nnue

import (
	"os"
	"testing"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// midgameFENs are a few representative positions (lots of pieces → many threats),
// so the per-call eval cost reflects real search-leaf conditions.
var benchFENs = []string{
	"r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 1",
	"r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1",
	"2r3k1/pp2bppp/2n1pn2/q7/3P4/2N1PN2/PP2BPPP/2RQ1RK1 w - - 0 1",
	"r2q1rk1/1b1nbppp/p2ppn2/1p6/3NPP2/1BN1B3/PPP3PP/R2Q1RK1 w - - 0 1",
}

func benchPositions(tb testing.TB) []*chess.Position {
	ps := make([]*chess.Position, len(benchFENs))
	for i, f := range benchFENs {
		p, err := chess.ParseFEN(f)
		if err != nil {
			tb.Fatal(err)
		}
		ps[i] = p
	}
	return ps
}

// BenchmarkEnrichedEvalFromScratch measures the throwaway PoC eval path (full
// rebuild every call). Set ENRICHED_NET. This is the cost the incremental Stage-2
// path must beat. Compare ns/op against BenchmarkV6Eval below.
func BenchmarkEnrichedEvalFromScratch(b *testing.B) {
	path := os.Getenv("ENRICHED_NET")
	if path == "" {
		b.Skip("set ENRICHED_NET")
	}
	n, err := ImportBulletEnrichedNet(path, 512, 16, 32, 8)
	if err != nil {
		b.Fatal(err)
	}
	ps := benchPositions(b)
	b.ResetTimer()
	var sink int
	for i := 0; i < b.N; i++ {
		sink += n.Eval(ps[i%len(ps)])
	}
	_ = sink
}

// BenchmarkEnrichedAccumOnly isolates the FT accumulator rebuild (the suspected
// bottleneck) from the tail, so we know whether addCol or the threat enumeration
// dominates.
func BenchmarkEnrichedAccumOnly(b *testing.B) {
	path := os.Getenv("ENRICHED_NET")
	if path == "" {
		b.Skip("set ENRICHED_NET")
	}
	n, err := ImportBulletEnrichedNet(path, 512, 16, 32, 8)
	if err != nil {
		b.Fatal(err)
	}
	ps := benchPositions(b)
	accW := make([]int16, n.H)
	accB := make([]int16, n.H)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		n.buildAcc(accW, accB, ps[i%len(ps)])
	}
}

// BenchmarkEnrichedFeaturesOnly isolates the threat enumeration (attack-gen +
// index building), no addCol — tells us if enumeration alone is a wall.
func BenchmarkEnrichedFeaturesOnly(b *testing.B) {
	ps := benchPositions(b)
	b.ResetTimer()
	var sink int
	for i := 0; i < b.N; i++ {
		var buf [maxEnrichedActive]uint16
		f := appendEnrichedFeatures(buf[:0], ps[i%len(ps)], chess.White)
		sink += len(f)
	}
	_ = sink
}

// BenchmarkEnrichedTailOnly isolates the tail (pairwise + L1/L2/L3, no-alloc),
// the cost paid every node regardless of incremental accumulation.
func BenchmarkEnrichedTailOnly(b *testing.B) {
	path := os.Getenv("ENRICHED_NET")
	if path == "" {
		b.Skip("set ENRICHED_NET")
	}
	n, err := ImportBulletEnrichedNet(path, 512, 16, 32, 8)
	if err != nil {
		b.Fatal(err)
	}
	ps := benchPositions(b)
	accW := make([]int16, n.H)
	accB := make([]int16, n.H)
	n.buildAcc(accW, accB, ps[0])
	sc := n.newScratch()
	b.ResetTimer()
	var sink int
	for i := 0; i < b.N; i++ {
		sink += n.evalFromHalves(accW, accB, 4, &sc)
	}
	_ = sink
}

// BenchmarkEnrichedIncrementalNode simulates a realistic search node on the
// incremental stack: Push a move, Eval, Pop. This is the per-node cost the
// movetime SPRT actually pays (vs v6's ~0.7µs/node).
func BenchmarkEnrichedIncrementalNode(b *testing.B) {
	path := os.Getenv("ENRICHED_NET")
	if path == "" {
		b.Skip("set ENRICHED_NET")
	}
	n, err := ImportBulletEnrichedNet(path, 512, 16, 32, 8)
	if err != nil {
		b.Fatal(err)
	}
	// A midgame with a queen move available (changes many threat edges = worst case).
	pos, err := chess.ParseFEN("r2q1rk1/1b1nbppp/p2ppn2/1p6/3NPP2/1BN1B3/PPP3PP/R2Q1RK1 w - - 0 1")
	if err != nil {
		b.Fatal(err)
	}
	moves := pos.LegalMoves()
	if len(moves) == 0 {
		b.Fatal("no legal moves")
	}
	st := n.NewStack(8)
	st.Reset(pos)
	b.ResetTimer()
	var sink int
	for i := 0; i < b.N; i++ {
		m := moves[i%len(moves)]
		st.Push(pos, m)
		child := *pos
		var u chess.Undo
		child.DoMove(m, &u)
		sink += st.Eval(&child)
		st.Pop()
	}
	_ = sink
}

// BenchmarkV6Eval is the shipped single-layer net's from-scratch eval, as the
// reference cost. Loads data/nnue/net.nnue (cwd = gomachine/).
func BenchmarkV6Eval(b *testing.B) {
	net, err := LoadNet("../../data/nnue/net.nnue")
	if err != nil {
		b.Skip("v6 net not loadable: " + err.Error())
	}
	ps := benchPositions(b)
	b.ResetTimer()
	var sink int
	for i := 0; i < b.N; i++ {
		sink += net.Eval(ps[i%len(ps)])
	}
	_ = sink
}
