package hub

import (
	crand "crypto/rand"
	"math/big"
	mrand "math/rand/v2"
	"time"
)

// Private "challenge a friend" matchmaking. A player creates a challenge with a
// chosen time control, color and rated preference; the hub mints a short code
// and holds the invite in h.challenges. A second player joins by that code and
// the hub pairs exactly the two of them — no rating bracket. Challenges are
// ephemeral (in-memory, like the queue): a creator disconnect or a TTL drops them.

const (
	challengeCodeLen = 6
	// Crockford-ish alphabet: no I, O, 0, 1 — unambiguous when typed/shared.
	challengeCodeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	// challengeTTL bounds how long an unanswered invite lingers before it is
	// reclaimed (the creator is told so their UI can reset).
	challengeTTL = 30 * time.Minute
)

// challenge is one pending private invite, held until a second player joins with
// its code (or the creator disconnects / it expires).
type challenge struct {
	code      string
	creator   *Client
	pool      string
	tc        timeControl
	color     string // creator's side preference: "w", "b", or "random"
	rated     bool   // creator asked for rated (still gated on both being accounts at join)
	createdAt time.Time
}

// createChallenge mints a private invite for the creator and returns its code.
// A client may hold at most one pending challenge and cannot be queued or in a
// game at the same time.
func (h *Hub) createChallenge(c *Client, pool, color string, rated bool) {
	if c.spectator {
		return // spectators don't play
	}
	if c.game != nil {
		h.sendErr(c, "already in a game")
		return
	}
	tc, ok := parseTimeControl(pool)
	if !ok {
		h.sendErr(c, "invalid time control")
		return
	}
	switch color {
	case "w", "b", "random":
	default:
		color = "random"
	}
	// One pending action per client: leave any queue and drop a prior challenge.
	h.dequeue(c)
	h.dropChallenge(c)

	code := h.newChallengeCode()
	ch := &challenge{
		code:      code,
		creator:   c,
		pool:      pool,
		tc:        tc,
		color:     color,
		rated:     rated && !c.id.Anon, // an anonymous creator can never make it rated
		createdAt: time.Now(),
	}
	h.challenges[code] = ch
	c.challengeCode = code
	c.trySend(mustJSON(out("challengeCreated", map[string]any{
		"code":  code,
		"pool":  pool,
		"color": color,
		"rated": ch.rated,
	})))
}

// joinChallenge pairs the joining client with the challenge's creator, starting
// a game immediately. Colors follow the creator's preference; the game is rated
// only if the creator asked for rated AND both sides are accounts.
func (h *Hub) joinChallenge(c *Client, code string) {
	if c.spectator {
		return
	}
	if c.game != nil {
		h.sendErr(c, "already in a game")
		return
	}
	ch := h.challenges[code]
	if ch == nil {
		h.sendErr(c, "challenge not found")
		return
	}
	creator := ch.creator
	if creator == c || creator.id.UserID == c.id.UserID {
		h.sendErr(c, "that's your own challenge")
		return
	}
	if creator.game != nil {
		// Creator already started another game — the invite is stale.
		h.removeChallenge(ch)
		h.sendErr(c, "challenge no longer available")
		return
	}

	var white, black *Client
	switch ch.color {
	case "w":
		white, black = creator, c
	case "b":
		white, black = c, creator
	default: // random
		if mrand.IntN(2) == 1 {
			white, black = c, creator
		} else {
			white, black = creator, c
		}
	}
	rated := ch.rated && !creator.id.Anon && !c.id.Anon

	h.removeChallenge(ch)
	h.dequeue(creator) // make sure neither side lingers in a public pool
	h.dequeue(c)
	h.startGameWith(white, black, ch.tc, ch.pool, rated)
}

// cancelChallenge drops the client's own pending challenge (if any) and returns
// them to an idle lobby.
func (h *Hub) cancelChallenge(c *Client) {
	h.dropChallenge(c)
	c.trySend(mustJSON(out("idle", nil)))
}

// dropChallenge removes whatever pending challenge the client created. Safe to
// call when the client has none.
func (h *Hub) dropChallenge(c *Client) {
	if c.challengeCode == "" {
		return
	}
	if ch := h.challenges[c.challengeCode]; ch != nil {
		h.removeChallenge(ch)
	}
	c.challengeCode = ""
}

// removeChallenge deletes a challenge from the index and clears the creator's
// pointer to it.
func (h *Hub) removeChallenge(ch *challenge) {
	delete(h.challenges, ch.code)
	if ch.creator != nil && ch.creator.challengeCode == ch.code {
		ch.creator.challengeCode = ""
	}
}

// checkChallenges reclaims expired invites each tick, notifying the creator.
func (h *Hub) checkChallenges() {
	now := time.Now()
	for code, ch := range h.challenges {
		if now.Sub(ch.createdAt) <= challengeTTL {
			continue
		}
		delete(h.challenges, code)
		if ch.creator != nil {
			if ch.creator.challengeCode == code {
				ch.creator.challengeCode = ""
			}
			ch.creator.trySend(mustJSON(out("challengeExpired", map[string]any{"code": code})))
		}
	}
}

// newChallengeCode returns a fresh, currently-unused short code. Runs on the hub
// goroutine, so reading h.challenges is lock-free.
func (h *Hub) newChallengeCode() string {
	for {
		b := make([]byte, challengeCodeLen)
		for i := range b {
			n, _ := crand.Int(crand.Reader, big.NewInt(int64(len(challengeCodeAlphabet))))
			b[i] = challengeCodeAlphabet[n.Int64()]
		}
		code := string(b)
		if _, exists := h.challenges[code]; !exists {
			return code
		}
	}
}
