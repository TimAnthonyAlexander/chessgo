package hub

import (
	"testing"
	"time"

	"github.com/timanthonyalexander/gomachine/internal/auth"
	"github.com/timanthonyalexander/gomachine/internal/chess"
	"github.com/timanthonyalexander/gomachine/internal/variant"
)

// botTakebackGame builds a human(white)-vs-bot(black) game one ply deep, with the
// bot's takeback disposition pinned, registered in the hub. No sockets: every
// function under test runs on the Run goroutine and a bot side has no clients
// anyway, so the broadcasts simply go nowhere.
func botTakebackGame(t *testing.T, h *Hub, friendly bool) *game {
	t.Helper()
	st, err := variant.New(variantStandard, chess.StartFEN)
	if err != nil {
		t.Fatalf("variant.New: %v", err)
	}
	bot := newBotPlayer(auth.Identity{UserID: "bot-x", Name: "SlyOtter"}, 1500)
	bot.takebackFriendly = friendly
	g := &game{
		id:        "tb-" + t.Name(),
		variant:   variantStandard,
		startFen:  chess.StartFEN,
		state:     st,
		tc:        timeControl{Base: 300_000},
		clockMs:   [2]int64{300_000, 300_000},
		turnStart: time.Now(),
		white:     &player{id: auth.Identity{UserID: "alice", Name: "Alice"}},
		black:     bot,
	}
	if _, ok := g.applyMove("e2e4"); !ok {
		t.Fatal("apply e2e4")
	}
	h.games[g.id] = g
	return g
}

// offerAndSettle stands a takeback offer up from White and runs the bot's answer,
// as the ticker would once the beat has elapsed. Returns the game's ply after.
func offerAndSettle(h *Hub, g *game) int {
	g.takebackPending, g.takebackBy = true, chess.White
	if _, isBot := g.takebackResponder(); isBot {
		g.takebackAnswerAt = time.Now().Add(botTakebackAnswerDelay())
	}
	g.takebackAnswerAt = time.Now().Add(-time.Millisecond) // fast-forward past the beat
	h.checkBotTakebacks()
	return len(g.moves)
}

// A bot that gives takebacks accepts; one that doesn't declines and leaves the
// position alone.
func TestBotTakebackHonoursDisposition(t *testing.T) {
	h := New(testSecret)

	friendly := botTakebackGame(t, h, true)
	if ply := offerAndSettle(h, friendly); ply != 0 {
		t.Errorf("friendly bot: ply = %d, want 0 (takeback applied)", ply)
	}
	if friendly.takebackPending {
		t.Error("friendly bot: offer still pending after acceptance")
	}

	stubborn := botTakebackGame(t, h, false)
	if ply := offerAndSettle(h, stubborn); ply != 1 {
		t.Errorf("stubborn bot: ply = %d, want 1 (takeback refused)", ply)
	}
	if stubborn.takebackPending {
		t.Error("stubborn bot: offer still pending after decline")
	}
	if !stubborn.takebackAnswerAt.IsZero() {
		t.Error("stubborn bot: answer still armed after decline")
	}
}

// The disposition is a property of the BOT, not of the request: re-asking a bot
// that said no must get the same no every time, or a player could simply spam
// offers until one landed.
func TestBotTakebackRefusalIsStableAcrossRequests(t *testing.T) {
	h := New(testSecret)
	g := botTakebackGame(t, h, false)

	for i := 0; i < 50; i++ {
		if ply := offerAndSettle(h, g); ply != 1 {
			t.Fatalf("request %d: ply = %d, want 1 — a re-ask must not flip the answer", i, ply)
		}
	}
}

// The bot must not answer before its beat has elapsed (an instant reply is a tell),
// and a human opponent must never be answered for.
func TestBotTakebackTimingAndHumanOpponent(t *testing.T) {
	h := New(testSecret)

	g := botTakebackGame(t, h, true)
	g.takebackPending, g.takebackBy = true, chess.White
	g.takebackAnswerAt = time.Now().Add(time.Hour)
	h.checkBotTakebacks()
	if len(g.moves) != 1 || !g.takebackPending {
		t.Error("bot answered before its beat elapsed")
	}

	// Same setup, but the opponent is human: nothing is armed, and even a stale
	// arming must resolve to "not ours to answer" rather than a takeback.
	human := botTakebackGame(t, h, true)
	human.black = &player{id: auth.Identity{UserID: "bob", Name: "Bob"}}
	human.takebackPending, human.takebackBy = true, chess.White
	if _, isBot := human.takebackResponder(); isBot {
		t.Fatal("human opponent reported as a bot responder")
	}
	human.takebackAnswerAt = time.Now().Add(-time.Millisecond)
	h.checkBotTakebacks()
	if len(human.moves) != 1 {
		t.Error("hub took a move back on a human opponent's behalf")
	}
	if !human.takebackPending {
		t.Error("hub cleared a human opponent's pending offer")
	}
	if !human.takebackAnswerAt.IsZero() {
		t.Error("stale arming not cleared")
	}
}

// Roughly a coin flip across freshly created bots — the per-bot roll must not be
// stuck on one answer.
func TestBotTakebackChanceIsBalanced(t *testing.T) {
	friendly := 0
	const n = 4000
	for i := 0; i < n; i++ {
		if newBotPlayer(auth.Identity{UserID: "bot-x"}, 1500).takebackFriendly {
			friendly++
		}
	}
	if friendly < n*40/100 || friendly > n*60/100 {
		t.Errorf("friendly bots = %d/%d, want roughly half", friendly, n)
	}
}
