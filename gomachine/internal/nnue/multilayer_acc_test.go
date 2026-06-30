package nnue

import (
	"testing"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// TestMultiIncrementalMatchesScratch validates MultiNet's per-move feature
// deltas for EVERY legal move of each position: build the accumulator, push the
// move's deltas, make the move, and compare to a from-scratch rebuild of the
// resulting position. Unlike the int16 path this is float (adds aren't
// associative), so the gate is a small tolerance, not bit-identity — a wrong
// piece/square/sign in any delta path is off by a whole column (~0.1+) and fails.
func TestMultiIncrementalMatchesScratch(t *testing.T) {
	n := RandomMultiNet(11, 128, 16, 32, 4)
	seen := map[chess.MoveType]int{}
	for _, fen := range moveTypeFENs {
		pos := mustFEN(t, fen)
		var ml chess.MoveList
		pos.GenerateLegal(&ml)
		for i := 0; i < ml.Len(); i++ {
			m := ml.Get(i)
			seen[m.Type()]++

			// Incremental: build at the pre-move position, push the move's deltas.
			acc := n.newAcc()
			n.buildAcc(&acc, pos)
			var ch [4]featChange
			k := moveChanges(pos, m, &ch)
			for j := 0; j < k; j++ {
				n.applyAcc(&acc, ch[j])
			}

			// From-scratch at the resulting position.
			var u chess.Undo
			pos.DoMove(m, &u)
			fresh := n.newAcc()
			n.buildAcc(&fresh, pos)

			for j := 0; j < n.H; j++ {
				// int16 accumulator ⇒ incremental must EXACTLY equal from-scratch.
				if acc.w[j] != fresh.w[j] || acc.b[j] != fresh.b[j] {
					pos.UndoMove(m, &u)
					t.Fatalf("delta drift %q move %s j=%d: w(inc=%d fresh=%d) b(inc=%d fresh=%d)",
						fen, m.String(), j, acc.w[j], fresh.w[j], acc.b[j], fresh.b[j])
				}
			}

			// Eval from the incremental accumulator must match the from-scratch eval.
			evInc := n.evalFromAcc(&acc, pos)
			evScratch := n.Eval(pos)
			pos.UndoMove(m, &u)
			d := evInc - evScratch
			if d < 0 {
				d = -d
			}
			if d > 1 {
				t.Fatalf("eval drift %q move %s: inc=%d scratch=%d", fen, m.String(), evInc, evScratch)
			}
		}
	}
	if seen[chess.Promotion] == 0 || seen[chess.EnPassant] == 0 || seen[chess.Castling] == 0 {
		t.Fatalf("coverage gap: promo=%d ep=%d castle=%d (need all > 0)",
			seen[chess.Promotion], seen[chess.EnPassant], seen[chess.Castling])
	}
}
