package engine

import (
	"testing"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

func mustFEN(t *testing.T, fen string) *chess.Position {
	t.Helper()
	pos, err := chess.ParseFEN(fen)
	if err != nil {
		t.Fatalf("ParseFEN(%q): %v", fen, err)
	}
	return pos
}

func TestAdjudicateCheckmate(t *testing.T) {
	// Fool's mate: White is checkmated.
	st := Adjudicate(mustFEN(t, "rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3"), nil)
	if st.State != "checkmate" || st.Result != "0-1" {
		t.Errorf("got %s/%s, want checkmate/0-1", st.State, st.Result)
	}
}

func TestAdjudicateStalemate(t *testing.T) {
	st := Adjudicate(mustFEN(t, "5k2/5P2/5K2/8/8/8/8/8 b - - 0 1"), nil)
	if st.State != "stalemate" || st.Result != "1/2-1/2" {
		t.Errorf("got %s/%s, want stalemate/1/2-1/2", st.State, st.Result)
	}
}

func TestAdjudicateInsufficientMaterial(t *testing.T) {
	st := Adjudicate(mustFEN(t, "8/8/4k3/8/8/3K4/8/8 w - - 0 1"), nil) // K vs K
	if st.State != "draw-insufficient-material" {
		t.Errorf("got %s, want draw-insufficient-material", st.State)
	}
}

func TestAdjudicateThreefoldClaimable(t *testing.T) {
	pos := mustFEN(t, "4k3/8/8/8/8/8/8/4K2R w K - 0 1")
	// History with the current position's key appearing twice already → 3rd now.
	hist := []uint64{pos.Key(), pos.Key()}
	st := Adjudicate(pos, hist)
	found := false
	for _, d := range st.ClaimableDraws {
		if d == "threefold" {
			found = true
		}
	}
	if !found {
		t.Errorf("expected threefold in claimableDraws, got %v", st.ClaimableDraws)
	}
}

func TestBestMoveAllLevelsLegal(t *testing.T) {
	pos := mustFEN(t, chess.StartFEN)
	eng := New(16)
	for level := 0; level <= 10; level++ {
		// Keep high levels quick by not actually using their long think time:
		// BestMove respects the level's time budget, so cap test cost via level<=4
		// for the slow ones is unnecessary — just verify legality at low levels and
		// a couple of high ones.
		if level > 4 && level < 9 {
			continue
		}
		res := eng.BestMove(pos, level, nil)
		if res.Move == chess.NullMove {
			t.Errorf("level %d returned null move", level)
			continue
		}
		if _, ok := pos.ParseUCIMove(res.Move.String()); !ok {
			t.Errorf("level %d returned illegal move %s", level, res.Move)
		}
	}
}
