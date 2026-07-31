package hub

import (
	"context"
	"net/http"
	"net/http/httptest"
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

	baseSnapshot := []ArenaSnapshot{{
		ID: arenaID, Pool: "3+0", Variant: "standard", Rated: true,
		EndsAtMs: time.Now().Add(time.Hour).UnixMilli(),
		Players: []ArenaPlayerSnapshot{
			{Sub: "id-carol", Score: 5},
			{Sub: "id-dave", Score: 5, Withdrawn: true},
		},
	}}

	// setup registers one arena with a valid participant (id-carol), a
	// withdrawn one (id-dave), and syncs on carol's join (SetArenaSnapshots is
	// delivered asynchronously) before handing control to the sub-test, then
	// has carol leave so she doesn't occupy the pool for the real assertion.
	// Returns the Hub too, so a sub-test can re-deliver snapshots itself (e.g.
	// to exhaust a pending join's grace period).
	setup := func(t *testing.T) (*Hub, string) {
		t.Helper()
		h := New(testSecret)
		go h.Run()
		srv := httptest.NewServer(http.HandlerFunc(h.ServeWS))
		t.Cleanup(srv.Close)
		h.SetArenaSnapshots(baseSnapshot)
		canary := dialAccount(t, srv.URL, "carol", "id-carol", 1500)
		readType(t, canary, "hello")
		joinArenaEventually(t, canary, arenaID)
		send(t, canary, map[string]any{"type": "leaveArena"})
		readType(t, canary, "arenaLeft")
		canary.CloseNow()
		return h, srv.URL
	}

	t.Run("anonymous client rejected", func(t *testing.T) {
		_, url := setup(t)
		c := dial(t, url, "anon")
		defer c.CloseNow()
		readType(t, c, "hello")
		send(t, c, map[string]any{"type": "joinArena", "tournamentId": arenaID})
		if msg := readType(t, c, "error"); msg["message"] == nil {
			t.Error("expected an error for an anonymous client")
		}
	})

	t.Run("spectator rejected", func(t *testing.T) {
		_, url := setup(t)
		c := dialSpectate(t, url)
		defer c.CloseNow()
		readType(t, c, "hello")
		send(t, c, map[string]any{"type": "joinArena", "tournamentId": arenaID})
		if msg := readType(t, c, "error"); msg["message"] == nil {
			t.Error("expected an error for a spectator")
		}
	})

	t.Run("non-participant parks pending then rejected after the grace period", func(t *testing.T) {
		h, url := setup(t)
		c := dialAccount(t, url, "eve", "id-eve", 1500) // a real account, just not entered
		defer c.CloseNow()
		readType(t, c, "hello")
		send(t, c, map[string]any{"type": "joinArena", "tournamentId": arenaID})
		// The hub can't yet tell "genuinely not a participant" apart from "the
		// roster just hasn't caught up" — see arena.go's pending doc — so it
		// parks pending and acks exactly like an ordinary join, instead of
		// rejecting outright.
		if msg := readType(t, c, "arenaJoined"); msg["tournamentId"] != arenaID {
			t.Fatalf("arenaJoined tournamentId = %v, want %v", msg["tournamentId"], arenaID)
		}
		// Re-deliver the SAME roster (still no eve) enough times to exhaust
		// arenaPendingGraceCycles — only then does it learn the truth.
		for range arenaPendingGraceCycles {
			h.SetArenaSnapshots(baseSnapshot)
			time.Sleep(20 * time.Millisecond) // let the Run goroutine drain it before the next one supersedes
		}
		if msg := readType(t, c, "error"); msg["message"] == nil {
			t.Error("expected an error for a sub that isn't a participant, after the grace period")
		}
	})

	t.Run("withdrawn participant rejected", func(t *testing.T) {
		_, url := setup(t)
		c := dialAccount(t, url, "dave", "id-dave", 1500)
		defer c.CloseNow()
		readType(t, c, "hello")
		send(t, c, map[string]any{"type": "joinArena", "tournamentId": arenaID})
		if msg := readType(t, c, "error"); msg["message"] == nil {
			t.Error("expected an error for a withdrawn participant")
		}
	})

	t.Run("unknown tournament id rejected", func(t *testing.T) {
		_, url := setup(t)
		c := dialAccount(t, url, "carol", "id-carol", 1500) // valid participant, wrong id
		defer c.CloseNow()
		readType(t, c, "hello")
		send(t, c, map[string]any{"type": "joinArena", "tournamentId": "NOT-REAL"})
		if msg := readType(t, c, "error"); msg["message"] == nil {
			t.Error("expected an error for an unknown/not-running tournament id")
		}
	})

	t.Run("valid participant joins and waits alone", func(t *testing.T) {
		_, url := setup(t)
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

// TestArenaPendingJoinAdmittedOnConfirmation is the actual bug fix: a
// joinArena that arrives before the hub's roster knows the joiner must park
// pending (not hard-reject), and get admitted into the pool — and paired —
// the moment a later snapshot confirms them.
func TestArenaPendingJoinAdmittedOnConfirmation(t *testing.T) {
	h := New(testSecret)
	go h.Run()
	srv := httptest.NewServer(http.HandlerFunc(h.ServeWS))
	defer srv.Close()

	const arenaID = "ARENA-PEND"
	// The arena exists and already has one participant (bob), but the
	// snapshot doesn't know about alice yet — exactly the REST-join/poll race
	// from production: alice's join already landed in BaseAPI, the hub just
	// hasn't polled it yet.
	h.SetArenaSnapshots([]ArenaSnapshot{{
		ID: arenaID, Pool: "3+0", Variant: "standard", Rated: true,
		EndsAtMs: time.Now().Add(time.Hour).UnixMilli(),
		Players:  []ArenaPlayerSnapshot{{Sub: "id-pend-bob", Score: 5}},
	}})

	bob := dialAccount(t, srv.URL, "bob", "id-pend-bob", 1500)
	defer bob.CloseNow()
	readType(t, bob, "hello")
	joinArenaEventually(t, bob, arenaID)
	readType(t, bob, "arenaWaiting")

	alice := dialAccount(t, srv.URL, "alice", "id-pend-alice", 1500)
	defer alice.CloseNow()
	readType(t, alice, "hello")
	send(t, alice, map[string]any{"type": "joinArena", "tournamentId": arenaID})
	// Parked pending, not rejected — she still gets the ordinary ack.
	if msg := readType(t, alice, "arenaJoined"); msg["tournamentId"] != arenaID {
		t.Fatalf("arenaJoined tournamentId = %v, want %v", msg["tournamentId"], arenaID)
	}

	// The next poll confirms her — she must be admitted into the pool and,
	// since bob is free too, paired immediately.
	h.SetArenaSnapshots([]ArenaSnapshot{{
		ID: arenaID, Pool: "3+0", Variant: "standard", Rated: true,
		EndsAtMs: time.Now().Add(time.Hour).UnixMilli(),
		Players: []ArenaPlayerSnapshot{
			{Sub: "id-pend-bob", Score: 5},
			{Sub: "id-pend-alice", Score: 5},
		},
	}})

	ma := readType(t, alice, "matched")
	mb := readType(t, bob, "matched")
	if ma["tournamentId"] != arenaID || mb["tournamentId"] != arenaID {
		t.Errorf("matched missing tournamentId: alice=%v bob=%v", ma["tournamentId"], mb["tournamentId"])
	}
}

// TestArenaPendingJoinCleanedUpOnDisconnect guards against a leaked pending
// entry: a connection that disconnects (or explicitly leaves) while still
// pending must be dropped from arenaState.pending, never later admitted as a
// stale *Client.
func TestArenaPendingJoinCleanedUpOnDisconnect(t *testing.T) {
	h := New(testSecret)
	go h.Run()
	srv := httptest.NewServer(http.HandlerFunc(h.ServeWS))
	defer srv.Close()

	const arenaID = "ARENA-PEND-DC"
	snap := []ArenaSnapshot{{
		ID: arenaID, Pool: "3+0", Variant: "standard", Rated: true,
		EndsAtMs: time.Now().Add(time.Hour).UnixMilli(),
		Players:  []ArenaPlayerSnapshot{{Sub: "id-pdc-anchor", Score: 5}},
	}}
	h.SetArenaSnapshots(snap)

	anchor := dialAccount(t, srv.URL, "anchor", "id-pdc-anchor", 1500)
	defer anchor.CloseNow()
	readType(t, anchor, "hello")
	joinArenaEventually(t, anchor, arenaID)
	readType(t, anchor, "arenaWaiting")
	send(t, anchor, map[string]any{"type": "leaveArena"})
	readType(t, anchor, "arenaLeft")

	// gone joins pending (not yet on the roster), then disconnects outright.
	gone := dialAccount(t, srv.URL, "gone", "id-pdc-gone", 1500)
	readType(t, gone, "hello")
	send(t, gone, map[string]any{"type": "joinArena", "tournamentId": arenaID})
	readType(t, gone, "arenaJoined")
	gone.CloseNow()

	// staying joins pending too, then explicitly leaves instead of disconnecting.
	staying := dialAccount(t, srv.URL, "staying", "id-pdc-staying", 1500)
	defer staying.CloseNow()
	readType(t, staying, "hello")
	send(t, staying, map[string]any{"type": "joinArena", "tournamentId": arenaID})
	readType(t, staying, "arenaJoined")
	send(t, staying, map[string]any{"type": "leaveArena"})
	readType(t, staying, "arenaLeft")

	// Give the disconnect a moment to reach the Run goroutine, then confirm
	// BOTH subs on the very next snapshot — if either pending entry leaked,
	// this would try to admit/send to a stale or already-torn-down *Client.
	time.Sleep(100 * time.Millisecond)
	h.SetArenaSnapshots([]ArenaSnapshot{{
		ID: arenaID, Pool: "3+0", Variant: "standard", Rated: true,
		EndsAtMs: time.Now().Add(time.Hour).UnixMilli(),
		Players: []ArenaPlayerSnapshot{
			{Sub: "id-pdc-anchor", Score: 5},
			{Sub: "id-pdc-gone", Score: 5},
			{Sub: "id-pdc-staying", Score: 5},
		},
	}})

	// A fresh connection for either identity must be free to join again — were
	// the old pending entry still parked, this joinArena would hit the
	// "already waiting on another connection" guard instead.
	goneAgain := dialAccount(t, srv.URL, "gone-again", "id-pdc-gone", 1500)
	defer goneAgain.CloseNow()
	readType(t, goneAgain, "hello")
	joinArenaEventually(t, goneAgain, arenaID)
	readType(t, goneAgain, "arenaWaiting")
	// Step out of the way again so stayingAgain also waits alone below — same
	// score would otherwise pair the two of them immediately, which is a fine
	// outcome too but would muddy this assertion.
	send(t, goneAgain, map[string]any{"type": "leaveArena"})
	readType(t, goneAgain, "arenaLeft")

	stayingAgain := dialAccount(t, srv.URL, "staying-again", "id-pdc-staying", 1500)
	defer stayingAgain.CloseNow()
	readType(t, stayingAgain, "hello")
	joinArenaEventually(t, stayingAgain, arenaID)
	readType(t, stayingAgain, "arenaWaiting")
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

// TestArenaGameEndLeavesHumanOutOfPoolButStillParticipant is the core of the
// Lichess-style change: a human's arena game ending must NOT put them back in
// ar.free (only a fresh joinArena does that now — see returnToArenaPool), it
// must tell them so with the NEW arenaGameEnded message (not arenaLeft — see
// that function's doc for why the two must stay distinct), and it must never
// touch their roster row (ar.players) — that's the standings source of
// truth, and BaseAPI's alone to change.
func TestArenaGameEndLeavesHumanOutOfPoolButStillParticipant(t *testing.T) {
	h := New(testSecret)

	ar := &arenaState{
		id: "ARENA-NOAUTO", pool: "3+0", variant: variantStandard, rated: true,
		players: map[string]*arenaPlayerState{
			"id-alice-na": {score: 10},
			"id-bob-na":   {score: 12},
		},
		lastOpponent: map[string]string{},
		botBusy:      map[string]bool{},
	}
	h.arenas[ar.id] = ar

	alice := mkArenaClient("id-alice-na")
	bob := mkArenaClient("id-bob-na")
	g := h.newArenaGame(ar, newPlayer(alice), newPlayer(bob))
	if g == nil {
		t.Fatal("newArenaGame returned nil")
	}
	alice.game, bob.game = g, g

	h.finish(g, "1-0", "resign")

	for _, c := range []*Client{alice, bob} {
		end := readQueued(t, c) // the ordinary game-end broadcast comes first
		if end["type"] != "end" {
			t.Fatalf("client %s first message = %v, want end", c.id.UserID, end["type"])
		}
		msg := readQueued(t, c)
		if msg["type"] != "arenaGameEnded" {
			t.Errorf("client %s second message = %v, want arenaGameEnded", c.id.UserID, msg["type"])
		}
		if msg["tournamentId"] != ar.id {
			t.Errorf("tournamentId = %v, want %v", msg["tournamentId"], ar.id)
		}
		if c.arenaID != "" {
			t.Errorf("client %s arenaID = %q, want empty", c.id.UserID, c.arenaID)
		}
	}
	if len(ar.free) != 0 {
		t.Errorf("ar.free = %v, want empty — a human must not auto-return", ar.free)
	}
	if ps := ar.players["id-alice-na"]; ps == nil || ps.withdrawn || ps.score != 10 {
		t.Errorf("alice's roster row changed: %+v", ps)
	}
	if ps := ar.players["id-bob-na"]; ps == nil || ps.withdrawn || ps.score != 12 {
		t.Errorf("bob's roster row changed: %+v", ps)
	}
}

// TestArenaRejoinAfterGameEnd confirms the other half of the same story: a
// human left out of the pool by their game ending is still a full participant
// and can ask to be paired again with an ordinary joinArena — exactly what
// the tournament page sends the moment the player navigates back to it.
func TestArenaRejoinAfterGameEnd(t *testing.T) {
	h := New(testSecret)

	ar := &arenaState{
		id: "ARENA-REJOIN", pool: "3+0", variant: variantStandard, rated: true,
		players: map[string]*arenaPlayerState{
			"id-alice-rj": {score: 10},
			"id-bob-rj":   {score: 10},
		},
		lastOpponent: map[string]string{},
		botBusy:      map[string]bool{},
	}
	h.arenas[ar.id] = ar

	alice := mkArenaClient("id-alice-rj")
	bob := mkArenaClient("id-bob-rj")
	g := h.newArenaGame(ar, newPlayer(alice), newPlayer(bob))
	alice.game, bob.game = g, g
	h.finish(g, "1-0", "resign")
	readQueued(t, alice) // end
	readQueued(t, alice) // arenaGameEnded
	readQueued(t, bob)   // end
	readQueued(t, bob)   // arenaGameEnded

	// alice is done reviewing the result and asks to be paired again.
	h.joinArena(alice, ar.id)
	joined := readQueued(t, alice)
	if joined["type"] != "arenaJoined" {
		t.Fatalf("type = %v, want arenaJoined", joined["type"])
	}
	if len(ar.free) != 1 || ar.free[0] != alice {
		t.Fatalf("ar.free = %v, want just alice", ar.free)
	}
	// Nobody else is free (bob hasn't rejoined), so alice just waits.
	waiting := readQueued(t, alice)
	if waiting["type"] != "arenaWaiting" {
		t.Errorf("type = %v, want arenaWaiting", waiting["type"])
	}
}

// TestArenaBotFreedImmediatelyAfterGameEnds covers a human-vs-bot arena game:
// the human is left out of the pool exactly like the human-vs-human case
// above, but the bot side — unlike a human — has no page to go back to, so it
// must be immediately re-pairable the instant the game ends (botBusy
// cleared), keeping the arena busy.
func TestArenaBotFreedImmediatelyAfterGameEnds(t *testing.T) {
	h := New(testSecret)

	ar := &arenaState{
		id: "ARENA-BOTFREE", pool: "3+0", variant: variantStandard, rated: true,
		players: map[string]*arenaPlayerState{
			"id-human-bf2": {score: 10},
			"id-bot-bf2":   {score: 10, bot: true, name: "RookRoamer", rating: 1500},
		},
		lastOpponent: map[string]string{},
		botBusy:      map[string]bool{},
	}
	h.arenas[ar.id] = ar

	human := mkArenaClient("id-human-bf2")
	botIdentity := auth.Identity{UserID: "id-bot-bf2", Name: "RookRoamer", Rating: 1500}
	g := h.newArenaGame(ar, newPlayer(human), newBotPlayer(botIdentity, 1500))
	human.game = g
	ar.botBusy["id-bot-bf2"] = true

	h.finish(g, "0-1", "resign")

	readQueued(t, human) // end
	msg := readQueued(t, human)
	if msg["type"] != "arenaGameEnded" {
		t.Errorf("type = %v, want arenaGameEnded", msg["type"])
	}
	if len(ar.free) != 0 {
		t.Errorf("ar.free = %v, want empty — the human must not auto-return", ar.free)
	}
	if ar.botBusy["id-bot-bf2"] {
		t.Error("the bot's busy marker should have been cleared")
	}
	// Immediately re-pairable: closestIdleArenaBot must find it with no delay
	// or extra step, unlike the human side.
	sub, ok := closestIdleArenaBot(ar, ar.players["id-human-bf2"])
	if !ok || sub != "id-bot-bf2" {
		t.Errorf("closestIdleArenaBot = (%q, %v), want (id-bot-bf2, true)", sub, ok)
	}
}

// TestArenaWithdrawnMidGameCannotRejoin covers a player who withdrew from the
// tournament while their game was still in progress (a fresher roster poll
// landed mid-game, marking ar.players[sub].withdrawn — see
// applyArenaSnapshots' free-pool sweep, which this mirrors for a client that
// wasn't in ar.free because it was mid-game): the game-end message must be
// the real arenaLeft (they're genuinely not coming back), and a subsequent
// joinArena must still be rejected.
func TestArenaWithdrawnMidGameCannotRejoin(t *testing.T) {
	h := New(testSecret)

	ar := &arenaState{
		id: "ARENA-WDMID", pool: "3+0", variant: variantStandard, rated: true,
		players: map[string]*arenaPlayerState{
			"id-wd-mid": {score: 10},
			"id-opp-wd": {score: 10},
		},
		lastOpponent: map[string]string{},
		botBusy:      map[string]bool{},
	}
	h.arenas[ar.id] = ar

	withdrawing := mkArenaClient("id-wd-mid")
	opp := mkArenaClient("id-opp-wd")
	g := h.newArenaGame(ar, newPlayer(withdrawing), newPlayer(opp))
	withdrawing.game, opp.game = g, g

	// The roster catches up mid-game: this sub has withdrawn.
	ar.players["id-wd-mid"].withdrawn = true

	h.finish(g, "0-1", "resign")

	readQueued(t, withdrawing) // end
	msg := readQueued(t, withdrawing)
	if msg["type"] != "arenaLeft" {
		t.Errorf("type = %v, want arenaLeft for a withdrawn participant", msg["type"])
	}
	if len(ar.free) != 0 {
		t.Errorf("ar.free = %v, want empty", ar.free)
	}

	h.joinArena(withdrawing, ar.id)
	rejected := readQueued(t, withdrawing)
	if rejected["type"] != "error" {
		t.Errorf("type = %v, want error", rejected["type"])
	}
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
