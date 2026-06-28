package search

import (
	"testing"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// TestConthistActuallyChangesTree is the decisive "is conthist even wired in?"
// check. conthist feeds BOTH quiet-move ordering and the LMR reduction term, so
// if it is genuinely active it must change move order and/or reduction depth ->
// the searched tree differs -> node counts differ. Identical node counts at a
// depth that populates the history tables prove it is a no-op (a wiring/blend
// bug), independent of any Elo measurement. Everything else stays at the shipped
// default (conservative LMR, lmr2/singular off) so this isolates conthist on the
// exact engine the standalone SPRT used.
func TestConthistActuallyChangesTree(t *testing.T) {
	on, off := DefaultParams(), DefaultParams()
	on.ContHist, off.ContHist = true, false

	identical := 0
	for _, fen := range wave3FENs {
		pos, err := chess.ParseFEN(fen)
		if err != nil {
			t.Fatalf("parse %q: %v", fen, err)
		}
		ron := NewWithParams(16, on).Search(pos, Limits{Depth: 12}, nil)
		roff := NewWithParams(16, off).Search(pos, Limits{Depth: 12}, nil)
		t.Logf("%-60.60s  on=%d off=%d  delta=%+d  bestOn=%v bestOff=%v",
			fen, ron.Nodes, roff.Nodes, int64(ron.Nodes)-int64(roff.Nodes), ron.BestMove, roff.BestMove)
		if ron.Nodes == roff.Nodes {
			identical++
		}
	}
	if identical == len(wave3FENs) {
		t.Fatalf("conthist on==off node counts on ALL %d FENs — conthist is a NO-OP (wiring bug)", len(wave3FENs))
	}
}
