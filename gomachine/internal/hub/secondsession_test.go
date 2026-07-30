package hub

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/coder/websocket"
)

// expectState asserts every named connection receives the same `state` frame.
func expectState(t *testing.T, wantSAN string, conns map[string]*websocket.Conn) {
	t.Helper()
	for name, c := range conns {
		if st := readType(t, c, "state"); st["san"] != wantSAN {
			t.Errorf("%s saw san = %v, want %v", name, st["san"], wantSAN)
		}
	}
}

// One account signed in twice (laptop + phone) is ONE player in ONE game: the
// second device is seated in the running game and stays in sync, and asking to
// queue there opens that game rather than starting another.
func TestSecondSessionJoinsTheSameGame(t *testing.T) {
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

	// The idle phone is seated in the game it had no part in starting.
	resumed := readType(t, phone, "resume")
	if resumed["gameId"] != matched["gameId"] {
		t.Errorf("resume gameId = %v, want %v", resumed["gameId"], matched["gameId"])
	}
	if resumed["color"] != matched["color"] {
		t.Errorf("resume color = %v, want %v", resumed["color"], matched["color"])
	}

	// Queueing on the phone re-opens the running game, never a second one.
	send(t, phone, map[string]any{"type": "queue", "pool": "10+0"})
	again := readType(t, phone, "resume")
	if again["gameId"] != matched["gameId"] {
		t.Errorf("re-resume gameId = %v, want %v", again["gameId"], matched["gameId"])
	}
	if len(h.games) != 1 {
		t.Errorf("games = %d, want 1 — a second game was started", len(h.games))
	}
}

// The point of seating both devices: a move made on either one reaches the
// other (and the opponent) immediately, and either one can be the one to move.
func TestBothDevicesStayInSync(t *testing.T) {
	h := New(testSecret)
	go h.Run()
	srv := httptest.NewServer(http.HandlerFunc(h.ServeWS))
	defer srv.Close()

	laptop := dialAs(t, srv.URL, "alice", "id-alice")
	defer laptop.CloseNow()
	opp := dialAs(t, srv.URL, "bob", "id-bob")
	defer opp.CloseNow()
	readType(t, laptop, "hello")
	readType(t, opp, "hello")

	send(t, laptop, map[string]any{"type": "queue", "pool": "3+0"})
	send(t, opp, map[string]any{"type": "queue", "pool": "3+0"})
	ma := readType(t, laptop, "matched")
	readType(t, opp, "matched")

	// The phone connects mid-game and is resumed into the same side.
	phone := dialAs(t, srv.URL, "alice", "id-alice")
	defer phone.CloseNow()
	readType(t, phone, "hello")
	readType(t, phone, "resume")

	// Whoever has white opens; alice's OTHER device must see the move too.
	aliceIsWhite := ma["color"] == "w"
	if aliceIsWhite {
		send(t, laptop, map[string]any{"type": "move", "move": "e2e4"})
	} else {
		send(t, opp, map[string]any{"type": "move", "move": "e2e4"})
	}
	expectState(t, "e4", map[string]*websocket.Conn{"laptop": laptop, "phone": phone, "opponent": opp})

	// …and the reply is accepted from the OTHER device of the same account,
	// proving the phone isn't a read-only mirror.
	if aliceIsWhite {
		send(t, opp, map[string]any{"type": "move", "move": "e7e5"})
	} else {
		send(t, phone, map[string]any{"type": "move", "move": "e7e5"})
	}
	expectState(t, "e5", map[string]*websocket.Conn{"laptop": laptop, "phone": phone, "opponent": opp})
}

// Closing one device must NOT mark the side offline while the other is still
// attached — the opponent should never see "opponent disconnected" for it.
func TestClosingOneDeviceKeepsSideOnline(t *testing.T) {
	h := New(testSecret)
	go h.Run()
	srv := httptest.NewServer(http.HandlerFunc(h.ServeWS))
	defer srv.Close()

	laptop := dialAs(t, srv.URL, "alice", "id-alice")
	defer laptop.CloseNow()
	opp := dialAs(t, srv.URL, "bob", "id-bob")
	defer opp.CloseNow()
	readType(t, laptop, "hello")
	readType(t, opp, "hello")
	send(t, laptop, map[string]any{"type": "queue", "pool": "3+0"})
	send(t, opp, map[string]any{"type": "queue", "pool": "3+0"})
	ma := readType(t, laptop, "matched")
	readType(t, opp, "matched")

	phone := dialAs(t, srv.URL, "alice", "id-alice")
	readType(t, phone, "hello")
	readType(t, phone, "resume")

	phone.CloseNow()

	// The opponent's next frame must be the move, not an opponentGone before it.
	if ma["color"] == "w" {
		send(t, laptop, map[string]any{"type": "move", "move": "e2e4"})
	} else {
		send(t, opp, map[string]any{"type": "move", "move": "e2e4"})
	}
	if st := readType(t, opp, "state"); st["san"] != "e4" {
		t.Errorf("san = %v, want e4", st["san"])
	}
	g := h.playerGames["id-alice"]
	if g == nil {
		t.Fatal("alice's game vanished")
	}
	if color := g.colorForID("id-alice"); !g.online[color] {
		t.Error("alice marked offline while the laptop is still attached")
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

	readType(t, phone, "resume")
	if n := len(h.pools["15+10"]); n != 0 {
		t.Errorf("phone still queued: pool holds %d client(s), want 0", n)
	}
}

// The explicit "resume" request: idle when there's nothing, and a re-report of
// the queue (never a bare "idle") when the client is still waiting in one.
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

	send(t, solo, map[string]any{"type": "queue", "pool": "5+0"})
	readType(t, solo, "queued")
	send(t, solo, map[string]any{"type": "resume"})
	if q := readType(t, solo, "queued"); q["pool"] != "5+0" {
		t.Errorf("re-reported pool = %v, want 5+0", q["pool"])
	}
}
