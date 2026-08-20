package hub

import (
	mrand "math/rand/v2"
	"time"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// This file is everything about a player NOT being there: the automatic grace
// timer that resolves a game when a disconnected side never comes back
// (real humans on either side, AND bots), and the fixed per-bot disposition
// that makes a fill-in bot occasionally behave like the real opponents it's
// standing in for — one who never shows up, one whose connection blips, one
// who quits for good. Same two rules as botoffers.go, because this is the
// same feature family:
//
// EVERY DISPOSITION IS ROLLED ONCE PER BOT (in newBotPlayer), never per game
// event, for the same reason takebackFriendly etc. are — see botoffers.go's
// doc.
//
// EVERYTHING RUNS ON THE RUN GOROUTINE, off the existing 200ms ticker, arm
// then fire, exactly like every other bot timer in botoffers.go.

// --- Feature A: the disconnect grace timer ---------------------------------
//
// Before this, a disconnected player was simply gone: opponentGone went out
// and then nothing happened until their own clock ran out naturally — in a
// 30+0 classical game, up to half an hour of a still opponent staring at a
// dead board. The grace timer below runs ALONGSIDE the clock (which is left
// completely alone — see game.go's remainingMs) and resolves the game the
// moment it expires, whichever of the two fires first.
//
// Resolution is AUTOMATIC, not a manual "claim victory" button, and that is
// load-bearing rather than a convenience choice: Watch-lobby filler games are
// bot-vs-bot with no human seated on either side (filler.go), so a
// manual-only claim would NEVER resolve one — which is exactly the
// "disconnected filler holds the board for half an hour" case this feature
// exists to kill. Automatic resolution is the only design that covers both a
// human waiting on a human and nobody waiting on anybody.

// disconnectGraceMin/Max bound the automatic grace period a still-connected
// side waits before a disconnected opponent's game is resolved without them —
// chess.com's published bounds (support.chess.com/en/articles/8593801). A
// bullet game gets barely half a minute; a slow classical game is capped at 3
// minutes, well short of the ~4m20s the raw formula would give it, because
// grace exists to cover a network blip, not to let someone step away from a
// long game for a coffee.
const (
	disconnectGraceMin = 30 * time.Second
	disconnectGraceMax = 180 * time.Second

	// disconnectGraceLostFlat is chess.com's documented override: if the
	// disconnected side is getting demolished, making the opponent sit out
	// the ordinary grace window just delays an already-decided result. 15s
	// is enough to rule out "actually reconnecting right now" without
	// dragging out the inevitable.
	disconnectGraceLostFlat = 15 * time.Second
)

// disconnectGraceSeconds implements chess.com's published formula:
// (base seconds + 40 × increment seconds) × 0.1, clamped to
// [disconnectGraceMin, disconnectGraceMax]. Examples the clamp is built to
// hit exactly: 3+0 → the raw formula gives 18s, clamped UP to 30s; 15+10 →
// 130s, inside the band untouched; 30+20 → the raw formula gives 260s,
// clamped DOWN to 180s.
//
// timeControl.Base/Inc are MILLISECONDS (protocol.go's doc), not the
// minutes/seconds the formula is stated in — both are converted to seconds
// before the arithmetic runs, and the multiply-then-clamp order matters:
// doing it in milliseconds and dividing once at the end would still land in
// the same band for these examples by luck of scale, but would silently
// mis-clamp a time control sitting right at a boundary, since the clamp
// constants above are themselves in seconds-equivalent Duration units.
func disconnectGraceSeconds(tc timeControl) time.Duration {
	baseSec := float64(tc.Base) / 1000.0
	incSec := float64(tc.Inc) / 1000.0
	grace := (baseSec + 40*incSec) * 0.1 // seconds
	d := time.Duration(grace * float64(time.Second))
	switch {
	case d < disconnectGraceMin:
		return disconnectGraceMin
	case d > disconnectGraceMax:
		return disconnectGraceMax
	default:
		return d
	}
}

// graceDurationFor picks the grace duration for one specific absence of
// `side`: the ordinary formula above UNLESS `side` is a bot with a recorded
// eval (game.go's botEvals, populated for free by every engine-pool bot move
// — see botoffers.go's doc) that reads as lost (isLostCp, botoffers.go's
// "this is over" line), in which case it's disconnectGraceLostFlat —
// chess.com's documented shortcut for a side that's already losing badly.
//
// A HUMAN side never has an eval on hand: the hub does not run a speculative
// search just to answer "are they losing?" for this feature alone — that
// would be a real cost (an extra zugzwang round trip) paid on every ordinary
// human disconnect for a refinement that only matters at the margin. So a
// disconnected human always gets the full formula; only a bot's OWN,
// already-free eval can ever unlock the 15s shortcut. This is not a gap to
// close casually — see this file's package doc on fabricating signals.
func graceDurationFor(g *game, side chess.Color) time.Duration {
	if cp, ok := g.lastBotEval(side); ok && isLostCp(cp) {
		return disconnectGraceLostFlat
	}
	return disconnectGraceSeconds(g.tc)
}

// refreshDisconnectGrace re-evaluates the grace timer after ANY online-state
// change for this game — a genuine human disconnect/reconnect (hub.go's
// handleDisconnect/attachToGame) or a bot going/coming from a scripted
// absence (fireBotDrop/fireBotReturn below). It is the single place that
// decides whether the timer is armed, for whom, and with what deadline, so
// those four call sites can never drift into disagreeing about it.
//
// Armed iff EXACTLY ONE side is online: a present side is actually waiting on
// a genuinely absent one. Both online is ordinary play — disarmed. BOTH
// OFFLINE is ALSO disarmed, deliberately: with the "waiting" side gone too,
// resolving now would still be handing a win to someone who isn't there to
// claim it, and whichever side reconnects first would find its own game
// already decided by a clock nobody was watching on the other end. Instead a
// mutual outage simply pauses the countdown — the moment one side comes back
// while the other is STILL away, this function reruns (from that side's own
// reconnect) and arms a fresh timer for whoever is still gone, so nobody is
// punished for a blip that happened to overlap the other side's own blip.
//
// Never armed before the clock itself has started (g.clocksRunning()) — that
// window belongs to firstMoveTimeout (hub.go's 30s stall abort), untouched by
// this feature entirely.
func (g *game) refreshDisconnectGrace() {
	if !g.clocksRunning() {
		g.disconnectGraceAt = time.Time{}
		return
	}
	wOnline, bOnline := g.online[chess.White], g.online[chess.Black]
	if wOnline == bOnline {
		g.disconnectGraceAt = time.Time{}
		return
	}
	away := chess.White
	if wOnline {
		away = chess.Black
	}
	if !g.disconnectGraceAt.IsZero() && g.disconnectGraceSide == away {
		return // already counting down for this exact absence — don't restart the clock
	}
	g.disconnectGraceSide = away
	g.disconnectGraceAt = time.Now().Add(graceDurationFor(g, away))
}

// checkDisconnectGrace resolves any game whose grace timer (armed by
// refreshDisconnectGrace) has expired before the flag did. Ticker entry,
// mirrors hub.go's checkClocks in shape.
func (h *Hub) checkDisconnectGrace() {
	now := time.Now()
	for _, g := range h.games {
		if g.over {
			continue
		}
		// Catch any countdown that armed without the present side being told —
		// see announceArmedGrace. Doing it here rather than at each arming site
		// means every path (disconnect, bot drop, and the move that starts the
		// clocks) is covered by one hook that cannot be forgotten by the next one.
		h.announceArmedGrace(g)
		if g.disconnectGraceAt.IsZero() || now.Before(g.disconnectGraceAt) {
			continue
		}
		h.resolveDisconnectGrace(g)
	}
}

// resolveDisconnectGrace ends a game whose absent side's grace has run out.
// It reuses the EXACT SAME adjudication a flag gets (checkClocks/
// game.state.CanMate) rather than a second copy of that logic: an abandoning
// player must not hand a win to an opponent sitting with a lone king any more
// than flagging does — CanMate already answers that per variant (standard
// checks material; Duck/Crazyhouse/Antichess/Secret Queen a king is always
// capturable, so it's always true there), so there is nothing variant-
// specific for this function to know.
func (h *Hub) resolveDisconnectGrace(g *game) {
	side := g.disconnectGraceSide
	g.disconnectGraceAt = time.Time{}
	opp := side.Opposite()
	result, reason := "1/2-1/2", "abandon-insufficient-material"
	if g.state.CanMate(opp) {
		reason = "abandon"
		if opp == chess.White {
			result = "1-0"
		} else {
			result = "0-1"
		}
	}
	h.finish(g, result, reason)
}

// sendOpponentGone tells the side still connected on the OTHER side of
// awaySide that it just went offline, carrying the grace deadline (epoch ms)
// as an ADDITIVE "graceDeadline" field whenever refreshDisconnectGrace armed
// one for this absence. Omitted (not merely zero/null) when it didn't — e.g.
// the pre-clock window, which firstMoveTimeout alone covers — so a client
// that predates this field behaves exactly as it always did, and a client
// that knows the field can render a countdown only when there's a real
// deadline to count down to.
func (h *Hub) sendOpponentGone(g *game, awaySide chess.Color) {
	opp := g.playerFor(awaySide.Opposite())
	if !opp.connected() {
		return // nobody there to tell
	}
	payload := map[string]any{"gameId": g.id}
	if !g.disconnectGraceAt.IsZero() {
		payload["graceDeadline"] = g.disconnectGraceAt.UnixMilli()
		// What the countdown is actually worth to the recipient, decided the same
		// way resolveDisconnectGrace will decide it: a player who cannot mate gets
		// a draw out of an abandonment, not a win, and a banner promising a win it
		// then doesn't deliver is worse than no banner.
		payload["graceOutcome"] = "draw"
		if g.state.CanMate(awaySide.Opposite()) {
			payload["graceOutcome"] = "win"
		}
	}
	g.graceAnnounced = g.disconnectGraceAt
	opp.send(mustJSON(out("opponentGone", payload)))
}

// announceArmedGrace tells the present side about a countdown that started
// AFTER they were told their opponent was gone. The deadline is not always
// known at disconnect time: refreshDisconnectGrace refuses to arm before
// clocksRunning(), so a player who dropped during the first two plies gets
// their opponentGone with no deadline in it, and the timer only starts on the
// move that finally starts the clocks. Without this the banner would sit on
// "disconnected" forever and the game would then just end, which is precisely
// the "I had no idea I was about to win" complaint this exists to answer.
//
// Comparing against graceAnnounced rather than a bool also re-announces a
// deadline that CHANGED (a fresh absence after a reconnect), so the countdown
// on screen is never a stale one from an earlier disconnect.
func (h *Hub) announceArmedGrace(g *game) {
	if g.disconnectGraceAt.Equal(g.graceAnnounced) {
		return
	}
	if g.disconnectGraceAt.IsZero() {
		g.graceAnnounced = time.Time{} // disarmed; opponentBack already told them
		return
	}
	h.sendOpponentGone(g, g.disconnectGraceSide)
}

// sendOpponentBack tells the side on the OTHER side of backSide that it just
// reconnected (or, for a bot, came back from a scripted drop). Shared by
// hub.go's attachToGame (a real reconnect) and fireBotReturn below (a bot's
// own drop ending) so the two can never emit a differently-shaped message
// for what the client should treat as the same event.
func (h *Hub) sendOpponentBack(g *game, backSide chess.Color) {
	// Whether or not anyone is listening, the countdown they were told about is
	// no longer running — clearing this is what lets a LATER absence announce its
	// own fresh deadline instead of being mistaken for the one already on screen.
	g.graceAnnounced = time.Time{}
	opp := g.playerFor(backSide.Opposite())
	if !opp.connected() {
		return
	}
	opp.send(mustJSON(out("opponentBack", map[string]any{"gameId": g.id})))
}

// --- Feature B: a bot is sometimes not there --------------------------------
//
// A fill-in bot is otherwise perfectly, suspiciously present: it never stalls
// on its first move, never blips offline, never vanishes for good — three
// things a real opponent routinely does. botPresence rolls ONE of those (or
// none) per bot, once, at creation, exactly like takebackFriendly/resigns/
// rematchFriendly in botoffers.go.

// botPresence is a bot's fixed disposition for whether — and how — it is
// ever absent during its OWN game. presencePresent is the zero value
// deliberately: every player{} literal in this codebase that doesn't set it
// (every human side, and any bot built by a path that predates this feature)
// is "present" by default, which is exactly today's unchanged behavior.
type botPresence int

const (
	presencePresent botPresence = iota // today's behavior: always there (the overwhelming majority)
	presenceNoShow                     // never plays its first move at all
	presenceDrops                      // blips offline once, mid-game, then comes back
	presenceLeaves                     // blips offline once, mid-game, and never comes back
)

// Roughly the shares real opponents split into: the great majority show up
// and stay, a small slice never shows at all, a slightly larger slice has a
// connection that blips, and a rare few vanish for good. rollBotPresence
// checks these in order and whatever doesn't match any of them is
// presencePresent — there is no explicit "present" chance to keep in sync
// with the other three.
// Dialed down from the first cut (4%/6%/2%, i.e. something happening in about
// one game in eight): played back to back that reads as a flaky site rather than
// as the occasional real opponent with a bad connection. At these shares roughly
// one game in thirty has any absence at all, and an outright abandonment is rare
// enough to stay surprising.
const (
	presenceNoShowChance = 0.010
	presenceDropsChance  = 0.020
	presenceLeavesChance = 0.005
)

// rollBotPresence rolls a bot's ONE presence disposition for the whole game
// it's about to play — called from newBotPlayer, alongside every other
// fixed manner a bot gets.
func rollBotPresence() botPresence {
	switch r := mrand.Float64(); {
	case r < presenceNoShowChance:
		return presenceNoShow
	case r < presenceNoShowChance+presenceDropsChance:
		return presenceDrops
	case r < presenceNoShowChance+presenceDropsChance+presenceLeavesChance:
		return presenceLeaves
	default:
		return presencePresent
	}
}

// botDropDelayFloor/Ceil bound how far into the game a presenceDrops/
// presenceLeaves bot's one scripted absence lands, regardless of time
// control: never sooner than a few seconds in (a drop in the first instant
// would just look like the bot never showed, which is presenceNoShow's job,
// not this one's), and never so late that a fast time control's game is
// likely already over before it ever fires.
const (
	botDropDelayFloor = 5 * time.Second
	botDropDelayCeil  = 90 * time.Second

	// botDropDelayMinFrac/MaxFrac pick the random point as a FRACTION of the
	// time control's base time, so a bullet game's drop lands early (in
	// absolute terms) and a classical game's can land meaningfully later —
	// clamped by the floor/ceiling above either way.
	botDropDelayMinFrac = 0.05
	botDropDelayMaxFrac = 0.60
)

// botDropDelay picks the random real-time delay (from game start) at which a
// presenceDrops/presenceLeaves bot's one absence begins.
func botDropDelay(tc timeControl) time.Duration {
	base := time.Duration(tc.Base) * time.Millisecond
	lo := time.Duration(float64(base) * botDropDelayMinFrac)
	hi := time.Duration(float64(base) * botDropDelayMaxFrac)
	if lo < botDropDelayFloor {
		lo = botDropDelayFloor
	}
	if hi > botDropDelayCeil {
		hi = botDropDelayCeil
	}
	if hi < lo {
		hi = lo
	}
	return lo + time.Duration(mrand.Int64N(int64(hi-lo)+1))
}

// botDropOfflineDuration picks how long a presenceDrops bot stays offline —
// 3 to 15 seconds, per this feature's spec. Comfortably under
// disconnectGraceMin (30s), so a "drops" bot can never be adjudicated by its
// own absence — only a presenceLeaves bot, whose absence never ends, ever
// reaches the grace timer. That's the interlock between the two features:
// see fireBotDrop's doc.
func botDropOfflineDuration() time.Duration {
	const min, max = 3 * time.Second, 15 * time.Second
	return min + time.Duration(mrand.Int64N(int64(max-min)+1))
}

// armBotDrop schedules a presenceDrops/presenceLeaves bot's one absence for
// THIS game, if its disposition calls for one. A no-op for presencePresent/
// presenceNoShow (nothing to schedule) and for any arena or filler game (see
// this function's arenaID/botVsHumanSide checks) — an arena's bot-vs-bot and
// bot-fill games feed the tournament standings directly, and a bot that
// silently vanished mid-game there would either strand its human opponent in
// a real, rated, scored game the same way a genuine disconnect would (not
// this feature's problem to solve — that's Feature A) or, for bot-vs-bot,
// hand a free win/loss to whichever bot happened not to "leave", corrupting
// the standings for a fabricated reason a real tournament would never have. A
// filler (Watch-lobby bot-vs-bot) has no human to ever see the absence, so
// there is nothing for it to simulate either.
//
// Called once, right after a genuine bot-vs-human game is registered
// (bot.go's startBotGame, rematch.go's startBotRematch) — not from
// newBotPlayer itself, because the random delay (botDropDelay) needs the
// game's own time control, and newBotPlayer runs before the game housing it
// even exists.
func (h *Hub) armBotDrop(g *game) {
	bot, _, ok := g.botVsHumanSide()
	if !ok || g.arenaID != "" {
		return
	}
	switch bot.presence {
	case presenceDrops, presenceLeaves:
		g.botDropAt = time.Now().Add(botDropDelay(g.tc))
	}
}

// checkBotDrops fires an armed bot absence (botDropAt) and an armed bot
// return (botReturnAt) once their beat has elapsed — ticker entry, the same
// arm-then-fire shape as every timer in botoffers.go.
func (h *Hub) checkBotDrops() {
	now := time.Now()
	for _, g := range h.games {
		if g.over {
			continue
		}
		if !g.botDropAt.IsZero() && !now.Before(g.botDropAt) {
			g.botDropAt = time.Time{}
			h.fireBotDrop(g)
		}
		if !g.botReturnAt.IsZero() && !now.Before(g.botReturnAt) {
			g.botReturnAt = time.Time{}
			h.fireBotReturn(g)
		}
	}
}

// fireBotDrop takes a presenceDrops/presenceLeaves bot offline: flips
// g.online false for its side (the SAME flag a real disconnect flips — every
// other piece of code that reads it, scheduleBotMove's suppression below,
// game.remainingMs, resumeMsg's opponentOnline, doesn't need to know this
// absence is scripted rather than real), tells the human via the same
// opponentGone path a real disconnect uses (carrying Feature A's grace
// deadline, since refreshDisconnectGrace runs right here), and — for
// presenceDrops only — arms the bot's own return. A presenceLeaves bot's
// botReturnAt is deliberately left unarmed: it never comes back, so Feature
// A's grace timer (just armed by refreshDisconnectGrace above) is the ONLY
// thing that ever ends this game — the two features interlock exactly there.
func (h *Hub) fireBotDrop(g *game) {
	bot, botColor, ok := g.botVsHumanSide()
	if !ok || g.arenaID != "" || g.over {
		return
	}
	g.online[botColor] = false
	g.refreshDisconnectGrace()
	h.sendOpponentGone(g, botColor)
	if bot.presence == presenceDrops {
		g.botReturnAt = time.Now().Add(botDropOfflineDuration())
	}
}

// fireBotReturn brings a presenceDrops bot back online: flips g.online back
// to true, re-evaluates the grace timer (disarming the one fireBotDrop just
// armed, since the absence it was counting down is now over), tells the
// human via the same opponentBack path a real reconnect uses, and re-invokes
// scheduleBotMove — a move that came due WHILE the bot was "offline" was
// suppressed there (scheduleBotMove's online check, bot.go), not lost, so
// this is what actually plays it.
func (h *Hub) fireBotReturn(g *game) {
	_, botColor, ok := g.botVsHumanSide()
	if !ok || g.over {
		return
	}
	g.online[botColor] = true
	g.refreshDisconnectGrace()
	h.sendOpponentBack(g, botColor)
	h.scheduleBotMove(g)
}
