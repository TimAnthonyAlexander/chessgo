package duckchess

import (
	"testing"
	"time"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

func TestBestMoveTakesInstantKingCapture(t *testing.T) {
	// Qxd8 wins on the spot; the search must find it and flag mate.
	fen := "3k4/8/8/8/8/8/8/3Q3K w - - 0 1"
	st, _ := Parse(fen, "")
	res := BestMove(st, DefaultLimits())
	if !res.HasMove {
		t.Fatalf("expected a move")
	}
	if res.Move.UCI() != "d1d8" {
		t.Fatalf("expected king capture d1d8, got %s", res.Move.UCI())
	}
	if res.Mate <= 0 {
		t.Errorf("king capture should report a positive mate score, got %d", res.Mate)
	}
	// The applied composite must be legal and win the game.
	_, _, status, err := st.ApplyComposite(res.MoveString())
	if err != nil {
		t.Fatalf("best move %q illegal: %v", res.MoveString(), err)
	}
	if status != WhiteWin {
		t.Errorf("status should be WhiteWin, got %q", status)
	}
}

func TestBestMoveIsDeterministic(t *testing.T) {
	st, _ := Parse(chess.StartFEN, "")
	lim := Limits{Rating: 1200, Level: -1, MoveTime: 200 * time.Millisecond}
	a := BestMove(st, lim)
	b := BestMove(st, lim)
	if a.MoveString() != b.MoveString() {
		t.Errorf("weakened search must be reproducible: %s vs %s", a.MoveString(), b.MoveString())
	}
}

func TestBestMoveAlwaysLegalFromStart(t *testing.T) {
	st, _ := Parse(chess.StartFEN, "")
	res := BestMove(st, Limits{Level: -1, Depth: 2})
	if !res.HasMove {
		t.Fatalf("start position must have a move")
	}
	if _, _, _, err := st.ApplyComposite(res.MoveString()); err != nil {
		t.Fatalf("search returned an illegal composite %q: %v", res.MoveString(), err)
	}
}

func TestNoLegalMoveIsTerminal(t *testing.T) {
	// A position where the side to move has been king-captured already (no black
	// king). Status resolves to the other side's win.
	fen := "8/8/8/8/8/8/8/4K2R b - - 0 1"
	st, err := Parse(fen, "")
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if got := st.Status(); got != WhiteWin {
		t.Errorf("black with no king should be WhiteWin, got %q", got)
	}
	res := BestMove(st, DefaultLimits())
	if res.HasMove {
		t.Errorf("black has no pieces, so no move should be returned")
	}
}

// TestScriptedMiniGameToKingCapture plays a short, fully-scripted game (both sides
// chosen by hand) that ends when a white rook slides along the back rank into the
// boxed-in black king.
func TestScriptedMiniGameToKingCapture(t *testing.T) {
	// Black king e8 is walled by its own pawns on d7/e7/f7 (it can only shuffle on
	// rank 8); an h-pawn gives Black a tempo move. White rook a1 climbs the (open)
	// a-file to a8 and then captures across the back rank.
	fen := "4k3/3ppp1p/8/8/8/8/8/R6K w - - 0 1"
	st, err := Parse(fen, "")
	if err != nil {
		t.Fatalf("parse: %v", err)
	}

	steps := []struct {
		move       string
		wantStatus Status
	}{
		{"a1a8:c4", Ongoing},  // white: rook to the 8th rank, eyeing the king
		{"h7h6:e4", Ongoing},  // black: a tempo pawn push (king stays boxed)
		{"a8e8:g4", WhiteWin}, // white: rook slides a8->e8, capturing the king
	}

	cur := st
	for i, step := range steps {
		ns, pm, status, err := cur.ApplyComposite(step.move)
		if err != nil {
			t.Fatalf("step %d apply %q: %v", i, step.move, err)
		}
		if status != step.wantStatus {
			t.Fatalf("step %d %q: status = %q, want %q", i, step.move, status, step.wantStatus)
		}
		// The SAN string is display-only but must be non-empty.
		if san := cur.SAN(pm, ns.Duck()); san == "" {
			t.Errorf("step %d produced an empty SAN", i)
		}
		cur = ns
	}
	if cur.PieceOn(chess.E8).Type() != chess.Rook {
		t.Errorf("white rook should occupy e8 after the capture")
	}
}

// TestScriptedMiniGameBlackWins mirrors the above with colours reversed to confirm
// the winner is attributed correctly for Black.
func TestScriptedMiniGameBlackWins(t *testing.T) {
	// Black rook a8 climbs the open a-file; white king e1 walled by pawns on
	// d2/e2/f2, with an h-pawn for a tempo move.
	fen := "r6k/8/8/8/8/8/3PPP1P/4K3 b - - 0 1"
	st, err := Parse(fen, "")
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	steps := []struct {
		move       string
		wantStatus Status
	}{
		{"a8a1:c5", Ongoing},  // black: rook to the 1st rank
		{"h2h3:e5", Ongoing},  // white: a tempo pawn push
		{"a1e1:g5", BlackWin}, // black: rook slides a1->e1, capturing the white king
	}
	cur := st
	for i, step := range steps {
		ns, _, status, err := cur.ApplyComposite(step.move)
		if err != nil {
			t.Fatalf("step %d apply %q: %v", i, step.move, err)
		}
		if status != step.wantStatus {
			t.Fatalf("step %d %q: status = %q, want %q", i, step.move, status, step.wantStatus)
		}
		cur = ns
	}
	if status := st.Status(); status != Ongoing {
		t.Errorf("initial position should be ongoing, got %q", status)
	}
}

func TestChooseDuckNeverStaysOrOccupies(t *testing.T) {
	// After any legal piece move, the heuristic duck square must be empty and differ
	// from the previous duck square.
	st, _ := Parse(chess.StartFEN, "e4")
	for _, m := range st.LegalPieceMoves() {
		mid, _ := st.doPieceMove(m)
		duck := chooseDuck(&mid, st.Side())
		if duck == chess.SqNone {
			t.Fatalf("chooseDuck returned SqNone for %s", m.UCI())
		}
		if duck == st.Duck() {
			t.Errorf("duck must move off e4 after %s", m.UCI())
		}
		if mid.PieceOn(duck) != chess.NoPiece {
			t.Errorf("duck placed on an occupied square %s after %s", duck.String(), m.UCI())
		}
	}
}
