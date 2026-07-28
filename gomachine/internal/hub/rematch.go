package hub

import "time"

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

// rematchTTL bounds how long a finished game stays rematch-eligible: an
// unanswered offer is dropped, and even with no offer at all the option
// itself expires, so a client can't pin a finished game in memory forever by
// leaving the post-game screen open.
const rematchTTL = 5 * time.Minute

// armRematch opens the rematch window on a just-finished game: both sides'
// `lastGame` now points at it (their `.game` was already cleared by
// teardown), and it's indexed for the TTL sweep. Called once, from finish().
func (h *Hub) armRematch(g *game) {
	if g.white.client != nil {
		g.white.client.lastGame = g
	}
	if g.black.client != nil {
		g.black.client.lastGame = g
	}
	g.rematchArmedAt = time.Now()
	h.rematchWindows[g.id] = g
}

// disarmRematch closes the rematch window: both sides' `lastGame` is cleared
// (any further rematch command against g is then a no-op) and g drops out of
// the TTL index. Safe to call whether or not an offer was ever standing.
func (h *Hub) disarmRematch(g *game) {
	if g.white.client != nil && g.white.client.lastGame == g {
		g.white.client.lastGame = nil
	}
	if g.black.client != nil && g.black.client.lastGame == g {
		g.black.client.lastGame = nil
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
// time it's processed.
func (h *Hub) startRematch(g *game) {
	white, black := g.black.client, g.white.client // swapped
	h.disarmRematch(g)
	if white == nil || black == nil {
		return // a side has no client (shouldn't happen — disconnect already
		// disarms the window — but never assume; a bot side never gets here
		// either, since it never has a client to send rematchAccept from)
	}
	h.startGameWith(white, black, g.tc, g.pool, g.rated, g.variant, g.id)
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
