package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestAnalyzeGameRepeatedPositionIsObjective is a regression test for the
// full-game analysis bug: a position that recurs in the game (here a king
// shuffle that returns to "rnb2rk1/.../1PPPKqPP/... w") must get the SAME,
// objective eval at both occurrences. The old code threaded the game history
// into each position's search, so the search's first-repetition-is-a-draw
// heuristic scored the SECOND occurrence 0.00 (a phantom draw) while the first
// correctly read a forced mate. analyzePosition is now history-free, so both
// occurrences evaluate identically.
func TestAnalyzeGameRepeatedPositionIsObjective(t *testing.T) {
	moves := []string{
		"g1f3", "g7g6", "e2e4", "f8g7", "b1c3", "c7c6", "a2a4", "e7e5",
		"f1c4", "g8f6", "a1a3", "e8g8", "e1e2", "d7d5", "e4d5", "e5e4",
		"c4b5", "e4f3", "e2e3", "f6g4", "e3f3", "d8f6", "f3e2", "f6f2",
		"e2d3", "f2d4", "d3e2", "d4f2", "e2d3", "g4e5", "d3e4", "c8f5",
	}
	s := New(4, 16, 1)
	body, err := json.Marshal(map[string]any{"moves": moves, "movetime": 150})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/analyze-game", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	s.handleAnalyzeGame(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}

	var out struct {
		Positions []map[string]any `json:"positions"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if len(out.Positions) <= 28 {
		t.Fatalf("expected >28 positions, got %d", len(out.Positions))
	}

	const a, b = 24, 28 // the two plies that share the identical position

	placement := func(i int) string {
		fen, _ := out.Positions[i]["fen"].(string)
		return strings.Fields(fen)[0]
	}
	if placement(a) != placement(b) {
		t.Fatalf("plies %d and %d should be the same position, got %q vs %q",
			a, b, placement(a), placement(b))
	}

	evalOf := func(i int) (string, float64) {
		e, ok := out.Positions[i]["eval"].(map[string]any)
		if !ok {
			t.Fatalf("ply %d has no eval object: %v", i, out.Positions[i]["eval"])
		}
		typ, _ := e["type"].(string)
		val, _ := e["value"].(float64)
		return typ, val
	}

	ta, va := evalOf(a)
	tb, vb := evalOf(b)
	if ta != tb || va != vb {
		t.Fatalf("identical position got different evals: ply %d = {%s %g}, ply %d = {%s %g}",
			a, ta, va, b, tb, vb)
	}
	if ta != "mate" {
		t.Fatalf("expected a forced mate at the recurring position, got {%s %g}", ta, va)
	}
}
