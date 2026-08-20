package hub

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"

	"github.com/timanthonyalexander/gomachine/internal/auth"
)

// expectNoMessage asserts nothing arrives on c within the window — used to
// prove a rejected/no-op command (a stale accept, a spectator's offer)
// produced no wire message, rather than just hoping a later assertion would
// have caught it.
func expectNoMessage(t *testing.T, c *websocket.Conn, within time.Duration) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), within)
	defer cancel()
	var m map[string]any
	if err := wsjson.Read(ctx, c, &m); err == nil {
		t.Fatalf("unexpected message: %v", m)
	}
}

// Happy path: after a game ends, either side can offer a rematch; the other
// accepting starts a brand new game with colors swapped and the same pool,
// variant and rated flag as the original.
func TestRematchOfferAcceptSwapsColorsAndKeepsSettings(t *testing.T) {
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

	// Pair via a rated private challenge so the rematch's carried-forward
	// pool/rated flag is unambiguous (public queue pairing here would also
	// work, but the challenge lets us pin the exact settings).
	send(t, a, map[string]any{"type": "createChallenge", "pool": "5+0", "color": "w", "rated": true})
	created := readType(t, a, "challengeCreated")
	code, _ := created["code"].(string)
	send(t, b, map[string]any{"type": "joinChallenge", "code": code})
	ma := readType(t, a, "matched")
	readType(t, b, "matched")
	if ma["color"] != "w" {
		t.Fatalf("setup: alice color = %v, want w", ma["color"])
	}
	firstGameID, _ := ma["gameId"].(string)

	send(t, a, map[string]any{"type": "resign"})
	readType(t, a, "end")
	readType(t, b, "end")

	// Alice (White in game 1) offers a rematch; Bob accepts.
	send(t, a, map[string]any{"type": "rematchOffer"})
	off := readType(t, b, "rematchOffered")
	if off["by"] != "w" {
		t.Errorf("rematchOffered by = %v, want w", off["by"])
	}
	send(t, b, map[string]any{"type": "rematchAccept"})

	ma2 := readType(t, a, "matched")
	mb2 := readType(t, b, "matched")
	if ma2["gameId"] == firstGameID || ma2["gameId"] == "" {
		t.Errorf("rematch gameId = %v, want a fresh id (not %v)", ma2["gameId"], firstGameID)
	}
	if ma2["gameId"] != mb2["gameId"] {
		t.Errorf("players landed in different games: %v vs %v", ma2["gameId"], mb2["gameId"])
	}
	if ma2["color"] != "b" {
		t.Errorf("alice color after rematch = %v, want b (swapped)", ma2["color"])
	}
	if mb2["color"] != "w" {
		t.Errorf("bob color after rematch = %v, want w (swapped)", mb2["color"])
	}
	if ma2["pool"] != "5+0" {
		t.Errorf("pool = %v, want 5+0", ma2["pool"])
	}
	if ma2["variant"] != "standard" {
		t.Errorf("variant = %v, want standard", ma2["variant"])
	}
	if ma2["rated"] != true {
		t.Errorf("rated = %v, want true (carried from original)", ma2["rated"])
	}
	if ma2["rematch"] != true {
		t.Errorf("rematch flag = %v, want true", ma2["rematch"])
	}
}

// Declining a standing offer clears it without starting anything, and leaves
// the game playable to keep offering again (mirrors drawDecline).
func TestRematchDeclineClearsOffer(t *testing.T) {
	h := New(testSecret)
	go h.Run()
	srv := httptest.NewServer(http.HandlerFunc(h.ServeWS))
	defer srv.Close()

	white, black := match(t, srv.URL)
	defer white.CloseNow()
	defer black.CloseNow()

	send(t, white, map[string]any{"type": "resign"})
	readType(t, white, "end")
	readType(t, black, "end")

	send(t, white, map[string]any{"type": "rematchOffer"})
	readType(t, black, "rematchOffered")

	send(t, black, map[string]any{"type": "rematchDecline"})
	dec := readType(t, white, "rematchDeclined")
	if dec["gameId"] == nil {
		t.Error("rematchDeclined missing gameId")
	}

	// The window is still open: a fresh offer still works.
	send(t, black, map[string]any{"type": "rematchOffer"})
	off := readType(t, white, "rematchOffered")
	if off["by"] != "b" {
		t.Errorf("rematchOffered by = %v, want b", off["by"])
	}
}

// Both sides offering (crossed offers, no explicit accept) pairs them
// immediately into a single new game rather than leaving two standing offers.
func TestRematchBothOfferPairsImmediately(t *testing.T) {
	h := New(testSecret)
	go h.Run()
	srv := httptest.NewServer(http.HandlerFunc(h.ServeWS))
	defer srv.Close()

	white, black := match(t, srv.URL)
	defer white.CloseNow()
	defer black.CloseNow()

	send(t, white, map[string]any{"type": "resign"})
	readType(t, white, "end")
	readType(t, black, "end")

	send(t, white, map[string]any{"type": "rematchOffer"})
	readType(t, black, "rematchOffered")

	// Black offers too, instead of accepting — this must pair them directly.
	send(t, black, map[string]any{"type": "rematchOffer"})

	mw := readType(t, white, "matched")
	mb := readType(t, black, "matched")
	if mw["gameId"] != mb["gameId"] {
		t.Errorf("crossed offers created two games: %v vs %v", mw["gameId"], mb["gameId"])
	}
}

// The offerer disconnecting cancels the standing offer so the opponent isn't
// left waiting on an accept that can never come, and a late accept afterward
// is a no-op.
func TestRematchOffererDisconnectCancelsOffer(t *testing.T) {
	h := New(testSecret)
	go h.Run()
	srv := httptest.NewServer(http.HandlerFunc(h.ServeWS))
	defer srv.Close()

	white, black := match(t, srv.URL)
	defer black.CloseNow()

	send(t, white, map[string]any{"type": "resign"})
	readType(t, white, "end")
	readType(t, black, "end")

	send(t, white, map[string]any{"type": "rematchOffer"})
	readType(t, black, "rematchOffered")

	white.CloseNow() // offerer walks away

	dec := readType(t, black, "rematchDeclined")
	if dec["gameId"] == nil {
		t.Error("rematchDeclined missing gameId")
	}

	// A late accept from Black must not start a game.
	send(t, black, map[string]any{"type": "rematchAccept"})
	expectNoMessage(t, black, 300*time.Millisecond)
}

// A spectator never played the game, so it has no finished game of its own to
// rematch from; its offer is silently ignored and doesn't disturb the real
// participants' ability to rematch each other.
func TestRematchSpectatorCannotOffer(t *testing.T) {
	h := New(testSecret)
	go h.Run()
	srv := httptest.NewServer(http.HandlerFunc(h.ServeWS))
	defer srv.Close()

	white, black := match(t, srv.URL)
	defer white.CloseNow()
	defer black.CloseNow()

	send(t, white, map[string]any{"type": "resign"})
	readType(t, white, "end")
	readType(t, black, "end")

	sp := dialSpectate(t, srv.URL)
	defer sp.CloseNow()
	readType(t, sp, "hello")

	send(t, sp, map[string]any{"type": "rematchOffer"})
	expectNoMessage(t, sp, 300*time.Millisecond)

	// The real players can still rematch each other afterward.
	send(t, white, map[string]any{"type": "rematchOffer"})
	off := readType(t, black, "rematchOffered")
	if off["by"] != "w" {
		t.Errorf("rematchOffered by = %v, want w", off["by"])
	}
}

// --- direct/unit-level tests (no live WS loop — same pattern as
// TestDeliverBotChatBroadcastsAsOpponent in botchat_test.go) ---

// recv reads one message off a fake client's send channel, failing the test
// if none arrives in time.
func recv(t *testing.T, ch chan []byte) map[string]any {
	t.Helper()
	select {
	case data := <-ch:
		var m map[string]any
		if err := json.Unmarshal(data, &m); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		return m
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for message")
		return nil
	}
}

// A duplicate rematchAccept (e.g. a double-click racing two commands through
// the hub) must start exactly one game, not two.
func TestRematchDoubleAcceptOnlyStartsOneGame(t *testing.T) {
	h := New(testSecret)
	white, whiteCh := humanPlayerWithSend("alice", 4)
	black, blackCh := humanPlayerWithSend("bob", 4)
	g := newStdGame(t, "gid", white, black)
	g.over = true
	g.tc = timeControl{Base: 180_000, Inc: 2_000}
	g.pool = "3+2"
	h.armRematch(g)

	h.rematchOffer(white.any())
	recv(t, whiteCh) // echo of our own standing offer
	recv(t, blackCh)

	h.rematchAccept(black.any())
	if m := recv(t, whiteCh); m["type"] != "matched" {
		t.Fatalf("type = %v, want matched", m["type"])
	}
	recv(t, blackCh)
	if len(h.games) != 1 {
		t.Fatalf("games after accept = %d, want 1", len(h.games))
	}

	// A second, racing accept must be a no-op: the window already closed.
	h.rematchAccept(black.any())
	select {
	case data := <-whiteCh:
		t.Fatalf("duplicate accept produced another message: %s", data)
	default:
	}
	if len(h.games) != 1 {
		t.Fatalf("games after duplicate accept = %d, want 1", len(h.games))
	}
}

// checkRematches reclaims a rematch window (offer standing or not) once
// rematchTTL has passed, notifying both sides.
func TestRematchOfferExpires(t *testing.T) {
	h := New(testSecret)
	white, whiteCh := humanPlayerWithSend("alice", 4)
	black, blackCh := humanPlayerWithSend("bob", 4)
	g := newStdGame(t, "gid", white, black)
	g.over = true
	h.armRematch(g)

	h.rematchOffer(white.any())
	recv(t, whiteCh)
	recv(t, blackCh)

	// Backdate the window past its TTL instead of sleeping for real.
	g.rematchArmedAt = time.Now().Add(-rematchTTL - time.Second)
	h.checkRematches()

	if m := recv(t, whiteCh); m["type"] != "rematchExpired" {
		t.Errorf("type = %v, want rematchExpired", m["type"])
	}
	if m := recv(t, blackCh); m["type"] != "rematchExpired" {
		t.Errorf("type = %v, want rematchExpired", m["type"])
	}
	if white.any().lastGame != nil || black.any().lastGame != nil {
		t.Error("lastGame still set after the rematch window expired")
	}
	if _, ok := h.rematchWindows[g.id]; ok {
		t.Error("rematchWindows still holds an expired game")
	}

	// The window is closed: a late offer must be a no-op.
	h.rematchOffer(white.any())
	select {
	case data := <-whiteCh:
		t.Fatalf("offer after expiry produced a message: %s", data)
	default:
	}
}

// --- bot rematch tests ------------------------------------------------------
//
// A fill-in bot opponent has no *Client, so it can never call rematchOffer/
// rematchAccept/rematchDecline itself — every one of these drives the human
// side's command and lets the hub answer on the bot's behalf, the same shape
// as botoffers_test.go drives checkBotTakebacks/checkBotDraws.

// botPlayerRematch builds a bot side with every disposition set to a distinct,
// checkable value, so a test can assert newBotPlayerLike actually carried them
// all into the rematch's fresh bot seat rather than just the one under test
// (rematchFriendly) matching by coincidence.
func botPlayerRematch(name string, rating int, rematchFriendly bool) *player {
	return &player{
		id:               auth.Identity{Name: name, Rating: rating},
		isBot:            true,
		rating:           rating,
		takebackFriendly: true,
		acceptsDraws:     false,
		offersDraws:      true,
		resigns:          false,
		asksTakeback:     true,
		rematchFriendly:  rematchFriendly,
	}
}

// A human who just beat a fill-in bot and clicks Rematch must not sit through
// the full 5-minute rematchTTL: a friendly bot answers on its own beat, and a
// new game exists with colors swapped and the same time control/pool/variant,
// seated by a bot side carrying the SAME dispositions as the one just played
// (newBotPlayerLike's whole point — a re-rolled disposition would read as a
// different person wearing the same name).
func TestBotRematchFriendlyBotAcceptsAndStartsSwappedGame(t *testing.T) {
	h := New(testSecret)
	human, humanCh := humanPlayerWithSend("alice", 4)
	bot := botPlayerRematch("Sneaky_Knight", 1400, true)
	g := newStdGame(t, "gid", human, bot) // human = White, bot = Black
	g.over = true
	g.tc = timeControl{Base: 300_000, Inc: 3_000}
	g.pool = "5+3"
	g.rated = true
	h.armRematch(g)

	h.rematchOffer(human.any())
	off := recv(t, humanCh) // echo of our own standing offer
	if off["type"] != "rematchOffered" {
		t.Fatalf("type = %v, want rematchOffered", off["type"])
	}
	if g.rematchAnswerAt.IsZero() {
		t.Fatal("rematchAnswerAt not armed against a bot opponent")
	}

	// Nothing fires before the beat elapses.
	h.checkBotRematches()
	select {
	case data := <-humanCh:
		t.Fatalf("bot answered before its beat elapsed: %s", data)
	default:
	}

	// Backdate the beat instead of sleeping for real.
	g.rematchAnswerAt = time.Now().Add(-time.Second)
	h.checkBotRematches()

	m := recv(t, humanCh)
	if m["type"] != "matched" {
		t.Fatalf("type = %v, want matched", m["type"])
	}
	if m["gameId"] == "gid" || m["gameId"] == "" {
		t.Errorf("rematch gameId = %v, want a fresh id (not gid)", m["gameId"])
	}
	if m["color"] != "b" {
		t.Errorf("human color after rematch = %v, want b (swapped from w)", m["color"])
	}
	if m["pool"] != "5+3" {
		t.Errorf("pool = %v, want 5+3", m["pool"])
	}
	if m["variant"] != "standard" {
		t.Errorf("variant = %v, want standard", m["variant"])
	}
	if m["rated"] != true {
		t.Errorf("rated = %v, want true (carried from original)", m["rated"])
	}
	if m["rematch"] != true {
		t.Errorf("rematch flag = %v, want true", m["rematch"])
	}

	gameID, _ := m["gameId"].(string)
	ng, ok := h.games[gameID]
	if !ok {
		t.Fatalf("new game %v not registered in h.games", gameID)
	}
	if ng.tc != g.tc {
		t.Errorf("new game tc = %+v, want %+v", ng.tc, g.tc)
	}
	newBot := ng.white // human was swapped to Black, so White is the fresh bot seat
	if !newBot.isBot {
		t.Fatal("expected White to be the fresh bot seat")
	}
	if newBot.id.Name != bot.id.Name || newBot.rating != bot.rating {
		t.Errorf("new bot identity = %+v/%d, want %+v/%d", newBot.id, newBot.rating, bot.id, bot.rating)
	}
	if newBot.takebackFriendly != bot.takebackFriendly || newBot.acceptsDraws != bot.acceptsDraws ||
		newBot.offersDraws != bot.offersDraws || newBot.resigns != bot.resigns ||
		newBot.asksTakeback != bot.asksTakeback || newBot.rematchFriendly != bot.rematchFriendly {
		t.Errorf("new bot dispositions = %+v, want the same as the original bot %+v", newBot, bot)
	}
	if newBot.connected() {
		t.Error("a fresh bot seat must hold no clients")
	}

	// The old window is closed — a stray late offer against it is a no-op.
	if _, ok := h.rematchWindows["gid"]; ok {
		t.Error("old rematch window still indexed after the bot accepted")
	}
}

// An unfriendly bot sends a real rematchDeclined instead of leaving the
// player to time out the whole 5-minute rematchTTL in silence.
func TestBotRematchUnfriendlyBotDeclines(t *testing.T) {
	h := New(testSecret)
	human, humanCh := humanPlayerWithSend("alice", 4)
	bot := botPlayerRematch("Grim_Rook", 1400, false)
	g := newStdGame(t, "gid", bot, human) // bot = White, human = Black
	g.over = true
	g.tc = timeControl{Base: 180_000, Inc: 0}
	g.pool = "3+0"
	h.armRematch(g)

	h.rematchOffer(human.any())
	recv(t, humanCh) // echo of our own standing offer
	if g.rematchAnswerAt.IsZero() {
		t.Fatal("rematchAnswerAt not armed against a bot opponent")
	}

	g.rematchAnswerAt = time.Now().Add(-time.Second)
	h.checkBotRematches()

	m := recv(t, humanCh)
	if m["type"] != "rematchDeclined" {
		t.Fatalf("type = %v, want rematchDeclined", m["type"])
	}
	if g.rematchPending {
		t.Error("rematchPending still true after the bot declined")
	}
	if len(h.games) != 0 {
		t.Errorf("games after decline = %d, want 0 (no rematch started)", len(h.games))
	}
}

// A rematch offered against a human opponent never arms rematchAnswerAt — the
// bot beat/answer machinery must stay completely inert for human-vs-human
// games (checkBotRematches has nothing to do and does nothing).
func TestRematchOfferAgainstHumanNeverArmsBotBeat(t *testing.T) {
	h := New(testSecret)
	white, whiteCh := humanPlayerWithSend("alice", 4)
	black, blackCh := humanPlayerWithSend("bob", 4)
	g := newStdGame(t, "gid", white, black)
	g.over = true
	h.armRematch(g)

	h.rematchOffer(white.any())
	recv(t, whiteCh)
	recv(t, blackCh)

	if !g.rematchAnswerAt.IsZero() {
		t.Error("rematchAnswerAt armed against a human opponent")
	}

	// checkBotRematches must not touch a human-vs-human standing offer.
	h.checkBotRematches()
	select {
	case data := <-blackCh:
		t.Fatalf("checkBotRematches acted on a human-vs-human offer: %s", data)
	default:
	}
	if !g.rematchPending {
		t.Error("rematchPending cleared by checkBotRematches against a human opponent")
	}
}
