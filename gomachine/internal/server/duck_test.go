package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// doJSON posts a JSON body to a handler and decodes the JSON response.
func doJSON(t *testing.T, h http.HandlerFunc, path string, req any) map[string]any {
	t.Helper()
	body, err := json.Marshal(req)
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(body))
	rec := httptest.NewRecorder()
	h(rec, r)
	if rec.Code != http.StatusOK {
		t.Fatalf("%s status %d: %s", path, rec.Code, rec.Body.String())
	}
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode %s: %v", path, err)
	}
	return out
}

func TestDuckLegalMovesEndpoint(t *testing.T) {
	s := New(1, 1, 1)
	out := doJSON(t, s.handleDuckLegalMoves, "/duck/legal-moves",
		map[string]any{"fen": chess.StartFEN, "duck": ""})
	moves, ok := out["moves"].([]any)
	if !ok || len(moves) != 20 {
		t.Fatalf("start position should have 20 piece moves, got %v", out["moves"])
	}
}

func TestDuckMoveEndpoint(t *testing.T) {
	s := New(1, 1, 1)
	out := doJSON(t, s.handleDuckMove, "/duck/move",
		map[string]any{"fen": chess.StartFEN, "duck": "", "move": "e2e4:e5"})
	if out["legal"] != true {
		t.Fatalf("e2e4:e5 should be legal: %v", out)
	}
	if out["duck"] != "e5" {
		t.Errorf("duck should be e5, got %v", out["duck"])
	}
	if out["sideToMove"] != "b" {
		t.Errorf("side to move should be b, got %v", out["sideToMove"])
	}
	if out["status"] != "ongoing" {
		t.Errorf("status should be ongoing, got %v", out["status"])
	}

	// An illegal composite is reported, not errored.
	bad := doJSON(t, s.handleDuckMove, "/duck/move",
		map[string]any{"fen": chess.StartFEN, "duck": "", "move": "e2e4:d7"})
	if bad["legal"] != false || bad["error"] == nil {
		t.Errorf("occupied duck target should be rejected: %v", bad)
	}
}

func TestDuckBestMoveEndpoint(t *testing.T) {
	s := New(1, 1, 1)
	// A position with an instant king capture (Qxd8).
	out := doJSON(t, s.handleDuckBestMove, "/duck/bestmove", map[string]any{
		"fen":    "3k4/8/8/8/8/8/8/3Q3K w - - 0 1",
		"duck":   "",
		"limits": map[string]any{"depth": 2},
	})
	best, _ := out["bestmove"].(string)
	if best[:4] != "d1d8" {
		t.Fatalf("best move should capture the king (d1d8:*), got %v", out["bestmove"])
	}
	if out["status"] != "white_win" {
		t.Errorf("status should be white_win after the capture, got %v", out["status"])
	}
	if out["result"] != "1-0" {
		t.Errorf("result should be 1-0, got %v", out["result"])
	}
}
