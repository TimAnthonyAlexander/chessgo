package hub

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/timanthonyalexander/gomachine/internal/auth"
)

const testSecret = "test-secret"

func dial(t *testing.T, srvURL, name string) *websocket.Conn {
	return dialAs(t, srvURL, name, "")
}

func dialAs(t *testing.T, srvURL, name, userID string) *websocket.Conn {
	t.Helper()
	ticket := auth.Sign(auth.Identity{UserID: userID, Anon: true, Name: name}, testSecret)
	url := "ws" + strings.TrimPrefix(srvURL, "http") + "/ws?ticket=" + ticket
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatalf("dial %s: %v", name, err)
	}
	return c
}

func send(t *testing.T, c *websocket.Conn, m map[string]any) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := wsjson.Write(ctx, c, m); err != nil {
		t.Fatalf("write: %v", err)
	}
}

func readType(t *testing.T, c *websocket.Conn, typ string) map[string]any {
	t.Helper()
	for i := 0; i < 12; i++ {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		var m map[string]any
		err := wsjson.Read(ctx, c, &m)
		cancel()
		if err != nil {
			t.Fatalf("read waiting for %s: %v", typ, err)
		}
		if m["type"] == typ {
			return m
		}
	}
	t.Fatalf("never received message of type %s", typ)
	return nil
}

func TestMatchPlayAndResign(t *testing.T) {
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
	if ma["color"] == mb["color"] {
		t.Fatalf("both players got color %v", ma["color"])
	}

	white, black := a, b
	if ma["color"] == "b" {
		white, black = b, a
	}

	send(t, white, map[string]any{"type": "move", "move": "e2e4"})
	sw := readType(t, white, "state")
	readType(t, black, "state")
	if sw["san"] != "e4" {
		t.Errorf("san = %v, want e4", sw["san"])
	}
	if sw["clock"] == nil {
		t.Error("state missing clock")
	}
	if sw["sideToMove"] != "b" {
		t.Errorf("sideToMove = %v, want b", sw["sideToMove"])
	}

	send(t, black, map[string]any{"type": "move", "move": "e7e5"})
	readType(t, white, "state")
	readType(t, black, "state")

	// Illegal move is rejected with an error, no state change.
	send(t, white, map[string]any{"type": "move", "move": "e2e4"})
	if msg := readType(t, white, "error"); msg["message"] == nil {
		t.Error("expected error message for illegal move")
	}

	send(t, white, map[string]any{"type": "resign"})
	end := readType(t, white, "end")
	if end["result"] != "0-1" {
		t.Errorf("result = %v, want 0-1 (white resigned)", end["result"])
	}
}

func TestReconnectResume(t *testing.T) {
	h := New(testSecret)
	go h.Run()
	srv := httptest.NewServer(http.HandlerFunc(h.ServeWS))
	defer srv.Close()

	a := dialAs(t, srv.URL, "alice", "id-alice")
	defer a.CloseNow()
	b := dialAs(t, srv.URL, "bob", "id-bob")
	defer b.CloseNow()
	readType(t, a, "hello")
	readType(t, b, "hello")

	send(t, a, map[string]any{"type": "queue", "pool": "3+0"})
	send(t, b, map[string]any{"type": "queue", "pool": "3+0"})
	ma := readType(t, a, "matched")
	mb := readType(t, b, "matched")

	// Identify white (conn, id) and black.
	whiteConn, whiteID, blackConn := a, "id-alice", b
	if ma["color"] == "b" {
		whiteConn, whiteID, blackConn = b, "id-bob", a
	}
	_ = mb

	send(t, whiteConn, map[string]any{"type": "move", "move": "e2e4"})
	readType(t, whiteConn, "state")
	readType(t, blackConn, "state")

	// White's tab "closes", then reconnects with the same identity.
	whiteConn.CloseNow()
	time.Sleep(60 * time.Millisecond)
	w2 := dialAs(t, srv.URL, "alice", whiteID)
	defer w2.CloseNow()
	readType(t, w2, "hello")

	rm := readType(t, w2, "resume")
	if rm["color"] != "w" {
		t.Errorf("resume color = %v, want w", rm["color"])
	}
	moves, ok := rm["moves"].([]any)
	if !ok || len(moves) != 1 {
		t.Errorf("resume moves = %v, want 1 move", rm["moves"])
	}
	if rm["opponentOnline"] != true {
		t.Errorf("opponentOnline = %v, want true", rm["opponentOnline"])
	}

	// The reconnected white can keep playing: black moves, white sees it.
	send(t, blackConn, map[string]any{"type": "move", "move": "e7e5"})
	st := readType(t, w2, "state")
	if st["sideToMove"] != "w" {
		t.Errorf("after black reply sideToMove = %v, want w", st["sideToMove"])
	}
}

func TestQueueThenCancel(t *testing.T) {
	h := New(testSecret)
	go h.Run()
	srv := httptest.NewServer(http.HandlerFunc(h.ServeWS))
	defer srv.Close()

	a := dial(t, srv.URL, "solo")
	defer a.CloseNow()
	readType(t, a, "hello")

	send(t, a, map[string]any{"type": "queue", "pool": "5+0"})
	readType(t, a, "queued")
	send(t, a, map[string]any{"type": "cancel"})
	readType(t, a, "idle")
}

func TestUnauthorizedTicketRejected(t *testing.T) {
	h := New(testSecret)
	go h.Run()
	srv := httptest.NewServer(http.HandlerFunc(h.ServeWS))
	defer srv.Close()

	url := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws?ticket=bogus"
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, url, nil)
	if err == nil {
		c.CloseNow()
		t.Fatal("expected dial to fail with a bad ticket")
	}
}
