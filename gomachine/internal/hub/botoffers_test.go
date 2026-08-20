package hub

import (
	"fmt"
	"testing"
	"time"

	"github.com/timanthonyalexander/gomachine/internal/auth"
	"github.com/timanthonyalexander/gomachine/internal/chess"
	"github.com/timanthonyalexander/gomachine/internal/variant"
)

// botOfferGame builds a human(white)-vs-bot(black) game one ply deep, registered
// in the hub, and hands the bot back for the caller to pin its dispositions on. No
// sockets: every function under test runs on the Run goroutine and a bot side has
// no clients anyway, so the broadcasts simply go nowhere.
func botOfferGame(t *testing.T, h *Hub) (*game, *player) {
	t.Helper()
	g := newBotOfferGame(t, h)
	return g, g.black
}

// botTakebackGame is botOfferGame with the takeback disposition pinned.
func botTakebackGame(t *testing.T, h *Hub, friendly bool) *game {
	t.Helper()
	g := newBotOfferGame(t, h)
	g.black.takebackFriendly = friendly
	return g
}

func newBotOfferGame(t *testing.T, h *Hub) *game {
	t.Helper()
	st, err := variant.New(variantStandard, chess.StartFEN)
	if err != nil {
		t.Fatalf("variant.New: %v", err)
	}
	bot := newBotPlayer(auth.Identity{UserID: "bot-x", Name: "SlyOtter"}, 1500)
	g := &game{
		// Unique per game: several tests build two in one hub, and h.games is
		// keyed by id — a shared key would silently drop the first one from
		// every ticker sweep under test.
		id:        fmt.Sprintf("g%d-%s", len(h.games), t.Name()),
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
		g.takebackAnswerAt = time.Now().Add(botOfferAnswerDelay())
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

// --- draw offers against a bot ---------------------------------------------

// offerDrawAndSettle stands a draw offer up from the human and runs the bot's
// answer, as the ticker would once the beat has elapsed.
func offerDrawAndSettle(h *Hub, g *game) {
	g.drawPending, g.drawBy = true, chess.White
	g.drawAnswerAt = time.Now().Add(-time.Millisecond) // fast-forward past the beat
	h.checkBotDraws()
}

// A bot takes a draw only when it is BOTH the kind that accepts and not winning.
func TestBotDrawAcceptance(t *testing.T) {
	cases := []struct {
		name       string
		accepts    bool
		evalCp     int
		hasEval    bool
		wantAccept bool
	}{
		{"accepts a level position", true, 5, true, true},
		{"accepts when clearly worse — a draw beats a loss", true, -800, true, true},
		{"declines while winning", true, 400, true, false},
		{"declines because it never gives draws", false, 0, true, false},
		{"declines with no eval to go on", true, 0, false, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h := New(testSecret)
			g, bot := botOfferGame(t, h)
			bot.acceptsDraws = c.accepts
			if c.hasEval {
				g.recordBotEval(chess.Black, c.evalCp)
			}

			offerDrawAndSettle(h, g)

			if got := g.over; got != c.wantAccept {
				t.Errorf("game over = %v, want %v", got, c.wantAccept)
			}
			if !c.wantAccept && g.drawPending {
				t.Error("declined offer still pending")
			}
			if !g.drawAnswerAt.IsZero() {
				t.Error("answer still armed after settling")
			}
		})
	}
}

// Re-offering must not flip a decline: the disposition is per bot, and the eval it
// checks moves at the speed of the game, not the speed of clicking.
func TestBotDrawRefusalIsStableAcrossRequests(t *testing.T) {
	h := New(testSecret)
	g, bot := botOfferGame(t, h)
	bot.acceptsDraws = false
	g.recordBotEval(chess.Black, 0) // dead level — the most tempting case

	for i := 0; i < 50; i++ {
		offerDrawAndSettle(h, g)
		if g.over {
			t.Fatalf("request %d: bot caved — a re-ask must not flip the answer", i)
		}
	}
}

// --- the bot's own concessions ---------------------------------------------

// padPlies pushes the game past a ply floor. Only the LENGTH of g.moves is read by
// the concession checks, so this needs no matching board state.
func padPlies(g *game, plies int) {
	for len(g.moves) < plies {
		g.moves = append(g.moves, "0000")
	}
}

// A bot that resigns does so once its own eval has said "lost" for long enough,
// and the game ends exactly as a human resignation does.
func TestBotResigns(t *testing.T) {
	h := New(testSecret)
	g, bot := botOfferGame(t, h)
	bot.resigns = true

	// One bad read is not enough — that is noise, not a lost game.
	g.recordBotEval(chess.Black, -1500)
	h.considerBotConcession(g, chess.Black)
	if !g.botResignAt.IsZero() {
		t.Fatal("resigned off a single eval sample")
	}

	g.recordBotEval(chess.Black, -1600)
	h.considerBotConcession(g, chess.Black)
	if g.botResignAt.IsZero() {
		t.Fatal("sustained lost eval did not arm a resignation")
	}

	// Armed, but not yet: the bot moves, sits there, and only then gives up.
	h.checkBotConcessions()
	if g.over {
		t.Fatal("resigned before its beat elapsed")
	}

	g.botResignAt = time.Now().Add(-time.Millisecond)
	h.checkBotConcessions()
	if !g.over {
		t.Fatal("armed resignation never fired")
	}
}

// A bot that doesn't resign plays a lost game out, however bad it gets.
func TestBotWithoutResignDispositionPlaysOn(t *testing.T) {
	h := New(testSecret)
	g, bot := botOfferGame(t, h)
	bot.resigns = false

	for i := 0; i < 10; i++ {
		g.recordBotEval(chess.Black, -3000)
		h.considerBotConcession(g, chess.Black)
	}
	h.checkBotConcessions()
	if !g.botResignAt.IsZero() || g.over {
		t.Error("a non-resigning bot gave up")
	}
}

// A dead-level game gets one draw offer from a bot that makes them — and only one.
func TestBotOffersDrawOnceInALevelGame(t *testing.T) {
	h := New(testSecret)
	g, bot := botOfferGame(t, h)
	bot.offersDraws = true
	bot.resigns = true // must not fire: level is not lost

	level := func() {
		for i := 0; i < botDrawEvalSustain; i++ {
			g.recordBotEval(chess.Black, 10)
		}
		h.considerBotConcession(g, chess.Black)
	}

	// Too early: the opening is level by definition, so a draw offer there is noise.
	level()
	if !g.botDrawOfferAt.IsZero() {
		t.Fatal("offered a draw before the ply floor")
	}

	padPlies(g, botDrawMinPly)
	level()
	if g.botDrawOfferAt.IsZero() {
		t.Fatal("sustained level eval past the ply floor did not arm an offer")
	}

	g.botDrawOfferAt = time.Now().Add(-time.Millisecond)
	h.checkBotConcessions()
	if !g.drawPending || g.drawBy != chess.Black {
		t.Fatalf("draw offer not standing from the bot: pending=%v by=%v", g.drawPending, g.drawBy)
	}
	if g.over {
		t.Error("offering a draw ended the game by itself")
	}

	// The human ignores it and moves; the offer dies like any other.
	g.clearOffers()
	level()
	if !g.botDrawOfferAt.IsZero() {
		t.Error("bot asked a second time — one offer per game")
	}
}

// A bot that doesn't offer draws never does, however level the game.
func TestBotWithoutOfferDispositionStaysQuiet(t *testing.T) {
	h := New(testSecret)
	g, bot := botOfferGame(t, h)
	bot.offersDraws = false
	padPlies(g, botDrawMinPly)

	for i := 0; i < 20; i++ {
		g.recordBotEval(chess.Black, 0)
		h.considerBotConcession(g, chess.Black)
	}
	if !g.botDrawOfferAt.IsZero() || g.drawPending {
		t.Error("a non-offering bot offered a draw")
	}
}

// Fillers and arena bot-vs-bot games concede nothing — there is no human there to
// concede to, and a filler resigning would end a lobby game for no reason.
func TestBotVsBotGamesNeverConcede(t *testing.T) {
	h := New(testSecret)
	g, _ := botOfferGame(t, h)
	g.white = newBotPlayer(auth.Identity{UserID: "bot-y"}, 1500)
	g.white.resigns, g.black.resigns = true, true
	g.filler = true
	padPlies(g, botDrawMinPly)

	for i := 0; i < 5; i++ {
		g.recordBotEval(chess.Black, -3000)
		h.considerBotConcession(g, chess.Black)
	}
	h.checkBotConcessions()
	if g.over || !g.botResignAt.IsZero() {
		t.Error("a filler game conceded")
	}
}

// --- eval bookkeeping ------------------------------------------------------

func TestBotEvalStreakAndHistoryBound(t *testing.T) {
	h := New(testSecret)
	g, _ := botOfferGame(t, h)

	if g.botEvalStreak(chess.Black, 2, isCenteredCp) {
		t.Error("an empty history is not a streak")
	}
	g.recordBotEval(chess.Black, 5)
	if g.botEvalStreak(chess.Black, 2, isCenteredCp) {
		t.Error("one sample is not a two-sample streak")
	}
	g.recordBotEval(chess.Black, -20)
	if !g.botEvalStreak(chess.Black, 2, isCenteredCp) {
		t.Error("two centered samples should be a streak")
	}
	g.recordBotEval(chess.Black, 900)
	if g.botEvalStreak(chess.Black, 2, isCenteredCp) {
		t.Error("a decisive sample must break the streak")
	}

	// The other colour's history is separate, and neither grows without bound.
	if _, ok := g.lastBotEval(chess.White); ok {
		t.Error("white recorded an eval it never reported")
	}
	for i := 0; i < botEvalHistory*3; i++ {
		g.recordBotEval(chess.Black, i)
	}
	if got := len(g.botEvals[chess.Black]); got != botEvalHistory {
		t.Errorf("history length = %d, want %d", got, botEvalHistory)
	}
	if cp, ok := g.lastBotEval(chess.Black); !ok || cp != botEvalHistory*3-1 {
		t.Errorf("lastBotEval = %d,%v; want the most recent sample", cp, ok)
	}
}

// A mate score must never read as a centipawn score — "mated in 2" arriving as −2
// would be indistinguishable from dead level, which is exactly the position a bot
// offers and accepts draws in.
func TestMateScoreCpIsNeverDrawish(t *testing.T) {
	for _, mateIn := range []int{-1, -2, -5, -30} {
		cp := mateScoreCp(mateIn)
		if isCenteredCp(cp) || !isLostCp(cp) {
			t.Errorf("mate in %d → %d cp: must read as lost, not level", mateIn, cp)
		}
	}
	for _, mateIn := range []int{1, 2, 5, 30} {
		cp := mateScoreCp(mateIn)
		if isCenteredCp(cp) || isLostCp(cp) {
			t.Errorf("mate in %d → %d cp: must read as winning", mateIn, cp)
		}
	}
	// Shorter mates outrank longer ones, in both directions.
	if mateScoreCp(1) <= mateScoreCp(5) {
		t.Error("a faster mate must score higher")
	}
	if mateScoreCp(-1) >= mateScoreCp(-5) {
		t.Error("being mated sooner must score lower")
	}
	if mateScoreCp(0) != 0 {
		t.Error("no mate must be a zero adjustment")
	}
}

// Every disposition must actually vary across freshly created bots — a roll stuck
// on one answer would make the whole per-bot idea decorative.
func TestBotDispositionsAreBalanced(t *testing.T) {
	const n = 4000
	counts := map[string]int{}
	for i := 0; i < n; i++ {
		p := newBotPlayer(auth.Identity{UserID: "bot-x"}, 1500)
		for name, on := range map[string]bool{
			"takeback": p.takebackFriendly,
			"accepts":  p.acceptsDraws,
			"offers":   p.offersDraws,
			"resigns":  p.resigns,
		} {
			if on {
				counts[name]++
			}
		}
	}
	want := map[string]float64{
		"takeback": botTakebackAcceptChance,
		"accepts":  botAcceptDrawChance,
		"offers":   botOfferDrawChance,
		"resigns":  botResignChance,
	}
	for name, chance := range want {
		got := float64(counts[name]) / n
		if got < chance-0.05 || got > chance+0.05 {
			t.Errorf("%s: %.3f of bots, want ~%.2f", name, got, chance)
		}
	}
}
