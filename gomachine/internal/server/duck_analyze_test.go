package server

import (
	"strings"
	"testing"
)

// TestDuckAnalyzeGameEndpoint posts a short scripted Duck-Chess game that ends in
// a king capture and checks the review shape: one position per (move+1), every
// non-terminal position carries an eval + composite best move, and the final
// position is a decisive (checkmate) terminal.
func TestDuckAnalyzeGameEndpoint(t *testing.T) {
	s := New(1, 1, 1)

	// White marches the queen to h5 and captures the black king on e8 once the
	// f7 pawn has vacated the diagonal. Duck alternates a3/a4 (each ply differs).
	moves := []string{
		"e2e4:a3",
		"f7f5:a4",
		"d1h5:a3",
		"g8f6:a4",
		"h5e8:a3", // Qxe8 — captures the black king (white_win)
	}

	out := doJSON(t, s.handleDuckAnalyzeGame, "/duck/analyze-game", map[string]any{
		"moves":    moves,
		"movetime": 50,
	})

	if count, _ := out["count"].(float64); int(count) != len(moves)+1 {
		t.Fatalf("count should be %d, got %v", len(moves)+1, out["count"])
	}
	positions, ok := out["positions"].([]any)
	if !ok || len(positions) != len(moves)+1 {
		t.Fatalf("expected %d positions, got %v", len(moves)+1, out["positions"])
	}

	for i, p := range positions {
		pos, ok := p.(map[string]any)
		if !ok {
			t.Fatalf("position %d is not an object: %v", i, p)
		}
		if ply, _ := pos["ply"].(float64); int(ply) != i {
			t.Errorf("position %d has ply %v", i, pos["ply"])
		}
		if fen, _ := pos["fen"].(string); fen == "" {
			t.Errorf("position %d missing fen", i)
		}
		if _, hasDuck := pos["duck"].(string); !hasDuck {
			t.Errorf("position %d missing duck field", i)
		}

		terminal, _ := pos["terminal"].(bool)
		if i < len(moves) {
			// Non-terminal: full-strength eval + composite best move present.
			if terminal {
				t.Errorf("position %d should not be terminal", i)
			}
			if pos["eval"] == nil {
				t.Errorf("position %d missing eval", i)
			}
			best, _ := pos["bestmove"].(string)
			if !strings.Contains(best, ":") {
				t.Errorf("position %d bestmove should be composite, got %v", i, pos["bestmove"])
			}
			if san, _ := pos["bestSan"].(string); san == "" {
				t.Errorf("position %d missing bestSan", i)
			}
		} else {
			// Final position: decisive terminal (king captured ⇒ checkmate).
			if !terminal {
				t.Errorf("final position should be terminal: %v", pos)
			}
			if cm, _ := pos["checkmate"].(bool); !cm {
				t.Errorf("final position should be checkmate (king captured): %v", pos)
			}
			if pos["eval"] != nil || pos["bestmove"] != nil {
				t.Errorf("terminal position should have null eval/bestmove: %v", pos)
			}
		}
	}
}
