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

// Aspiration windows must be a pure-speed change to the SEARCH LOGIC: under
// identical pruning they must return the same move and score as a full window.
// That equality is exact only for plain alpha-beta — null-move/LMR/RFP/LMP/delta
// all read the (alpha,beta) window, so a narrow aspiration search legitimately
// prunes a different tree than a full-window one (and a shared TT adds its own
// instability). Those are expected interactions, NOT aspiration bugs. So this
// test isolates the aspiration re-search logic: window-sensitive pruning + TT
// off → aspiration on/off must agree exactly (verified across the tuned and base
// eval). With everything on in real play, results can differ by a few cp on some
// positions; that's why strength is judged by SPRT, not by this equality.
func TestAspirationMatchesFullWindow(t *testing.T) {
	fens := []string{
		chess.StartFEN,
		"r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4",    // Italian
		"r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1", // Kiwipete
		"8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1",                            // endgame
		"4k3/8/8/8/7q/8/8/4K2R w - - 0 1",                                      // tactical
	}
	// Pure alpha-beta: disable every window-sensitive feature + the TT, so the
	// only variable is the aspiration window itself.
	pure := func() Params {
		p := DefaultParams()
		p.UseTT, p.NullMove, p.LMR, p.RFP, p.LMP, p.DeltaPrune = false, false, false, false, false, false
		// Correction/continuation history are PATH-dependent (their tables mutate as
		// the search runs), so an aspiration re-search updates them and shifts the
		// eval by a hair vs a single full-window pass — the same class of effect as
		// the window-sensitive pruning disabled above. Pin them off so the only
		// variable is the aspiration window itself.
		p.CorrHist, p.ContHist = false, false
		// Pin the eval: this isolates the aspiration window, and the move+score
		// equality below only holds on an eval without frequent exact-score ties
		// (the HCE — "tuned and base" — per the doc above). NNUE produces exact
		// integer ties on some positions where a narrow re-search legitimately
		// keeps a different, equally-scored move; that's tie resolution, not an
		// aspiration bug. The net is now embedded so it auto-loads in tests too,
		// hence pinning here keeps this test independent of net presence.
		p.Nnue = false
		return p
	}
	off := pure()
	off.Aspiration = false
	on := pure()
	on.Aspiration = true

	for _, fen := range fens {
		pos, err := chess.ParseFEN(fen)
		if err != nil {
			t.Fatalf("ParseFEN(%s): %v", fen, err)
		}
		const depth = 6
		rOff := NewWithParams(16, off).Search(clone(pos), Limits{Depth: depth}, nil)
		rOn := NewWithParams(16, on).Search(clone(pos), Limits{Depth: depth}, nil)
		if rOff.BestMove != rOn.BestMove || rOff.Score != rOn.Score {
			t.Errorf("aspiration diverged (pure alpha-beta) on %s:\n  off: move=%s score=%d\n  on:  move=%s score=%d",
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

// The history gravity update must stay bounded: hammering one entry with the
// maximum bonus converges to ≈+maxHistory and never exceeds it; flipping to the
// maximum malus converges to ≈−maxHistory. A bounded table is the whole point of
// gravity (the legacy += depth² scheme had no ceiling).
func TestHistoryGravityBounds(t *testing.T) {
	if got := statBonus(1000); got != histBonusMax {
		t.Errorf("statBonus(1000) = %d, want cap %d", got, histBonusMax)
	}
	s := New(1)
	pc, sq := chess.WhiteKnight, chess.Square(20)
	for i := 0; i < 10000; i++ {
		s.updateHistory(pc, sq, histBonusMax)
	}
	if v := s.history[pc][sq]; v > maxHistory || v < maxHistory-histBonusMax {
		t.Errorf("after saturating +bonus, history = %d, want in (%d, %d]", v, maxHistory-histBonusMax, maxHistory)
	}
	for i := 0; i < 20000; i++ {
		s.updateHistory(pc, sq, -histBonusMax)
	}
	if v := s.history[pc][sq]; v < -maxHistory || v > -(maxHistory - histBonusMax) {
		t.Errorf("after saturating -bonus, history = %d, want in [%d, %d)", v, -maxHistory, -(maxHistory - histBonusMax))
	}
}

// HistMalus changes how quiet-move history is credited; it must not blind the
// engine to basic tactics.
func TestHistMalusKeepsTactics(t *testing.T) {
	p := DefaultParams()
	p.HistMalus = true
	mate, _ := chess.ParseFEN("6k1/5ppp/8/8/8/8/8/R6K w - - 0 1")
	if r := NewWithParams(16, p).Search(mate, Limits{Depth: 6}, nil); r.BestMove.String() != "a1a8" {
		t.Errorf("with HistMalus, mate-in-1 best = %s, want a1a8", r.BestMove)
	}
	hang, _ := chess.ParseFEN("4k3/8/8/8/7q/8/8/4K2R w - - 0 1")
	if r := NewWithParams(16, p).Search(hang, Limits{Depth: 8}, nil); r.BestMove.String() != "h1h4" {
		t.Errorf("with HistMalus, win-queen best = %s, want h1h4", r.BestMove)
	}
}

// The improving heuristic scales the RFP margin and LMP move count; it must not
// blind the engine to basic tactics.
func TestImprovingKeepsTactics(t *testing.T) {
	p := DefaultParams()
	p.Improving = true
	mate, _ := chess.ParseFEN("6k1/5ppp/8/8/8/8/8/R6K w - - 0 1")
	if r := NewWithParams(16, p).Search(mate, Limits{Depth: 6}, nil); r.BestMove.String() != "a1a8" {
		t.Errorf("with Improving, mate-in-1 best = %s, want a1a8", r.BestMove)
	}
	hang, _ := chess.ParseFEN("4k3/8/8/8/7q/8/8/4K2R w - - 0 1")
	if r := NewWithParams(16, p).Search(hang, Limits{Depth: 8}, nil); r.BestMove.String() != "h1h4" {
		t.Errorf("with Improving, win-queen best = %s, want h1h4", r.BestMove)
	}
}

// The log-formula LMR reduces most late quiets (more aggressively than the flat
// 1/2), relying on the PVS re-search for safety; it must still solve basic
// tactics. Exercise both serial and parallel (shared read-only lmrTable).
func TestLMRFormulaKeepsTactics(t *testing.T) {
	p := DefaultParams()
	p.LMRFormula = true
	mate, _ := chess.ParseFEN("6k1/5ppp/8/8/8/8/8/R6K w - - 0 1")
	if r := NewWithParams(16, p).Search(mate, Limits{Depth: 6}, nil); r.BestMove.String() != "a1a8" {
		t.Errorf("with LMRFormula, mate-in-1 best = %s, want a1a8", r.BestMove)
	}
	hang, _ := chess.ParseFEN("4k3/8/8/8/7q/8/8/4K2R w - - 0 1")
	if r := NewWithParams(16, p).SearchParallel(hang, Limits{Depth: 8}, nil, 4); r.BestMove.String() != "h1h4" {
		t.Errorf("with LMRFormula (4 threads), win-queen best = %s, want h1h4", r.BestMove)
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
