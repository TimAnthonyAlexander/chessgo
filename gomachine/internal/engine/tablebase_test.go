package engine

import (
	"os"
	"testing"
	"time"

	"github.com/timanthonyalexander/gomachine/internal/chess"
	"github.com/timanthonyalexander/gomachine/internal/search"
	"github.com/timanthonyalexander/gomachine/internal/syzygy"
)

// --- Pure decode helpers (no tablebase files needed) ---

// sq parses an algebraic square ("e2") to its 0..63 index for test fixtures.
func sq(s string) int {
	q, ok := chess.ParseSquare(s)
	if !ok {
		panic("bad square " + s)
	}
	return int(q)
}

func TestTBMoveUCI(t *testing.T) {
	cases := []struct {
		res  syzygy.Result
		want string
	}{
		{syzygy.Result{From: sq("e2"), To: sq("e4")}, "e2e4"},
		{syzygy.Result{From: sq("e7"), To: sq("e8"), Promotes: syzygy.PromoteQueen}, "e7e8q"},
		{syzygy.Result{From: sq("a7"), To: sq("a8"), Promotes: syzygy.PromoteKnight}, "a7a8n"},
		{syzygy.Result{From: sq("h2"), To: sq("h1"), Promotes: syzygy.PromoteRook}, "h2h1r"},
		{syzygy.Result{From: sq("b7"), To: sq("b8"), Promotes: syzygy.PromoteBishop}, "b7b8b"},
	}
	for _, c := range cases {
		if got := tbMoveUCI(c.res); got != c.want {
			t.Errorf("tbMoveUCI(%+v) = %q, want %q", c.res, got, c.want)
		}
	}
}

func TestTBScore(t *testing.T) {
	cases := []struct {
		wdl  int
		want int
	}{
		{syzygy.WDLWin, tbWinScore},
		{syzygy.WDLLoss, -tbWinScore},
		{syzygy.WDLDraw, 0},
		{syzygy.WDLCursedWin, 0},   // win, but a draw under the 50-move rule
		{syzygy.WDLBlessedLoss, 0}, // loss, but a draw under the 50-move rule
	}
	for _, c := range cases {
		if got := tbScore(c.wdl); got != c.want {
			t.Errorf("tbScore(%d) = %d, want %d", c.wdl, got, c.want)
		}
	}
}

// tbEngine builds a full-strength engine with the tablebase at path enabled, or
// skips the test when SYZYGY_TEST_PATH is unset (CI without the files) / cgo is
// disabled. Set SYZYGY_TEST_PATH to a Syzygy directory (e.g. the 3-4-5 set) to run.
func tbEngine(t *testing.T) *Engine {
	t.Helper()
	path := os.Getenv("SYZYGY_TEST_PATH")
	if path == "" {
		t.Skip("set SYZYGY_TEST_PATH to a Syzygy tablebase directory to run tablebase integration tests")
	}
	tb, err := syzygy.Open(path)
	if err != nil {
		t.Skipf("syzygy.Open(%q): %v (cgo build + real files required)", path, err)
	}
	t.Cleanup(tb.Close)

	p := search.DefaultParams()
	p.UseTablebase = true
	e := NewWithParams(16, p)
	e.SetTablebase(tb)
	return e
}

// TestTablebaseRootScores verifies the root probe reports the correct WDL sign,
// side-to-move-relative, and marks the hit (Nodes==0). Positions are LEGAL (the
// side not to move is not in check) — Fathom's capture-resolution assumes legal
// input, which real game positions always are.
//
// NOTE: the winning side's root probe is reliable; the LOSING side's DTZ root
// probe can legitimately return FAILED for some tables (Fathom falls back to a
// search there), so we only assert a TB hit on a losing position known to probe
// cleanly (KQvK), not on every table.
func TestTablebaseRootScores(t *testing.T) {
	e := tbEngine(t)
	if e.tb.MaxPieces() < 4 {
		t.Skipf("need ≥4-piece tablebase for KBNvK (have %d)", e.tb.MaxPieces())
	}

	cases := []struct {
		fen  string
		name string
		want int // expected side-to-move-relative TB score
	}{
		// KBN vs K, White (bishop+knight) to move and winning.
		{"8/8/8/3k4/8/8/8/3BKN2 w - - 0 1", "KBNvK white winning", tbWinScore},
		// KQ vs K, White to move and winning (queen on a1 gives no check to kd3).
		{"8/8/8/8/8/3k4/8/Q3K3 w - - 0 1", "KQvK white winning", tbWinScore},
		// KQ vs K, Black (lone king) to move and losing — a legal position whose
		// losing-side DTZ root probe resolves cleanly.
		{"8/8/8/8/3k4/8/8/Q3K3 b - - 0 1", "KQvK black losing", -tbWinScore},
	}
	for _, c := range cases {
		pos, err := chess.ParseFEN(c.fen)
		if err != nil {
			t.Fatalf("%s: bad fen: %v", c.name, err)
		}
		r := e.SearchDirect(pos, 0, 0, nil)
		if r.Nodes != 0 {
			t.Errorf("%s: Nodes=%d, want 0 (tablebase hit marker)", c.name, r.Nodes)
		}
		if r.Move == chess.NullMove {
			t.Fatalf("%s: no move returned", c.name)
		}
		if _, legal := pos.ParseUCIMove(r.Move.String()); !legal {
			t.Errorf("%s: returned illegal move %s", c.name, r.Move)
		}
		if r.Score != c.want {
			t.Errorf("%s: Score=%d, want %d", c.name, r.Score, c.want)
		}
	}
}

// TestTablebaseMatesKBNvK is the end-to-end correctness proof: play out a
// KBN-vs-K endgame with the tablebase enabled and assert it reaches checkmate.
// KBN-vs-K is the canonical position search alone routinely fails to convert
// under time pressure (up to 33 moves of an unintuitive pattern). With the
// tablebase the winning side plays provably-optimal DTZ moves on every ply its
// root probe resolves, so the win is converted to mate within the 50-move rule.
//
// Both sides are driven by the engine's normal SearchDirect (tablebase first,
// search fallback). It is given a time budget — never the unbounded
// depth=0/movetime=0 form, which would spin forever on a probe miss. We assert the
// OUTCOME (checkmate) plus that the tablebase actually fired (at least one ply was
// a TB hit, Nodes==0); requiring a hit on every single ply is wrong, since
// Fathom's DTZ root probe legitimately returns FAILED for some positions (it needs
// the opposite side's table perspective), and the engine then searches instead.
func TestTablebaseMatesKBNvK(t *testing.T) {
	e := tbEngine(t)
	if e.tb.MaxPieces() < 4 {
		t.Skipf("need ≥4-piece tablebase for KBNvK (have %d)", e.tb.MaxPieces())
	}

	pos, err := chess.ParseFEN("8/8/8/3k4/8/8/8/3BKN2 w - - 0 1")
	if err != nil {
		t.Fatal(err)
	}

	var history []uint64
	tbHits := 0
	const maxPlies = 100 // KBN mate is ≤33 moves (66 plies); 100 is generous
	for ply := 0; ply < maxPlies; ply++ {
		st := Adjudicate(pos, history)
		if st.State == "checkmate" {
			if tbHits == 0 {
				t.Fatalf("reached mate but the tablebase never fired (no TB hits) — probe not engaged")
			}
			return // success: the tablebase converted the win to mate
		}
		if st.State != "ongoing" {
			t.Fatalf("ply %d: game ended %q (%s), expected progress toward mate", ply, st.State, st.Result)
		}
		// Bounded budget so a probe miss falls back to a real search, never the
		// unbounded depth=0/movetime=0 spin.
		r := e.SearchDirect(pos, 0, 300*time.Millisecond, history)
		if r.Nodes == 0 {
			tbHits++ // Nodes==0 marks a tablebase hit
		}
		if r.Move == chess.NullMove {
			t.Fatalf("ply %d: no move at %s", ply, pos.FEN())
		}
		history = append(history, pos.Key())
		var u chess.Undo
		pos.DoMove(r.Move, &u)
	}
	t.Fatalf("did not reach checkmate within %d plies (%d TB hits) — final: %s", maxPlies, tbHits, pos.FEN())
}
