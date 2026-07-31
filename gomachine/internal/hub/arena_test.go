package hub

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/timanthonyalexander/gomachine/internal/auth"
)

// joinArenaEventually retries `joinArena` until it succeeds (arenaJoined) or a
// short deadline passes. SetArenaSnapshots delivers to the Run goroutine
// asynchronously (a buffered channel, like every other Hub input), so a join
// issued immediately after registering a snapshot can race ahead of it;
// retrying absorbs that race exactly like TestOnline's poll loop absorbs the
// register-channel race for session lookups.
func joinArenaEventually(t *testing.T, c *websocket.Conn, tournamentID string) map[string]any {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		send(t, c, map[string]any{"type": "joinArena", "tournamentId": tournamentID})
		ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
		var m map[string]any
		err := wsjson.Read(ctx, c, &m)
		cancel()
		if err != nil {
			continue // no reply within the window; retry
		}
		if m["type"] == "arenaJoined" {
			return m
		}
		time.Sleep(20 * time.Millisecond) // likely "arena not found" — the snapshot hasn't landed yet
	}
	t.Fatalf("joinArena(%s) never succeeded", tournamentID)
	return nil
}

// --- closestArenaPair: pure unit tests (score-based pairing + no-self-pairing) ---

func TestClosestArenaPair(t *testing.T) {
	mkClient := func(sub string) *Client { return &Client{id: auth.Identity{UserID: sub}} }

	cases := []struct {
		name         string
		scores       map[string]int
		lastOpponent map[string]string
		subs         []string // ar.free order
		wantA, wantB string   // expected pair (order-insensitive)
	}{
		{
			name:   "picks the closest score pair, not the first two present",
			scores: map[string]int{"a": 100, "b": 105, "c": 500},
			subs:   []string{"a", "c", "b"}, // arrival order must not matter
			wantA:  "a", wantB: "b",
		},
		{
			name:         "avoids an immediate rematch when a third player is free",
			scores:       map[string]int{"a": 100, "b": 100, "c": 100}, // equal, so score alone wouldn't decide
			lastOpponent: map[string]string{"a": "b", "b": "a"},
			subs:         []string{"a", "b", "c"},
			wantA:        "a", wantB: "c", // NOT a-b again, since c is available
		},
		{
			name:         "allows a repeat when no third player is free",
			scores:       map[string]int{"a": 100, "b": 100},
			lastOpponent: map[string]string{"a": "b", "b": "a"},
			subs:         []string{"a", "b"},
			wantA:        "a", wantB: "b",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ar := &arenaState{players: map[string]*arenaPlayerState{}, lastOpponent: tc.lastOpponent}
			if ar.lastOpponent == nil {
				ar.lastOpponent = map[string]string{}
			}
			for sub, score := range tc.scores {
				ar.players[sub] = &arenaPlayerState{score: score}
			}
			for _, sub := range tc.subs {
				ar.free = append(ar.free, mkClient(sub))
			}
			i, j := closestArenaPair(ar)
			if i < 0 {
				t.Fatalf("closestArenaPair returned no pair")
			}
			gotA, gotB := ar.free[i].id.UserID, ar.free[j].id.UserID
			if (gotA != tc.wantA || gotB != tc.wantB) && (gotA != tc.wantB || gotB != tc.wantA) {
				t.Errorf("pair = (%s, %s), want (%s, %s)", gotA, gotB, tc.wantA, tc.wantB)
			}
		})
	}
}

// TestClosestArenaPairNeverSelfPairs guards the defensive same-identity skip
// directly: two different connections that (should never happen, but
// defensively) share one identity must never be reported as a pair.
func TestClosestArenaPairNeverSelfPairs(t *testing.T) {
	ar := &arenaState{
		players:      map[string]*arenaPlayerState{"a": {score: 100}},
		lastOpponent: map[string]string{},
		free: []*Client{
			{id: auth.Identity{UserID: "a"}},
			{id: auth.Identity{UserID: "a"}},
		},
	}
	if i, j := closestArenaPair(ar); i >= 0 {
		t.Fatalf("closestArenaPair paired the same identity with itself: (%d, %d)", i, j)
	}
}

// --- WS-integration: participant validation ---

func TestArenaJoinValidation(t *testing.T) {
	const arenaID = "ARENA-V"

	// setup registers one arena with a valid participant (id-carol), a
	// withdrawn one (id-dave), and syncs on carol's join (SetArenaSnapshots is
	// delivered asynchronously) before handing control to the sub-test, then
	// has carol leave so she doesn't occupy the pool for the real assertion.
	setup := func(t *testing.T) string {
		t.Helper()
		h := New(testSecret)
		go h.Run()
		srv := httptest.NewServer(http.HandlerFunc(h.ServeWS))
		t.Cleanup(srv.Close)
		h.SetArenaSnapshots([]ArenaSnapshot{{
			ID: arenaID, Pool: "3+0", Variant: "standard", Rated: true,
			EndsAtMs: time.Now().Add(time.Hour).UnixMilli(),
			Players: []ArenaPlayerSnapshot{
				{Sub: "id-carol", Score: 5},
				{Sub: "id-dave", Score: 5, Withdrawn: true},
			},
		}})
		canary := dialAccount(t, srv.URL, "carol", "id-carol", 1500)
		readType(t, canary, "hello")
		joinArenaEventually(t, canary, arenaID)
		send(t, canary, map[string]any{"type": "leaveArena"})
		readType(t, canary, "arenaLeft")
		canary.CloseNow()
		return srv.URL
	}

	t.Run("anonymous client rejected", func(t *testing.T) {
		url := setup(t)
		c := dial(t, url, "anon")
		defer c.CloseNow()
		readType(t, c, "hello")
		send(t, c, map[string]any{"type": "joinArena", "tournamentId": arenaID})
		if msg := readType(t, c, "error"); msg["message"] == nil {
			t.Error("expected an error for an anonymous client")
		}
	})

	t.Run("spectator rejected", func(t *testing.T) {
		url := setup(t)
		c := dialSpectate(t, url)
		defer c.CloseNow()
		readType(t, c, "hello")
		send(t, c, map[string]any{"type": "joinArena", "tournamentId": arenaID})
		if msg := readType(t, c, "error"); msg["message"] == nil {
			t.Error("expected an error for a spectator")
		}
	})

	t.Run("non-participant rejected", func(t *testing.T) {
		url := setup(t)
		c := dialAccount(t, url, "eve", "id-eve", 1500) // a real account, just not entered
		defer c.CloseNow()
		readType(t, c, "hello")
		send(t, c, map[string]any{"type": "joinArena", "tournamentId": arenaID})
		if msg := readType(t, c, "error"); msg["message"] == nil {
			t.Error("expected an error for a sub that isn't a participant")
		}
	})

	t.Run("withdrawn participant rejected", func(t *testing.T) {
		url := setup(t)
		c := dialAccount(t, url, "dave", "id-dave", 1500)
		defer c.CloseNow()
		readType(t, c, "hello")
		send(t, c, map[string]any{"type": "joinArena", "tournamentId": arenaID})
		if msg := readType(t, c, "error"); msg["message"] == nil {
			t.Error("expected an error for a withdrawn participant")
		}
	})

	t.Run("unknown tournament id rejected", func(t *testing.T) {
		url := setup(t)
		c := dialAccount(t, url, "carol", "id-carol", 1500) // valid participant, wrong id
		defer c.CloseNow()
		readType(t, c, "hello")
		send(t, c, map[string]any{"type": "joinArena", "tournamentId": "NOT-REAL"})
		if msg := readType(t, c, "error"); msg["message"] == nil {
			t.Error("expected an error for an unknown/not-running tournament id")
		}
	})

	t.Run("valid participant joins and waits alone", func(t *testing.T) {
		url := setup(t)
		c := dialAccount(t, url, "carol", "id-carol", 1500)
		defer c.CloseNow()
		readType(t, c, "hello")
		joined := joinArenaEventually(t, c, arenaID)
		if joined["tournamentId"] != arenaID {
			t.Errorf("arenaJoined tournamentId = %v, want %v", joined["tournamentId"], arenaID)
		}
		readType(t, c, "arenaWaiting")
	})
}

// TestArenaJoinRejectsIfBusy guards the "one pending activity per client"
// rule: a client already in a normal matchmaking queue, or already playing,
// must not also be seated in an arena's pool.
func TestArenaJoinRejectsIfBusy(t *testing.T) {
	h := New(testSecret)
	go h.Run()
	srv := httptest.NewServer(http.HandlerFunc(h.ServeWS))
	defer srv.Close()

	const arenaID = "ARENA-BUSY"
	h.SetArenaSnapshots([]ArenaSnapshot{{
		ID: arenaID, Pool: "3+0", Variant: "standard",
		EndsAtMs: time.Now().Add(time.Hour).UnixMilli(),
		Players:  []ArenaPlayerSnapshot{{Sub: "id-busy1", Score: 1}, {Sub: "id-busy2", Score: 1}},
	}})

	// Sync the snapshot's arrival via a canary, exactly like TestArenaJoinValidation.
	canary := dialAccount(t, srv.URL, "busy1", "id-busy1", 1500)
	readType(t, canary, "hello")
	joinArenaEventually(t, canary, arenaID)
	send(t, canary, map[string]any{"type": "leaveArena"})
	readType(t, canary, "arenaLeft")
	canary.CloseNow()

	queued := dialAccount(t, srv.URL, "busy1", "id-busy1", 1500)
	defer queued.CloseNow()
	readType(t, queued, "hello")
	send(t, queued, map[string]any{"type": "queue", "pool": "3+0"})
	readType(t, queued, "queued")
	send(t, queued, map[string]any{"type": "joinArena", "tournamentId": arenaID})
	if msg := readType(t, queued, "error"); msg["message"] == nil {
		t.Error("expected an error joining an arena while queued in a normal pool")
	}
}

// TestArenaJoinRejectsDuplicateIdentity guards the same rule at the identity
// level (two connections, same account): the second must never be allowed to
// wait alongside the first — that would let closestArenaPair pair the account
// with itself.
func TestArenaJoinRejectsDuplicateIdentity(t *testing.T) {
	h := New(testSecret)
	go h.Run()
	srv := httptest.NewServer(http.HandlerFunc(h.ServeWS))
	defer srv.Close()

	const arenaID = "ARENA-DUP"
	h.SetArenaSnapshots([]ArenaSnapshot{{
		ID: arenaID, Pool: "3+0", Variant: "standard",
		EndsAtMs: time.Now().Add(time.Hour).UnixMilli(),
		Players:  []ArenaPlayerSnapshot{{Sub: "id-dup", Score: 1}, {Sub: "id-dup-2", Score: 1}},
	}})

	a1 := dialAccount(t, srv.URL, "dup-tab1", "id-dup", 1500)
	defer a1.CloseNow()
	a2 := dialAccount(t, srv.URL, "dup-tab2", "id-dup", 1500)
	defer a2.CloseNow()
	readType(t, a1, "hello")
	readType(t, a2, "hello")

	joinArenaEventually(t, a1, arenaID)
	readType(t, a1, "arenaWaiting")

	send(t, a2, map[string]any{"type": "joinArena", "tournamentId": arenaID})
	if msg := readType(t, a2, "error"); msg["message"] == nil {
		t.Error("expected an error joining the same arena from a second connection on the same identity")
	}
}

// --- WS-integration: return-to-pool after a game, avoiding an immediate rematch ---

func TestArenaReturnToPoolAvoidsRematch(t *testing.T) {
	h := New(testSecret)
	go h.Run()
	srv := httptest.NewServer(http.HandlerFunc(h.ServeWS))
	defer srv.Close()

	var mu sync.Mutex
	var reports []FinishedGame
	h.OnFinish(func(g FinishedGame) {
		mu.Lock()
		reports = append(reports, g)
		mu.Unlock()
	})

	const arenaID = "ARENA-R"
	h.SetArenaSnapshots([]ArenaSnapshot{{
		ID: arenaID, Pool: "3+0", Variant: "standard", Rated: true,
		EndsAtMs: time.Now().Add(time.Hour).UnixMilli(),
		Players: []ArenaPlayerSnapshot{
			{Sub: "id-r-alice", Score: 10},
			{Sub: "id-r-bob", Score: 10},
			{Sub: "id-r-carol", Score: 500}, // far in score — must still be preferred over a rematch
		},
	}})

	alice := dialAccount(t, srv.URL, "alice", "id-r-alice", 1500)
	defer alice.CloseNow()
	bob := dialAccount(t, srv.URL, "bob", "id-r-bob", 1500)
	defer bob.CloseNow()
	carol := dialAccount(t, srv.URL, "carol", "id-r-carol", 1500)
	defer carol.CloseNow()
	readType(t, alice, "hello")
	readType(t, bob, "hello")
	readType(t, carol, "hello")

	joinArenaEventually(t, alice, arenaID)
	readType(t, alice, "arenaWaiting")

	send(t, bob, map[string]any{"type": "joinArena", "tournamentId": arenaID})
	readType(t, bob, "arenaJoined")
	ma := readType(t, alice, "matched")
	mb := readType(t, bob, "matched")
	if ma["tournamentId"] != arenaID || mb["tournamentId"] != arenaID {
		t.Fatalf("matched missing tournamentId: alice=%v bob=%v", ma["tournamentId"], mb["tournamentId"])
	}

	white, black := alice, bob
	if ma["color"] == "b" {
		white, black = bob, alice
	}

	// Carol joins while alice/bob are mid-game — nobody free to pair her with yet.
	send(t, carol, map[string]any{"type": "joinArena", "tournamentId": arenaID})
	readType(t, carol, "arenaJoined")
	readType(t, carol, "arenaWaiting")

	send(t, white, map[string]any{"type": "resign"})
	readType(t, white, "end")
	readType(t, black, "end")

	mu.Lock()
	if len(reports) != 1 || reports[0].TournamentID != arenaID {
		t.Errorf("finished report = %+v, want exactly one with TournamentID=%s", reports, arenaID)
	}
	mu.Unlock()

	// Both alice and bob return to the pool automatically; carol is also free,
	// so pairing must favor a NON-repeat pair (white-carol) over an immediate
	// alice-bob rematch, even though alice/bob's score gap is far closer.
	m1 := readType(t, carol, "matched")
	m2 := readType(t, white, "matched")
	if m1["tournamentId"] != arenaID || m2["tournamentId"] != arenaID {
		t.Errorf("re-pairing missing tournamentId: carol=%v white=%v", m1["tournamentId"], m2["tournamentId"])
	}
	// black is left waiting rather than immediately rematched with white.
	readType(t, black, "arenaWaiting")
}

// --- WS-integration: drain on arena end ---

func TestArenaDrainWhenGoneFromFeed(t *testing.T) {
	h := New(testSecret)
	go h.Run()
	srv := httptest.NewServer(http.HandlerFunc(h.ServeWS))
	defer srv.Close()

	const arenaID = "ARENA-END"
	h.SetArenaSnapshots([]ArenaSnapshot{{
		ID: arenaID, Pool: "3+0", Variant: "standard",
		EndsAtMs: time.Now().Add(time.Hour).UnixMilli(),
		Players:  []ArenaPlayerSnapshot{{Sub: "id-solo", Score: 1}},
	}})

	solo := dialAccount(t, srv.URL, "solo", "id-solo", 1500)
	defer solo.CloseNow()
	readType(t, solo, "hello")
	joinArenaEventually(t, solo, arenaID)
	readType(t, solo, "arenaWaiting")

	// The next poll no longer lists it at all — as if it ended/was removed.
	h.SetArenaSnapshots([]ArenaSnapshot{})
	if msg := readType(t, solo, "arenaLeft"); msg["tournamentId"] != arenaID {
		t.Errorf("arenaLeft tournamentId = %v, want %v", msg["tournamentId"], arenaID)
	}

	// It's really gone — rejoining fails.
	send(t, solo, map[string]any{"type": "joinArena", "tournamentId": arenaID})
	if msg := readType(t, solo, "error"); msg["message"] == nil {
		t.Error("expected an error joining a no-longer-running arena")
	}
}

func TestArenaDrainWhenEndsAtMsPasses(t *testing.T) {
	h := New(testSecret)
	go h.Run()
	srv := httptest.NewServer(http.HandlerFunc(h.ServeWS))
	defer srv.Close()

	const arenaID = "ARENA-EXPIRE"
	h.SetArenaSnapshots([]ArenaSnapshot{{
		ID: arenaID, Pool: "3+0", Variant: "standard",
		EndsAtMs: time.Now().Add(300 * time.Millisecond).UnixMilli(),
		Players:  []ArenaPlayerSnapshot{{Sub: "id-solo2", Score: 1}},
	}})

	solo := dialAccount(t, srv.URL, "solo2", "id-solo2", 1500)
	defer solo.CloseNow()
	readType(t, solo, "hello")
	joinArenaEventually(t, solo, arenaID)
	readType(t, solo, "arenaWaiting")

	// Nobody re-polls; the hub's own ticker (checkArenas) notices endsAtMs has
	// passed and reaps it without waiting for the next fetch to say so.
	if msg := readType(t, solo, "arenaLeft"); msg["tournamentId"] != arenaID {
		t.Errorf("arenaLeft tournamentId = %v, want %v", msg["tournamentId"], arenaID)
	}
}
