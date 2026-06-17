package search

import (
	"testing"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

func TestSearchFindsMateIn1(t *testing.T) {
	// Black king boxed in by its own pawns; Ra8 is mate.
	pos, err := chess.ParseFEN("6k1/5ppp/8/8/8/8/8/R6K w - - 0 1")
	if err != nil {
		t.Fatal(err)
	}
	r := New(16).Search(pos, Limits{Depth: 4}, nil)
	if r.BestMove.String() != "a1a8" {
		t.Errorf("best move = %s, want a1a8 (score %d, mateIn %d)", r.BestMove, r.Score, r.MateIn)
	}
	if r.MateIn != 1 {
		t.Errorf("mateIn = %d, want 1", r.MateIn)
	}
}

func TestSearchWinsHangingQueen(t *testing.T) {
	// White rook on h1, black queen hanging on h4: Rxh4 wins the queen.
	pos, err := chess.ParseFEN("4k3/8/8/8/7q/8/8/4K2R w - - 0 1")
	if err != nil {
		t.Fatal(err)
	}
	r := New(16).Search(pos, Limits{Depth: 6}, nil)
	if r.BestMove.String() != "h1h4" {
		t.Errorf("best move = %s, want h1h4 (score %d)", r.BestMove, r.Score)
	}
	if r.Score < 500 {
		t.Errorf("score = %d, expected a large material advantage", r.Score)
	}
}

func TestSearchStartposSane(t *testing.T) {
	pos, err := chess.ParseFEN(chess.StartFEN)
	if err != nil {
		t.Fatal(err)
	}
	r := New(16).Search(pos, Limits{Depth: 7}, nil)
	if r.BestMove == chess.NullMove {
		t.Fatal("no best move from start position")
	}
	if r.Score < -100 || r.Score > 100 {
		t.Errorf("startpos score = %d, expected near-equal", r.Score)
	}
	if len(r.PV) == 0 {
		t.Error("expected a non-empty principal variation")
	}
	t.Logf("startpos depth %d: best=%s score=%d nodes=%d pv=%v",
		r.Depth, r.BestMove, r.Score, r.Nodes, pvString(r.PV))
}

func pvString(pv []chess.Move) string {
	s := ""
	for i, m := range pv {
		if i > 0 {
			s += " "
		}
		s += m.String()
	}
	return s
}
