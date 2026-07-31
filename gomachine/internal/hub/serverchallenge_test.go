package hub

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestRegisterServerChallengeValidation(t *testing.T) {
	h := New(testSecret)
	go h.Run()
	srv := httptest.NewServer(http.HandlerFunc(h.ServeWS))
	defer srv.Close()

	base := ServerChallengeRequest{
		Code: "SRV001", Pool: "5+0", Color: "w", Rated: true,
		Variant: "standard", CreatorSub: "id-alice", OpponentSub: "id-bob",
	}

	if err := h.RegisterServerChallenge(base); err != nil {
		t.Fatalf("valid registration rejected: %v", err)
	}
	// Same code again — already registered.
	if err := h.RegisterServerChallenge(base); err == nil {
		t.Error("expected error re-registering the same code")
	}

	badPool := base
	badPool.Code, badPool.Pool = "SRV002", "not-a-pool"
	if err := h.RegisterServerChallenge(badPool); err == nil {
		t.Error("expected error for invalid pool")
	}

	sameSub := base
	sameSub.Code, sameSub.OpponentSub = "SRV003", sameSub.CreatorSub
	if err := h.RegisterServerChallenge(sameSub); err == nil {
		t.Error("expected error when creatorSub == opponentSub")
	}

	missingSub := base
	missingSub.Code, missingSub.OpponentSub = "SRV004", ""
	if err := h.RegisterServerChallenge(missingSub); err == nil {
		t.Error("expected error for missing opponentSub")
	}

	noCode := base
	noCode.Code = ""
	if err := h.RegisterServerChallenge(noCode); err == nil {
		t.Error("expected error for empty code")
	}

	// A custom FEN paired with chess960 is rejected — its own random start
	// always wins, so the combination doesn't make sense.
	chess960WithFen := base
	chess960WithFen.Code, chess960WithFen.Variant, chess960WithFen.FEN =
		"SRV005", "chess960", "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
	if err := h.RegisterServerChallenge(chess960WithFen); err == nil {
		t.Error("expected error combining a custom FEN with chess960")
	}

	badFen := base
	badFen.Code, badFen.FEN = "SRV006", "not a real fen"
	if err := h.RegisterServerChallenge(badFen); err == nil {
		t.Error("expected error for an unparseable custom FEN")
	}
}

func TestServerChallengeWrongUserRejected(t *testing.T) {
	h := New(testSecret)
	go h.Run()
	srv := httptest.NewServer(http.HandlerFunc(h.ServeWS))
	defer srv.Close()

	if err := h.RegisterServerChallenge(ServerChallengeRequest{
		Code: "WRONG1", Pool: "5+0", Color: "w", Rated: true,
		Variant: "standard", CreatorSub: "id-alice", OpponentSub: "id-bob",
	}); err != nil {
		t.Fatalf("register: %v", err)
	}

	eve := dialAccount(t, srv.URL, "eve", "id-eve", 1500)
	defer eve.CloseNow()
	readType(t, eve, "hello")

	send(t, eve, map[string]any{"type": "joinChallenge", "code": "WRONG1"})
	if msg := readType(t, eve, "error"); msg["message"] == nil {
		t.Error("expected an error joining a server challenge that isn't yours")
	}

	// The challenge must still be intact and joinable by the actual two subs.
	alice := dialAccount(t, srv.URL, "alice", "id-alice", 1500)
	defer alice.CloseNow()
	readType(t, alice, "hello")
	send(t, alice, map[string]any{"type": "joinChallenge", "code": "WRONG1"})
	readType(t, alice, "challengeWaiting")
}

// TestServerChallengeBothArrivalOrders registers two identical challenges (one
// per sub-test) and checks that the creatorSub side always ends up with the
// registered color, regardless of which of the two named players happens to
// connect and join first.
func TestServerChallengeBothArrivalOrders(t *testing.T) {
	h := New(testSecret)
	go h.Run()
	srv := httptest.NewServer(http.HandlerFunc(h.ServeWS))
	defer srv.Close()

	t.Run("creator arrives first", func(t *testing.T) {
		if err := h.RegisterServerChallenge(ServerChallengeRequest{
			Code: "ORDER1", Pool: "5+0", Color: "w", Rated: true,
			Variant: "standard", CreatorSub: "id-alice", OpponentSub: "id-bob",
		}); err != nil {
			t.Fatalf("register: %v", err)
		}
		alice := dialAccount(t, srv.URL, "alice", "id-alice", 1500)
		defer alice.CloseNow()
		bob := dialAccount(t, srv.URL, "bob", "id-bob", 1500)
		defer bob.CloseNow()
		readType(t, alice, "hello")
		readType(t, bob, "hello")

		send(t, alice, map[string]any{"type": "joinChallenge", "code": "ORDER1"})
		waiting := readType(t, alice, "challengeWaiting")
		if waiting["code"] != "ORDER1" {
			t.Errorf("challengeWaiting code = %v", waiting["code"])
		}

		send(t, bob, map[string]any{"type": "joinChallenge", "code": "ORDER1"})
		ma := readType(t, alice, "matched")
		mb := readType(t, bob, "matched")
		if ma["color"] != "w" {
			t.Errorf("creatorSub (alice) color = %v, want w", ma["color"])
		}
		if mb["color"] != "b" {
			t.Errorf("opponentSub (bob) color = %v, want b", mb["color"])
		}
		if ma["rated"] != true || mb["rated"] != true {
			t.Errorf("rated = %v/%v, want true/true", ma["rated"], mb["rated"])
		}
	})

	t.Run("opponent arrives first", func(t *testing.T) {
		if err := h.RegisterServerChallenge(ServerChallengeRequest{
			Code: "ORDER2", Pool: "5+0", Color: "w", Rated: true,
			Variant: "standard", CreatorSub: "id-alice2", OpponentSub: "id-bob2",
		}); err != nil {
			t.Fatalf("register: %v", err)
		}
		alice := dialAccount(t, srv.URL, "alice2", "id-alice2", 1500)
		defer alice.CloseNow()
		bob := dialAccount(t, srv.URL, "bob2", "id-bob2", 1500)
		defer bob.CloseNow()
		readType(t, alice, "hello")
		readType(t, bob, "hello")

		// Bob (the opponentSub) joins FIRST this time and parks.
		send(t, bob, map[string]any{"type": "joinChallenge", "code": "ORDER2"})
		readType(t, bob, "challengeWaiting")

		send(t, alice, map[string]any{"type": "joinChallenge", "code": "ORDER2"})
		ma := readType(t, alice, "matched")
		mb := readType(t, bob, "matched")
		// Color is still relative to creatorSub (alice), regardless of who parked first.
		if ma["color"] != "w" {
			t.Errorf("creatorSub (alice) color = %v, want w", ma["color"])
		}
		if mb["color"] != "b" {
			t.Errorf("opponentSub (bob) color = %v, want b", mb["color"])
		}
	})
}

func TestServerChallengeNoSelfPairing(t *testing.T) {
	h := New(testSecret)
	go h.Run()
	srv := httptest.NewServer(http.HandlerFunc(h.ServeWS))
	defer srv.Close()

	if err := h.RegisterServerChallenge(ServerChallengeRequest{
		Code: "SELF1", Pool: "5+0", Color: "random",
		Variant: "standard", CreatorSub: "id-alice", OpponentSub: "id-bob",
	}); err != nil {
		t.Fatalf("register: %v", err)
	}

	a1 := dialAccount(t, srv.URL, "alice-tab1", "id-alice", 1500)
	defer a1.CloseNow()
	a2 := dialAccount(t, srv.URL, "alice-tab2", "id-alice", 1500)
	defer a2.CloseNow()
	readType(t, a1, "hello")
	readType(t, a2, "hello")

	send(t, a1, map[string]any{"type": "joinChallenge", "code": "SELF1"})
	readType(t, a1, "challengeWaiting")

	// A second connection on the SAME identity must not pair with the parked
	// first one — that would be alice playing herself.
	send(t, a2, map[string]any{"type": "joinChallenge", "code": "SELF1"})
	if msg := readType(t, a2, "error"); msg["message"] == nil {
		t.Error("expected an error — a client cannot pair with its own identity")
	}
}

func TestServerChallengeExpiry(t *testing.T) {
	h := New(testSecret)
	go h.Run()
	srv := httptest.NewServer(http.HandlerFunc(h.ServeWS))
	defer srv.Close()

	if err := h.RegisterServerChallenge(ServerChallengeRequest{
		Code: "EXP1", Pool: "5+0", Color: "w",
		Variant: "standard", CreatorSub: "id-alice", OpponentSub: "id-bob",
		TTL: 30 * time.Millisecond,
	}); err != nil {
		t.Fatalf("register: %v", err)
	}
	time.Sleep(100 * time.Millisecond)

	alice := dialAccount(t, srv.URL, "alice", "id-alice", 1500)
	defer alice.CloseNow()
	readType(t, alice, "hello")

	send(t, alice, map[string]any{"type": "joinChallenge", "code": "EXP1"})
	if msg := readType(t, alice, "error"); msg["message"] == nil {
		t.Error("expected an error joining an expired server challenge")
	}
}

func TestServerChallengeCustomFENForcesCasual(t *testing.T) {
	h := New(testSecret)
	go h.Run()
	srv := httptest.NewServer(http.HandlerFunc(h.ServeWS))
	defer srv.Close()

	fen := "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3"
	if err := h.RegisterServerChallenge(ServerChallengeRequest{
		Code: "FEN1", Pool: "5+0", Color: "w", Rated: true,
		Variant: "standard", FEN: fen, CreatorSub: "id-alice", OpponentSub: "id-bob",
	}); err != nil {
		t.Fatalf("register: %v", err)
	}

	alice := dialAccount(t, srv.URL, "alice", "id-alice", 1500)
	defer alice.CloseNow()
	bob := dialAccount(t, srv.URL, "bob", "id-bob", 1500)
	defer bob.CloseNow()
	readType(t, alice, "hello")
	readType(t, bob, "hello")

	send(t, alice, map[string]any{"type": "joinChallenge", "code": "FEN1"})
	readType(t, alice, "challengeWaiting")
	send(t, bob, map[string]any{"type": "joinChallenge", "code": "FEN1"})
	ma := readType(t, alice, "matched")
	mb := readType(t, bob, "matched")

	// Rated was requested and both are accounts, but a custom start forces casual.
	if ma["rated"] != false || mb["rated"] != false {
		t.Errorf("rated = %v/%v, want false/false (custom FEN forces casual)", ma["rated"], mb["rated"])
	}
	if ma["fen"] != fen {
		t.Errorf("matched fen = %v, want %v", ma["fen"], fen)
	}
}

// TestServerChallengeReconnectReattaches covers the core bug: the parked
// side's socket drops (network blip / backgrounded tab) without ever clearing
// its waiting slot, and the frontend reconnects and replays the same
// joinChallenge. That must re-attach the new connection into the waiting
// seat, not reject it as "already waiting" — the parked identity's OLD
// connection is dead, so it can no longer be "the same live connection".
func TestServerChallengeReconnectReattaches(t *testing.T) {
	h := New(testSecret)
	go h.Run()
	srv := httptest.NewServer(http.HandlerFunc(h.ServeWS))
	defer srv.Close()

	if err := h.RegisterServerChallenge(ServerChallengeRequest{
		Code: "RECON1", Pool: "5+0", Color: "w", Rated: true,
		Variant: "standard", CreatorSub: "id-alice", OpponentSub: "id-bob",
	}); err != nil {
		t.Fatalf("register: %v", err)
	}

	alice1 := dialAccount(t, srv.URL, "alice", "id-alice", 1500)
	readType(t, alice1, "hello")
	send(t, alice1, map[string]any{"type": "joinChallenge", "code": "RECON1"})
	readType(t, alice1, "challengeWaiting")

	// Alice's tab dies without ever telling the challenge it's leaving.
	alice1.CloseNow()
	time.Sleep(60 * time.Millisecond) // let handleDisconnect process the drop

	// She reconnects and the frontend replays the same join.
	alice2 := dialAccount(t, srv.URL, "alice", "id-alice", 1500)
	defer alice2.CloseNow()
	readType(t, alice2, "hello")
	send(t, alice2, map[string]any{"type": "joinChallenge", "code": "RECON1"})
	readType(t, alice2, "challengeWaiting") // re-attached, not rejected

	// Proof the waiting slot really moved to alice2 (not just an isolated
	// "you're fine" reply): alice2 is now the live parked connection, so a
	// second join from IT is rejected exactly like the pre-existing
	// same-live-connection case.
	send(t, alice2, map[string]any{"type": "joinChallenge", "code": "RECON1"})
	if msg := readType(t, alice2, "error"); msg["message"] == nil {
		t.Error("expected an error re-joining while alice2 itself is the live parked connection")
	}
}

// TestServerChallengeLiveSecondTabStillRejected makes sure the reattach fix
// above didn't loosen the self-pairing guard: while the parked connection is
// still genuinely live, a second connection for the same identity must still
// be rejected outright.
func TestServerChallengeLiveSecondTabStillRejected(t *testing.T) {
	h := New(testSecret)
	go h.Run()
	srv := httptest.NewServer(http.HandlerFunc(h.ServeWS))
	defer srv.Close()

	if err := h.RegisterServerChallenge(ServerChallengeRequest{
		Code: "LIVE1", Pool: "5+0", Color: "w", Rated: true,
		Variant: "standard", CreatorSub: "id-alice", OpponentSub: "id-bob",
	}); err != nil {
		t.Fatalf("register: %v", err)
	}

	alice1 := dialAccount(t, srv.URL, "alice-tab1", "id-alice", 1500)
	defer alice1.CloseNow()
	alice2 := dialAccount(t, srv.URL, "alice-tab2", "id-alice", 1500)
	defer alice2.CloseNow()
	readType(t, alice1, "hello")
	readType(t, alice2, "hello")

	send(t, alice1, map[string]any{"type": "joinChallenge", "code": "LIVE1"})
	readType(t, alice1, "challengeWaiting")

	// alice1 is still open (never closed) — a second tab must be rejected.
	send(t, alice2, map[string]any{"type": "joinChallenge", "code": "LIVE1"})
	if msg := readType(t, alice2, "error"); msg["message"] == nil {
		t.Error("expected an error — the parked connection is still live")
	}

	// The waiting slot must still belong to alice1: bob joining now pairs
	// against it, proving it was never displaced by alice2's rejected join.
	bob := dialAccount(t, srv.URL, "bob", "id-bob", 1500)
	defer bob.CloseNow()
	readType(t, bob, "hello")
	send(t, bob, map[string]any{"type": "joinChallenge", "code": "LIVE1"})
	ma := readType(t, alice1, "matched")
	mb := readType(t, bob, "matched")
	if ma["color"] != "w" || mb["color"] != "b" {
		t.Errorf("colors = %v/%v, want w/b", ma["color"], mb["color"])
	}
}

// TestServerChallengeReattachThenPair proves the reattach isn't just cosmetic:
// after the parked side's dead connection is replaced, the OTHER named player
// joining still pairs correctly (and pairs with the NEW connection, not the
// dead one).
func TestServerChallengeReattachThenPair(t *testing.T) {
	h := New(testSecret)
	go h.Run()
	srv := httptest.NewServer(http.HandlerFunc(h.ServeWS))
	defer srv.Close()

	if err := h.RegisterServerChallenge(ServerChallengeRequest{
		Code: "PAIR1", Pool: "5+0", Color: "w", Rated: true,
		Variant: "standard", CreatorSub: "id-alice", OpponentSub: "id-bob",
	}); err != nil {
		t.Fatalf("register: %v", err)
	}

	alice1 := dialAccount(t, srv.URL, "alice", "id-alice", 1500)
	readType(t, alice1, "hello")
	send(t, alice1, map[string]any{"type": "joinChallenge", "code": "PAIR1"})
	readType(t, alice1, "challengeWaiting")

	alice1.CloseNow()
	time.Sleep(60 * time.Millisecond)

	alice2 := dialAccount(t, srv.URL, "alice", "id-alice", 1500)
	defer alice2.CloseNow()
	readType(t, alice2, "hello")
	send(t, alice2, map[string]any{"type": "joinChallenge", "code": "PAIR1"})
	readType(t, alice2, "challengeWaiting")

	bob := dialAccount(t, srv.URL, "bob", "id-bob", 1500)
	defer bob.CloseNow()
	readType(t, bob, "hello")
	send(t, bob, map[string]any{"type": "joinChallenge", "code": "PAIR1"})

	ma := readType(t, alice2, "matched")
	mb := readType(t, bob, "matched")
	if ma["color"] != "w" {
		t.Errorf("creatorSub (alice, reattached) color = %v, want w", ma["color"])
	}
	if mb["color"] != "b" {
		t.Errorf("opponentSub (bob) color = %v, want b", mb["color"])
	}
	if _, exists := h.challenges["PAIR1"]; exists {
		t.Error("challenge should be removed once the game starts")
	}
}

func TestOnline(t *testing.T) {
	h := New(testSecret)
	go h.Run()
	srv := httptest.NewServer(http.HandlerFunc(h.ServeWS))
	defer srv.Close()

	a := dialAs(t, srv.URL, "a", "id-a")
	defer a.CloseNow()
	b := dialAs(t, srv.URL, "b", "id-b")
	defer b.CloseNow()
	readType(t, a, "hello")
	readType(t, b, "hello")

	// Give the hub's register channel a moment to seat both connections.
	deadline := time.Now().Add(2 * time.Second)
	var online []string
	for time.Now().Before(deadline) {
		online = h.Online([]string{"id-a", "id-b", "id-nobody"})
		if len(online) == 2 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if len(online) != 2 {
		t.Fatalf("Online = %v, want exactly id-a and id-b", online)
	}
	seen := map[string]bool{}
	for _, s := range online {
		seen[s] = true
	}
	if !seen["id-a"] || !seen["id-b"] {
		t.Errorf("Online = %v, want id-a and id-b present", online)
	}
	if seen["id-nobody"] {
		t.Errorf("Online = %v, want id-nobody absent", online)
	}
}

func TestOnlineCapsInputSize(t *testing.T) {
	h := New(testSecret)
	go h.Run()
	srv := httptest.NewServer(http.HandlerFunc(h.ServeWS))
	defer srv.Close()

	subs := make([]string, 250)
	for i := range subs {
		subs[i] = "sub-nobody"
	}
	online := h.Online(subs) // must not hang or panic on an oversized list
	if len(online) != 0 {
		t.Errorf("Online(oversized, all disconnected) = %v, want empty", online)
	}
}
