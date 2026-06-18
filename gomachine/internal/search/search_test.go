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

// Aspiration windows must only change SEARCH SPEED, never the chosen move or
// score at a completed depth. Verify on several positions that aspiration on/off
// agree — any divergence is a bug, not a feature (per the CPW guidance).
func TestAspirationMatchesFullWindow(t *testing.T) {
	fens := []string{
		chess.StartFEN,
		"r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4",    // Italian
		"r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1", // Kiwipete
		"8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1",                            // endgame
		"4k3/8/8/8/7q/8/8/4K2R w - - 0 1",                                      // tactical
	}
	off := DefaultParams()
	off.Aspiration = false
	on := DefaultParams()
	on.Aspiration = true

	for _, fen := range fens {
		pos, err := chess.ParseFEN(fen)
		if err != nil {
			t.Fatalf("ParseFEN(%s): %v", fen, err)
		}
		const depth = 7
		rOff := NewWithParams(16, off).Search(clone(pos), Limits{Depth: depth}, nil)
		rOn := NewWithParams(16, on).Search(clone(pos), Limits{Depth: depth}, nil)
		if rOff.BestMove != rOn.BestMove || rOff.Score != rOn.Score {
			t.Errorf("aspiration diverged on %s:\n  off: move=%s score=%d\n  on:  move=%s score=%d",
				fen, rOff.BestMove, rOff.Score, rOn.BestMove, rOn.Score)
		}
	}
}

func clone(pos *chess.Position) *chess.Position {
	p := *pos
	return &p
}

// Lazy SMP must not break tactics or race on the shared TT. Run this package with
// -race to exercise the lock-free table under concurrent workers.
func TestParallelSearchKeepsTactics(t *testing.T) {
	for _, threads := range []int{2, 4, 8} {
		mate, _ := chess.ParseFEN("6k1/5ppp/8/8/8/8/8/R6K w - - 0 1")
		r := New(16).SearchParallel(mate, Limits{Depth: 6}, nil, threads)
		if r.BestMove.String() != "a1a8" {
			t.Errorf("threads=%d: mate-in-1 best = %s, want a1a8", threads, r.BestMove)
		}

		hang, _ := chess.ParseFEN("4k3/8/8/8/7q/8/8/4K2R w - - 0 1")
		r = New(16).SearchParallel(hang, Limits{Depth: 8}, nil, threads)
		if r.BestMove.String() != "h1h4" {
			t.Errorf("threads=%d: win-queen best = %s, want h1h4", threads, r.BestMove)
		}
	}
}

// A node-limited parallel search must terminate cleanly and return a legal move
// (stresses the shared TT and the stop path under -race).
func TestParallelSearchNodeLimited(t *testing.T) {
	pos, _ := chess.ParseFEN("r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1")
	r := New(32).SearchParallel(pos, Limits{Nodes: 200000}, nil, 6)
	if r.BestMove == chess.NullMove {
		t.Fatal("parallel search returned no move")
	}
	var ml chess.MoveList
	pos.GenerateLegal(&ml)
	legal := false
	for i := 0; i < ml.Len(); i++ {
		if ml.Get(i) == r.BestMove {
			legal = true
			break
		}
	}
	if !legal {
		t.Fatalf("parallel search returned illegal move %s", r.BestMove)
	}
}

// threads=1 via SearchParallel must be identical to plain Search (same path).
func TestParallelThreadsOneMatchesSerial(t *testing.T) {
	for _, fen := range []string{chess.StartFEN, "4k3/8/8/8/7q/8/8/4K2R w - - 0 1"} {
		pos, _ := chess.ParseFEN(fen)
		a := New(16).Search(clone(pos), Limits{Depth: 7}, nil)
		b := New(16).SearchParallel(clone(pos), Limits{Depth: 7}, nil, 1)
		if a.BestMove != b.BestMove || a.Score != b.Score {
			t.Errorf("%s: threads=1 differs from serial: serial=%s/%d parallel=%s/%d",
				fen, a.BestMove, a.Score, b.BestMove, b.Score)
		}
	}
}

// RFP and LMP are forward-pruning heuristics (they change the search, not just
// its speed), so they must not blind the engine to basic tactics. Verify the
// mate-in-1 and hanging-queen positions are still solved with both enabled.
func TestForwardPruningKeepsTactics(t *testing.T) {
	p := DefaultParams()
	p.RFP = true
	p.LMP = true

	mate, _ := chess.ParseFEN("6k1/5ppp/8/8/8/8/8/R6K w - - 0 1")
	if r := NewWithParams(16, p).Search(mate, Limits{Depth: 6}, nil); r.BestMove.String() != "a1a8" {
		t.Errorf("with RFP+LMP, mate-in-1 best = %s, want a1a8", r.BestMove)
	}
	hang, _ := chess.ParseFEN("4k3/8/8/8/7q/8/8/4K2R w - - 0 1")
	if r := NewWithParams(16, p).Search(hang, Limits{Depth: 8}, nil); r.BestMove.String() != "h1h4" {
		t.Errorf("with RFP+LMP, win-queen best = %s, want h1h4", r.BestMove)
	}
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
