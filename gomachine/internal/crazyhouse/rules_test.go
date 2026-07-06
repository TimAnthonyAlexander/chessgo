package crazyhouse

import (
	"testing"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

func mustParse(t *testing.T, fen string) State {
	t.Helper()
	st, err := Parse(fen)
	if err != nil {
		t.Fatalf("Parse(%q): %v", fen, err)
	}
	return st
}

func mustApply(t *testing.T, s State, move string) State {
	t.Helper()
	ns, err := s.Apply(move)
	if err != nil {
		t.Fatalf("Apply(%q): %v", move, err)
	}
	return ns
}

// The opening has 20 legal moves and no drops (empty pockets).
func TestOpeningMoveCount(t *testing.T) {
	st := mustParse(t, StartFEN)
	if n := len(st.LegalMoves()); n != 20 {
		t.Errorf("opening legal moves = %d, want 20", n)
	}
	if st.Status() != Ongoing {
		t.Errorf("opening status = %v, want ongoing", st.Status())
	}
}

// A capture drops the victim into the mover's pocket.
func TestCaptureFillsPocket(t *testing.T) {
	// White rook e2 captures the black knight on e4 (Rxe4).
	st := mustParse(t, "4k3/8/8/8/4n3/8/4R3/4K3[] w - - 0 1")
	st = mustApply(t, st, "e2e4")
	if n := st.Pocket(chess.White, chess.Knight); n != 1 {
		t.Errorf("white pocket knights = %d, want 1", n)
	}
}

// A captured PROMOTED piece reverts to a pawn in the pocket.
func TestCapturedPromotedRevertsToPawn(t *testing.T) {
	// Black queen a8 captures the promoted white queen on a1 down the open a-file.
	st := mustParse(t, "q3k3/8/8/8/8/8/8/Q~3K3 b - - 0 1")
	st = mustApply(t, st, "a8a1")
	if n := st.Pocket(chess.Black, chess.Pawn); n != 1 {
		t.Errorf("black pocket pawns = %d, want 1 (promoted queen reverts)", n)
	}
	if n := st.Pocket(chess.Black, chess.Queen); n != 0 {
		t.Errorf("black pocket queens = %d, want 0", n)
	}
	if st.promoted&chess.Square(0).BB() != 0 { // a1
		t.Error("captured promoted square must be cleared from the promoted set")
	}
}

// Under check, only a drop that blocks the check is legal.
func TestDropMustBlockCheck(t *testing.T) {
	// Black rook e8 checks the white king e1 down the open e-file; white holds a pawn.
	st := mustParse(t, "4r3/8/8/8/8/8/8/4K3[P] w - - 0 1")
	if _, err := st.Apply("P@e5"); err != nil {
		t.Errorf("P@e5 should block the check and be legal: %v", err)
	}
	if _, err := st.Apply("P@a4"); err == nil {
		t.Error("P@a4 does not block the check and must be illegal")
	}
}

// A drop can deliver checkmate.
func TestDropDeliversMate(t *testing.T) {
	// Black king g8 walled in by f7/g7/h7; white drops a rook to e8 for back-rank mate.
	st := mustParse(t, "6k1/5ppp/8/8/8/8/8/4K3[R] w - - 0 1")
	if st.Status() != Ongoing {
		t.Fatalf("pre-drop status = %v, want ongoing", st.Status())
	}
	st = mustApply(t, st, "R@e8")
	if st.Status() != WhiteWin {
		t.Errorf("after R@e8 status = %v, want white_win (mate)", st.Status())
	}
}

// A position that is checkmate in standard chess is NOT mate if the defender can
// drop a piece to interpose.
func TestMateEscapableByDropIsNotMate(t *testing.T) {
	// White rook e8 checks black king g8. With an empty pocket it is mate; with a
	// knight in pocket, black interposes N@f8, so the game is still ongoing.
	mate := mustParse(t, "4R1k1/5ppp/8/8/8/8/8/4K3[] b - - 0 1")
	if mate.Status() != WhiteWin {
		t.Errorf("empty-pocket back rank status = %v, want white_win", mate.Status())
	}
	escapable := mustParse(t, "4R1k1/5ppp/8/8/8/8/8/4K3[n] b - - 0 1")
	if escapable.Status() != Ongoing {
		t.Errorf("with a droppable knight status = %v, want ongoing", escapable.Status())
	}
	if _, err := escapable.Apply("N@f8"); err != nil {
		t.Errorf("N@f8 should interpose and be legal: %v", err)
	}
}

// Threefold repetition of the same board (and pockets) is a draw.
func TestThreefoldRepetition(t *testing.T) {
	st := mustParse(t, "4k3/8/8/8/8/8/8/4K3[] w - - 0 1")
	// Shuffle both kings back and forth; the start position recurs every 4 plies.
	shuffle := []string{"e1e2", "e8e7", "e2e1", "e7e8"}
	for i := 0; i < 2; i++ {
		for _, mv := range shuffle {
			if st.Status() != Ongoing {
				t.Fatalf("premature terminal status %v mid-shuffle", st.Status())
			}
			st = mustApply(t, st, mv)
		}
	}
	// After two full shuffles the start position has occurred three times.
	if st.Status() != Draw {
		t.Errorf("status after threefold = %v, want draw", st.Status())
	}
}
