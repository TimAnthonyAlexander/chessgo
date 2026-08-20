package hub

import (
	"time"

	"github.com/timanthonyalexander/gomachine/internal/chess"
	"github.com/timanthonyalexander/gomachine/internal/variant"
)

// Rematch: once a game ends, either participant may offer to play the same
// opponent again — colors swapped, same time control / variant / rated flag.
// It mirrors the draw-offer shape (drawPending/drawBy) but the offer has to
// outlive the game object itself: finish() tears the game down (clearing each
// Client's `.game`) before either player has a chance to click anything, so
// the finished game is instead held on the client's `lastGame` pointer.
//
// A finished game's whole rematch window — armed by armRematch at finish(),
// whether or not an offer is ever made — is indexed in h.rematchWindows and
// swept by the ticker after rematchTTL, the same shape as challenge's TTL
// reap (checkChallenges).
//
// A fill-in bot opponent answers a rematch offer too, the same shape as
// takeback/draw offers against a bot (botoffers.go): rematchOffer arms
// g.rematchAnswerAt when the side that owes the answer is a bot, and
// checkBotRematches fires it after a human-ish beat. Without this, the
// frontend's Rematch button — which never learns the opponent was a bot, by
// design — sat "Offered…" for the full rematchTTL because nobody was ever
// going to click accept. Bots never OFFER a rematch of their own; they only
// answer one a human made.

// rematchTTL bounds how long a finished game stays rematch-eligible: an
// unanswered offer is dropped, and even with no offer at all the option
// itself expires, so a client can't pin a finished game in memory forever by
// leaving the post-game screen open.
const rematchTTL = 5 * time.Minute

// armRematch opens the rematch window on a just-finished game: both sides'
// `lastGame` now points at it (their `.game` was already cleared by
// teardown), and it's indexed for the TTL sweep. Called once, from finish().
func (h *Hub) armRematch(g *game) {
	for _, p := range []*player{g.white, g.black} {
		for c := range p.clients {
			c.lastGame = g
		}
	}
	g.rematchArmedAt = time.Now()
	h.rematchWindows[g.id] = g
}

// disarmRematch closes the rematch window: both sides' `lastGame` is cleared
// (any further rematch command against g is then a no-op) and g drops out of
// the TTL index. Safe to call whether or not an offer was ever standing.
func (h *Hub) disarmRematch(g *game) {
	for _, p := range []*player{g.white, g.black} {
		for c := range p.clients {
			if c.lastGame == g {
				c.lastGame = nil
			}
		}
	}
	g.rematchPending = false
	delete(h.rematchWindows, g.id)
}

// retireRematch closes g's rematch window (if any — g may be nil, the common
// case) because one of its participants is no longer available for it: they
// disconnected, or they just started a different game. Notifies the other
// side if an offer was standing, so they're not left waiting on an accept
// that can now never come.
func (h *Hub) retireRematch(g *game) {
	if g == nil {
		return
	}
	wasPending := g.rematchPending
	h.disarmRematch(g)
	if wasPending {
		h.broadcastPlayers(g, mustJSON(out("rematchDeclined", map[string]any{"gameId": g.id})))
	}
}

// rematchOffer registers c's offer to replay the game it just finished.
// Offering into a standing offer from the other side pairs them immediately
// instead of leaving two crossed offers (mirrors drawOffer's symmetric-accept
// shortcut).
func (h *Hub) rematchOffer(c *Client) {
	g := c.lastGame
	if g == nil {
		return // no finished game to rematch (never played one / window closed)
	}
	color, ok := g.colorOf(c)
	if !ok {
		return
	}
	if g.rematchPending && g.rematchBy == color {
		return // already standing
	}
	if g.rematchPending && g.rematchBy == color.Opposite() {
		h.startRematch(g)
		return
	}
	g.rematchPending, g.rematchBy = true, color
	h.broadcastPlayers(g, mustJSON(out("rematchOffered", map[string]any{"gameId": g.id, "by": colorStr(color)})))

	// The side that owes the answer has no client to press accept/decline if
	// it's a fill-in bot — arm the same human-ish beat takeback/draw offers use
	// against a bot (botOfferAnswerDelay) and let checkBotRematches answer it.
	if _, isBot := g.botResponderTo(color); isBot {
		g.rematchAnswerAt = time.Now().Add(botOfferAnswerDelay())
	}
}

// rematchAccept starts the rematch. Only the side that did NOT make the
// standing offer may accept it.
func (h *Hub) rematchAccept(c *Client) {
	g := c.lastGame
	if g == nil || !g.rematchPending {
		return
	}
	color, ok := g.colorOf(c)
	if !ok || color == g.rematchBy {
		return
	}
	h.startRematch(g)
}

// rematchDecline rejects a standing offer. Either side may clear it — the
// decliner, or the offerer withdrawing their own (mirrors drawDecline /
// takebackDecline, which document the same either-party rule) — leaving the
// window itself open so a fresh offer can still be made.
func (h *Hub) rematchDecline(c *Client) {
	g := c.lastGame
	if g == nil || !g.rematchPending {
		return
	}
	if _, ok := g.colorOf(c); !ok {
		return
	}
	g.rematchPending = false
	h.broadcastPlayers(g, mustJSON(out("rematchDeclined", map[string]any{"gameId": g.id})))
}

// rematchCancel withdraws the caller's own standing offer. Same effect as
// rematchDecline; kept as a distinct message so the offerer's "cancel"
// affordance doesn't have to pretend it's declining its own offer, and so it
// can be refused to anyone but the offerer.
func (h *Hub) rematchCancel(c *Client) {
	g := c.lastGame
	if g == nil || !g.rematchPending {
		return
	}
	color, ok := g.colorOf(c)
	if !ok || color != g.rematchBy {
		return // only the offerer can cancel their own offer
	}
	g.rematchPending = false
	h.broadcastPlayers(g, mustJSON(out("rematchDeclined", map[string]any{"gameId": g.id})))
}

// startRematch creates a new game between g's two participants with colors
// swapped and the same time control / variant / rated flag, reusing the
// normal pairing path (startGameWith + its "matched" push) so both clients
// land in the new game exactly like any other match. Closes g's rematch
// window first so a racing duplicate accept/offer is already a no-op by the
// time it's processed. A custom start fen is never carried forward into a
// rematch (passed as "") — same as Chess960, which gets a fresh random start
// each time rather than replaying the prior game's; a rematch from the exact
// same hand-picked position would be an odd, not requested, behavior.
func (h *Hub) startRematch(g *game) {
	// A bot side never had a *Client (a bot doesn't hold a socket), so reading
	// white/black via .any() below would find nil for it and bail — silently
	// swallowing every human-vs-bot rematch, accepted or not. Branch to the bot
	// constructor BEFORE that read; g.white/g.black here are still the FINISHED
	// game's sides, so isBot is exactly what it was during play.
	if g.white.isBot || g.black.isBot {
		h.startBotRematch(g)
		return
	}
	// Either side may have several devices attached; startGameWith seats one of
	// them and joinOtherSessions pulls the rest of that account in behind it.
	white, black := g.black.any(), g.white.any() // swapped
	h.disarmRematch(g)
	if white == nil || black == nil {
		return // a side has no client (shouldn't happen — disconnect already
		// disarms the window — but never assume)
	}
	h.startGameWith(white, black, g.tc, g.pool, g.rated, g.variant, g.id, "", "")
}

// startBotRematch is startRematch's branch for a human-vs-bot game. It can't
// go through startGameWith — that function seats two *Client sides, and a bot
// side never has one — so it follows startBotGame's registration shape
// end to end instead (games/playerGames/markLive/activeGames/sendMatched/
// joinOtherSessions/scheduleBotMove/maybeOpeningChat), the same set startBotGame
// documents as easy to under-build.
//
// The bot side is reseated fresh via newBotPlayerLike(oldBot): same identity,
// rating and manners as the bot the human just played, so the opponent reads
// as the same person again rather than a stranger wearing the same name (see
// newBotPlayerLike's doc). Colors swap exactly like the human-vs-human path:
// the human gets whichever color the bot had last game.
func (h *Hub) startBotRematch(g *game) {
	oldBot, oldBotColor, ok := g.botVsHumanSide()
	if !ok {
		// Defensive: a filler (bot-vs-bot) game never arms a rematch window at
		// all (finish() skips armRematch for g.filler), so this should be
		// unreachable. Still, never build a "rematch" with no human in it —
		// just close the window.
		h.disarmRematch(g)
		return
	}
	human := g.playerFor(oldBotColor.Opposite()).any()
	h.disarmRematch(g)
	if human == nil {
		return // the human disconnected between the offer firing and this
		// running — retireRematch handles the ordinary disconnect path, but a
		// race between the two is not impossible; never assume.
	}
	newHumanColor := oldBotColor // swapped: the human gets the bot's old color

	// A rematch never carries a custom start fen forward (see this file's doc
	// above startRematch) — same rule as the human-vs-human path, just applied
	// without startGameWith to enforce it. Chess960 still needs a genuinely
	// fresh shuffled back rank rather than replaying the last one.
	startFen := chess.StartFEN
	if g.variant == variantChess960 {
		startFen = chess.RandomChess960FEN()
	}
	st, err := variant.New(g.variant, startFen)
	if err != nil {
		return // defensive: our start FENs always parse
	}

	// Every variant the hub understands is rated; kept as the same guard
	// startGameWith carries, so a future unrated variant can't slip a rated
	// bot rematch through this second construction path.
	rated := g.rated && (g.variant == variantStandard || g.variant == variantChess960 ||
		g.variant == variantDuck || g.variant == variantCrazyhouse ||
		g.variant == variantAntichess || g.variant == variantSecretQueen)

	ng := &game{
		id:        newID(),
		state:     st,
		tc:        g.tc,
		pool:      g.pool,
		rated:     rated,
		clockMs:   [2]int64{g.tc.Base, g.tc.Base},
		turnStart: time.Now(),
		online:    [2]bool{true, true},
		startFen:  startFen,
		variant:   g.variant,
		rematchOf: g.id,
	}
	if newHumanColor == chess.White {
		ng.white = newPlayer(human)
		ng.black = newBotPlayerLike(oldBot)
	} else {
		ng.white = newBotPlayerLike(oldBot)
		ng.black = newPlayer(human)
	}
	// Carry the chat character over with the manners, for the same reason
	// newBotPlayerLike carries the dispositions: this is the person you just
	// played, and someone who was chatty last game and silent this one — or who
	// opened with "hi" and then went cold in a rematch they agreed to — reads as
	// two people sharing a name. Rolling a fresh persona here would undo the
	// continuity the rest of this function exists to preserve.
	ng.chat = g.chat
	if ng.chat == nil {
		ng.chat = newChatPersona()
	}

	human.game = ng
	h.games[ng.id] = ng
	h.playerGames[human.id.UserID] = ng
	h.markLive(ng)
	h.activeGames.Add(1)

	// Secret Queen: designate the bot's side and arm the human's deadline
	// BEFORE sendMatched, so its payload already carries needsDesignation —
	// startBotGame orders it the same way, for the same reason.
	if ng.variant == variantSecretQueen {
		h.beginSecretQueenDesignation(ng)
	}
	h.sendMatched(ng, human, newHumanColor)
	h.joinOtherSessions(ng, human) // open it on this account's other devices too
	h.scheduleBotMove(ng)          // if the bot plays White, it moves first
	h.maybeOpeningChat(ng)         // ...and it might open with a friendly "hi"
}

// checkBotRematches answers rematch offers standing against a bot once their
// beat has elapsed, mirroring checkBotTakebacks/checkBotDraws in botoffers.go.
// The verdict is the bot's fixed disposition (player.rematchFriendly, rolled
// once in newBotPlayer), not a fresh roll — offering again after a decline
// gets the same no every time.
//
// It iterates h.rematchWindows, not h.games: a finished game is deleted from
// h.games at teardown (its whole reason for surviving past that is the
// rematch window), so h.games has nothing left to range over by the time this
// fires.
//
// Unlike takebacks/draws, "accept" here doesn't just flip a flag back on g —
// there is no live game left to apply anything to. A friendly bot actually
// STARTS the replacement (through startRematch's bot branch); an unfriendly
// one clears the pending offer and sends the same rematchDeclined payload a
// human decline would, so the player gets a real answer instead of riding out
// the full rematchTTL in silence.
func (h *Hub) checkBotRematches() {
	now := time.Now()
	for _, g := range h.rematchWindows {
		if !g.rematchPending || g.rematchAnswerAt.IsZero() || now.Before(g.rematchAnswerAt) {
			continue
		}
		bot, isBot := g.botResponderTo(g.rematchBy)
		if !isBot {
			g.rematchAnswerAt = time.Time{} // stale arming; a human answers for themselves
			continue
		}
		if bot.rematchFriendly {
			h.startRematch(g) // disarms the window itself
			continue
		}
		g.rematchPending = false
		g.rematchAnswerAt = time.Time{}
		h.broadcastPlayers(g, mustJSON(out("rematchDeclined", map[string]any{"gameId": g.id})))
	}
}

// checkRematches reclaims rematch windows past rematchTTL each tick — whether
// idle or mid-offer — notifying both sides so their UI can drop the option.
func (h *Hub) checkRematches() {
	now := time.Now()
	for id, g := range h.rematchWindows {
		if now.Sub(g.rematchArmedAt) <= rematchTTL {
			continue
		}
		h.disarmRematch(g)
		h.broadcastPlayers(g, mustJSON(out("rematchExpired", map[string]any{"gameId": id})))
	}
}
