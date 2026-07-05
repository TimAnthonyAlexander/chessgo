package nnue

import (
	"math/rand"
	"testing"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// TestBatchApplyEquivEval asserts the batchApply threat-column path produces
// byte-identical evals to the default (counts) path across a move walk, in the
// prod-like config (int8-FT + move-aware). Bit-exactness is the whole contract.
func TestBatchApplyEquivEval(t *testing.T) {
	mkNet := func() *EnrichedNet {
		n := NewEnrichedNet(512, 16, 32, 8)
		n.lean = true
		rng := rand.New(rand.NewSource(42))
		for i := range n.W0i {
			n.W0i[i] = int16(rng.Intn(512) - 256)
		}
		for i := range n.B0i {
			n.B0i[i] = int16(rng.Intn(512) - 256)
		}
		n.QuantizeFTInt8()
		n.SetMoveAware(true)
		return n
	}
	n := mkNet()
	if !n.int8FT {
		t.Fatal("net not int8FT — batchApply path would be skipped")
	}

	fens := []string{
		chess.StartFEN,
		"r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1",
		"r1bqk2r/pp2bppp/2n1pn2/2pp4/3P1B2/2PBPN2/PP3PPP/RN1QK2R w KQkq - 0 8",
		"8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1",
		"r2q1rk1/pp2ppbp/2np1np1/2p5/2P1P3/2NP1N2/PP2BPPP/R1BQ1RK1 w - - 0 9",
	}
	for _, fen := range fens {
		pos, err := chess.ParseFEN(fen)
		if err != nil {
			t.Fatalf("%s: %v", fen, err)
		}
		n.SetBatchApply(false)
		ref := walkEval(n.NewStack(8), pos)
		n.SetBatchApply(true)
		got := walkEval(n.NewStack(8), pos)
		n.SetBatchApply(false)
		if len(ref) != len(got) {
			t.Fatalf("%s: len mismatch %d vs %d", fen, len(ref), len(got))
		}
		for i := range ref {
			if ref[i] != got[i] {
				t.Fatalf("%s move %d: counts=%d batch=%d (NOT bit-exact)", fen, i, ref[i], got[i])
			}
		}
	}
}

// walkEval pushes each legal move (then pops) and records the resulting child
// ACCUMULATOR (both halves concatenated) — the direct output of applyDiff. Comparing
// accumulators (not evals) tests applyDiff bit-exactness without needing the net tail,
// and Eval is a pure function of the accumulator, so acc-identity ⇒ eval-identity.
func walkEval(st *EnrichedStack, pos *chess.Position) []int16 {
	st.Reset(pos)
	var out []int16
	var ml chess.MoveList
	pos.GenerateLegal(&ml)
	for i := 0; i < ml.Len(); i++ {
		m := ml.Get(i)
		st.Push(pos, m)
		top := &st.data[st.sp]
		out = append(out, top.w...)
		out = append(out, top.b...)
		st.Pop()
	}
	return out
}
