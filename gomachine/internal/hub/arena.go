package hub

import (
	"context"
	"encoding/json"
	"fmt"
	mrand "math/rand/v2"
	"net/http"
	"os"
	"strings"
	"time"
)

// Arena tournaments. BaseAPI is the single source of truth for which
// tournaments are running, who's entered, and everyone's live score — the hub
// only ever polls that roster, pairs currently-free participants against each
// other by closest score, plays the games through the ordinary game path, and
// tags the result with the tournament id so BaseAPI can attribute it. The hub
// never computes standings and never decides when an arena starts or ends.
//
// Shapes mirror the established Hub conventions: HTTP happens off the Run
// goroutine (arenaClient, polled by pollArenas), the poll result is handed to
// Run over a channel (arenaSnapshotCh — same "deliver a fetched pool" shape as
// SetFillerFENs/fillerFensCh), and the live pairing state (h.arenas) is
// touched only on the Run goroutine, exactly like h.pools/h.challenges.

// ArenaPlayerSnapshot is one participant row from BaseAPI's arena feed.
type ArenaPlayerSnapshot struct {
	Sub       string `json:"sub"`
	Score     int    `json:"score"`
	Withdrawn bool   `json:"withdrawn"`
}

// ArenaSnapshot is one currently-running tournament, as reported by BaseAPI's
// GET /internal/arenas/active.
type ArenaSnapshot struct {
	ID       string                `json:"id"`
	Pool     string                `json:"pool"`
	Variant  string                `json:"variant"`
	Rated    bool                  `json:"rated"`
	EndsAtMs int64                 `json:"endsAtMs"`
	Players  []ArenaPlayerSnapshot `json:"players"`
}

// arenaPlayerState is the hub's cached copy of one participant's roster row —
// just enough to validate a joinArena and pick pairings by score.
type arenaPlayerState struct {
	score     int
	withdrawn bool
}

// arenaState is one running tournament's live pairing state — Run-goroutine-
// only, the arena analogue of h.pools.
type arenaState struct {
	id       string
	pool     string // time control, e.g. "3+0" — validated when the snapshot is applied
	variant  string
	rated    bool
	endsAtMs int64
	players  map[string]*arenaPlayerState // identity sub -> latest roster row

	// free holds present, currently-unpaired connections waiting to be paired,
	// in join/return order (so pairing among equal gaps is deterministic).
	// A connection is added here by joinArena or (post-game) returnToArenaPool,
	// and removed the moment it's paired, it leaves, it disconnects, or it's
	// dropped for having withdrawn / fallen off the roster.
	free []*Client

	// lastOpponent records each sub's most recently paired opponent, so the
	// pairing loop avoids an immediate rematch when a third free player would
	// let it pair someone else instead (closestArenaPair prefers a non-repeat
	// pair whenever one exists; a repeat is only chosen when the free pool has
	// exactly these two players and no alternative).
	lastOpponent map[string]string
}

// --- BaseAPI polling (off the Run goroutine) ---

// arenaPollInterval is how often the hub re-fetches the active-arenas roster.
const arenaPollInterval = 5 * time.Second

// arenaClient is a thin HTTP client for BaseAPI's hub-secret-gated arena feed.
type arenaClient struct {
	baseURL string
	secret  string
	http    *http.Client
}

func newArenaClient(baseURL, secret string) *arenaClient {
	return &arenaClient{
		baseURL: strings.TrimRight(baseURL, "/"),
		secret:  secret,
		http:    &http.Client{Timeout: 5 * time.Second},
	}
}

// fetch pulls the current set of running arenas from BaseAPI.
func (a *arenaClient) fetch(ctx context.Context) ([]ArenaSnapshot, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, a.baseURL+"/internal/arenas/active", nil)
	if err != nil {
		return nil, fmt.Errorf("arena: build request: %w", err)
	}
	req.Header.Set("X-Hub-Secret", a.secret)

	resp, err := a.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("arena: request: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return nil, fmt.Errorf("arena: status %d", resp.StatusCode)
	}

	var body struct {
		Arenas []ArenaSnapshot `json:"arenas"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return nil, fmt.Errorf("arena: decode: %w", err)
	}
	return body.Arenas, nil
}

// SetArenaClient wires arena polling to BaseAPI's GET /internal/arenas/active
// and starts a DEDICATED polling goroutine, kept entirely off the Run
// goroutine — it only ever hands a finished snapshot to Run over
// arenaSnapshotCh (already allocated by New, so this never races the field
// itself; only pollArenas ever sends on it). A failed poll is logged and
// simply skipped: the Run goroutine keeps pairing/serving off its last known
// snapshot, so a BaseAPI outage degrades arenas to "frozen" (no new
// tournaments picked up, no roster/score updates, no reaping of one that just
// ended) rather than crashing or stalling the hub. Call before Run, like the
// other Set*/Enable* wiring calls.
func (h *Hub) SetArenaClient(baseURL, secret string) {
	h.arenaClient = newArenaClient(baseURL, secret)
	go h.pollArenas()
}

// pollArenas runs forever on its own goroutine, fetching the active-arenas
// roster every arenaPollInterval and handing a successful result to the Run
// goroutine. Never touches h.arenas or any other Run-goroutine-only state
// directly.
func (h *Hub) pollArenas() {
	for {
		ctx, cancel := context.WithTimeout(context.Background(), arenaPollInterval)
		snaps, err := h.arenaClient.fetch(ctx)
		cancel()
		if err != nil {
			fmt.Fprintf(os.Stderr, "hub: arena poll failed (%v) — keeping the last known snapshot\n", err)
		} else {
			h.SetArenaSnapshots(snaps)
		}
		time.Sleep(arenaPollInterval)
	}
}

// SetArenaSnapshots hands the hub a fresh set of running arenas. Safe to call
// from any goroutine (it only ever sends on the pre-allocated
// arenaSnapshotCh): used by pollArenas after a successful fetch, and directly
// by tests that want to drive arena state without standing up a BaseAPI stub.
// The buffered, latest-wins channel means a burst of calls (or a slow Run
// goroutine) never blocks the caller — an un-drained snapshot is simply
// superseded by the next poll a few seconds later.
func (h *Hub) SetArenaSnapshots(snaps []ArenaSnapshot) {
	select {
	case h.arenaSnapshotCh <- snaps:
	default: // a snapshot is already queued; the next poll will supersede it
	}
}

// --- Run-goroutine state: apply a snapshot, pair, drain ---

// applyArenaSnapshots runs on the Run goroutine: refreshes h.arenas from the
// latest poll, drops any free (waiting) client who withdrew or fell off a
// roster, attempts pairing in every touched arena, and reaps any arena that
// either disappeared from the feed or has passed its own endsAtMs — draining
// its pool and telling those clients.
func (h *Hub) applyArenaSnapshots(snaps []ArenaSnapshot) {
	now := time.Now().UnixMilli()
	seen := make(map[string]bool, len(snaps))

	for _, s := range snaps {
		if s.EndsAtMs > 0 && s.EndsAtMs <= now {
			// Already over per its own terms — treat exactly like it vanished
			// from the feed (drained by the sweep below, since it's left unseen).
			continue
		}
		if _, ok := parseTimeControl(s.Pool); !ok {
			fmt.Fprintf(os.Stderr, "hub: arena %s has an invalid pool %q — ignoring this snapshot for it\n", s.ID, s.Pool)
			continue
		}
		seen[s.ID] = true

		ar := h.arenas[s.ID]
		if ar == nil {
			ar = &arenaState{id: s.ID, players: map[string]*arenaPlayerState{}, lastOpponent: map[string]string{}}
			h.arenas[s.ID] = ar
		}
		ar.pool = s.Pool
		ar.variant = normalizeVariant(s.Variant)
		ar.rated = s.Rated
		ar.endsAtMs = s.EndsAtMs

		players := make(map[string]*arenaPlayerState, len(s.Players))
		for _, p := range s.Players {
			players[p.Sub] = &arenaPlayerState{score: p.Score, withdrawn: p.Withdrawn}
		}
		ar.players = players

		// A free (waiting) client whose sub withdrew or fell out of the roster
		// is no longer eligible to be paired — drop them and tell them so.
		kept := ar.free[:0]
		for _, c := range ar.free {
			ps := ar.players[c.id.UserID]
			if ps == nil || ps.withdrawn {
				c.arenaID = ""
				c.trySend(mustJSON(out("arenaLeft", map[string]any{"tournamentId": ar.id})))
				continue
			}
			kept = append(kept, c)
		}
		ar.free = kept

		h.pairArena(ar)
	}

	// Anything previously known that wasn't in this snapshot (or just passed
	// its own endsAtMs above) has ended: drain its pool and forget it.
	for id, ar := range h.arenas {
		if seen[id] {
			continue
		}
		h.drainArena(ar)
		delete(h.arenas, id)
	}
}

// checkArenas runs on the hub's normal ticker cadence (mirrors
// checkFillers/checkBotFill): it reaps an arena the instant its endsAtMs
// passes (rather than waiting up to arenaPollInterval for BaseAPI to stop
// listing it) and re-attempts pairing everywhere, catching any free client
// that became pairable for a reason other than a join/return (e.g. an
// opponent's game just ended a tick ago in a way that didn't itself trigger
// a pairing pass).
func (h *Hub) checkArenas() {
	now := time.Now().UnixMilli()
	for id, ar := range h.arenas {
		if ar.endsAtMs > 0 && ar.endsAtMs <= now {
			h.drainArena(ar)
			delete(h.arenas, id)
			continue
		}
		h.pairArena(ar)
	}
}

// drainArena empties ar's waiting pool, telling each client it's over.
// In-flight arena games are never killed here — they finish naturally
// (mirrors the filler-game philosophy: we only ever stop ADDING); their
// finish() will find the arena gone from h.arenas and simply not return
// their sides to a pool that no longer exists.
func (h *Hub) drainArena(ar *arenaState) {
	for _, c := range ar.free {
		c.arenaID = ""
		c.trySend(mustJSON(out("arenaLeft", map[string]any{"tournamentId": ar.id})))
	}
	ar.free = nil
}

// --- joinArena / leaveArena ---

// joinArena seats c in the pairing pool for a running arena tournament it is a
// registered participant of. Rejects an anonymous client, a spectator, a
// client already occupied (an active game or a normal matchmaking queue —
// one pending activity per client, exactly like queue/createChallenge), a
// client already waiting in an arena, an unknown/non-running tournament id, a
// sub that isn't one of its participants, or a withdrawn participant — each
// with a distinct, clear error.
func (h *Hub) joinArena(c *Client, tournamentID string) {
	if c.spectator {
		h.sendErr(c, "spectators can't play")
		return
	}
	if c.id.Anon {
		h.sendErr(c, "sign in to play in an arena")
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
	if c.pool != "" {
		h.sendErr(c, "already queued")
		return
	}
	if c.arenaID != "" {
		h.sendErr(c, "already waiting in an arena")
		return
	}
	ar := h.arenas[tournamentID]
	if ar == nil {
		h.sendErr(c, "arena not found or not running")
		return
	}
	ps := ar.players[c.id.UserID]
	if ps == nil {
		h.sendErr(c, "you're not a participant in this arena")
		return
	}
	if ps.withdrawn {
		h.sendErr(c, "you have withdrawn from this arena")
		return
	}
	// Never let the same identity occupy two slots in the pool at once (e.g. a
	// second tab) — that could otherwise let closestArenaPair "pair" someone
	// with themselves.
	for _, x := range ar.free {
		if x.id.UserID == c.id.UserID {
			h.sendErr(c, "already waiting in this arena on another connection")
			return
		}
	}

	c.arenaID = tournamentID
	ar.free = append(ar.free, c)
	c.trySend(mustJSON(out("arenaJoined", map[string]any{"tournamentId": tournamentID})))
	h.pairArena(ar)
	if arenaFreeHas(ar, c) {
		c.trySend(mustJSON(out("arenaWaiting", map[string]any{"tournamentId": tournamentID})))
	}
}

// leaveArena withdraws c from whatever arena pool it's currently waiting in
// (a no-op if it isn't waiting in one). Does not touch a game already in
// progress — resigning/finishing that is unrelated; leaving the pool just
// means finish() won't put this connection back into it afterward (see
// returnToArenaPool, which re-checks c.arenaID).
func (h *Hub) leaveArena(c *Client) {
	id := c.arenaID
	if id == "" {
		return
	}
	h.clearArenaMembership(c)
	c.trySend(mustJSON(out("arenaLeft", map[string]any{"tournamentId": id})))
}

// clearArenaMembership removes c from its current arena's free pool (if any)
// and clears its arenaID. Safe to call whether or not c is currently waiting
// in one. Does not itself send a message — callers decide whether/what to
// tell the client.
func (h *Hub) clearArenaMembership(c *Client) {
	if c.arenaID == "" {
		return
	}
	if ar := h.arenas[c.arenaID]; ar != nil {
		ar.free = removeClient(ar.free, c)
	}
	c.arenaID = ""
}

// --- pairing ---

// pairArena repeatedly pairs the closest-score match available in ar's free
// pool until none remains (mirrors matchWaiting's "loop until no acceptable
// pair" shape, minus any rating-gap/wait-time gate — arena pairing has
// neither: every free participant is eligible, all the time).
func (h *Hub) pairArena(ar *arenaState) {
	for {
		i, j := closestArenaPair(ar)
		if i < 0 {
			return
		}
		a, b := ar.free[i], ar.free[j]
		// Remove the higher index first so the lower one stays valid.
		if i < j {
			i, j = j, i
		}
		ar.free = append(ar.free[:i], ar.free[i+1:]...)
		ar.free = append(ar.free[:j], ar.free[j+1:]...)
		a.arenaID, b.arenaID = "", "" // no longer waiting — about to be seated in a game
		ar.lastOpponent[a.id.UserID] = b.id.UserID
		ar.lastOpponent[b.id.UserID] = a.id.UserID
		h.startArenaGame(ar, a, b)
	}
}

// closestArenaPair finds the best pairing in ar.free: the smallest score gap,
// PREFERRING a pair that isn't each side's most recent opponent whenever any
// such pair exists (so a repeat only happens when the free pool is down to
// exactly the two players who just played each other, with no third free
// player available to pair with instead). Returns (-1, -1) if fewer than two
// are free. Iterates ar.free in its stored (join/return) order, so ties
// resolve deterministically.
func closestArenaPair(ar *arenaState) (int, int) {
	bestI, bestJ := -1, -1
	bestGap := 0
	bestRepeat := true
	for i := 0; i < len(ar.free); i++ {
		for j := i + 1; j < len(ar.free); j++ {
			subA, subB := ar.free[i].id.UserID, ar.free[j].id.UserID
			if subA == subB {
				continue // defensive: the same identity should never be free twice
			}
			psA, psB := ar.players[subA], ar.players[subB]
			if psA == nil || psB == nil {
				continue // dropped from the roster since joining; applyArenaSnapshots will clear it
			}
			gap := absInt(psA.score - psB.score)
			repeat := ar.lastOpponent[subA] == subB
			if bestI < 0 || (bestRepeat && !repeat) || (repeat == bestRepeat && gap < bestGap) {
				bestI, bestJ, bestGap, bestRepeat = i, j, gap, repeat
			}
		}
	}
	return bestI, bestJ
}

// startArenaGame starts a game between two arena participants using the
// arena's own pool/variant/rated terms, colors assigned at random (arena
// pairing has no color preference to honor), then tags the new game with the
// tournament id so finish() can persist and return-to-pool it correctly.
func (h *Hub) startArenaGame(ar *arenaState, a, b *Client) {
	tc, ok := parseTimeControl(ar.pool)
	if !ok {
		return // defensive: applyArenaSnapshots already validates this pool
	}
	white, black := a, b
	if mrand.IntN(2) == 1 {
		white, black = b, a
	}
	h.startGameWith(white, black, tc, ar.pool, ar.rated, ar.variant, "", "", ar.id)
}

// --- back to the pool after a game ---

// returnToArenaPool runs at the end of every finished game (a no-op unless it
// came from an arena, g.arenaID == ""). It reads directly off g.white/g.black
// — which always reflect whichever connections are CURRENTLY attached, having
// survived any mid-game reconnect — rather than any per-connection arenaID,
// so a player who reconnected mid-game is still correctly returned to the
// pool. Each side that is still a valid (registered, non-withdrawn)
// participant of a still-running arena goes back into its free pool and a
// pairing pass is attempted immediately; anyone else (arena ended, or they
// withdrew mid-game) is simply told arenaLeft instead.
func (h *Hub) returnToArenaPool(g *game) {
	if g.arenaID == "" {
		return
	}
	ar := h.arenas[g.arenaID]
	var returned []*Client
	for _, p := range []*player{g.white, g.black} {
		if p.isBot {
			continue // defensive: arena games are always human-vs-human
		}
		for c := range p.clients {
			sub := c.id.UserID
			var ps *arenaPlayerState
			if ar != nil {
				ps = ar.players[sub]
			}
			if ar == nil || ps == nil || ps.withdrawn {
				c.arenaID = ""
				c.trySend(mustJSON(out("arenaLeft", map[string]any{"tournamentId": g.arenaID})))
				continue
			}
			c.arenaID = ar.id
			ar.free = append(ar.free, c)
			returned = append(returned, c)
		}
	}
	if ar == nil || len(returned) == 0 {
		return
	}
	h.pairArena(ar)
	for _, c := range returned {
		if arenaFreeHas(ar, c) {
			c.trySend(mustJSON(out("arenaWaiting", map[string]any{"tournamentId": ar.id})))
		}
	}
}

// --- small helpers ---

// arenaFreeHas reports whether c is (still) in ar's free pool.
func arenaFreeHas(ar *arenaState, c *Client) bool {
	for _, x := range ar.free {
		if x == c {
			return true
		}
	}
	return false
}

// removeClient returns list with the first occurrence of c removed (or list
// unchanged if c isn't in it).
func removeClient(list []*Client, c *Client) []*Client {
	for i, x := range list {
		if x == c {
			return append(list[:i], list[i+1:]...)
		}
	}
	return list
}
