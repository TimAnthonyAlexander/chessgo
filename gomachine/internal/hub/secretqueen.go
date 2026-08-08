package hub

import (
	mrand "math/rand/v2"
	"time"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// secretQueenDesignationTimeout is how long each human side has to pick
// their secret pawn before the server assigns one at random — the
// designation-phase counterpart of firstMoveTimeout (hub.go): a stalling
// guard, but shorter, because there's no clock or board state to protect
// yet, just a single click. It is always well under firstMoveTimeout (30s),
// so a secretqueen game can never trip checkClocks' stalled-first-move abort
// while it is still (legitimately) in the designation phase — no extra
// gating was needed there.
const secretQueenDesignationTimeout = 15 * time.Second

// beginSecretQueenDesignation starts g's designation phase: called once,
// right after the game struct exists and BEFORE sendMatched (so the
// "matched" payload can already carry needsDesignation/designationDeadline),
// from both startGameWith (human vs human — arms the deadline for both
// sides) and startBotGame (human vs bot — designates the bot's own side
// immediately and synchronously, then arms the deadline for the human only).
// A bot never sits waiting on a click, matching docs/tasks/open/
// secret-queen.md: "A bot opponent designates immediately and at random."
func (h *Hub) beginSecretQueenDesignation(g *game) {
	g.sqDesignationDeadline = time.Now().Add(secretQueenDesignationTimeout)
	if g.white.isBot {
		h.autoDesignateSecretQueen(g, chess.White)
	}
	if g.black.isBot {
		h.autoDesignateSecretQueen(g, chess.Black)
	}
}

// applySecretQueenDesignation runs one side's designation against zugzwang
// and, on success, updates g.state — the SINGLE call site for every way a
// side can become designated (a player's own "designate" message, the
// timeout auto-pick, and a bot's immediate pick at game creation), so "what
// happens when a side gets designated" is defined exactly once. Returns
// false on an HTTP/engine failure or an invalid square; the caller decides
// what to do about that (a human's own click gets an error reply; the
// timeout/bot paths just log and leave it to be retried on the next tick —
// see checkSecretQueenDesignations' doc).
func (h *Hub) applySecretQueenDesignation(g *game, color chess.Color, square string) bool {
	hs, hidden := g.hiddenState()
	if !hidden {
		return false
	}
	next, ok := hs.Designate(color, square)
	if !ok {
		return false
	}
	g.state = next
	if g.secretQueenReady() {
		// Both sides done: the designation phase is over. Reset turnStart so
		// the ordinary 30s first-move-timeout window (firstMoveTimeout) starts
		// fresh from now, not from whenever the game was created — creation
		// may have already eaten most (or, on a bot-vs-bot pairing, none) of
		// the 15s designation window.
		g.sqDesignationDeadline = time.Time{}
		g.turnStart = time.Now()
		// startFen becomes the fully-designated canonical position: from here
		// on, g.moves are ordinary plies, so reconstruction (variant.New(
		// g.variant, g.startFen) + replay — game.go's fenHistory/rebuildTo)
		// starts from a position that already carries both secrets, exactly
		// like a Chess960 game's randomized start. Persistence (FinishedGame.
		// StartFEN) picks this up automatically — no separate field needed.
		g.startFen = next.FEN()
	}
	return true
}

// designateSecretQueen handles a player's own "designate" WS message —
// square is a home-rank pawn square such as "e2". One-shot per side
// (OwnSecretSquare != "" means this side already went); ignored entirely
// once the phase is already over, or if this isn't a Secret Queen game at
// all. On success, tells both sides a designation happened (booleans only —
// see the designationUpdate comment below for why that's always safe to
// broadcast) and, once both are in, starts real play with a full per-viewer
// state broadcast.
func (h *Hub) designateSecretQueen(c *Client, square string) {
	g := c.game
	if g == nil || g.over || g.variant != variantSecretQueen {
		return
	}
	color, ok := g.colorOf(c)
	if !ok {
		return
	}
	hs, hidden := g.hiddenState()
	if !hidden || g.secretQueenReady() {
		return
	}
	if hs.OwnSecretSquare(color) != "" {
		return // this side already designated — designation is one-shot
	}
	if !h.applySecretQueenDesignation(g, color, square) {
		h.sendErr(c, "invalid designation")
		return
	}
	h.broadcastDesignationUpdate(g, false)
	if g.secretQueenReady() {
		h.broadcastState(g)  // hands out the real starting position + each side's own legal moves
		h.scheduleBotMove(g) // no-op unless White is (somehow) a bot here — defensive, mirrors startBotGame's own path
	}
}

// broadcastDesignationUpdate tells both players whether each side has
// designated yet — booleans ONLY, never the square, so unlike every other
// Secret Queen broadcast this one carries no secret at all and can safely
// reuse the ordinary broadcastPlayers (no per-viewer split needed). auto
// marks a server-assigned (timeout) designation so the client can
// distinguish "opponent picked" from "opponent ran out of time", if it wants
// to say so.
func (h *Hub) broadcastDesignationUpdate(g *game, auto bool) {
	hs, hidden := g.hiddenState()
	if !hidden {
		return
	}
	h.broadcastPlayers(g, mustJSON(out("designationUpdate", map[string]any{
		"gameId": g.id,
		"white":  hs.OwnSecretSquare(chess.White) != "",
		"black":  hs.OwnSecretSquare(chess.Black) != "",
		"auto":   auto,
	})))
}

// autoDesignateSecretQueen picks a square for color via pickSecretQueenSquare
// and applies it — used for a bot's own immediate pick (beginSecretQueenDesignation)
// and a timed-out human (checkSecretQueenDesignations). A failed HTTP call here is
// simply left for the next tick to retry (checkSecretQueenDesignations runs on
// every ticker beat, and the deadline has already passed, so it will try again
// immediately) rather than erroring out — there is no client to show an error to on
// this path.
func (h *Hub) autoDesignateSecretQueen(g *game, color chess.Color) {
	h.applySecretQueenDesignation(g, color, pickSecretQueenSquare(color))
}

// pickSecretQueenSquare chooses a home-rank pawn square for color, weighted
// slightly away from the rook pawns (docs/tasks/open/secret-queen.md: "a
// central pawn and a rook pawn play very differently... weight the pick
// rather than picking uniformly, so bot games don't feel samey"). This is
// flavor/selection logic, not a rules question — like botDisplayRating/
// fakeUsername in bot.go, it never asks the engine anything; it just decides
// WHICH already-valid square to hand to Designate.
func pickSecretQueenSquare(color chess.Color) string {
	const files = "abcdefgh"
	// a/h (rook pawns) get weight 1; the other six get weight 3 — rarer, not
	// impossible.
	weights := [8]int{1, 3, 3, 3, 3, 3, 3, 1}
	total := 0
	for _, w := range weights {
		total += w
	}
	r := mrand.IntN(total)
	idx := 0
	for i, w := range weights {
		if r < w {
			idx = i
			break
		}
		r -= w
	}
	rank := "2"
	if color == chess.Black {
		rank = "7"
	}
	return string(files[idx]) + rank
}

// checkSecretQueenDesignations auto-assigns a uniformly random home-rank
// pawn for any side that hasn't designated by its 15s deadline
// (secretQueenDesignationTimeout) — the same "the server decides so the game
// isn't stuck forever" role firstMoveTimeout/checkClocks plays once the
// clock is running, just earlier in the game's life. A FIXED default (say,
// always the e-pawn) would hand the opponent free information the instant
// someone times out, so this always rerolls per side (pickSecretQueenSquare).
// Runs on the hub's ticker (Run's select loop), same cadence as checkClocks.
func (h *Hub) checkSecretQueenDesignations() {
	now := time.Now()
	for _, g := range h.games {
		if g.over || g.variant != variantSecretQueen || g.sqDesignationDeadline.IsZero() {
			continue
		}
		if now.Before(g.sqDesignationDeadline) {
			continue
		}
		hs, hidden := g.hiddenState()
		if !hidden {
			continue
		}
		changed := false
		if hs.OwnSecretSquare(chess.White) == "" {
			h.autoDesignateSecretQueen(g, chess.White)
			changed = true
		}
		if hs.OwnSecretSquare(chess.Black) == "" {
			h.autoDesignateSecretQueen(g, chess.Black)
			changed = true
		}
		if changed {
			h.broadcastDesignationUpdate(g, true)
		}
		if g.secretQueenReady() {
			h.broadcastState(g)
			h.scheduleBotMove(g)
		}
	}
}
