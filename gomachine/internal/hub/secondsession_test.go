package hub

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// One account signed in twice (laptop + phone) must never end up in two games.
// The second connection is told a game is running, and asking to queue on it
// opens that game instead of starting another.
func TestSecondSessionCannotQueueIntoSecondGame(t *testing.T) {
	h := New(testSecret)
	go h.Run()
	srv := httptest.NewServer(http.HandlerFunc(h.ServeWS))
	defer srv.Close()

	laptop := dialAs(t, srv.URL, "alice", "id-alice")
	defer laptop.CloseNow()
	phone := dialAs(t, srv.URL, "alice", "id-alice") // same identity, second device
	defer phone.CloseNow()
	opp := dialAs(t, srv.URL, "bob", "id-bob")
	defer opp.CloseNow()

	readType(t, laptop, "hello")
	readType(t, phone, "hello")
	readType(t, opp, "hello")

	send(t, laptop, map[string]any{"type": "queue", "pool": "3+0"})
	send(t, opp, map[string]any{"type": "queue", "pool": "3+0"})
	matched := readType(t, laptop, "matched")
	readType(t, opp, "matched")

	// The idle phone is told about the game it wasn't part of starting.
	notice := readType(t, phone, "activeGame")
	if notice["gameId"] != matched["gameId"] {
		t.Errorf("activeGame gameId = %v, want %v", notice["gameId"], matched["gameId"])
	}
	if notice["pool"] != "3+0" {
		t.Errorf("activeGame pool = %v, want 3+0", notice["pool"])
	}

	// Queueing on the phone opens the running game rather than starting a new one.
	send(t, phone, map[string]any{"type": "queue", "pool": "10+0"})
	resumed := readType(t, phone, "resume")
	if resumed["gameId"] != matched["gameId"] {
		t.Errorf("resume gameId = %v, want %v", resumed["gameId"], matched["gameId"])
	}
	if resumed["color"] != matched["color"] {
		t.Errorf("resume color = %v, want %v", resumed["color"], matched["color"])
	}
	if len(h.games) != 1 {
		t.Errorf("games = %d, want 1 — a second game was started", len(h.games))
	}
}

// A connection already WAITING in a pool when the account gets matched on
// another device must be pulled out of it — otherwise matchmaking (or bot
// backfill) pairs it into a second game a moment later.
func TestSecondSessionQueuedIsStoodDown(t *testing.T) {
	h := New(testSecret)
	go h.Run()
	srv := httptest.NewServer(http.HandlerFunc(h.ServeWS))
	defer srv.Close()

	phone := dialAs(t, srv.URL, "alice", "id-alice")
	defer phone.CloseNow()
	laptop := dialAs(t, srv.URL, "alice", "id-alice")
	defer laptop.CloseNow()
	opp := dialAs(t, srv.URL, "bob", "id-bob")
	defer opp.CloseNow()
	readType(t, phone, "hello")
	readType(t, laptop, "hello")
	readType(t, opp, "hello")

	// The phone sits in a pool nobody else is in…
	send(t, phone, map[string]any{"type": "queue", "pool": "15+10"})
	readType(t, phone, "queued")

	// …while the laptop gets a real game.
	send(t, laptop, map[string]any{"type": "queue", "pool": "3+0"})
	send(t, opp, map[string]any{"type": "queue", "pool": "3+0"})
	readType(t, laptop, "matched")
	readType(t, opp, "matched")

	readType(t, phone, "activeGame")
	if n := len(h.pools["15+10"]); n != 0 {
		t.Errorf("phone still queued: pool holds %d client(s), want 0", n)
	}
}

// The explicit "resume" request: a second device takes over the seat after an
// activeGame notice, and a lone client with no game gets a plain idle back.
func TestResumeRequest(t *testing.T) {
	h := New(testSecret)
	go h.Run()
	srv := httptest.NewServer(http.HandlerFunc(h.ServeWS))
	defer srv.Close()

	solo := dialAs(t, srv.URL, "solo", "id-solo")
	defer solo.CloseNow()
	readType(t, solo, "hello")
	send(t, solo, map[string]any{"type": "resume"})
	readType(t, solo, "idle")

	// A queued client's resume probe must not wipe its searching state.
	send(t, solo, map[string]any{"type": "queue", "pool": "5+0"})
	readType(t, solo, "queued")
	send(t, solo, map[string]any{"type": "resume"})
	if q := readType(t, solo, "queued"); q["pool"] != "5+0" {
		t.Errorf("re-reported pool = %v, want 5+0", q["pool"])
	}
	send(t, solo, map[string]any{"type": "cancel"})
	readType(t, solo, "idle")

	// Now play a game on one connection and take it over from a second one.
	opp := dialAs(t, srv.URL, "bob", "id-bob")
	defer opp.CloseNow()
	readType(t, opp, "hello")
	send(t, solo, map[string]any{"type": "queue", "pool": "3+0"})
	send(t, opp, map[string]any{"type": "queue", "pool": "3+0"})
	matched := readType(t, solo, "matched")
	readType(t, opp, "matched")

	phone := dialAs(t, srv.URL, "solo", "id-solo")
	defer phone.CloseNow()
	readType(t, phone, "hello")
	// A fresh connection already resumes at register time; ask again explicitly
	// to prove the request path is idempotent.
	readType(t, phone, "resume")
	send(t, phone, map[string]any{"type": "resume"})
	again := readType(t, phone, "resume")
	if again["gameId"] != matched["gameId"] {
		t.Errorf("resume gameId = %v, want %v", again["gameId"], matched["gameId"])
	}

	// The phone now holds the seat, so it's the one that receives play — whoever
	// has white opens, and both sides see the resulting state.
	white := phone
	if matched["color"] != "w" {
		white = opp
	}
	send(t, white, map[string]any{"type": "move", "move": "e2e4"})
	readType(t, phone, "state")
	readType(t, opp, "state")
}
