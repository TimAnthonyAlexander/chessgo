package hub

import (
	mrand "math/rand/v2"
	"time"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// This file is everything a fill-in bot does that ISN'T playing a move: answering
// a takeback offer, answering a draw offer, offering a draw of its own, and
// resigning a lost game. Without it a bot opponent is a player who never once
// reacts to you — every offer sits unanswered until it expires, and a bot plays on
// a queen down until mate. That is the loudest tell there is that nobody is there.
//
// Two rules shape all of it.
//
// EVERY DISPOSITION IS ROLLED ONCE PER BOT, never per request (see the player
// fields below). Some opponents give takebacks, some take draws, some resign when
// they're lost and some make you mate them — but whichever one you got, you got it
// for the whole game. Re-rolling per request would mean re-asking until you got the
// answer you wanted, which is a 100% acceptance rate wearing a percentage label.
//
// AND THE EVAL IS FREE. Every bot move already comes back from zugzwang with the
// search's own score for the position (botMoveResult.evalCp), so "am I lost?" and
// "is this dead equal?" cost nothing — no second search, no extra HTTP call, no
// analysis pass. The hub just records what the bot already thought.
//
// All of it runs on the Run goroutine, off the existing 200ms ticker.

// Per-bot dispositions, rolled in newBotPlayer. The offer chances are deliberately
// not all the same: a person is likelier to take a draw they're offered than to be
// the one who offers, and likelier to offer a draw in a dead position than to hand
// you a takeback.
const (
	botTakebackAcceptChance = 0.50 // gives takebacks
	botAcceptDrawChance     = 0.55 // takes a draw when offered one
	botOfferDrawChance      = 0.20 // offers a draw itself — deliberately uncommon
	botResignChance         = 0.50 // resigns a lost game rather than playing it out
)

// Eval thresholds, in centipawns from the BOT's point of view.
const (
	// drawishCp is how far off dead level still counts as "centered". A third of
	// a pawn either way is a position neither side is making progress in.
	drawishCp = 40

	// botResignCp is the "this is over" line: about a queen down. The score is the
	// bot's own search talking, so it already folds in position — a queen down with
	// compensation does not reach this, and a rook down in a hopeless ending does.
	botResignCp = -900
)

// How long a read has to hold before the bot acts on it. A single search can spike
// (a shallow ply, a tablebase probe landing) and acting on one sample would have
// bots resigning on noise and offering draws in sharp positions.
const (
	botEvalHistory       = 8  // recorded evals kept per side
	botDrawEvalSustain   = 4  // bot moves the eval must have stayed centered
	botResignEvalSustain = 2  // bot moves the eval must have stayed lost
	botDrawMinPly        = 40 // no draw offers before move 20 — the opening is level by definition
)

// botOfferAnswerDelay is the pause before a bot answers an offer: long enough to
// read as someone noticing it and deciding, short enough not to feel abandoned.
func botOfferAnswerDelay() time.Duration {
	return time.Duration(1200+mrand.IntN(3300)) * time.Millisecond // 1.2s–4.5s
}

// botConcessionDelay is the pause before a bot offers a draw or resigns — longer
// than answering, because this one is the bot's own idea and a person sits and
// looks at the board before giving up or asking for a split.
func botConcessionDelay() time.Duration {
	return time.Duration(2000+mrand.IntN(4000)) * time.Millisecond // 2.0s–6.0s
}

// --- eval bookkeeping ------------------------------------------------------

// recordBotEval stores the score a bot's own search returned for the move it just
// played, from that bot's point of view. Bounded to the last botEvalHistory.
func (g *game) recordBotEval(c chess.Color, cp int) {
	e := append(g.botEvals[c], cp)
	if len(e) > botEvalHistory {
		e = e[len(e)-botEvalHistory:]
	}
	g.botEvals[c] = e
}

// lastBotEval returns the bot's most recent score, ok=false if it has never
// reported one — a self-search variant, or a bot that hasn't moved yet.
func (g *game) lastBotEval(c chess.Color) (int, bool) {
	e := g.botEvals[c]
	if len(e) == 0 {
		return 0, false
	}
	return e[len(e)-1], true
}

// botEvalStreak reports whether the last `n` scores this bot reported ALL satisfy
// `pred`. False when it has reported fewer than n — an unproven read is not a
// streak.
func (g *game) botEvalStreak(c chess.Color, n int, pred func(cp int) bool) bool {
	e := g.botEvals[c]
	if n <= 0 || len(e) < n {
		return false
	}
	for _, cp := range e[len(e)-n:] {
		if !pred(cp) {
			return false
		}
	}
	return true
}

// isCenteredCp is the "nobody is getting anywhere" test: level, or a shade either
// way. This is the sustained condition a bot offers a draw on.
func isCenteredCp(cp int) bool { return cp >= -drawishCp && cp <= drawishCp }

// isLostCp is the "this is over" test — see botResignCp.
func isLostCp(cp int) bool { return cp <= botResignCp }

// --- answering offers ------------------------------------------------------

// takebackResponder returns the side that owes an answer to the standing takeback
// offer — the one that did not make it — and whether it is a bot.
func (g *game) takebackResponder() (*player, bool) {
	if !g.takebackPending {
		return nil, false
	}
	return g.botResponderTo(g.takebackBy)
}

// drawResponder is takebackResponder for the standing draw offer.
func (g *game) drawResponder() (*player, bool) {
	if !g.drawPending {
		return nil, false
	}
	return g.botResponderTo(g.drawBy)
}

// botResponderTo returns the side facing an offer made by `by`, and whether the
// hub has to answer for it — a bot has no client to press accept or decline, a
// human answers for themselves.
func (g *game) botResponderTo(by chess.Color) (*player, bool) {
	p := g.playerFor(by.Opposite())
	return p, p.isBot
}

// checkBotTakebacks answers takeback offers standing against a bot once their beat
// has elapsed. The verdict is the BOT's fixed disposition (player.takebackFriendly,
// rolled at creation), NOT a fresh roll — re-asking a bot that said no gets the
// same no every time, so a player can't spam offers until one lands.
func (h *Hub) checkBotTakebacks() {
	now := time.Now()
	for _, g := range h.games {
		if g.over || g.takebackAnswerAt.IsZero() || now.Before(g.takebackAnswerAt) {
			continue
		}
		bot, isBot := g.takebackResponder()
		if !isBot {
			g.takebackAnswerAt = time.Time{} // stale arming; nothing owes an answer
			continue
		}
		if bot.takebackFriendly {
			h.applyTakeback(g) // clearOffers() disarms
			continue
		}
		g.takebackPending = false
		g.takebackAnswerAt = time.Time{}
		h.broadcastPlayers(g, mustJSON(out("takebackDeclined", map[string]any{"gameId": g.id})))
	}
}

// checkBotDraws answers draw offers standing against a bot. It takes the draw only
// if it is BOTH the kind of opponent who takes draws (player.acceptsDraws, fixed)
// AND not winning — nobody agrees to a draw in a position they are converting.
//
// "Not winning" rather than "level" is deliberate: a bot being taken apart should
// bite your hand off for a draw, and declining one while a queen down is not
// something a person does. So the test is a ceiling, not a band.
//
// Spamming offers gets nowhere for the same reason it does not with takebacks: the
// disposition is fixed per bot, and the eval it checks moves at the speed of the
// game rather than the speed of clicking.
func (h *Hub) checkBotDraws() {
	now := time.Now()
	for _, g := range h.games {
		if g.over || g.drawAnswerAt.IsZero() || now.Before(g.drawAnswerAt) {
			continue
		}
		g.drawAnswerAt = time.Time{}
		bot, isBot := g.drawResponder()
		if !isBot {
			continue // stale arming; a human answers for themselves
		}
		cp, known := g.lastBotEval(g.drawBy.Opposite())
		if bot.acceptsDraws && known && cp <= drawishCp {
			h.finish(g, "1/2-1/2", "agreement")
			continue
		}
		g.drawPending = false
		h.broadcastPlayers(g, mustJSON(out("drawDeclined", map[string]any{"gameId": g.id})))
	}
}

// --- offering and resigning ------------------------------------------------

// considerBotConcession runs right after a bot's move lands, with that move's own
// eval already recorded, and decides whether the bot wants out of the game. Both
// outcomes are ARMED here and fired later by checkBotConcessions, so the bot
// doesn't resign in the same instant as its move — it moves, sits there, and then
// gives up, the way a person does.
//
// Resignation is checked first and returns: a lost game is not a game you offer a
// draw in.
func (h *Hub) considerBotConcession(g *game, botColor chess.Color) {
	bot, side, ok := g.botVsHumanSide()
	if !ok || side != botColor || g.over {
		return // fillers, arena bot-vs-bot and human-vs-human concede nothing
	}

	if bot.resigns && g.botResignAt.IsZero() &&
		g.botEvalStreak(botColor, botResignEvalSustain, isLostCp) {
		g.botResignAt = time.Now().Add(botConcessionDelay())
		return
	}

	// One draw offer per game. A bot that asks every move until you cave is a
	// worse opponent than one that never asks at all.
	if bot.offersDraws && !g.botDrawOffered && !g.drawPending &&
		g.botDrawOfferAt.IsZero() && len(g.moves) >= botDrawMinPly &&
		g.botEvalStreak(botColor, botDrawEvalSustain, isCenteredCp) {
		g.botDrawOfferAt = time.Now().Add(botConcessionDelay())
	}
}

// checkBotConcessions fires an armed resignation or draw offer once its beat has
// elapsed. Run-goroutine entry (ticker).
func (h *Hub) checkBotConcessions() {
	now := time.Now()
	for _, g := range h.games {
		if g.over {
			continue
		}
		if !g.botResignAt.IsZero() && !now.Before(g.botResignAt) {
			g.botResignAt = time.Time{}
			h.botResign(g)
			continue
		}
		if !g.botDrawOfferAt.IsZero() && !now.Before(g.botDrawOfferAt) {
			g.botDrawOfferAt = time.Time{}
			h.botOfferDraw(g)
		}
	}
}

// botResign ends the game the same way a human resignation does — same result,
// same "resign" reason, same finish() path — so nothing downstream (persistence,
// Elo, the result screen) can tell the difference.
func (h *Hub) botResign(g *game) {
	_, botColor, ok := g.botVsHumanSide()
	if !ok || g.over {
		return
	}
	result := "0-1"
	if botColor == chess.Black {
		result = "1-0"
	}
	h.finish(g, result, "resign")
}

// botOfferDraw puts a draw offer up from the bot, through the same payload a human
// offer produces. The human accepts or declines it with the buttons they already
// have; their reply lands in drawAccept/drawDecline unchanged. Like any offer it
// dies on the opponent's next move (clearOffers).
func (h *Hub) botOfferDraw(g *game) {
	_, botColor, ok := g.botVsHumanSide()
	if !ok || g.over || g.drawPending {
		return
	}
	g.drawPending, g.drawBy = true, botColor
	g.botDrawOffered = true
	h.broadcastPlayers(g, mustJSON(out("drawOffered", map[string]any{
		"gameId": g.id,
		"by":     colorStr(botColor),
	})))
}
