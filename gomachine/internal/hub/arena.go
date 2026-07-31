package hub

import (
	"context"
	"encoding/json"
	"fmt"
	mrand "math/rand/v2"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/timanthonyalexander/gomachine/internal/auth"
	"github.com/timanthonyalexander/gomachine/internal/chess"
	"github.com/timanthonyalexander/gomachine/internal/variant"
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

// ArenaPlayerSnapshot is one participant row from BaseAPI's arena feed. Bot
// participants are real, BaseAPI-enrolled accounts with a stable identity
// (Sub/Name/Rating/Title) — the hub seats them using that identity verbatim
// rather than inventing one, so a bot's game and the arena standings always
// agree on who played.
type ArenaPlayerSnapshot struct {
	Sub       string `json:"sub"`
	Score     int    `json:"score"`
	Withdrawn bool   `json:"withdrawn"`
	Bot       bool   `json:"bot"`
	Name      string `json:"name"`
	Rating    int    `json:"rating"`
	Title     string `json:"title"`
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
// just enough to validate a joinArena and pick pairings by score. bot/name/
// rating/title are only meaningful when bot is true (BaseAPI always sends
// them for a bot row) — they're the exact identity fillArenaWithBot/
// topUpArenaBotVsBot seat a bot side with, so its game and the standings
// agree on who it was.
type arenaPlayerState struct {
	score     int
	withdrawn bool
	bot       bool
	name      string
	rating    int
	title     string
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

	// botBusy marks which of this arena's own bot participants (by sub) are
	// currently seated in a live game — either a human-fill or a bot-vs-bot
	// pairing. A bot side has no *Client, so it can't be tracked by leaving
	// ar.free the way a human is; this is the bot equivalent of that removal,
	// set when fillArenaWithBot/topUpArenaBotVsBot seat one and cleared by
	// returnToArenaPool once its game ends, so the same bot is never
	// double-booked into two games at once.
	botBusy map[string]bool
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
			ar = &arenaState{id: s.ID, players: map[string]*arenaPlayerState{}, lastOpponent: map[string]string{}, botBusy: map[string]bool{}}
			h.arenas[s.ID] = ar
		}
		ar.pool = s.Pool
		ar.variant = normalizeVariant(s.Variant)
		ar.rated = s.Rated
		ar.endsAtMs = s.EndsAtMs

		players := make(map[string]*arenaPlayerState, len(s.Players))
		for _, p := range s.Players {
			players[p.Sub] = &arenaPlayerState{
				score: p.Score, withdrawn: p.Withdrawn,
				bot: p.Bot, name: p.Name, rating: p.Rating, title: p.Title,
			}
		}
		ar.players = players
		// A bot that fell out of the roster entirely no longer needs a busy
		// marker — prune it so a long-running tournament's map doesn't hold
		// stale entries for bots that are gone for good.
		for sub := range ar.botBusy {
			if _, ok := ar.players[sub]; !ok {
				delete(ar.botBusy, sub)
			}
		}

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
		h.fillArenaWithBot(ar)
		h.topUpArenaBotVsBot(ar)
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
	c.arenaJoinedAt = time.Now()
	c.arenaBotFillDelay = randomArenaBotFillDelay()
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

// --- bot participants: fill-in (human-vs-bot) and bot-vs-bot ---
//
// An arena tournament must never feel empty. BaseAPI pre-enrolls a set of bot
// accounts as ordinary participants (ArenaPlayerSnapshot.Bot) with a real,
// stable identity (sub/name/rating/title) — the hub never invents one, so a
// bot's game and the arena standings always agree on who played. Two
// mechanisms keep the pool moving even with few or no humans around:
//
//  1. fillArenaWithBot: a lone human who has waited past a short randomized
//     delay (no human opponent found by pairArena) is seated against the
//     roster's closest-score idle bot — mirrors bot.go's own matchmaking
//     backfill (same h.engines pool, same botThinkDelay pacing), just picking
//     from the arena's own bots instead of inventing a fresh identity.
//  2. topUpArenaBotVsBot: a small, capped number of bot-vs-bot games run per
//     arena so the standings move even with nobody free to pair. These use
//     the SEPARATE, cheap filler engine pool (h.fillerEngines) — the same one
//     the Watch page's self-play games run on — so they can never contend
//     with h.engines, the human-facing pool. Unlike a Watch filler, they ARE
//     persisted (g.filler stays false) so both bots score.
//
// A bot side has no *Client, so it can't be tracked in ar.free the way a
// human is; ar.botBusy is the bot equivalent — marking which bot participants
// are currently seated in a game so the same one is never double-booked.

// arenaBotFillDelayMin/Max bound a lone waiting human's randomized wait
// before being seated against a bot participant — shorter than matchmaking's
// own randomBotFillDelay (2-10s) since an arena's pool is inherently small
// and a stalled tournament should feel alive again quickly.
const (
	arenaBotFillDelayMin = 1 * time.Second
	arenaBotFillDelayMax = 3 * time.Second
)

// randomArenaBotFillDelay returns a uniformly random wait in
// [arenaBotFillDelayMin, arenaBotFillDelayMax], assigned whenever a
// connection enters an arena's free pool (joinArena, and again on every
// return via returnToArenaPool).
func randomArenaBotFillDelay() time.Duration {
	span := arenaBotFillDelayMax - arenaBotFillDelayMin
	return arenaBotFillDelayMin + time.Duration(mrand.Int64N(int64(span)+1))
}

// fillArenaWithBot promotes any free client that has waited past its own
// randomized delay into a game against this arena's closest-score idle bot
// participant, if one is available. Mirrors checkBotFill's "humans are
// always preferred, only a lone long-waiter gets a bot" shape: pairArena
// (called first, on every join/return AND every tick) always gets first
// crack at pairing two humans, so this only ever picks up whoever it left
// free. Gated on h.botFill — the same on/off switch as ordinary matchmaking
// backfill — since a standard-chess bot side needs h.engines to ever move; a
// self-search variant's bot (Duck/Crazyhouse/Antichess) doesn't need the
// pool but is gated the same way for one consistent on/off signal.
func (h *Hub) fillArenaWithBot(ar *arenaState) {
	if !h.botFill {
		return
	}
	now := time.Now()
	var kept, promote []*Client
	for _, c := range ar.free {
		if now.Sub(c.arenaJoinedAt) >= c.arenaBotFillDelay {
			promote = append(promote, c)
		} else {
			kept = append(kept, c)
		}
	}
	ar.free = kept
	for _, c := range promote {
		sub, ok := closestIdleArenaBot(ar, ar.players[c.id.UserID])
		if !ok {
			// No idle bot right now (none enrolled in this arena, or every one
			// is already busy in another game) — leave it free so a human
			// opponent (pairArena) or a bot freeing up next tick can still take
			// it; we'll try again on the next tick.
			ar.free = append(ar.free, c)
			continue
		}
		c.arenaID = ""
		h.startArenaBotFillGame(ar, c, sub)
	}
}

// closestIdleArenaBot finds the arena's own idle bot participant (enrolled,
// not withdrawn, and not currently seated in another live game) whose score
// is closest to ps's — the human-fill analogue of closestArenaPair, but
// matched against the roster's bot rows instead of another free human.
// Returns ok=false if this arena has no bot participants at all, or every one
// is currently busy.
func closestIdleArenaBot(ar *arenaState, ps *arenaPlayerState) (sub string, ok bool) {
	if ps == nil {
		return "", false
	}
	bestGap := 0
	for s, p := range ar.players {
		if !p.bot || p.withdrawn || ar.botBusy[s] {
			continue
		}
		gap := absInt(p.score - ps.score)
		if !ok || gap < bestGap {
			sub, bestGap, ok = s, gap, true
		}
	}
	return sub, ok
}

// startArenaBotFillGame seats a human who has waited past its own arena delay
// against one of the arena's own pre-enrolled bot participants (botSub, its
// REAL account id/name/rating/title from BaseAPI's roster — never invented),
// tagged with the tournament id and persisted exactly like a human-vs-human
// arena game. Uses the SAME rating-ladder engine pool (h.engines) and pacing
// as ordinary matchmaking bot backfill — this is a real one-sided game for a
// human, not cosmetic filler — via the ordinary scheduleBotMove/
// computeBotMove path.
func (h *Hub) startArenaBotFillGame(ar *arenaState, human *Client, botSub string) {
	ps := ar.players[botSub]
	if ps == nil {
		return // defensive: closestIdleArenaBot only ever returns a currently-valid sub
	}
	botIdentity := auth.Identity{UserID: botSub, Anon: false, Name: ps.name, Rating: ps.rating, Title: ps.title}

	humanColor := chess.White
	if mrand.IntN(2) == 1 {
		humanColor = chess.Black
	}
	var white, black *player
	if humanColor == chess.White {
		white, black = newPlayer(human), newBotPlayer(botIdentity, ps.rating)
	} else {
		white, black = newBotPlayer(botIdentity, ps.rating), newPlayer(human)
	}

	g := h.newArenaGame(ar, white, black)
	if g == nil {
		return
	}
	ar.botBusy[botSub] = true
	human.game = g
	h.sendMatched(g, human, humanColor)
	h.joinOtherSessions(g, human)
	h.scheduleBotMove(g) // if the bot plays White, it moves first
}

// arenaBotVsBotCap bounds how many bot-vs-bot games run concurrently per
// arena — enough that the standings keep moving even with no humans around,
// small enough that the shared filler engine pool never gets crowded.
const arenaBotVsBotCap = 2

// countArenaBotVsBot reports how many of THIS arena's own games are currently
// a live bot-vs-bot pairing — the same "count what's already running" shape
// checkFillers uses to pad the Watch lobby up to its own target.
func (h *Hub) countArenaBotVsBot(ar *arenaState) int {
	n := 0
	for _, g := range h.games {
		if g.over || g.arenaID != ar.id {
			continue
		}
		if g.white.isBot && g.black.isBot {
			n++
		}
	}
	return n
}

// topUpArenaBotVsBot starts one bot-vs-bot game (at most one per tick, the
// same gentle ramp checkFillers uses) between two of this arena's own idle
// bot participants whenever fewer than arenaBotVsBotCap are already running.
// Runs on the SEPARATE, cheap filler engine pool (h.fillerEngines) — never
// h.engines, the human-facing pool — so it can't starve human bot-fill; gated
// on that pool existing at all (EnableSpectatorFillers), same as any other
// caller of it. Unlike a Watch filler, the resulting game IS persisted
// (g.filler stays false) so both bots score.
func (h *Hub) topUpArenaBotVsBot(ar *arenaState) {
	if h.fillerEngines == nil {
		return // filler pool not enabled — nothing cheap to run bot-vs-bot on
	}
	if h.countArenaBotVsBot(ar) >= arenaBotVsBotCap {
		return
	}
	subA, subB, ok := twoIdleArenaBots(ar)
	if !ok {
		return
	}
	psA, psB := ar.players[subA], ar.players[subB]
	idA := auth.Identity{UserID: subA, Anon: false, Name: psA.name, Rating: psA.rating, Title: psA.title}
	idB := auth.Identity{UserID: subB, Anon: false, Name: psB.name, Rating: psB.rating, Title: psB.title}
	white, black := newBotPlayer(idA, psA.rating), newBotPlayer(idB, psB.rating)
	if mrand.IntN(2) == 1 {
		white, black = black, white
	}
	g := h.newArenaGame(ar, white, black)
	if g == nil {
		return
	}
	ar.botBusy[subA] = true
	ar.botBusy[subB] = true
	h.scheduleBotMove(g)
}

// twoIdleArenaBots picks two distinct idle bot participants (enrolled, not
// withdrawn, not already seated in another live game) from ar's roster to
// play each other — closest in score, the same spirit as closestArenaPair but
// over the roster's bot rows instead of ar.free. Returns ok=false if fewer
// than two are currently idle.
func twoIdleArenaBots(ar *arenaState) (subA, subB string, ok bool) {
	var idle []string
	for sub, ps := range ar.players {
		if ps.bot && !ps.withdrawn && !ar.botBusy[sub] {
			idle = append(idle, sub)
		}
	}
	if len(idle) < 2 {
		return "", "", false
	}
	sort.Strings(idle) // deterministic scan order — map iteration isn't
	bestI, bestJ, bestGap := -1, -1, 0
	for i := 0; i < len(idle); i++ {
		for j := i + 1; j < len(idle); j++ {
			gap := absInt(ar.players[idle[i]].score - ar.players[idle[j]].score)
			if bestI < 0 || gap < bestGap {
				bestI, bestJ, bestGap = i, j, gap
			}
		}
	}
	return idle[bestI], idle[bestJ], true
}

// newArenaGame builds and registers a game between white and black — either
// side may be a bot (newBotPlayer, no *Client at all) or a human already
// seated via newPlayer — using ar's own pool/variant/rated terms and tagging
// it with the arena id. It's the *player-based sibling of startGameWith
// (which takes two *Clients and so can't seat a bot): the rated-gating and
// start-position logic mirror startGameWith exactly, just generalized over
// *player. Callers handle anything client-specific themselves afterward
// (sendMatched, joinOtherSessions, scheduling the first bot move), since that
// differs by which side(s), if any, are real clients.
func (h *Hub) newArenaGame(ar *arenaState, white, black *player) *game {
	tc, ok := parseTimeControl(ar.pool)
	if !ok {
		return nil // defensive: applyArenaSnapshots already validates this pool
	}
	rated := ar.rated && (ar.variant == variantStandard || ar.variant == variantDuck ||
		ar.variant == variantCrazyhouse || ar.variant == variantAntichess)
	startFen := chess.StartFEN
	if ar.variant == variantChess960 {
		startFen = chess.RandomChess960FEN()
	}
	st, err := variant.New(ar.variant, startFen)
	if err != nil {
		return nil // defensive: our start FENs always parse
	}
	g := &game{
		id:        newID(),
		white:     white,
		black:     black,
		state:     st,
		tc:        tc,
		pool:      ar.pool,
		rated:     rated,
		clockMs:   [2]int64{tc.Base, tc.Base},
		turnStart: time.Now(),
		online:    [2]bool{true, true},
		startFen:  startFen,
		variant:   ar.variant,
		arenaID:   ar.id,
	}
	h.games[g.id] = g
	if !white.isBot {
		h.playerGames[white.id.UserID] = g
	}
	if !black.isBot {
		h.playerGames[black.id.UserID] = g
	}
	h.markLive(g)
	h.activeGames.Add(1)
	return g
}

// --- back to the pool after a game ---

// returnToArenaPool runs at the end of every finished game (a no-op unless it
// came from an arena, g.arenaID == ""). It reads directly off g.white/g.black
// — which always reflect whichever connections are CURRENTLY attached, having
// survived any mid-game reconnect — rather than any per-connection arenaID,
// so a player who reconnected mid-game is still correctly returned to the
// pool. Each human side that is still a valid (registered, non-withdrawn)
// participant of a still-running arena goes back into its free pool and a
// pairing pass is attempted immediately; anyone else (arena ended, or they
// withdrew mid-game) is simply told arenaLeft instead. A bot side is instead
// freed up for reuse (see the isBot branch below) — it has no *Client and so
// was never in ar.free to begin with.
func (h *Hub) returnToArenaPool(g *game) {
	if g.arenaID == "" {
		return
	}
	ar := h.arenas[g.arenaID]
	var returned []*Client
	for _, p := range []*player{g.white, g.black} {
		if p.isBot {
			// A bot side has no *Client to re-seat in ar.free — instead it just
			// frees up its busy marker, so fillArenaWithBot/topUpArenaBotVsBot
			// are eligible to pick this SAME bot again for a fresh game on the
			// next tick (a no-op if the arena is gone or the bot fell off the
			// roster — nothing references it anymore either way).
			if ar != nil {
				delete(ar.botBusy, p.id.UserID)
			}
			continue
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
			c.arenaJoinedAt = time.Now()
			c.arenaBotFillDelay = randomArenaBotFillDelay()
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

// --- live games in a tournament (GET /internal/arena-games) ---

// arenaGamesCap bounds how many live games the /internal/arena-games feed
// reports for one tournament — enough to give a sense of what's being played
// without the payload growing with a large arena.
const arenaGamesCap = 20

// ArenaGameSummary is one live game row for the /internal/arena-games feed —
// a tournament page's "watch what's being played right now", next to
// standings.
type ArenaGameSummary struct {
	GameID  string           `json:"gameId"`
	Pool    string           `json:"pool"`
	Variant string           `json:"variant"`
	Ply     int              `json:"ply"`
	White   ArenaSideSummary `json:"white"`
	Black   ArenaSideSummary `json:"black"`
}

// ArenaSideSummary is the public view of one side of an ArenaGameSummary.
// Title is a *string (null on the wire, not omitted) so the caller can tell
// "no title" apart from a field that was never sent.
type ArenaSideSummary struct {
	Name   string  `json:"name"`
	Rating int     `json:"rating"`
	Title  *string `json:"title"`
	Bot    bool    `json:"bot"`
}

// arenaGamesQuery is one "what's live in this tournament" lookup funneled
// onto the Run goroutine — see Hub.ArenaGames and Hub.arenaGamesQueries.
type arenaGamesQuery struct {
	tournamentID string
	result       chan []ArenaGameSummary
}

// ArenaGames reports the currently-live (not yet over) games tagged with
// tournamentID, ordered "most interesting first" exactly like the Watch
// lobby (moreInteresting — real games first, then higher combined rating),
// capped at arenaGamesCap. Safe to call from any goroutine (funnels onto Run
// over arenaGamesQueries, same shape as Online). An unknown or already-ended
// tournament id — nothing currently live carries that arenaID — returns an
// empty slice, never an error.
func (h *Hub) ArenaGames(tournamentID string) []ArenaGameSummary {
	resultCh := make(chan []ArenaGameSummary, 1)
	h.arenaGamesQueries <- arenaGamesQuery{tournamentID: tournamentID, result: resultCh}
	return <-resultCh
}

// arenaSideSummaryFor is the ArenaSideSummary view of one game side.
func arenaSideSummaryFor(p *player, cat string) ArenaSideSummary {
	var title *string
	if p.id.Title != "" {
		t := p.id.Title
		title = &t
	}
	return ArenaSideSummary{Name: p.id.Name, Rating: p.id.RatingFor(cat), Title: title, Bot: p.isBot}
}

// arenaGameRow pairs an ArenaGameSummary with its combined rating so the two
// travel together through the sort below (a bare index-parallel slice would
// desync the moment sort.SliceStable swaps one but not the other).
type arenaGameRow struct {
	summary ArenaGameSummary
	rating  int
}

// doArenaGames runs on the Run goroutine: h.games is otherwise touched only
// there (exactly like doOnline/h.sessions). Filters to live games tagged with
// tournamentID, then orders and caps them like the Watch lobby.
func (h *Hub) doArenaGames(tournamentID string) []ArenaGameSummary {
	var rows []arenaGameRow
	if tournamentID != "" {
		for _, g := range h.games {
			if g.over || g.arenaID != tournamentID {
				continue
			}
			cat := categoryFor(g.pool, g.variant)
			white := arenaSideSummaryFor(g.white, cat)
			black := arenaSideSummaryFor(g.black, cat)
			rows = append(rows, arenaGameRow{
				summary: ArenaGameSummary{
					GameID: g.id, Pool: g.pool, Variant: g.variant, Ply: len(g.moves),
					White: white, Black: black,
				},
				rating: white.Rating + black.Rating,
			})
		}
	}
	sort.SliceStable(rows, func(i, j int) bool {
		return moreInteresting(false, rows[i].rating, false, rows[j].rating)
	})
	if len(rows) > arenaGamesCap {
		rows = rows[:arenaGamesCap]
	}
	games := make([]ArenaGameSummary, len(rows))
	for i, r := range rows {
		games[i] = r.summary
	}
	return games
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
