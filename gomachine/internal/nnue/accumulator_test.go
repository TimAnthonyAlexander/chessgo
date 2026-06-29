package nnue

import (
	"testing"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// fensCoveringAllMoveTypes are positions chosen so their legal moves exercise
// every delta path in moveChanges: quiet, capture, double-push (ep target),
// en-passant capture, all four castles, and promotions (incl. capture-promo).
var moveTypeFENs = []string{
	chess.StartFEN,
	"r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1", // kiwipete: castles, captures
	"r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R b KQkq - 0 1", // kiwipete, black to move
	"rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8",            // promotions available (d7)
	"8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1",                            // rook endgame
	"n3k3/1P6/8/8/8/8/8/4K3 w - - 0 1",                                     // push-promo (b8) + capture-promo (bxa8)
	"rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3",        // en-passant available (exf6)
	"4k3/8/8/2pP4/8/8/8/4K3 w - c6 0 1",                                    // en-passant available (dxc6)
}

// TestAccumulatorEvalMatchesScratch confirms the integer from-scratch eval
// (evalFrom) matches the float reference eval (Net.Eval) within float-rounding
// (≤2cp). We first dequantize so both views describe the SAME quantized weights —
// then the only difference is int-vs-float arithmetic, i.e. the ≤1–2cp drift, not
// quantization error.
func TestAccumulatorEvalMatchesScratch(t *testing.T) {
	net := RandomNet(7)
	net.dequantizeToFloat() // float view == dequantized int view (same weights)
	for _, fen := range moveTypeFENs {
		pos := mustFEN(t, fen)
		acc := net.newAccumulator()
		net.build(&acc, pos)
		gotInt := net.evalFrom(&acc, pos.SideToMove(), net.outputBucket(pos))
		gotFloat := net.Eval(pos)
		if d := gotInt - gotFloat; d > 2 || d < -2 {
			t.Fatalf("int evalFrom %d vs float Eval %d (diff %d > 2cp) for %q", gotInt, gotFloat, d, fen)
		}
	}
}

// TestIncrementalDeltaMatchesScratch validates moveChanges for EVERY legal move
// of each position: push the delta, make the move, and compare the incrementally
// updated accumulator to a from-scratch rebuild of the resulting position. A
// wrong piece/square/sign in any delta path fails here.
func TestIncrementalDeltaMatchesScratch(t *testing.T) {
	net := RandomNet(11)
	seen := map[chess.MoveType]int{}
	for _, fen := range moveTypeFENs {
		pos := mustFEN(t, fen)
		var ml chess.MoveList
		pos.GenerateLegal(&ml)
		for i := 0; i < ml.Len(); i++ {
			m := ml.Get(i)
			seen[m.Type()]++

			st := net.NewStack(4)
			st.Reset(pos)
			st.Push(pos, m) // reads the pre-move position

			var u chess.Undo
			pos.DoMove(m, &u)
			fresh := net.newAccumulator()
			net.build(&fresh, pos)
			top := &st.data[st.sp]
			for j := 0; j < net.HL; j++ {
				// Integer adds are associative: incremental MUST equal from-scratch
				// exactly (bit-identical), strictly stronger than Phase A's epsilon.
				if top.w[j] != fresh.w[j] || top.b[j] != fresh.b[j] {
					pos.UndoMove(m, &u)
					t.Fatalf("delta desync %q move %s j=%d: w(inc=%d fresh=%d) b(inc=%d fresh=%d)",
						fen, m.String(), j, top.w[j], fresh.w[j], top.b[j], fresh.b[j])
				}
			}
			pos.UndoMove(m, &u)
		}
	}
	// Confirm we actually exercised the special move types, not just quiets.
	if seen[chess.Promotion] == 0 || seen[chess.EnPassant] == 0 || seen[chess.Castling] == 0 {
		t.Fatalf("coverage gap: promo=%d ep=%d castle=%d (need all > 0)",
			seen[chess.Promotion], seen[chess.EnPassant], seen[chess.Castling])
	}
}
