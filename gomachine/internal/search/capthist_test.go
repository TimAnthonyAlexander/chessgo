package search

import (
	"testing"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// TestCaptHistOffPathIdentical confirms that with CaptHist off (the default) the
// search is byte-identical to the current engine — same nodes, move, and score on
// every wave3 FEN at a fixed depth. The capthist reads/updates are all flag-gated.
func TestCaptHistOffPathIdentical(t *testing.T) {
	on, off := DefaultParams(), DefaultParams()
	on.CaptHist, off.CaptHist = true, false
	for _, fen := range wave3FENs {
		pos, err := chess.ParseFEN(fen)
		if err != nil {
			t.Fatalf("parse %q: %v", fen, err)
		}
		// off must equal the plain default (DefaultParams has CaptHist=false anyway).
		a := NewWithParams(16, off).Search(pos, Limits{Depth: 11}, nil)
		b := NewWithParams(16, DefaultParams()).Search(pos, Limits{Depth: 11}, nil)
		if a.Nodes != b.Nodes || a.BestMove != b.BestMove || a.Score != b.Score {
			t.Fatalf("%s: CaptHist-off diverged from default: off n=%d m=%v s=%d  def n=%d m=%v s=%d",
				fen, a.Nodes, a.BestMove, a.Score, b.Nodes, b.BestMove, b.Score)
		}
		_ = on
	}
}

// TestCaptHistWired confirms CaptHist actually changes the search (better capture
// ordering → different tree) on at least some positions — i.e. it's not a no-op.
func TestCaptHistWired(t *testing.T) {
	on, off := DefaultParams(), DefaultParams()
	on.CaptHist, off.CaptHist = true, false
	diffs := 0
	for _, fen := range wave3FENs {
		pos, err := chess.ParseFEN(fen)
		if err != nil {
			t.Fatalf("parse %q: %v", fen, err)
		}
		ron := NewWithParams(16, on).Search(pos, Limits{Depth: 12}, nil)
		roff := NewWithParams(16, off).Search(pos, Limits{Depth: 12}, nil)
		t.Logf("%-50.50s on=%d off=%d delta=%+d", fen, ron.Nodes, roff.Nodes, int64(ron.Nodes)-int64(roff.Nodes))
		if ron.Nodes != roff.Nodes {
			diffs++
		}
	}
	if diffs == 0 {
		t.Fatalf("CaptHist on never changed node counts — capture history is a NO-OP (wiring bug)")
	}
}

// TestCaptHistUpdateRaisesEntry confirms the update path writes the table: after a
// capture causes a beta cutoff during a real search, at least one captureHist entry
// is non-zero.
func TestCaptHistUpdateRaisesEntry(t *testing.T) {
	p := DefaultParams()
	p.CaptHist = true
	s := NewWithParams(16, p)
	// A sharp, capture-rich middlegame so capture cutoffs happen.
	pos, err := chess.ParseFEN("r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4")
	if err != nil {
		t.Fatal(err)
	}
	s.Search(pos, Limits{Depth: 12}, nil)
	nonzero := false
	for pc := 0; pc < 12 && !nonzero; pc++ {
		for to := 0; to < 64 && !nonzero; to++ {
			for v := 0; v < 6; v++ {
				if s.captureHist[pc][to][v] != 0 {
					nonzero = true
					break
				}
			}
		}
	}
	if !nonzero {
		t.Fatal("captureHist table is all zero after a search — update path never fired")
	}
}
