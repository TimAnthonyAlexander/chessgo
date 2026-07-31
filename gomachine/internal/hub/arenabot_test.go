package hub

import (
	"context"
	"encoding/json"
	"fmt"
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
	h.EnableArenaBotEngines(2, 8, 1) // populates h.arenaBotEngines

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

	// Simulate several ticks — with 4 idle bots, arenaBotVsBotCapForField(4)
	// == 2, so exactly two games should start (using all four bots) and no
	// more.
	wantCap := arenaBotVsBotCapForField(4)
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
	if live != wantCap {
		t.Errorf("live bot-vs-bot games = %d, want exactly the cap (%d)", live, wantCap)
	}

	busy := 0
	for _, b := range ar.botBusy {
		if b {
			busy++
		}
	}
	if want := wantCap * 2; busy != want {
		t.Errorf("busy bots = %d, want %d (two per capped game)", busy, want)
	}
}

func TestArenaBotVsBotNeedsTwoIdle(t *testing.T) {
	h := New(testSecret)
	h.EnableArenaBotEngines(2, 8, 1)

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

// TestArenaAbortReturnsBotsToPool covers the OTHER terminal game path besides
// finish() — abortGame, fired by checkClocks' 30s stalled-first-move guard
// (e.g. zugzwang unreachable and the emergency in-process fallback also
// failing/disabled, so no bot move ever lands). Before this fix abortGame
// never called returnToArenaPool, so an aborted arena bot-vs-bot game would
// leak both bots permanently stuck in ar.botBusy — never picked again for the
// rest of the tournament.
func TestArenaAbortReturnsBotsToPool(t *testing.T) {
	h := New(testSecret)
	ar := &arenaState{
		id: "ARENA-ABORT", pool: "3+0", variant: variantStandard, rated: true,
		players: map[string]*arenaPlayerState{
			"bot-x": {score: 10, bot: true, name: "BotX", rating: 1500},
			"bot-y": {score: 10, bot: true, name: "BotY", rating: 1500},
		},
		lastOpponent: map[string]string{},
		botBusy:      map[string]bool{},
	}
	h.arenas[ar.id] = ar

	idX := auth.Identity{UserID: "bot-x", Name: "BotX", Rating: 1500}
	idY := auth.Identity{UserID: "bot-y", Name: "BotY", Rating: 1500}
	white, black := newBotPlayer(idX, 1500), newBotPlayer(idY, 1500)
	g := h.newArenaGame(ar, white, black)
	if g == nil {
		t.Fatal("newArenaGame returned nil")
	}
	ar.botBusy["bot-x"] = true
	ar.botBusy["bot-y"] = true

	h.abortGame(g)

	if ar.botBusy["bot-x"] || ar.botBusy["bot-y"] {
		t.Error("aborting a stalled arena game must free both bots' busy markers, not leak them forever")
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
	h.EnableArenaBotEngines(2, 8, 1)

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

// --- arenaBotVsBotCapForField: concurrency scales with the field, bounded by
// the dedicated engine pool's real throughput ---

func TestArenaBotVsBotCapScalesWithField(t *testing.T) {
	cases := []struct{ bots, want int }{
		{0, 1}, // never zero — a tiny/empty field still gets a floor of 1
		{1, 1}, // no possible pair yet either way
		{2, 1}, // exactly one pair possible
		{3, 1}, // 1 pair possible, one bot always sits out a round
		{4, 2}, // two full pairs
		{8, 4}, // scales linearly while under the ceiling
		{11, 5},
		{12, 6}, // hits arenaBotVsBotCapMax exactly
	}
	for _, c := range cases {
		if got := arenaBotVsBotCapForField(c.bots); got != c.want {
			t.Errorf("arenaBotVsBotCapForField(%d) = %d, want %d", c.bots, got, c.want)
		}
	}
}

// TestArenaBotVsBotCapRespectsEnginePoolBound asserts the cap PLATEAUS at
// arenaBotVsBotCapMax no matter how large BaseAPI's enrolled bot field gets —
// this is what keeps a 50- or 200-bot arena from ever demanding more
// concurrent searches than the dedicated arenaBotEngines pool can sustain
// without visible move-latency creep (see arenaBotVsBotCapMax's doc for the
// throughput reasoning).
func TestArenaBotVsBotCapRespectsEnginePoolBound(t *testing.T) {
	for _, bots := range []int{13, 20, 50, 200, 100_000} {
		if got := arenaBotVsBotCapForField(bots); got != arenaBotVsBotCapMax {
			t.Errorf("arenaBotVsBotCapForField(%d) = %d, want the ceiling %d", bots, got, arenaBotVsBotCapMax)
		}
	}
}

// --- twoIdleArenaBots: least-played bias breaks the "same two forever" bug ---

// TestTwoIdleArenaBotsPrefersLeastPlayedOnTiedScore reproduces the real
// starvation bug: with every bot tied at the same score (as they all are at a
// tournament's start), a pure closest-score pick always resolves to the same
// alphabetically-first pair (sort.Strings' deterministic order), which then
// re-idles and gets re-picked every single tick forever — every OTHER bot
// stays at zero games for the tournament's entire life. Anchoring on
// games-played fixes it: the never-played bot must be included.
func TestTwoIdleArenaBotsPrefersLeastPlayedOnTiedScore(t *testing.T) {
	ar := &arenaState{
		players: map[string]*arenaPlayerState{
			"bot-a": {score: 0, bot: true}, // alphabetically first — would always win a pure score tiebreak
			"bot-b": {score: 0, bot: true},
			"bot-c": {score: 0, bot: true}, // never played — must be picked
		},
		botBusy:        map[string]bool{},
		botGamesPlayed: map[string]int{"bot-a": 5, "bot-b": 3, "bot-c": 0},
	}
	a, b, ok := twoIdleArenaBots(ar)
	if !ok {
		t.Fatal("expected a pair")
	}
	if a != "bot-c" && b != "bot-c" {
		t.Errorf("pair = (%s, %s), want the never-played bot-c included", a, b)
	}
	// The anchor itself should be the strict minimum, bot-c.
	if a != "bot-c" {
		t.Errorf("anchor (first return value) = %q, want the least-played bot-c", a)
	}
}

// TestTwoIdleArenaBotsStillScoreSensibleAmongEquallyPlayed confirms the bias
// doesn't override score-sensible pairing when games-played is already equal
// (the common case after the field evens out) — closest score still wins.
func TestTwoIdleArenaBotsStillScoreSensibleAmongEquallyPlayed(t *testing.T) {
	ar := &arenaState{
		players: map[string]*arenaPlayerState{
			"bot-1": {score: 10, bot: true},
			"bot-2": {score: 12, bot: true},
			"bot-3": {score: 500, bot: true},
		},
		botBusy:        map[string]bool{},
		botGamesPlayed: map[string]int{"bot-1": 2, "bot-2": 2, "bot-3": 2},
	}
	a, b, ok := twoIdleArenaBots(ar)
	if !ok {
		t.Fatal("expected a pair")
	}
	if (a != "bot-1" || b != "bot-2") && (a != "bot-2" || b != "bot-1") {
		t.Errorf("pair = (%s, %s), want the closest-score pair (bot-1, bot-2)", a, b)
	}
}

// TestArenaBotVsBotEveryoneGetsPairedOverTicks is the end-to-end rotation
// check: a field of 20 bots with arenaBotVsBotCapForField(20) == 6 games (12
// bots busy at once, 8 always idle) must still get every single bot a game
// within a handful of rounds — the least-played bias in twoIdleArenaBots
// draining the "never played" backlog before touching anyone who's already
// played, rather than the same 12 bots looping forever.
func TestArenaBotVsBotEveryoneGetsPairedOverTicks(t *testing.T) {
	h := New(testSecret)
	h.EnableArenaBotEngines(2, 8, 1)

	const nBots = 20
	players := map[string]*arenaPlayerState{}
	for i := 0; i < nBots; i++ {
		sub := fmt.Sprintf("bot-%02d", i)
		players[sub] = &arenaPlayerState{score: 0, bot: true, name: sub, rating: 1500}
	}
	ar := &arenaState{
		id: "ARENA-ROTATION", pool: "3+0", variant: variantStandard, rated: true,
		players:      players,
		lastOpponent: map[string]string{},
		botBusy:      map[string]bool{},
	}
	h.arenas[ar.id] = ar

	fieldCap := arenaBotVsBotCapForField(nBots)
	if fieldCap != arenaBotVsBotCapMax {
		t.Fatalf("test assumes a 20-bot field is above the ceiling (fieldCap=%d, want %d)", fieldCap, arenaBotVsBotCapMax)
	}

	for round := 0; round < 6; round++ {
		// Ramp up to the cap (topUpArenaBotVsBot starts at most one game per
		// call, mirroring the real per-tick ramp).
		for i := 0; i < fieldCap; i++ {
			h.topUpArenaBotVsBot(ar)
		}
		// Simulate every one of this round's games finishing immediately (a
		// fast bullet game) so both bots return to the idle pool for the next
		// round — mirrors returnToArenaPool's real bot-busy-clearing path.
		for _, g := range h.games {
			if !g.over && g.arenaID == ar.id {
				h.finish(g, "1-0", "test")
			}
		}
	}

	for sub := range players {
		if ar.botGamesPlayed[sub] == 0 {
			t.Errorf("bot %s never got a single game after 6 rounds — rotation is still starving it", sub)
		}
	}
}
