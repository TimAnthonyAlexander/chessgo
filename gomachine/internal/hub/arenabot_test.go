package hub

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/timanthonyalexander/gomachine/internal/auth"
)

// mkArenaClient builds a bare *Client good enough to receive queued messages
// (a real send channel + a live ctx/cancel) without a network connection at
// all — the same "construct the Run-goroutine-only state directly, no
// go h.Run()" style zugzwang_test.go's newTestBotGame uses, just carried one
// step further so sendMatched (which does write to c.send) has somewhere to
// write.
func mkArenaClient(sub string) *Client {
	ctx, cancel := context.WithCancel(context.Background())
	return &Client{
		id:     auth.Identity{UserID: sub, Name: sub, Rating: 1500, Ratings: map[string]int{"blitz": 1500}},
		send:   make(chan []byte, sendBuffer),
		ctx:    ctx,
		cancel: cancel,
	}
}

// readQueued unmarshals the next pre-marshaled message already sitting in
// c.send (non-blocking — every message in these tests is queued
// synchronously by the call under test, not delivered by a writePump).
func readQueued(t *testing.T, c *Client) map[string]any {
	t.Helper()
	select {
	case data := <-c.send:
		var m map[string]any
		if err := json.Unmarshal(data, &m); err != nil {
			t.Fatalf("unmarshal queued message: %v", err)
		}
		return m
	default:
		t.Fatal("expected a message already queued for this client")
		return nil
	}
}

// --- closestIdleArenaBot / twoIdleArenaBots: pure unit tests ---

func TestClosestIdleArenaBot(t *testing.T) {
	ar := &arenaState{
		players: map[string]*arenaPlayerState{
			"human":    {score: 100},
			"bot-far":  {score: 500, bot: true},
			"bot-near": {score: 105, bot: true},
			"bot-busy": {score: 100, bot: true}, // closest of all, but busy
			"withdrew": {score: 100, bot: true, withdrawn: true},
		},
		botBusy: map[string]bool{"bot-busy": true},
	}
	sub, ok := closestIdleArenaBot(ar, ar.players["human"])
	if !ok {
		t.Fatal("expected an idle bot to be found")
	}
	if sub != "bot-near" {
		t.Errorf("closestIdleArenaBot = %q, want bot-near (closest idle, ignoring busy/withdrawn)", sub)
	}
}

func TestClosestIdleArenaBotNoneAvailable(t *testing.T) {
	ar := &arenaState{
		players: map[string]*arenaPlayerState{
			"human":  {score: 100},
			"bot-1":  {score: 100, bot: true, withdrawn: true},
			"bot-2":  {score: 100, bot: true},
			"nobody": {score: 100},
		},
		botBusy: map[string]bool{"bot-2": true},
	}
	if _, ok := closestIdleArenaBot(ar, ar.players["human"]); ok {
		t.Error("expected no idle bot (one withdrawn, the other busy)")
	}
	if _, ok := closestIdleArenaBot(ar, nil); ok {
		t.Error("expected ok=false for a nil player state")
	}
}

func TestTwoIdleArenaBots(t *testing.T) {
	ar := &arenaState{
		players: map[string]*arenaPlayerState{
			"bot-1": {score: 10, bot: true},
			"bot-2": {score: 12, bot: true},
			"bot-3": {score: 500, bot: true},
			"human": {score: 11}, // never a candidate, bot=false
		},
		botBusy: map[string]bool{},
	}
	a, b, ok := twoIdleArenaBots(ar)
	if !ok {
		t.Fatal("expected a pair")
	}
	if (a != "bot-1" || b != "bot-2") && (a != "bot-2" || b != "bot-1") {
		t.Errorf("pair = (%s, %s), want the closest-score pair (bot-1, bot-2)", a, b)
	}
}

func TestTwoIdleArenaBotsNotEnoughIdle(t *testing.T) {
	ar := &arenaState{
		players: map[string]*arenaPlayerState{
			"bot-1": {score: 10, bot: true},
			"bot-2": {score: 12, bot: true, withdrawn: true},
		},
		botBusy: map[string]bool{},
	}
	if _, _, ok := twoIdleArenaBots(ar); ok {
		t.Error("expected ok=false with only one idle bot")
	}
}

// --- fillArenaWithBot: seats a long-waiting human against an idle bot ---

func TestArenaHumanPairedWithBotAfterDelay(t *testing.T) {
	h := New(testSecret)
	h.EnableBotFill(6, time.Minute, 1, 8, 1) // in-process fallback engine (no zugzwang configured)

	ar := &arenaState{
		id: "ARENA-BF", pool: "3+0", variant: variantStandard, rated: true,
		players: map[string]*arenaPlayerState{
			"id-human-bf": {score: 10},
			"id-bot-bf":   {score: 12, bot: true, name: "SilentFalcon42", rating: 1834, title: "GM"},
		},
		lastOpponent: map[string]string{},
		botBusy:      map[string]bool{},
	}
	h.arenas[ar.id] = ar

	waiter := mkArenaClient("id-human-bf")
	waiter.arenaID = ar.id
	waiter.arenaJoinedAt = time.Now().Add(-time.Hour) // long past any delay
	waiter.arenaBotFillDelay = time.Millisecond
	ar.free = append(ar.free, waiter)

	fresh := mkArenaClient("id-fresh") // not even a real participant, just proves it's untouched
	fresh.arenaID = ar.id
	fresh.arenaJoinedAt = time.Now()
	fresh.arenaBotFillDelay = time.Hour
	ar.free = append(ar.free, fresh)

	h.fillArenaWithBot(ar)

	if len(ar.free) != 1 || ar.free[0] != fresh {
		t.Fatalf("expected only the fresh joiner left waiting, ar.free = %v", ar.free)
	}
	if waiter.arenaID != "" {
		t.Error("the seated human's arenaID should be cleared")
	}
	if waiter.game == nil {
		t.Fatal("the long-waiting human should have been seated in a game")
	}
	if waiter.game.arenaID != ar.id {
		t.Errorf("game.arenaID = %q, want %q", waiter.game.arenaID, ar.id)
	}
	if !ar.botBusy["id-bot-bf"] {
		t.Error("the seated bot should be marked busy")
	}

	matched := readQueued(t, waiter)
	if matched["type"] != "matched" {
		t.Fatalf("type = %v, want matched", matched["type"])
	}
	if matched["tournamentId"] != ar.id {
		t.Errorf("tournamentId = %v, want %v", matched["tournamentId"], ar.id)
	}
	opp, _ := matched["opponent"].(map[string]any)
	if opp["name"] != "SilentFalcon42" {
		t.Errorf("opponent name = %v, want the roster bot's real name", opp["name"])
	}
}

func TestArenaFillArenaWithBotNoneAvailable(t *testing.T) {
	h := New(testSecret)
	h.EnableBotFill(6, time.Minute, 1, 8, 1)

	ar := &arenaState{
		id: "ARENA-BF-NONE", pool: "3+0", variant: variantStandard, rated: true,
		players:      map[string]*arenaPlayerState{"id-lonely": {score: 10}}, // no bots enrolled at all
		lastOpponent: map[string]string{},
		botBusy:      map[string]bool{},
	}
	h.arenas[ar.id] = ar

	waiter := mkArenaClient("id-lonely")
	waiter.arenaID = ar.id
	waiter.arenaJoinedAt = time.Now().Add(-time.Hour)
	waiter.arenaBotFillDelay = time.Millisecond
	ar.free = append(ar.free, waiter)

	h.fillArenaWithBot(ar)

	if waiter.game != nil {
		t.Error("no bot is enrolled — the human must stay waiting, not be seated")
	}
	if len(ar.free) != 1 || ar.free[0] != waiter {
		t.Errorf("the human should remain in ar.free, got %v", ar.free)
	}
}

// --- topUpArenaBotVsBot: caps concurrent bot-vs-bot games per arena ---

func TestArenaBotVsBotCapped(t *testing.T) {
	h := New(testSecret)
	h.EnableSpectatorFillers(2, 2, 8, 1) // populates h.fillerEngines

	ar := &arenaState{
		id: "ARENA-BVB", pool: "3+0", variant: variantStandard, rated: true,
		players: map[string]*arenaPlayerState{
			"bot-1": {score: 10, bot: true, name: "Bot1", rating: 1500},
			"bot-2": {score: 12, bot: true, name: "Bot2", rating: 1500},
			"bot-3": {score: 14, bot: true, name: "Bot3", rating: 1500},
			"bot-4": {score: 16, bot: true, name: "Bot4", rating: 1500},
		},
		lastOpponent: map[string]string{},
		botBusy:      map[string]bool{},
	}
	h.arenas[ar.id] = ar

	// Simulate several ticks — with 4 idle bots and a cap of 2, exactly two
	// games should start (using all four bots) and no more.
	for i := 0; i < 5; i++ {
		h.topUpArenaBotVsBot(ar)
	}

	live := 0
	for _, g := range h.games {
		if g.over || g.arenaID != ar.id {
			continue
		}
		live++
		if !g.white.isBot || !g.black.isBot {
			t.Errorf("expected a bot-vs-bot game, white.isBot=%v black.isBot=%v", g.white.isBot, g.black.isBot)
		}
		if g.filler {
			t.Error("an arena bot-vs-bot game must NOT be marked filler — it has to be persisted")
		}
	}
	if live != arenaBotVsBotCap {
		t.Errorf("live bot-vs-bot games = %d, want exactly the cap (%d)", live, arenaBotVsBotCap)
	}

	busy := 0
	for _, b := range ar.botBusy {
		if b {
			busy++
		}
	}
	if want := arenaBotVsBotCap * 2; busy != want {
		t.Errorf("busy bots = %d, want %d (two per capped game)", busy, want)
	}
}

func TestArenaBotVsBotNeedsTwoIdle(t *testing.T) {
	h := New(testSecret)
	h.EnableSpectatorFillers(2, 2, 8, 1)

	ar := &arenaState{
		id: "ARENA-BVB-ONE", pool: "3+0", variant: variantStandard, rated: true,
		players: map[string]*arenaPlayerState{
			"bot-solo": {score: 10, bot: true, name: "Solo", rating: 1500},
			"human":    {score: 10},
		},
		lastOpponent: map[string]string{},
		botBusy:      map[string]bool{},
	}
	h.arenas[ar.id] = ar

	h.topUpArenaBotVsBot(ar)

	for _, g := range h.games {
		if g.arenaID == ar.id {
			t.Fatalf("no bot-vs-bot game should start with only one bot enrolled, got %+v", g)
		}
	}
}

// --- persistence: a bot's real account id and the tournament id both reach
// the FinishedGame report handed to BaseAPI ---

func TestArenaGamePersistsBotRealIdentity(t *testing.T) {
	h := New(testSecret)

	ar := &arenaState{
		id: "ARENA-PERSIST", pool: "3+0", variant: variantStandard, rated: true,
		players: map[string]*arenaPlayerState{
			"id-human-p": {score: 5},
			"id-bot-p":   {score: 5, bot: true, name: "SilentFalcon42", rating: 1834, title: "GM"},
		},
		lastOpponent: map[string]string{},
		botBusy:      map[string]bool{},
	}
	h.arenas[ar.id] = ar

	human := mkArenaClient("id-human-p")
	botIdentity := auth.Identity{UserID: "id-bot-p", Name: "SilentFalcon42", Rating: 1834, Title: "GM"}
	white := newPlayer(human)
	black := newBotPlayer(botIdentity, 1834)

	g := h.newArenaGame(ar, white, black)
	if g == nil {
		t.Fatal("newArenaGame returned nil")
	}
	human.game = g
	ar.botBusy["id-bot-p"] = true

	var finished FinishedGame
	h.OnFinish(func(f FinishedGame) { finished = f })
	h.finish(g, "0-1", "test")

	if finished.TournamentID != ar.id {
		t.Errorf("TournamentID = %q, want %q", finished.TournamentID, ar.id)
	}
	if !finished.BlackBot {
		t.Fatal("expected BlackBot = true")
	}
	if finished.Black.UserID != "id-bot-p" {
		t.Errorf("bot side UserID = %q, want the real roster account id", finished.Black.UserID)
	}
	if finished.Black.Name != "SilentFalcon42" || finished.Black.Rating != 1834 {
		t.Errorf("bot identity = %+v, want the roster's real name/rating", finished.Black)
	}
	if finished.WhiteBot {
		t.Error("the human side must not be flagged as a bot")
	}

	// The bot is freed up (returnToArenaPool's lifted skip) for a future game.
	if ar.botBusy["id-bot-p"] {
		t.Error("finishing the game should have cleared the bot's busy marker")
	}
}

// --- no new bot games are ever added for an arena that has ended ---

func countLiveGamesForArena(h *Hub, arenaID string) int {
	n := 0
	for _, g := range h.games {
		if !g.over && g.arenaID == arenaID {
			n++
		}
	}
	return n
}

func TestArenaNoNewBotGamesAfterEnd(t *testing.T) {
	h := New(testSecret)
	h.EnableSpectatorFillers(2, 2, 8, 1)

	ar := &arenaState{
		id: "ARENA-END-BVB", pool: "3+0", variant: variantStandard, rated: true,
		players: map[string]*arenaPlayerState{
			"bot-e1": {score: 10, bot: true, name: "BotE1", rating: 1500},
			"bot-e2": {score: 12, bot: true, name: "BotE2", rating: 1500},
			"bot-e3": {score: 14, bot: true, name: "BotE3", rating: 1500},
			"bot-e4": {score: 16, bot: true, name: "BotE4", rating: 1500},
		},
		lastOpponent: map[string]string{},
		botBusy:      map[string]bool{},
	}
	h.arenas[ar.id] = ar

	h.topUpArenaBotVsBot(ar)
	liveBefore := countLiveGamesForArena(h, ar.id)
	if liveBefore == 0 {
		t.Fatal("expected a bot-vs-bot game to have started before the arena ends")
	}

	// The arena vanishes from BaseAPI's feed — this is exactly what
	// applyArenaSnapshots does to an arena missing from a fresh poll.
	delete(h.arenas, ar.id)

	// Several more simulated ticks: checkArenas' loop ranges over h.arenas, so
	// an id no longer in that map can never be reached by pairArena/
	// fillArenaWithBot/topUpArenaBotVsBot again — no NEW game for it can start,
	// and the one already running must be left alone (never killed).
	for i := 0; i < 5; i++ {
		h.checkArenas()
	}

	if liveAfter := countLiveGamesForArena(h, ar.id); liveAfter != liveBefore {
		t.Errorf("live games for the ended arena changed: before=%d after=%d", liveBefore, liveAfter)
	}
}
