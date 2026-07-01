package nnue

import (
	"math/rand"
	"testing"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// walkMoveAware recursively plays every legal move to `depth`, and after each
// incremental Push+DoMove checks the top accumulator EXACTLY (int16) against a
// from-scratch rebuild — the ground truth. Any move-aware delta bug (a missed
// discovered slider, a botched castle/ep/promotion cell) surfaces as a mismatch
// with the offending FEN.
func walkMoveAware(t *testing.T, n *EnrichedNet, st *EnrichedStack, pos *chess.Position, depth int, nodes *int) {
	if depth == 0 {
		return
	}
	var ml chess.MoveList
	pos.GenerateLegal(&ml)
	fw := make([]int16, n.H)
	fb := make([]int16, n.H)
	for i := 0; i < ml.Len(); i++ {
		m := ml.Get(i)
		st.Push(pos, m)
		var u chess.Undo
		pos.DoMove(m, &u)

		top := &st.data[st.sp]
		n.buildAcc(fw, fb, pos)
		for j := 0; j < n.H; j++ {
			if top.w[j] != fw[j] || top.b[j] != fb[j] {
				t.Fatalf("move-aware drift after %s at j=%d: w(inc=%d fresh=%d) b(inc=%d fresh=%d)\nfen=%q",
					m, j, top.w[j], fw[j], top.b[j], fb[j], pos.FEN())
			}
		}
		*nodes++
		walkMoveAware(t, n, st, pos, depth-1, nodes)

		pos.UndoMove(m, &u)
		st.Pop()
	}
}

// benchLeanPush isolates the per-move accumulator push cost (Push→Pop, no Eval)
// for a lean int8-FT net, comparing the enumerate path vs move-aware. Dense
// midgame (many threat edges = worst case). No net file needed (random weights;
// the push cost is weight-independent).
func benchLeanPush(b *testing.B, moveAware bool) {
	n := NewEnrichedNet(512, 16, 32, 8)
	n.lean = true
	rng := rand.New(rand.NewSource(7))
	for i := range n.W0i {
		n.W0i[i] = int16(rng.Intn(512) - 256)
	}
	for i := range n.B0i {
		n.B0i[i] = int16(rng.Intn(512) - 256)
	}
	n.QuantizeFTInt8()
	n.SetMoveAware(moveAware)
	pos, err := chess.ParseFEN(midgameForBench)
	if err != nil {
		b.Fatal(err)
	}
	var ml chess.MoveList
	pos.GenerateLegal(&ml)
	st := n.NewStack(8)
	st.Reset(pos)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		st.Push(pos, ml.Get(i%ml.Len()))
		st.Pop()
	}
}

func BenchmarkLeanPushEnumerate(b *testing.B) { benchLeanPush(b, false) }
func BenchmarkLeanPushMoveAware(b *testing.B) { benchLeanPush(b, true) }

// TestEnrichedMoveAwareBitExact validates the O(delta) move-aware push
// (enriched_delta.go) is byte-identical to the from-scratch feature set across
// every move type (captures, castling, en passant, promotion) in a perft walk,
// for both int8-FT off and on (the two ftAdd dispatch paths).
func TestEnrichedMoveAwareBitExact(t *testing.T) {
	mkNet := func(int8ft bool) *EnrichedNet {
		n := NewEnrichedNet(512, 16, 32, 8)
		n.lean = true
		rng := rand.New(rand.NewSource(42))
		for i := range n.W0i {
			n.W0i[i] = int16(rng.Intn(512) - 256)
		}
		for i := range n.B0i {
			n.B0i[i] = int16(rng.Intn(512) - 256)
		}
		if int8ft {
			n.QuantizeFTInt8()
		}
		n.SetMoveAware(true)
		return n
	}

	positions := []struct {
		name, fen string
		depth     int
	}{
		{"startpos", chess.StartFEN, 4},
		{"kiwipete", "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1", 3},
		{"promotions", "n1n5/PPPk4/8/8/8/8/4Kppp/5N1N b - - 0 1", 4},
		{"enpassant", "rnbqkbnr/pp1ppppp/8/2pP4/8/8/PPP1PPPP/RNBQKBNR w KQkq c6 0 3", 4},
		{"midgame", "r2q1rk1/pp2ppbp/2np1np1/2p5/2P1P3/2NP1N2/PP2BPPP/R1BQ1RK1 w - - 0 9", 3},
	}
	for _, int8ft := range []bool{false, true} {
		n := mkNet(int8ft)
		for _, p := range positions {
			pos, err := chess.ParseFEN(p.fen)
			if err != nil {
				t.Fatalf("%s: %v", p.name, err)
			}
			st := n.NewStack(p.depth + 1)
			st.Reset(pos)
			nodes := 0
			walkMoveAware(t, n, st, pos, p.depth, &nodes)
			t.Logf("int8FT=%v %-11s depth=%d: %d nodes bit-exact", int8ft, p.name, p.depth, nodes)
		}
	}
}
