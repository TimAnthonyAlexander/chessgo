package hub

import (
	crand "crypto/rand"
	"errors"
	"fmt"
	"math/big"
	mrand "math/rand/v2"
	"strings"
	"time"

	"github.com/timanthonyalexander/gomachine/internal/variant"
)

// Private "challenge a friend" matchmaking. A player creates a challenge with a
// chosen time control, color and rated preference; the hub mints a short code
// and holds the invite in h.challenges. A second player joins by that code and
// the hub pairs exactly the two of them — no rating bracket. Challenges are
// ephemeral (in-memory, like the queue): a creator disconnect or a TTL drops them.
//
// A challenge can ALSO be registered server-side, with no creator connection at
// all (RegisterServerChallenge, in serverchallenge.go) — BaseAPI pre-registers an
// already-accepted user-to-user challenge, restricted to exactly two identity
// subs, and both players join later (independently) with the ordinary
// joinChallenge message. See challenge.serverSide and joinServerChallenge.

const (
	challengeCodeLen = 6
	// Crockford-ish alphabet: no I, O, 0, 1 — unambiguous when typed/shared.
	challengeCodeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	// challengeTTL bounds how long an unanswered invite lingers before it is
	// reclaimed (the creator is told so their UI can reset). Also the default
	// TTL for a server-side challenge that doesn't specify its own.
	challengeTTL = 30 * time.Minute
)

// challenge is one pending private invite, held until a second player joins with
// its code (or the creator disconnects / it expires).
type challenge struct {
	code      string
	creator   *Client // nil for a server-side challenge (no creator connection)
	pool      string
	tc        timeControl
	color     string // side preference relative to the creator (or creatorSub): "w", "b", or "random"
	rated     bool   // rated preference (still gated on both being accounts, and forced false by a custom fen, at join)
	variant   string // board variant: "standard", "chess960", "duck", "crazyhouse" or "antichess"
	fen       string // optional custom start position; "" = the variant's normal start
	createdAt time.Time
	expiresAt time.Time // when this invite is reclaimed by checkChallenges

	// Server-side fields (serverSide=true): BaseAPI registered this challenge
	// with no creator connected (RegisterServerChallenge), restricted to
	// exactly these two identity subs. The first of the two to arrive over
	// joinChallenge parks as waitingClient/waitingSub (mirroring how a
	// client-created challenge's creator waits); the second starts the game.
	serverSide  bool
	creatorSub  string // identity sub the `color` preference is relative to
	opponentSub string
	waitingClient *Client
	waitingSub    string
}

// createChallenge mints a private invite for the creator and returns its code.
// A client may hold at most one pending challenge and cannot be queued or in a
// game at the same time. fen is an optional custom start position ("" = the
// variant's normal start); it is validated up front so a bad FEN is rejected at
// creation, not silently dropped once the game starts.
func (h *Hub) createChallenge(c *Client, pool, color string, rated bool, variantID, fen string) {
	if c.spectator {
		return // spectators don't play
	}
	// Already playing here or on another device on this account — open that game
	// instead of minting an invite that could never be honoured (see Hub.queue).
	if g := h.activeGameFor(c); g != nil {
		h.attachToGame(c, g)
		return
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
	variantID = normalizeVariant(variantID)
	fen = strings.TrimSpace(fen)
	if fen != "" {
		if err := validateCustomStartFEN(variantID, fen); err != nil {
			h.sendErr(c, err.Error())
			return
		}
	}
	// One pending action per client: leave any queue and drop a prior challenge.
	h.dequeue(c)
	h.dropChallenge(c)

	code := h.newChallengeCode()
	now := time.Now()
	ch := &challenge{
		code:      code,
		creator:   c,
		pool:      pool,
		tc:        tc,
		color:     color,
		rated:     rated && !c.id.Anon, // an anonymous creator can never make it rated
		variant:   variantID,
		fen:       fen,
		createdAt: now,
		expiresAt: now.Add(challengeTTL),
	}
	h.challenges[code] = ch
	c.challengeCode = code
	c.trySend(mustJSON(out("challengeCreated", map[string]any{
		"code":    code,
		"pool":    pool,
		"color":   color,
		"rated":   ch.rated,
		"variant": ch.variant,
		"fen":     ch.fen,
	})))
}

// joinChallenge pairs the joining client with the challenge behind code —
// either a client-created invite (its creator, waiting) or a server-side one
// (BaseAPI-registered, restricted to two identity subs; see
// joinServerChallenge). Colors follow the challenge's color preference; the
// game is rated only if that was asked for AND both sides are accounts.
func (h *Hub) joinChallenge(c *Client, code string) {
	if c.spectator {
		return
	}
	if g := h.activeGameFor(c); g != nil {
		h.attachToGame(c, g)
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
	if h.challengeExpired(ch) {
		h.removeChallenge(ch)
		h.sendErr(c, "challenge expired")
		return
	}
	if ch.serverSide {
		h.joinServerChallenge(c, ch)
		return
	}

	creator := ch.creator
	if creator == c || creator.id.UserID == c.id.UserID {
		h.sendErr(c, "that's your own challenge")
		return
	}
	if creator.game != nil || h.activeGameFor(creator) != nil {
		// Creator already started another game — the invite is stale.
		h.removeChallenge(ch)
		h.sendErr(c, "challenge no longer available")
		return
	}

	white, black := assignColors(ch.color, creator, c)
	rated := ch.rated && !creator.id.Anon && !c.id.Anon

	h.removeChallenge(ch)
	h.dequeue(creator) // make sure neither side lingers in a public pool
	h.dequeue(c)
	h.startGameWith(white, black, ch.tc, ch.pool, rated, ch.variant, "", ch.fen)
}

// joinServerChallenge handles a joinChallenge against a challenge BaseAPI
// registered with no creator connection (RegisterServerChallenge), restricted
// to exactly ch.creatorSub and ch.opponentSub. The first of the two identities
// to arrive parks as the waiting side — exactly like a WS creator waits for a
// joiner — so it is NOT ok for one of them to "pair" with itself via a second
// tab or device: arriving again while still parked is rejected outright.
func (h *Hub) joinServerChallenge(c *Client, ch *challenge) {
	sub := c.id.UserID
	if sub == "" || (sub != ch.creatorSub && sub != ch.opponentSub) {
		h.sendErr(c, "this challenge isn't yours to join")
		return
	}

	if ch.waitingClient == nil {
		ch.waitingClient = c
		ch.waitingSub = sub
		c.challengeCode = ch.code
		c.trySend(mustJSON(out("challengeWaiting", map[string]any{
			"code":    ch.code,
			"pool":    ch.pool,
			"color":   ch.color,
			"rated":   ch.rated,
			"variant": ch.variant,
			"fen":     ch.fen,
		})))
		return
	}
	if ch.waitingSub == sub {
		// The same identity, a second tab/device, trying to join again before
		// the OTHER named player has arrived — never pair a player with itself.
		h.sendErr(c, "already waiting on this challenge")
		return
	}

	waiting := ch.waitingClient
	if waiting.game != nil || h.activeGameFor(waiting) != nil {
		// The other named player already started another game elsewhere — the
		// invite is stale.
		h.removeChallenge(ch)
		h.sendErr(c, "challenge no longer available")
		return
	}

	// color is always relative to creatorSub's player, regardless of which of
	// the two subs happened to arrive (and park) first.
	var preferred, other *Client
	if ch.waitingSub == ch.creatorSub {
		preferred, other = waiting, c
	} else {
		preferred, other = c, waiting
	}
	white, black := assignColors(ch.color, preferred, other)
	rated := ch.rated && !waiting.id.Anon && !c.id.Anon

	h.removeChallenge(ch)
	h.dequeue(waiting)
	h.dequeue(c)
	h.startGameWith(white, black, ch.tc, ch.pool, rated, ch.variant, "", ch.fen)
}

// assignColors resolves a "w"/"b"/"random" preference into concrete white/black
// clients. pref is always read relative to `preferred` — the client-created
// challenge's creator, or, for a server-side challenge, whichever connection
// currently belongs to creatorSub.
func assignColors(pref string, preferred, other *Client) (white, black *Client) {
	switch pref {
	case "w":
		return preferred, other
	case "b":
		return other, preferred
	default: // random
		if mrand.IntN(2) == 1 {
			return other, preferred
		}
		return preferred, other
	}
}

// validateCustomStartFEN checks fen against the same parser the game itself
// will use to build its start position (variant.New, backed by
// internal/chess), so registration/creation rejects a bad FEN up front instead
// of it going wrong once the game actually starts. Chess960's own randomized
// start always wins over any custom FEN (hub.startGameWith), so combining the
// two is rejected here rather than silently discarding the FEN.
func validateCustomStartFEN(variantID, fen string) error {
	if variantID == variantChess960 {
		return errors.New("a custom start position cannot be combined with chess960 (its own random start always applies)")
	}
	if _, err := variant.New(variantID, fen); err != nil {
		return fmt.Errorf("invalid start FEN for variant %q: %w", variantID, err)
	}
	return nil
}

// challengeExpired reports whether ch is past its expiry.
func (h *Hub) challengeExpired(ch *challenge) bool {
	return !ch.expiresAt.IsZero() && time.Now().After(ch.expiresAt)
}

// cancelChallenge drops the client's own pending challenge (if any) and returns
// them to an idle lobby.
func (h *Hub) cancelChallenge(c *Client) {
	h.dropChallenge(c)
	c.trySend(mustJSON(out("idle", nil)))
}

// dropChallenge removes whatever pending challenge the client created or is
// waiting on. Safe to call when the client has none.
//
// A client-created challenge is ephemeral and tied to its creator's connection
// (unchanged behavior): dropping it removes the whole invite. A server-side
// challenge is meant to outlive any single connection, so dropping only clears
// THIS client's parked "waiting" slot — the challenge stays registered until
// its TTL, so the other named player (or this one, reconnecting) can still
// join by code.
func (h *Hub) dropChallenge(c *Client) {
	if c.challengeCode == "" {
		return
	}
	if ch := h.challenges[c.challengeCode]; ch != nil {
		if ch.serverSide {
			if ch.waitingClient == c {
				ch.waitingClient = nil
				ch.waitingSub = ""
			}
		} else {
			h.removeChallenge(ch)
		}
	}
	c.challengeCode = ""
}

// removeChallenge deletes a challenge from the index and clears any client's
// pointer to it (the client-created creator, and/or a server-side challenge's
// currently-parked waiting side).
func (h *Hub) removeChallenge(ch *challenge) {
	delete(h.challenges, ch.code)
	if ch.creator != nil && ch.creator.challengeCode == ch.code {
		ch.creator.challengeCode = ""
	}
	if ch.waitingClient != nil && ch.waitingClient.challengeCode == ch.code {
		ch.waitingClient.challengeCode = ""
	}
}

// checkChallenges reclaims expired invites each tick, notifying whichever
// client(s) are attached to it (a client-created challenge's creator, and/or a
// server-side challenge's currently-parked waiting side).
func (h *Hub) checkChallenges() {
	now := time.Now()
	for code, ch := range h.challenges {
		if now.Before(ch.expiresAt) {
			continue
		}
		delete(h.challenges, code)
		if ch.creator != nil {
			if ch.creator.challengeCode == code {
				ch.creator.challengeCode = ""
			}
			ch.creator.trySend(mustJSON(out("challengeExpired", map[string]any{"code": code})))
		}
		if ch.waitingClient != nil {
			if ch.waitingClient.challengeCode == code {
				ch.waitingClient.challengeCode = ""
			}
			ch.waitingClient.trySend(mustJSON(out("challengeExpired", map[string]any{"code": code})))
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
