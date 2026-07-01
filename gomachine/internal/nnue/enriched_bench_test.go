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
	var ml chess.MoveList
	pos.GenerateLegal(&ml)
	if ml.Len() == 0 {
		b.Fatal("no legal moves")
	}
	st := n.NewStack(8)
	st.Reset(pos)
	b.ResetTimer()
	var sink int
	for i := 0; i < b.N; i++ {
		m := ml.Get(i % ml.Len())
		st.Push(pos, m)
		child := *pos
		var u chess.Undo
		child.DoMove(m, &u)
		sink += st.Eval(&child)
		st.Pop()
	}
	_ = sink
}

// midgameForBench is a dense midgame (many threats = worst case) used by the
// per-node benchmarks below.
const midgameForBench = "r2q1rk1/1b1nbppp/p2ppn2/1p6/3NPP2/1BN1B3/PPP3PP/R2Q1RK1 w - - 0 1"

// benchIncrementalNode runs Push→Eval→Pop on a stack-with-Push/Eval/Pop, the real
// per-node search cost. pushEvalPop abstracts over the v6 and enriched stacks.
func benchIncrementalNode(b *testing.B, pos *chess.Position, reset func(*chess.Position), pushEvalPop func(*chess.Position, chess.Move) int) {
	var ml chess.MoveList
	pos.GenerateLegal(&ml)
	if ml.Len() == 0 {
		b.Fatal("no moves")
	}
	reset(pos)
	b.ResetTimer()
	var sink int
	for i := 0; i < b.N; i++ {
		sink += pushEvalPop(pos, ml.Get(i%ml.Len()))
	}
	_ = sink
}

// BenchmarkEnrichedIncrementalNodeInt8 is the shipping path's per-node cost: full
// int8 (tail L1 + FT threat columns), incremental accumulator. THIS is the number
// to compare against BenchmarkV6IncrementalNode for the movetime NPS ratio.
func BenchmarkEnrichedIncrementalNodeInt8(b *testing.B) {
	path := os.Getenv("ENRICHED_NET")
	if path == "" {
		b.Skip("set ENRICHED_NET")
	}
	n, err := ImportBulletEnrichedNet(path, 512, 16, 32, 8)
	if err != nil {
		b.Fatal(err)
	}
	n.QuantizeForInt8()
	n.QuantizeFTInt8()
	pos, _ := chess.ParseFEN(midgameForBench)
	st := n.NewStack(8)
	benchIncrementalNode(b, pos, st.Reset, func(p *chess.Position, m chess.Move) int {
		st.Push(p, m)
		child := *p
		var u chess.Undo
		child.DoMove(m, &u)
		v := st.Eval(&child)
		st.Pop()
		return v
	})
}

// BenchmarkV6IncrementalNode is the shipped v6 net's per-node cost (incremental
// Stack), the baseline our enriched net must approach to be movetime-viable.
func BenchmarkV6IncrementalNode(b *testing.B) {
	net, err := LoadNet("../../data/nnue/net.nnue")
	if err != nil {
		b.Skip("v6 net: " + err.Error())
	}
	pos, _ := chess.ParseFEN(midgameForBench)
	st := net.NewStack(8)
	benchIncrementalNode(b, pos, st.Reset, func(p *chess.Position, m chess.Move) int {
		st.Push(p, m)
		child := *p
		var u chess.Undo
		child.DoMove(m, &u)
		v := st.Eval(&child)
		st.Pop()
		return v
	})
}

// BenchmarkEnrichedTailOnlyInt8 isolates the int8 tail cost (pairwise u8 + maddubs
// L1), to compare against the float tail (BenchmarkEnrichedTailOnly) on AVX-512.
func BenchmarkEnrichedTailOnlyInt8(b *testing.B) {
	path := os.Getenv("ENRICHED_NET")
	if path == "" {
		b.Skip("set ENRICHED_NET")
	}
	n, _ := ImportBulletEnrichedNet(path, 512, 16, 32, 8)
	n.QuantizeForInt8()
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

// BenchmarkPairwiseHalfTail isolates the pairwise FT activation (the 2× scalar
// CReLU-clamp+multiply over H, into the H-wide hidden buffer) — to see if the
// ~5µs tail is the activation (scalar, SIMD-able) or the matmuls.
func BenchmarkPairwiseHalfTail(b *testing.B) {
	path := os.Getenv("ENRICHED_NET")
	if path == "" {
		b.Skip("set ENRICHED_NET")
	}
	n, _ := ImportBulletEnrichedNet(path, 512, 16, 32, 8)
	accW := make([]int16, n.H)
	accB := make([]int16, n.H)
	n.buildAcc(accW, accB, benchPositions(b)[0])
	hidden := make([]float32, n.H)
	half := n.H / 2
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		pairwiseHalf(hidden[:half], accW)
		pairwiseHalf(hidden[half:], accB)
	}
}

// BenchmarkGemvL1Tail isolates just the L1 GEMV (hidden[H]→l1[D2]), the biggest
// matmul, to compare against the pairwise cost.
func BenchmarkGemvL1Tail(b *testing.B) {
	path := os.Getenv("ENRICHED_NET")
	if path == "" {
		b.Skip("set ENRICHED_NET")
	}
	n, _ := ImportBulletEnrichedNet(path, 512, 16, 32, 8)
	hidden := make([]float32, n.H)
	for i := range hidden {
		hidden[i] = 0.1
	}
	l1 := make([]float32, n.D2)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		gemvF32(l1, hidden, n.L1W, n.NB*n.D2, 4*n.D2)
	}
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

// benchEnrichedIncrementalNode runs the real movetime per-node cost (Push→Eval→Pop,
// int8FT + move-aware) for an already-built lean/pairwise EnrichedNet. This is the
// number that determines NPS; 1/it is the search rate. Compare across v6
// (BenchmarkV6IncrementalNode), v9-lean, and pairwise.
func benchEnrichedIncrementalNode(b *testing.B, n *EnrichedNet) {
	n.QuantizeFTInt8() // int8 threat columns — the movetime config
	n.SetMoveAware(true)
	pos, _ := chess.ParseFEN(midgameForBench)
	st := n.NewStack(8)
	benchIncrementalNode(b, pos, st.Reset, func(p *chess.Position, m chess.Move) int {
		st.Push(p, m)
		child := *p
		var u chess.Undo
		child.DoMove(m, &u)
		v := st.Eval(&child)
		st.Pop()
		return v
	})
}

// BenchmarkLeanIncrementalNode — v9 (single-layer threats) per-node cost at the
// movetime config. Set LEAN_NET to a lean_threats raw.bin.
func BenchmarkLeanV9Node(b *testing.B) {
	path := os.Getenv("LEAN_NET")
	if path == "" {
		b.Skip("set LEAN_NET")
	}
	n, err := ImportBulletLeanNet(path, 512, 8)
	if err != nil {
		b.Fatal(err)
	}
	benchEnrichedIncrementalNode(b, n)
}

// BenchmarkPairwiseIncrementalNode — the pairwise-head net per-node cost at the
// movetime config (the scalar pairwise tail). Set LEAN_PAIRWISE_NET.
func BenchmarkPairwiseIncrementalNode(b *testing.B) {
	path := os.Getenv("LEAN_PAIRWISE_NET")
	if path == "" {
		b.Skip("set LEAN_PAIRWISE_NET")
	}
	n, err := ImportBulletLeanPairwiseNet(path, 512, 8)
	if err != nil {
		b.Fatal(err)
	}
	benchEnrichedIncrementalNode(b, n)
}
