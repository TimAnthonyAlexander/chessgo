package hub

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/timanthonyalexander/gomachine/internal/auth"
	"github.com/timanthonyalexander/gomachine/internal/chess"
	"github.com/timanthonyalexander/gomachine/internal/variant"
)

// --- test helpers ------------------------------------------------------------

// newGraceTestGame builds a bare human-vs-human game (no clients — like
// botOfferGame's white side, every function under test here runs on what
// would be the Run goroutine and neither side has a socket to receive
// anything) at the given start position and time control, registered in h,
// with the clock already "running" (padPlies(g, 2), botoffers_test.go's
// convention — only the LENGTH of g.moves is read by clocksRunning(), so this
// needs no matching board state for the ply-count tests, and the real board
// state is what the CanMate-adjudication tests key off of instead).
func newGraceTestGame(t *testing.T, h *Hub, fen string, tc timeControl) *game {
	t.Helper()
	st, err := variant.New(variantStandard, fen)
	if err != nil {
		t.Fatalf("variant.New: %v", err)
	}
	g := &game{
		id:        newID(),
		variant:   variantStandard,
		startFen:  fen,
		state:     st,
		tc:        tc,
		clockMs:   [2]int64{tc.Base, tc.Base},
		turnStart: time.Now(),
		white:     &player{id: auth.Identity{UserID: "alice", Name: "Alice"}},
		black:     &player{id: auth.Identity{UserID: "bob", Name: "Bob"}},
		online:    [2]bool{true, true},
	}
	h.games[g.id] = g
	return g
}

// newPresenceTestGame builds a bot-vs-human game (bot at botColor, a real
// in-process-engine-movable bot, not a client-backed human) for Feature B's
// tests. When the bot is Black, White's opening move is already played (via
// applyMove, so the board and move list agree) — the exact "bot never
// answers" shape noShow/drops/leaves are tested against.
func newPresenceTestGame(t *testing.T, botColor chess.Color) (*game, *player) {
	t.Helper()
	st, err := variant.New(variantStandard, chess.StartFEN)
	if err != nil {
		t.Fatalf("variant.New: %v", err)
	}
	g := &game{
		id:        newID(),
		state:     st,
		tc:        timeControl{Base: 300_000},
		startFen:  chess.StartFEN,
		variant:   variantStandard,
		clockMs:   [2]int64{300_000, 300_000},
		turnStart: time.Now(),
		online:    [2]bool{true, true},
	}
	bot := newBotPlayer(newBotIdentity(1500), 1500)
	human := &player{id: auth.Identity{UserID: "human-test"}}
	if botColor == chess.White {
		g.white, g.black = bot, human
		return g, bot
	}
	g.white, g.black = human, bot
	if _, ok := g.applyMove("e2e4"); !ok {
		t.Fatal("apply e2e4")
	}
	return g, bot
}

// --- Feature A: the grace formula --------------------------------------------

// The three worked examples from chess.com's published spec: clamped up at
// the fast end, untouched in the middle, clamped down at the slow end.
func TestDisconnectGraceSecondsFormulaAndClamps(t *testing.T) {
	cases := []struct {
		name string
		pool string
		want time.Duration
	}{
		{"3+0: the raw 18s formula clamps up to the 30s minimum", "3+0", 30 * time.Second},
		{"15+10: 130s lands inside the band untouched", "15+10", 130 * time.Second},
		{"30+20: the raw 260s formula clamps down to the 180s maximum", "30+20", 180 * time.Second},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			tc, ok := parseTimeControl(c.pool)
			if !ok {
				t.Fatalf("parseTimeControl(%q) failed", c.pool)
			}
			if got := disconnectGraceSeconds(tc); got != c.want {
				t.Errorf("disconnectGraceSeconds(%s) = %v, want %v", c.pool, got, c.want)
			}
		})
	}
}

// Whatever the time control, the result must never leave [min, max] — the
// clamp is the whole point of the function, not an edge case of it.
func TestDisconnectGraceSecondsNeverLeavesTheBand(t *testing.T) {
	for base := 0; base <= 180; base += 15 {
		for inc := 0; inc <= 180; inc += 15 {
			if base == 0 && inc == 0 {
				continue // parseTimeControl itself rejects 0+0; not a real pool
			}
			tc := timeControl{Base: int64(base) * 60_000, Inc: int64(inc) * 1000}
			got := disconnectGraceSeconds(tc)
			if got < disconnectGraceMin || got > disconnectGraceMax {
				t.Fatalf("base=%dm inc=%ds: grace = %v, out of [%v,%v]", base, inc, got, disconnectGraceMin, disconnectGraceMax)
			}
		}
	}
}

// The 15s "losing badly" shortcut only ever fires off a BOT's own recorded
// eval — never fabricated for a human side, which has none on hand.
func TestGraceDurationForUsesTheLostShortcutOnlyForABotWithAKnownLostEval(t *testing.T) {
	h := New(testSecret)
	g, _ := botOfferGame(t, h) // white human, black bot — botoffers_test.go

	// No eval recorded yet at all: the full formula.
	if got, want := graceDurationFor(g, chess.Black), disconnectGraceSeconds(g.tc); got != want {
		t.Errorf("no eval on hand: grace = %v, want the full formula %v", got, want)
	}

	// A level eval: still the full formula — not lost.
	g.recordBotEval(chess.Black, 20)
	if got, want := graceDurationFor(g, chess.Black), disconnectGraceSeconds(g.tc); got != want {
		t.Errorf("level eval: grace = %v, want the full formula %v", got, want)
	}

	// A lost eval (botResignCp's own "this is over" line): the flat shortcut.
	g.recordBotEval(chess.Black, botResignCp-1)
	if got := graceDurationFor(g, chess.Black); got != disconnectGraceLostFlat {
		t.Errorf("lost eval: grace = %v, want the flat shortcut %v", got, disconnectGraceLostFlat)
	}

	// The human side never has an eval on hand — always the full formula,
	// however the BOT's own game is going (botEvals is per-color, and only a
	// bot's own moves ever populate its slot).
	if got, want := graceDurationFor(g, chess.White), disconnectGraceSeconds(g.tc); got != want {
		t.Errorf("human side: grace = %v, want the full formula %v (no eval to shortcut on)", got, want)
	}
}

// --- Feature A: arming rules --------------------------------------------------

func TestDisconnectGraceNeverArmsBeforeClockStarts(t *testing.T) {
	h := New(testSecret)
	g := newGraceTestGame(t, h, chess.StartFEN, timeControl{Base: 180_000})

	// Fewer than 2 plies: exactly one side offline, which would otherwise arm
	// it — but the clock itself hasn't started, so firstMoveTimeout owns this
	// window instead.
	g.online = [2]bool{true, false}
	g.refreshDisconnectGrace()
	if !g.disconnectGraceAt.IsZero() {
		t.Fatal("armed before the clock started (fewer than 2 plies)")
	}

	padPlies(g, 1) // still short of clocksRunning()'s 2-ply threshold
	g.refreshDisconnectGrace()
	if !g.disconnectGraceAt.IsZero() {
		t.Fatal("armed at 1 ply — clocksRunning() needs 2")
	}
}

func TestRefreshDisconnectGraceArmingRules(t *testing.T) {
	h := New(testSecret)
	g := newGraceTestGame(t, h, chess.StartFEN, timeControl{Base: 180_000})
	padPlies(g, 2) // clocksRunning() now true

	// Both online: ordinary play, disarmed.
	g.online = [2]bool{true, true}
	g.refreshDisconnectGrace()
	if !g.disconnectGraceAt.IsZero() {
		t.Error("armed with both sides online")
	}

	// Both offline: disarmed — nobody present is "waiting" on anybody.
	g.online = [2]bool{false, false}
	g.refreshDisconnectGrace()
	if !g.disconnectGraceAt.IsZero() {
		t.Error("armed with both sides offline")
	}

	// Exactly one offline: armed, for that side.
	g.online = [2]bool{true, false}
	g.refreshDisconnectGrace()
	if g.disconnectGraceAt.IsZero() {
		t.Fatal("not armed with black offline and white present")
	}
	if g.disconnectGraceSide != chess.Black {
		t.Errorf("disconnectGraceSide = %v, want Black", g.disconnectGraceSide)
	}

	// A redundant call for the SAME absence must not push the deadline out —
	// otherwise a flaky opponent connection (or a second device attaching)
	// could keep resetting someone else's countdown forever.
	first := g.disconnectGraceAt
	time.Sleep(2 * time.Millisecond)
	g.refreshDisconnectGrace()
	if !g.disconnectGraceAt.Equal(first) {
		t.Error("refreshDisconnectGrace restarted an already-running timer")
	}
}

// A reconnect (the other side coming back online) must cancel the timer
// outright — the mechanical half of "reconnecting cancels it"; the wire-level
// half (an actual WebSocket reconnect, verifying no further messages) is
// TestDisconnectGraceCarriesDeadlineAndReconnectCancelsIt below.
func TestReconnectCancelsGraceTimer(t *testing.T) {
	h := New(testSecret)
	g := newGraceTestGame(t, h, chess.StartFEN, timeControl{Base: 180_000})
	padPlies(g, 2)
	g.online = [2]bool{true, false}
	g.refreshDisconnectGrace()
	if g.disconnectGraceAt.IsZero() {
		t.Fatal("setup: timer never armed")
	}

	g.online[chess.Black] = true // black reconnects
	g.refreshDisconnectGrace()
	if !g.disconnectGraceAt.IsZero() {
		t.Error("reconnecting did not cancel the grace timer")
	}
}

// --- Feature A: automatic resolution ------------------------------------------

func TestCheckDisconnectGraceResolvesAutomaticallyInFavorOfThePresentSide(t *testing.T) {
	h := New(testSecret)
	var got FinishedGame
	h.OnFinish(func(fg FinishedGame) { got = fg })

	g := newGraceTestGame(t, h, chess.StartFEN, timeControl{Base: 180_000})
	padPlies(g, 2)
	g.online = [2]bool{true, false} // black gone, white still here
	g.refreshDisconnectGrace()
	g.disconnectGraceAt = time.Now().Add(-time.Millisecond) // fast-forward past the deadline

	h.checkDisconnectGrace()

	if !g.over {
		t.Fatal("grace expiry did not end the game")
	}
	if got.Result != "1-0" || got.Reason != "abandon" {
		t.Errorf("result=%q reason=%q, want 1-0/abandon (white present, black abandoned, full material)", got.Result, got.Reason)
	}
}

// An abandoning player must not hand a win to an opponent who can't
// physically deliver mate any more than flagging does — resolveDisconnectGrace
// reuses checkClocks' own CanMate adjudication rather than a second copy.
func TestCheckDisconnectGraceDrawsWhenThePresentSideCannotMate(t *testing.T) {
	h := New(testSecret)
	var got FinishedGame
	h.OnFinish(func(fg FinishedGame) { got = fg })

	g := newGraceTestGame(t, h, "4k3/8/8/8/8/8/8/4K3 w - - 0 1", timeControl{Base: 180_000})
	padPlies(g, 2)
	g.online = [2]bool{true, false} // black gone; white is a lone king
	g.refreshDisconnectGrace()
	g.disconnectGraceAt = time.Now().Add(-time.Millisecond)

	h.checkDisconnectGrace()

	if !g.over {
		t.Fatal("grace expiry did not end the game")
	}
	if got.Result != "1/2-1/2" || got.Reason != "abandon-insufficient-material" {
		t.Errorf("result=%q reason=%q, want a draw — a lone king can't be handed a forced win", got.Result, got.Reason)
	}
}

// --- Feature A: wire-level integration ----------------------------------------

func TestDisconnectGraceCarriesDeadlineAndReconnectCancelsIt(t *testing.T) {
	h := New(testSecret)
	go h.Run()
	srv := httptest.NewServer(http.HandlerFunc(h.ServeWS))
	defer srv.Close()

	a := dialAs(t, srv.URL, "alice", "id-alice")
	defer a.CloseNow()
	b := dialAs(t, srv.URL, "bob", "id-bob")
	defer b.CloseNow()
	readType(t, a, "hello")
	readType(t, b, "hello")
	send(t, a, map[string]any{"type": "queue", "pool": "3+0"})
	send(t, b, map[string]any{"type": "queue", "pool": "3+0"})
	ma := readType(t, a, "matched")
	readType(t, b, "matched")

	white, black, blackID := a, b, "id-bob"
	if ma["color"] == "b" {
		white, black, blackID = b, a, "id-alice"
	}

	// Get the clock running: two plies.
	send(t, white, map[string]any{"type": "move", "move": "e2e4"})
	readType(t, white, "state")
	readType(t, black, "state")
	send(t, black, map[string]any{"type": "move", "move": "e7e5"})
	readType(t, white, "state")
	readType(t, black, "state")

	// Black disconnects: white is told, and the message carries a future
	// grace deadline (the additive field the client renders a countdown
	// from — opponentGone itself is unchanged for anyone not looking for it).
	black.CloseNow()
	gone := readType(t, white, "opponentGone")
	dl, ok := gone["graceDeadline"].(float64)
	if !ok || int64(dl) <= time.Now().UnixMilli() {
		t.Fatalf("opponentGone graceDeadline = %v, want a future epoch-ms deadline", gone["graceDeadline"])
	}

	// Black reconnects well before a 3+0 game's 30s grace could ever expire:
	// white is told the opponent is back, through the same shared path a real
	// reconnect always used.
	b2 := dialAs(t, srv.URL, "bob", blackID)
	defer b2.CloseNow()
	readType(t, b2, "hello")
	readType(t, b2, "resume")
	readType(t, white, "opponentBack")
}

// --- Feature B: presence weights ---------------------------------------------

// Every disposition must actually vary across freshly created bots, roughly
// matching its documented share — a roll stuck on one answer would make the
// whole per-bot idea decorative, exactly like botoffers_test.go's own
// TestBotDispositionsAreBalanced.
func TestBotPresenceDispositionsAreBalanced(t *testing.T) {
	const n = 30000
	counts := map[botPresence]int{}
	for i := 0; i < n; i++ {
		counts[rollBotPresence()]++
	}
	want := map[botPresence]float64{
		presenceNoShow:  presenceNoShowChance,
		presenceDrops:   presenceDropsChance,
		presenceLeaves:  presenceLeavesChance,
		presencePresent: 1 - presenceNoShowChance - presenceDropsChance - presenceLeavesChance,
	}
	for p, chance := range want {
		got := float64(counts[p]) / n
		if got < chance-0.02 || got > chance+0.02 {
			t.Errorf("presence %v: %.4f of rolls, want ~%.4f", p, got, chance)
		}
	}
}

// --- Feature B: noShow ---------------------------------------------------------

// A noShow bot never gets scheduled, whichever color it plays — and the
// EXISTING firstMoveTimeout/abortGame path (untouched by this feature) is
// what actually ends the game, with no result and no rating change.
func TestNoShowBotNeverSchedulesAMoveEitherColor(t *testing.T) {
	for _, botColor := range []chess.Color{chess.White, chess.Black} {
		name := "bot is White — never opens"
		if botColor == chess.Black {
			name = "bot is Black — never answers"
		}
		t.Run(name, func(t *testing.T) {
			h := New(testSecret)
			h.EnableBotFill(6, time.Minute, 1, 8, 1) // in-process fallback engine — no zugzwang configured
			var got FinishedGame
			h.OnFinish(func(fg FinishedGame) { got = fg })

			g, bot := newPresenceTestGame(t, botColor)
			bot.presence = presenceNoShow
			h.games[g.id] = g

			h.scheduleBotMove(g)
			select {
			case r := <-h.botMoves:
				t.Fatalf("a noShow bot scheduled a move: %+v", r)
			case <-time.After(800 * time.Millisecond):
				// Correct: nothing was ever scheduled.
			}

			// firstMoveTimeout's existing stall guard is what actually ends
			// this game — exercised directly (arenabot_test.go's
			// TestArenaAbortReturnsBotsToPool does the same) rather than
			// sleeping out the real 30s in a test.
			h.abortGame(g)
			if !g.over {
				t.Fatal("stalled noShow game never aborted")
			}
			if got.ID != "" {
				t.Error("an aborted game must never reach onFinish — no result, no rating change")
			}
		})
	}
}

// Sanity control for the test above: WITHOUT the noShow disposition, the same
// setup produces a real move — proving the silence above is the disposition
// at work, not a broken test harness.
func TestPresencePresentBotSchedulesNormally(t *testing.T) {
	h := New(testSecret)
	h.EnableBotFill(6, time.Minute, 1, 8, 1)
	g, bot := newPresenceTestGame(t, chess.White)
	bot.presence = presencePresent
	h.games[g.id] = g

	h.scheduleBotMove(g)
	select {
	case r := <-h.botMoves:
		if r.gameID != g.id {
			t.Fatalf("botMoves result for wrong game: %q", r.gameID)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("an ordinary present bot never produced a move — check the test harness before trusting the noShow test")
	}
}

// noShow (and the drops/leaves gate below) must never touch an arena game —
// see armBotDrop's doc for why: it would either strand a real, rated,
// standings-affecting game or fabricate a free win/loss for a tournament that
// never had one.
func TestScheduleBotMoveIgnoresPresenceForArenaGames(t *testing.T) {
	h := New(testSecret)
	h.EnableBotFill(6, time.Minute, 1, 8, 1)
	g, bot := newPresenceTestGame(t, chess.White)
	bot.presence = presenceNoShow
	g.arenaID = "ARENA-1"
	h.games[g.id] = g

	h.scheduleBotMove(g)
	select {
	case r := <-h.botMoves:
		if r.gameID != g.id {
			t.Fatalf("botMoves result for wrong game: %q", r.gameID)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("an arena game must never honor the noShow disposition")
	}
}

// --- Feature B: drops ----------------------------------------------------------

func TestArmBotDropSchedulesOnlyDropsAndLeaves(t *testing.T) {
	h := New(testSecret)
	for _, p := range []botPresence{presencePresent, presenceNoShow, presenceDrops, presenceLeaves} {
		g, bot := newPresenceTestGame(t, chess.White)
		bot.presence = p
		h.armBotDrop(g)
		armed := !g.botDropAt.IsZero()
		want := p == presenceDrops || p == presenceLeaves
		if armed != want {
			t.Errorf("presence=%v: armed=%v, want %v", p, armed, want)
		}
	}
}

func TestArmBotDropExcludesArenaGames(t *testing.T) {
	h := New(testSecret)
	g, bot := newPresenceTestGame(t, chess.White)
	bot.presence = presenceLeaves
	g.arenaID = "ARENA-1"

	h.armBotDrop(g)

	if !g.botDropAt.IsZero() {
		t.Error("an arena bot-fill game must never arm the drop/leave feature")
	}
}

func TestFireBotDropNoOpsForArenaGames(t *testing.T) {
	h := New(testSecret)
	g, bot := newPresenceTestGame(t, chess.White)
	bot.presence = presenceLeaves
	g.arenaID = "ARENA-1"
	g.online = [2]bool{true, true}

	h.fireBotDrop(g)

	if !g.online[chess.White] {
		t.Error("fireBotDrop touched an arena game's online state")
	}
}

func TestCheckBotDropsWaitsForItsOwnBeat(t *testing.T) {
	h := New(testSecret)
	g, bot := newPresenceTestGame(t, chess.White)
	bot.presence = presenceDrops
	g.botDropAt = time.Now().Add(time.Hour) // armed, nowhere near due
	h.games[g.id] = g

	h.checkBotDrops()

	if !g.online[chess.White] {
		t.Error("bot went offline before its own armed beat elapsed")
	}
}

// A drops bot goes offline (suppressing scheduling), then comes back on its
// own and resumes play without the caller having to remember to reschedule.
func TestDropsBotGoesOfflineThenReturnsAndResumesPlay(t *testing.T) {
	h := New(testSecret)
	h.EnableBotFill(6, time.Minute, 1, 8, 1)
	g, bot := newPresenceTestGame(t, chess.White)
	bot.presence = presenceDrops
	h.games[g.id] = g

	// Fire the drop directly — the arm-then-fire beat itself is covered by
	// TestCheckBotDropsWaitsForItsOwnBeat above.
	h.fireBotDrop(g)
	if g.online[chess.White] {
		t.Fatal("fireBotDrop did not take the bot offline")
	}
	if g.botReturnAt.IsZero() {
		t.Fatal("a presenceDrops bot must arm its own return")
	}

	// While offline, scheduling produces nothing — a move due during the
	// outage must be suppressed, not lost.
	h.scheduleBotMove(g)
	select {
	case r := <-h.botMoves:
		t.Fatalf("a dropped bot scheduled a move while offline: %+v", r)
	case <-time.After(300 * time.Millisecond):
	}

	// Fast-forward the return: checkBotDrops must bring it back online AND
	// itself resume scheduling.
	g.botReturnAt = time.Now().Add(-time.Millisecond)
	h.checkBotDrops()
	if !g.online[chess.White] {
		t.Fatal("checkBotDrops did not bring the bot back online")
	}

	select {
	case r := <-h.botMoves:
		if r.gameID != g.id {
			t.Fatalf("botMoves result for wrong game: %q", r.gameID)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("play never resumed after the bot's return")
	}
}

// --- Feature B: leaves, and the interlock with Feature A ----------------------

// The whole reason resolution is automatic (see this file's package doc): a
// presenceLeaves bot's game must be resolved by the grace timer, not hang
// until the human's own clock happens to run out on its own.
func TestLeavesBotIsResolvedByTheGraceTimerNotAHang(t *testing.T) {
	h := New(testSecret)
	var got FinishedGame
	h.OnFinish(func(fg FinishedGame) { got = fg })

	// Bot plays Black and has already answered once, so there's a real game
	// in progress (clock running) at the moment it vanishes for good.
	g, bot := newPresenceTestGame(t, chess.Black)
	bot.presence = presenceLeaves
	if _, ok := g.applyMove("e7e5"); !ok {
		t.Fatal("apply e7e5")
	}
	h.games[g.id] = g

	h.fireBotDrop(g)
	if g.online[chess.Black] {
		t.Fatal("fireBotDrop did not take the leaving bot offline")
	}
	if !g.botReturnAt.IsZero() {
		t.Error("a presenceLeaves bot must never arm its own return — it isn't coming back")
	}
	if g.disconnectGraceAt.IsZero() {
		t.Fatal("Feature A's grace timer never armed for the leaving bot")
	}

	// Fast-forward the grace timer and let Feature A resolve it, exactly as
	// it would for any other abandonment.
	g.disconnectGraceAt = time.Now().Add(-time.Millisecond)
	h.checkDisconnectGrace()

	if !g.over {
		t.Fatal("a presenceLeaves bot's game hung instead of being resolved by the grace timer")
	}
	if got.Reason != "abandon" {
		t.Errorf("reason = %q, want abandon", got.Reason)
	}
}

// A drop must never last long enough to reach the grace minimum itself —
// otherwise an ordinary temporary drop could occasionally get misadjudicated
// as an abandonment before the bot ever had a chance to return.
func TestDropDurationNeverReachesTheGraceMinimum(t *testing.T) {
	for i := 0; i < 2000; i++ {
		if d := botDropOfflineDuration(); d >= disconnectGraceMin {
			t.Fatalf("a drop lasted %v, which would reach the grace minimum %v", d, disconnectGraceMin)
		}
	}
}

// --- misc bounds ---------------------------------------------------------------

func TestBotDropDelayBounds(t *testing.T) {
	cases := []timeControl{
		{Base: 60_000},                 // bullet
		{Base: 300_000},                // blitz
		{Base: 1_800_000, Inc: 20_000}, // classical
	}
	for _, tc := range cases {
		for i := 0; i < 200; i++ {
			d := botDropDelay(tc)
			if d < botDropDelayFloor || d > botDropDelayCeil {
				t.Fatalf("botDropDelay(%+v) = %v, out of [%v,%v]", tc, d, botDropDelayFloor, botDropDelayCeil)
			}
		}
	}
}

func TestBotDropOfflineDurationBounds(t *testing.T) {
	for i := 0; i < 500; i++ {
		d := botDropOfflineDuration()
		if d < 3*time.Second || d > 15*time.Second {
			t.Fatalf("botDropOfflineDuration = %v, want [3s,15s]", d)
		}
	}
}

// A player who drops after their own first move but before the reply lands is
// offline at a moment when clocksRunning() is still false, so the disconnect hook
// cannot arm anything. The move that starts the clocks has to arm it instead —
// without that the game sits until their clock expires, which on a 30+0 is the
// half-hour wait the grace timer exists to prevent.
func TestGraceArmsOnTheMoveThatStartsTheClocks(t *testing.T) {
	h := New(testSecret)
	g, _ := botOfferGame(t, h)     // one ply played, clocks not yet running
	g.online = [2]bool{true, true} // as every real game is created

	// The human is gone before the reply.
	g.online[chess.White] = false
	g.refreshDisconnectGrace()
	if !g.disconnectGraceAt.IsZero() {
		t.Fatal("grace must not arm before the clocks start — that window is firstMoveTimeout's")
	}

	// The bot replies: ply 2, clocks now running, and the absence is still real.
	if _, ok := g.applyMove("e7e5"); !ok {
		t.Fatal("apply e7e5")
	}
	if !g.clocksRunning() {
		t.Fatal("two plies should have started the clocks")
	}
	if g.disconnectGraceAt.IsZero() {
		t.Error("the move that started the clocks did not arm the grace timer")
	}
	if g.disconnectGraceSide != chess.White {
		t.Errorf("grace armed against %v, want the absent side (White)", g.disconnectGraceSide)
	}
}

// Arming is idempotent per absence: a running countdown must not restart every
// time the present player moves, or an absent opponent could never be timed out
// in a game where the other side keeps playing.
func TestGraceCountdownDoesNotRestartOnEveryMove(t *testing.T) {
	h := New(testSecret)
	g, _ := botOfferGame(t, h)
	g.online = [2]bool{true, true}
	if _, ok := g.applyMove("e7e5"); !ok {
		t.Fatal("apply e7e5")
	}
	g.online[chess.White] = false
	g.refreshDisconnectGrace()
	first := g.disconnectGraceAt
	if first.IsZero() {
		t.Fatal("grace did not arm")
	}

	if _, ok := g.applyMove("g1f3"); !ok {
		t.Fatal("apply g1f3")
	}
	if !g.disconnectGraceAt.Equal(first) {
		t.Errorf("deadline moved from %v to %v — the countdown restarted", first, g.disconnectGraceAt)
	}
}
