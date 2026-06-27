package hub

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/timanthonyalexander/gomachine/internal/auth"
)

// dialAccount connects as a non-anonymous account (so rated challenges are
// possible), with a real per-category rating.
func dialAccount(t *testing.T, srvURL, name, userID string, rating int) *websocket.Conn {
	t.Helper()
	id := auth.Identity{
		UserID: userID,
		Anon:   false,
		Name:   name,
		Rating: rating,
		Ratings: map[string]int{
			"bullet": rating, "blitz": rating, "rapid": rating, "classical": rating,
		},
	}
	ticket := auth.Sign(id, testSecret)
	url := "ws" + strings.TrimPrefix(srvURL, "http") + "/ws?ticket=" + ticket
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatalf("dial %s: %v", name, err)
	}
	return c
}

func TestPrivateChallengeColorAndRated(t *testing.T) {
	h := New(testSecret)
	go h.Run()
	srv := httptest.NewServer(http.HandlerFunc(h.ServeWS))
	defer srv.Close()

	a := dialAccount(t, srv.URL, "alice", "id-alice", 1600)
	defer a.CloseNow()
	b := dialAccount(t, srv.URL, "bob", "id-bob", 2400) // far apart: would NEVER pair publicly
	defer b.CloseNow()
	readType(t, a, "hello")
	readType(t, b, "hello")

	// Alice creates a rated challenge, choosing to play White.
	send(t, a, map[string]any{"type": "createChallenge", "pool": "5+0", "color": "w", "rated": true})
	created := readType(t, a, "challengeCreated")
	code, _ := created["code"].(string)
	if code == "" {
		t.Fatalf("challengeCreated missing code: %v", created)
	}
	if created["rated"] != true {
		t.Errorf("rated = %v, want true (both accounts)", created["rated"])
	}

	// Bob joins by code — they pair despite the 800-point rating gap.
	send(t, b, map[string]any{"type": "joinChallenge", "code": code})
	ma := readType(t, a, "matched")
	mb := readType(t, b, "matched")

	if ma["color"] != "w" {
		t.Errorf("creator color = %v, want w", ma["color"])
	}
	if mb["color"] != "b" {
		t.Errorf("joiner color = %v, want b", mb["color"])
	}
	if ma["rated"] != true || mb["rated"] != true {
		t.Errorf("rated = %v/%v, want true/true", ma["rated"], mb["rated"])
	}
}

func TestPrivateChallengeAnonForcesCasual(t *testing.T) {
	h := New(testSecret)
	go h.Run()
	srv := httptest.NewServer(http.HandlerFunc(h.ServeWS))
	defer srv.Close()

	// Anonymous creator asks for rated — must be downgraded to casual.
	a := dial(t, srv.URL, "anon-a")
	defer a.CloseNow()
	b := dialAccount(t, srv.URL, "bob", "id-bob", 1500)
	defer b.CloseNow()
	readType(t, a, "hello")
	readType(t, b, "hello")

	send(t, a, map[string]any{"type": "createChallenge", "pool": "3+0", "color": "random", "rated": true})
	created := readType(t, a, "challengeCreated")
	if created["rated"] != false {
		t.Errorf("rated = %v, want false (anon creator)", created["rated"])
	}
	code, _ := created["code"].(string)

	send(t, b, map[string]any{"type": "joinChallenge", "code": code})
	ma := readType(t, a, "matched")
	if ma["rated"] != false {
		t.Errorf("matched rated = %v, want false", ma["rated"])
	}
}

func TestPrivateChallengeUnknownCode(t *testing.T) {
	h := New(testSecret)
	go h.Run()
	srv := httptest.NewServer(http.HandlerFunc(h.ServeWS))
	defer srv.Close()

	a := dial(t, srv.URL, "solo")
	defer a.CloseNow()
	readType(t, a, "hello")

	send(t, a, map[string]any{"type": "joinChallenge", "code": "ZZZZZZ"})
	if msg := readType(t, a, "error"); msg["message"] == nil {
		t.Error("expected error for unknown code")
	}
}

func TestPrivateChallengeOwnCodeRejected(t *testing.T) {
	h := New(testSecret)
	go h.Run()
	srv := httptest.NewServer(http.HandlerFunc(h.ServeWS))
	defer srv.Close()

	a := dialAccount(t, srv.URL, "alice", "id-alice", 1500)
	defer a.CloseNow()
	readType(t, a, "hello")

	send(t, a, map[string]any{"type": "createChallenge", "pool": "5+0", "color": "random", "rated": false})
	created := readType(t, a, "challengeCreated")
	code, _ := created["code"].(string)

	// Same identity joining its own challenge is rejected.
	send(t, a, map[string]any{"type": "joinChallenge", "code": code})
	if msg := readType(t, a, "error"); msg["message"] == nil {
		t.Error("expected error joining own challenge")
	}
}

func TestPrivateChallengeCancel(t *testing.T) {
	h := New(testSecret)
	go h.Run()
	srv := httptest.NewServer(http.HandlerFunc(h.ServeWS))
	defer srv.Close()

	a := dialAccount(t, srv.URL, "alice", "id-alice", 1500)
	defer a.CloseNow()
	b := dialAccount(t, srv.URL, "bob", "id-bob", 1500)
	defer b.CloseNow()
	readType(t, a, "hello")
	readType(t, b, "hello")

	send(t, a, map[string]any{"type": "createChallenge", "pool": "5+0", "color": "random", "rated": false})
	created := readType(t, a, "challengeCreated")
	code, _ := created["code"].(string)

	send(t, a, map[string]any{"type": "cancelChallenge"})
	readType(t, a, "idle")

	// After cancel, the code no longer resolves.
	send(t, b, map[string]any{"type": "joinChallenge", "code": code})
	if msg := readType(t, b, "error"); msg["message"] == nil {
		t.Error("expected error joining cancelled challenge")
	}
}
