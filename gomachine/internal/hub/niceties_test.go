package hub

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/coder/websocket"
)

// match dials two players, queues them into the same pool, and returns the
// white and black connections.
func match(t *testing.T, srvURL string) (white, black *websocket.Conn) {
	t.Helper()
	a := dialAs(t, srvURL, "alice", "id-alice")
	b := dialAs(t, srvURL, "bob", "id-bob")
	readType(t, a, "hello")
	readType(t, b, "hello")
	send(t, a, map[string]any{"type": "queue", "pool": "3+0"})
	send(t, b, map[string]any{"type": "queue", "pool": "3+0"})
	ma := readType(t, a, "matched")
	readType(t, b, "matched")
	if ma["color"] == "b" {
		return b, a
	}
	return a, b
}

func TestDrawOfferAndAccept(t *testing.T) {
	h := New(testSecret)
	go h.Run()
	srv := httptest.NewServer(http.HandlerFunc(h.ServeWS))
	defer srv.Close()

	white, black := match(t, srv.URL)
	defer white.CloseNow()
	defer black.CloseNow()

	send(t, white, map[string]any{"type": "drawOffer"})
	off := readType(t, black, "drawOffered")
	if off["by"] != "w" {
		t.Errorf("drawOffered by = %v, want w", off["by"])
	}

	send(t, black, map[string]any{"type": "drawAccept"})
	for _, c := range []*websocket.Conn{white, black} {
		end := readType(t, c, "end")
		if end["result"] != "1/2-1/2" {
			t.Errorf("result = %v, want 1/2-1/2", end["result"])
		}
		if end["reason"] != "agreement" {
			t.Errorf("reason = %v, want agreement", end["reason"])
		}
	}
}

func TestDrawDeclineKeepsGame(t *testing.T) {
	h := New(testSecret)
	go h.Run()
	srv := httptest.NewServer(http.HandlerFunc(h.ServeWS))
	defer srv.Close()

	white, black := match(t, srv.URL)
	defer white.CloseNow()
	defer black.CloseNow()

	send(t, white, map[string]any{"type": "drawOffer"})
	readType(t, black, "drawOffered")
	send(t, black, map[string]any{"type": "drawDecline"})
	readType(t, white, "drawDeclined")

	// Game continues: white can still move.
	send(t, white, map[string]any{"type": "move", "move": "e2e4"})
	if st := readType(t, black, "state"); st["san"] != "e4" {
		t.Errorf("san = %v, want e4 after declined draw", st["san"])
	}
}

func TestTakebackRollsBack(t *testing.T) {
	h := New(testSecret)
	go h.Run()
	srv := httptest.NewServer(http.HandlerFunc(h.ServeWS))
	defer srv.Close()

	white, black := match(t, srv.URL)
	defer white.CloseNow()
	defer black.CloseNow()

	send(t, white, map[string]any{"type": "move", "move": "e2e4"})
	readType(t, white, "state")
	readType(t, black, "state")

	// White (who just moved) requests a takeback; black accepts. It rolls back to
	// white's turn — here, all the way to the start (ply 0, white to move).
	send(t, white, map[string]any{"type": "takebackOffer"})
	off := readType(t, black, "takebackOffered")
	if off["by"] != "w" {
		t.Errorf("takebackOffered by = %v, want w", off["by"])
	}
	send(t, black, map[string]any{"type": "takebackAccept"})

	for _, c := range []*websocket.Conn{white, black} {
		st := readType(t, c, "state")
		if ply, _ := st["ply"].(float64); ply != 0 {
			t.Errorf("ply = %v, want 0 after takeback", st["ply"])
		}
		if st["sideToMove"] != "w" {
			t.Errorf("sideToMove = %v, want w after takeback", st["sideToMove"])
		}
	}

	// And play resumes from the rolled-back position.
	send(t, white, map[string]any{"type": "move", "move": "d2d4"})
	if st := readType(t, black, "state"); st["san"] != "d4" {
		t.Errorf("san = %v, want d4 after takeback resume", st["san"])
	}
}

func TestChatRelaysToPlayers(t *testing.T) {
	h := New(testSecret)
	go h.Run()
	srv := httptest.NewServer(http.HandlerFunc(h.ServeWS))
	defer srv.Close()

	white, black := match(t, srv.URL)
	defer white.CloseNow()
	defer black.CloseNow()

	send(t, white, map[string]any{"type": "chat", "text": "  hi there  "})
	got := readType(t, black, "chat")
	if got["text"] != "hi there" {
		t.Errorf("chat text = %q, want %q (trimmed)", got["text"], "hi there")
	}
	if got["by"] != "w" {
		t.Errorf("chat by = %v, want w", got["by"])
	}

	// Empty / whitespace-only chat is dropped (no relay): a real message after it
	// is what black should see next.
	send(t, white, map[string]any{"type": "chat", "text": "   "})
	send(t, white, map[string]any{"type": "chat", "text": "second"})
	if got := readType(t, black, "chat"); got["text"] != "second" {
		t.Errorf("chat text = %q, want second", got["text"])
	}
}
