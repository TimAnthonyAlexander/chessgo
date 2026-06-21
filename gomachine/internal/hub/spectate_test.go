package hub

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/timanthonyalexander/gomachine/internal/auth"
)

func dialSpectate(t *testing.T, srvURL string) *websocket.Conn {
	t.Helper()
	ticket := auth.Sign(auth.Identity{Anon: true, Name: "watcher"}, testSecret)
	url := "ws" + strings.TrimPrefix(srvURL, "http") + "/ws?ticket=" + ticket + "&spectate=1"
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatalf("dial spectator: %v", err)
	}
	return c
}

// A spectator can watch a live game read-only: it gets the full state on join,
// every subsequent move as a broadcast, and the terminal end.
func TestSpectateLiveGame(t *testing.T) {
	h := New(testSecret)
	go h.Run()
	srv := httptest.NewServer(http.HandlerFunc(h.ServeWS))
	defer srv.Close()

	a := dial(t, srv.URL, "alice")
	defer a.CloseNow()
	b := dial(t, srv.URL, "bob")
	defer b.CloseNow()
	readType(t, a, "hello")
	readType(t, b, "hello")

	send(t, a, map[string]any{"type": "queue", "pool": "3+0"})
	send(t, b, map[string]any{"type": "queue", "pool": "3+0"})
	ma := readType(t, a, "matched")
	mb := readType(t, b, "matched")
	gameID, _ := ma["gameId"].(string)
	if gameID == "" {
		t.Fatal("no gameId in matched")
	}

	white, black := a, b
	if ma["color"] == "b" {
		white, black = b, a
	}
	_ = mb

	// A spectator joins and gets the full current state.
	sp := dialSpectate(t, srv.URL)
	defer sp.CloseNow()
	readType(t, sp, "hello")
	send(t, sp, map[string]any{"type": "watch", "gameId": gameID})
	w := readType(t, sp, "watching")
	if w["gameId"] != gameID {
		t.Errorf("watching gameId = %v, want %v", w["gameId"], gameID)
	}
	if _, ok := w["white"].(map[string]any); !ok {
		t.Errorf("watching missing white player: %v", w["white"])
	}
	if _, ok := w["black"].(map[string]any); !ok {
		t.Errorf("watching missing black player: %v", w["black"])
	}

	// A move is broadcast to the spectator too.
	send(t, white, map[string]any{"type": "move", "move": "e2e4"})
	readType(t, white, "state")
	readType(t, black, "state")
	st := readType(t, sp, "state")
	if st["san"] != "e4" {
		t.Errorf("spectator state san = %v, want e4", st["san"])
	}

	// Game end reaches the spectator.
	send(t, white, map[string]any{"type": "resign"})
	end := readType(t, sp, "end")
	if end["result"] != "0-1" {
		t.Errorf("spectator end result = %v, want 0-1", end["result"])
	}
}

// Watching an unknown / already-finished game yields a watchEnd, not a hang.
func TestSpectateUnavailable(t *testing.T) {
	h := New(testSecret)
	go h.Run()
	srv := httptest.NewServer(http.HandlerFunc(h.ServeWS))
	defer srv.Close()

	sp := dialSpectate(t, srv.URL)
	defer sp.CloseNow()
	readType(t, sp, "hello")
	send(t, sp, map[string]any{"type": "watch", "gameId": "does-not-exist"})
	if m := readType(t, sp, "watchEnd"); m["gameId"] != "does-not-exist" {
		t.Errorf("watchEnd gameId = %v", m["gameId"])
	}
}

type lobbyResp struct {
	Games []struct {
		ID    string `json:"id"`
		Ply   int    `json:"ply"`
		White struct {
			Name string `json:"name"`
		} `json:"white"`
	} `json:"games"`
	Max int `json:"max"`
}

func parseLobby(t *testing.T, h *Hub) lobbyResp {
	t.Helper()
	var lr lobbyResp
	if err := json.Unmarshal(h.LobbyJSON(), &lr); err != nil {
		t.Fatalf("unmarshal lobby: %v", err)
	}
	return lr
}

// A live game appears in the GET /games lobby snapshot.
func TestLobbySnapshotListsGame(t *testing.T) {
	h := New(testSecret)
	go h.Run()
	srv := httptest.NewServer(http.HandlerFunc(h.ServeWS))
	defer srv.Close()

	a := dial(t, srv.URL, "alice")
	defer a.CloseNow()
	b := dial(t, srv.URL, "bob")
	defer b.CloseNow()
	readType(t, a, "hello")
	readType(t, b, "hello")
	send(t, a, map[string]any{"type": "queue", "pool": "3+0"})
	send(t, b, map[string]any{"type": "queue", "pool": "3+0"})
	ma := readType(t, a, "matched")
	gameID := ma["gameId"].(string)

	// The ticker publishes the snapshot every 200ms; wait a couple of ticks.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		lr := parseLobby(t, h)
		for _, g := range lr.Games {
			if g.ID == gameID {
				if lr.Max != lobbyMax {
					t.Errorf("lobby max = %d, want %d", lr.Max, lobbyMax)
				}
				return
			}
		}
		time.Sleep(80 * time.Millisecond)
	}
	t.Fatalf("game %s never appeared in lobby snapshot", gameID)
}

// With fillers enabled and watch activity, self-play games spawn and advance.
// Without recent activity they are NOT replenished (JIT).
func TestFillerSelfPlay(t *testing.T) {
	if raceDetectorOn {
		// Real engine self-play against a wall-clock deadline; under -race the ~10×
		// slowdown plus the suite's lingering hub goroutines starve filler search.
		// Functionality is covered by the (reliable) normal-build run.
		t.Skip("timing-sensitive filler self-play skipped under -race")
	}
	h := New(testSecret)
	h.EnableSpectatorFillers(3, 2, 8, 1)
	go h.Run()

	// No watch activity yet: nothing should spawn.
	time.Sleep(400 * time.Millisecond)
	if n := len(parseLobby(t, h).Games); n != 0 {
		t.Fatalf("fillers spawned without watchers: %d games", n)
	}

	// Signal interest; fillers spawn (one per tick) and the engine moves.
	h.WatchPing()
	// Deadline is a MAX wait — the loop returns the instant self-play advances, so
	// a roomy bound costs nothing on success, just headroom for slow CI.
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		lr := parseLobby(t, h)
		advanced := false
		for _, g := range lr.Games {
			if g.Ply > 0 && g.White.Name != "" {
				advanced = true
			}
		}
		if len(lr.Games) >= 2 && advanced {
			return // self-play is running
		}
		time.Sleep(120 * time.Millisecond)
	}
	t.Fatal("filler self-play games never spawned/advanced")
}
