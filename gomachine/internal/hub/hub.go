// Package hub is the in-memory realtime server for human-vs-human play: it
// manages WebSocket connections, a per-time-control matchmaking pool, and live
// games with server-authoritative clocks. All shared state is mutated on a
// single goroutine (Run), so there are no locks; connections talk to it over
// channels. Finished games are reported via OnFinish for BaseAPI to persist.
package hub

import (
	"context"
	crand "crypto/rand"
	"encoding/hex"
	"encoding/json"
	mrand "math/rand/v2"
	"net/http"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/timanthonyalexander/gomachine/internal/auth"
	"github.com/timanthonyalexander/gomachine/internal/chess"
	"github.com/timanthonyalexander/gomachine/internal/syzygy"
)

type command struct {
	client *Client
	msg    inMsg
}

// Hub owns all realtime state. Use New, then run Run in a goroutine.
type Hub struct {
	secret      string
	register    chan *Client
	unregister  chan *Client
	commands    chan command
	pools       map[string][]*Client // waiting clients per time-control pool
	games       map[string]*game
	playerGames map[string]*game      // identity id -> active game (for reconnect)
	challenges  map[string]*challenge // pending private invites, keyed by short code
	onFinish    func(FinishedGame)

	// Bot backfill: if a player waits longer than botDelay with no human match,
	// pair them with an engine-driven opponent. Moves are computed off the Run
	// goroutine by a pool of engines and applied back via botMoves.
	botFill  bool
	botLevel int
	botDelay time.Duration
	engines  chan *engineHandle // search workers (nil until EnableBotFill)
	botMoves chan botMoveResult // bot moves ready to apply (on the Run goroutine)
	tb       *syzygy.Tablebase  // optional Syzygy tablebase, attached to every pooled engine (nil = disabled)

	// Spectator fillers: engine-vs-engine games kept running so the Watch page
	// is never empty. They run on a SEPARATE, small engine pool so they can't
	// starve human bot-fill, and only while someone is actually watching (JIT) —
	// the GET /games poll stamps lastWatchActivity. In-flight fillers always
	// finish naturally; we just stop replenishing once nobody is watching.
	fillerOn          bool
	fillerTarget      int                // desired total live games shown (real first, padded)
	fillerEngines     chan *engineHandle // dedicated filler search pool (nil until enabled)
	fillerFens        []string           // realistic midgame seed positions (Run goroutine only)
	fillerFensCh      chan []string      // delivers a fetched FEN pool to the Run goroutine
	lastWatchActivity atomic.Int64       // unix-nano of the most recent watch poll/connect

	// Live lobby counters. Written only on the Run goroutine (paired with the
	// register/unregister and startGame/finish lifecycle), read via atomics from
	// the /stats HTTP handler on another goroutine.
	onlineClients atomic.Int64
	activeGames   atomic.Int64

	// lobby is the pre-marshaled JSON for the GET /games handler — a top-N
	// snapshot of live games rebuilt on the Run goroutine each tick and published
	// here, read (never mutated) from the HTTP goroutine.
	lobby atomic.Pointer[[]byte]
}

// Stats returns live lobby counts (connected clients, active games). Safe to call
// from any goroutine.
func (h *Hub) Stats() (online, games int64) {
	return h.onlineClients.Load(), h.activeGames.Load()
}

// FinishedGame is handed to the persistence hook when a game ends.
type FinishedGame struct {
	ID       string
	Pool     string
	Rated    bool
	White    auth.Identity
	Black    auth.Identity
	WhiteBot bool // bot opponents have a non-anon identity (for display) but no account
	BlackBot bool
	Result   string // "1-0" | "0-1" | "1/2-1/2"
	Reason   string
	Moves    []string
	SANs     []string
}

// New creates a Hub authenticating tickets with the given shared secret.
func New(secret string) *Hub {
	return &Hub{
		secret:      secret,
		register:    make(chan *Client),
		unregister:  make(chan *Client),
		commands:    make(chan command, 256),
		pools:       map[string][]*Client{},
		games:       map[string]*game{},
		playerGames: map[string]*game{},
		challenges:  map[string]*challenge{},
		botMoves:    make(chan botMoveResult, 64),
	}
}

// SetTablebase attaches a Syzygy endgame tablebase that every bot/filler engine
// will probe at the root. Call BEFORE EnableBotFill / EnableSpectatorFillers so
// the pools are built with it attached. nil disables it.
func (h *Hub) SetTablebase(tb *syzygy.Tablebase) { h.tb = tb }

// OnFinish registers a callback invoked (on the hub goroutine) when a game ends.
func (h *Hub) OnFinish(fn func(FinishedGame)) { h.onFinish = fn }

// Run is the single-goroutine event loop. Block on it (e.g. `go h.Run()`).
func (h *Hub) Run() {
	ticker := time.NewTicker(200 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case c := <-h.register:
			if !c.spectator {
				h.onlineClients.Add(1)
			}
			h.handleRegister(c)
		case c := <-h.unregister:
			if !c.spectator {
				h.onlineClients.Add(-1)
			}
			h.handleDisconnect(c)
		case cmd := <-h.commands:
			h.handle(cmd)
		case r := <-h.botMoves:
			h.applyBotMove(r)
		case fens := <-h.fillerFensCh:
			// A fetched pool of realistic midgame FENs (from BaseAPI) — assigned on
			// the Run goroutine so startFillerGame can read it lock-free.
			h.fillerFens = fens
		case <-ticker.C:
			h.checkClocks()
			h.matchWaiting()
			h.checkBotFill()
			h.checkFillers()
			h.checkChallenges()
			h.publishLobby()
		}
	}
}

func (h *Hub) handle(cmd command) {
	c := cmd.client
	switch cmd.msg.Type {
	case "queue":
		h.queue(c, cmd.msg.Pool)
	case "cancel":
		h.dequeue(c)
		c.trySend(mustJSON(out("idle", nil)))
	case "move":
		h.move(c, cmd.msg.Move)
	case "resign":
		h.resign(c)
	case "drawOffer":
		h.drawOffer(c)
	case "drawAccept":
		h.drawAccept(c)
	case "drawDecline":
		h.drawDecline(c)
	case "takebackOffer":
		h.takebackOffer(c)
	case "takebackAccept":
		h.takebackAccept(c)
	case "takebackDecline":
		h.takebackDecline(c)
	case "chat":
		h.chat(c, cmd.msg.Text)
	case "watch":
		h.watchGame(c, cmd.msg.GameID)
	case "unwatch":
		h.unwatchGame(c)
	case "createChallenge":
		h.createChallenge(c, cmd.msg.Pool, cmd.msg.Color, cmd.msg.Rated)
	case "joinChallenge":
		h.joinChallenge(c, cmd.msg.Code)
	case "cancelChallenge":
		h.cancelChallenge(c)
	}
}

// --- matchmaking ---

func (h *Hub) queue(c *Client, pool string) {
	if c.game != nil {
		h.sendErr(c, "already in a game")
		return
	}
	tc, ok := parseTimeControl(pool)
	if !ok {
		h.sendErr(c, "invalid time control")
		return
	}
	h.dequeue(c)
	now := time.Now()
	c.queuedAt = now
	// Pair immediately only with a rating-close opponent (within this fresh
	// arrival's tight tolerance). Otherwise wait — matchWaiting widens the
	// acceptable gap over time, and bot backfill catches a lone long-waiter.
	if other := h.bestOpponent(c, pool, now); other != nil {
		h.dequeue(other)
		h.startGame(other, c, tc, pool)
		return
	}
	c.pool = pool
	h.pools[pool] = append(h.pools[pool], c)
	c.trySend(mustJSON(out("queued", map[string]any{"pool": pool})))
}

func (h *Hub) dequeue(c *Client) {
	if c.pool == "" {
		return
	}
	pool := h.pools[c.pool]
	for i, x := range pool {
		if x == c {
			h.pools[c.pool] = append(pool[:i], pool[i+1:]...)
			break
		}
	}
	c.pool = ""
}

func (h *Hub) startGame(a, b *Client, tc timeControl, pool string) {
	white, black := a, b
	if mrand.IntN(2) == 1 {
		white, black = b, a
	}
	// Public pairing is rated only if both sides are accounts.
	h.startGameWith(white, black, tc, pool, !white.id.Anon && !black.id.Anon)
}

// startGameWith creates a game between two clients with explicit colors and a
// caller-decided rated flag. Shared by public matchmaking (random colors, rated
// iff both accounts) and private challenges (creator's color/rated preference).
func (h *Hub) startGameWith(white, black *Client, tc timeControl, pool string, rated bool) {
	pos, _ := chess.ParseFEN(chess.StartFEN)
	g := &game{
		id:        newID(),
		white:     &player{client: white, id: white.id},
		black:     &player{client: black, id: black.id},
		pos:       pos,
		tc:        tc,
		pool:      pool,
		rated:     rated,
		clockMs:   [2]int64{tc.Base, tc.Base},
		turnStart: time.Now(),
		online:    [2]bool{true, true},
		startFen:  chess.StartFEN,
	}
	white.game, black.game = g, g
	h.games[g.id] = g
	h.playerGames[white.id.UserID] = g
	h.playerGames[black.id.UserID] = g
	h.activeGames.Add(1)
	h.sendMatched(g, white, chess.White)
	h.sendMatched(g, black, chess.Black)
}

func (h *Hub) sendMatched(g *game, c *Client, color chess.Color) {
	opp := g.playerFor(color.Opposite()).id
	colStr := "w"
	if color == chess.Black {
		colStr = "b"
	}
	c.trySend(mustJSON(out("matched", map[string]any{
		"gameId":      g.id,
		"color":       colStr,
		"rated":       g.rated,
		"pool":        g.pool,
		"fen":         g.pos.FEN(),
		"timeControl": map[string]int64{"base": g.tc.Base, "inc": g.tc.Inc},
		"clock":       map[string]int64{"w": g.clockMs[chess.White], "b": g.clockMs[chess.Black]},
		"opponent":    map[string]any{"name": opp.Name, "rating": opp.RatingFor(categoryForPool(g.pool)), "anon": opp.Anon},
		"legalMoves":  g.legalMoves(),
	})))
}

// --- gameplay ---

func (h *Hub) move(c *Client, uci string) {
	g := c.game
	if g == nil || g.over {
		h.sendErr(c, "no active game")
		return
	}
	color, ok := g.colorOf(c)
	if !ok {
		return
	}
	if g.pos.SideToMove() != color {
		h.sendErr(c, "not your turn")
		return
	}
	if _, ok := g.applyMove(uci); !ok {
		h.sendErr(c, "illegal move")
		return
	}
	h.broadcast(g, mustJSON(out("state", g.snapshot())))
	if st := g.status(); st.State != "ongoing" {
		h.finish(g, st.Result, st.State)
		return
	}
	h.scheduleBotMove(g) // no-op unless this is a bot game and it's now the bot's turn
}

func (h *Hub) resign(c *Client) {
	g := c.game
	if g == nil || g.over {
		return
	}
	color, ok := g.colorOf(c)
	if !ok {
		return
	}
	result := "0-1"
	if color == chess.Black {
		result = "1-0"
	}
	h.finish(g, result, "resign")
}

// --- draw offers, takebacks, chat (human-vs-human niceties) ---

// colorStr renders a color as "w"/"b" for the wire.
func colorStr(c chess.Color) string {
	if c == chess.Black {
		return "b"
	}
	return "w"
}

// broadcastPlayers sends to the two seated players only (not spectators). Offers
// and chat are private to the participants. A bot side has a nil client, so the
// offer simply goes unanswered — the frontend never learns the opponent is a bot.
func (h *Hub) broadcastPlayers(g *game, data []byte) {
	if g.white.client != nil {
		g.white.client.trySend(data)
	}
	if g.black.client != nil {
		g.black.client.trySend(data)
	}
}

func (h *Hub) drawOffer(c *Client) {
	g := c.game
	if g == nil || g.over {
		return
	}
	color, ok := g.colorOf(c)
	if !ok {
		return
	}
	if g.drawPending && g.drawBy == color {
		return // already standing
	}
	// Offering into a standing opposite offer is an acceptance.
	if g.drawPending && g.drawBy == color.Opposite() {
		h.finish(g, "1/2-1/2", "agreement")
		return
	}
	g.drawPending, g.drawBy = true, color
	h.broadcastPlayers(g, mustJSON(out("drawOffered", map[string]any{"gameId": g.id, "by": colorStr(color)})))
}

func (h *Hub) drawAccept(c *Client) {
	g := c.game
	if g == nil || g.over || !g.drawPending {
		return
	}
	if color, ok := g.colorOf(c); !ok || color == g.drawBy {
		return // only the side that did NOT offer can accept
	}
	h.finish(g, "1/2-1/2", "agreement")
}

func (h *Hub) drawDecline(c *Client) {
	g := c.game
	if g == nil || g.over || !g.drawPending {
		return
	}
	if _, ok := g.colorOf(c); !ok {
		return // either party (decliner or withdrawer) clears it
	}
	g.drawPending = false
	h.broadcastPlayers(g, mustJSON(out("drawDeclined", map[string]any{"gameId": g.id})))
}

func (h *Hub) takebackOffer(c *Client) {
	g := c.game
	if g == nil || g.over || len(g.moves) == 0 {
		return
	}
	color, ok := g.colorOf(c)
	if !ok {
		return
	}
	if g.takebackPending && g.takebackBy == color {
		return
	}
	if g.takebackPending && g.takebackBy == color.Opposite() {
		h.applyTakeback(g)
		return
	}
	g.takebackPending, g.takebackBy = true, color
	h.broadcastPlayers(g, mustJSON(out("takebackOffered", map[string]any{"gameId": g.id, "by": colorStr(color)})))
}

func (h *Hub) takebackAccept(c *Client) {
	g := c.game
	if g == nil || g.over || !g.takebackPending {
		return
	}
	if color, ok := g.colorOf(c); !ok || color == g.takebackBy {
		return
	}
	h.applyTakeback(g)
}

func (h *Hub) takebackDecline(c *Client) {
	g := c.game
	if g == nil || g.over || !g.takebackPending {
		return
	}
	if _, ok := g.colorOf(c); !ok {
		return
	}
	g.takebackPending = false
	h.broadcastPlayers(g, mustJSON(out("takebackDeclined", map[string]any{"gameId": g.id})))
}

// applyTakeback rolls the game back to the requester's most recent turn (1 or 2
// plies), broadcasts the new position to players and spectators, and reschedules
// a bot reply if the rolled-back turn belongs to a bot.
func (h *Hub) applyTakeback(g *game) {
	target := len(g.moves) - 1
	if target < 0 {
		return
	}
	requester := g.takebackBy
	g.rebuildTo(target)
	if g.pos.SideToMove() != requester && target >= 1 {
		target--
		g.rebuildTo(target)
	}
	g.clearOffers()
	h.broadcast(g, mustJSON(out("state", g.snapshot())))
	h.scheduleBotMove(g)
}

func (h *Hub) chat(c *Client, text string) {
	g := c.game
	if g == nil {
		return
	}
	color, ok := g.colorOf(c)
	if !ok {
		return // players only — spectators don't chat
	}
	if text = sanitizeChat(text); text == "" {
		return
	}
	h.broadcastPlayers(g, mustJSON(out("chat", map[string]any{
		"gameId": g.id,
		"by":     colorStr(color),
		"name":   c.id.Name,
		"text":   text,
	})))
}

// firstMoveTimeout is how long a side has to make its (untimed) first move
// before the game is aborted — a stalling guard that stands in for the clock
// while it hasn't started yet (Lichess-style).
const firstMoveTimeout = 30 * time.Second

func (h *Hub) checkClocks() {
	for _, g := range h.games {
		// Before the clocks start, neither side's time is running, so a stalled
		// opening ply can't flag. Abort if the side to move sits past the window.
		if !g.over && !g.clocksRunning() && time.Since(g.turnStart) >= firstMoveTimeout {
			h.abortGame(g)
			continue
		}
		side, flagged := g.flaggedSide()
		if !flagged {
			continue
		}
		opp := side.Opposite()
		result, reason := "1/2-1/2", "timeout-insufficient-material"
		if g.pos.CanAnyoneMate(opp) {
			reason = "timeout"
			if opp == chess.White {
				result = "1-0"
			} else {
				result = "0-1"
			}
		}
		h.finish(g, result, reason)
	}
}

func (h *Hub) finish(g *game, result, reason string) {
	if g.over {
		return
	}
	// Snapshot the live clocks BEFORE flipping `over`: remainingMs only deducts
	// the side-to-move's elapsed think-time while !over, so reading after over=true
	// would report the flagged side's pre-turn time (e.g. "lost on time" with 44s
	// still showing) instead of 0.
	clock := map[string]int64{"w": g.remainingMs(chess.White), "b": g.remainingMs(chess.Black)}
	g.over = true
	h.broadcast(g, mustJSON(out("end", map[string]any{
		"gameId": g.id,
		"result": result,
		"reason": reason,
		"status": g.status().State,
		"clock":  clock,
	})))
	h.teardown(g)

	// Filler (engine-vs-engine) games are never persisted or rated.
	if h.onFinish != nil && !g.filler {
		h.onFinish(FinishedGame{
			ID: g.id, Pool: g.pool, Rated: g.rated,
			White: g.white.id, Black: g.black.id,
			WhiteBot: g.white.isBot, BlackBot: g.black.isBot,
			Result: result, Reason: reason, Moves: g.moves, SANs: g.sans,
		})
	}
}

// abortGame ends a game with no result (first-move timeout). Aborted games are
// NOT reported to onFinish — they don't count toward records or ratings.
func (h *Hub) abortGame(g *game) {
	if g.over {
		return
	}
	g.over = true
	h.broadcast(g, mustJSON(out("end", map[string]any{
		"gameId": g.id,
		"result": nil,
		"reason": "aborted",
		"status": "aborted",
		"clock":  map[string]int64{"w": g.remainingMs(chess.White), "b": g.remainingMs(chess.Black)},
	})))
	h.teardown(g)
}

// teardown detaches both clients and removes the game from all indexes. The
// terminal end broadcast has already reached spectators; detach them so a later
// game lookup or unwatch is a no-op.
func (h *Hub) teardown(g *game) {
	if g.white.client != nil {
		g.white.client.game = nil
	}
	if g.black.client != nil {
		g.black.client.game = nil
	}
	for c := range g.spectators {
		c.watching = nil
	}
	g.spectators = nil
	delete(h.games, g.id)
	delete(h.playerGames, g.white.id.UserID)
	delete(h.playerGames, g.black.id.UserID)
	h.activeGames.Add(-1)
}

// handleRegister runs when a connection opens. If the player (by identity id)
// has an active game, reattach them and send a full resume; the lobby/game view
// can then pick it back up.
func (h *Hub) handleRegister(c *Client) {
	if c.spectator {
		return // spectators never reattach to a player's game
	}
	key := c.id.UserID
	if key == "" {
		return
	}
	g := h.playerGames[key]
	if g == nil || g.over {
		return
	}
	color := g.colorForID(key)
	g.playerFor(color).client = c
	g.online[color] = true
	c.game = g
	c.trySend(mustJSON(h.resumeMsg(g, color)))

	if opp := g.playerFor(color.Opposite()); g.online[color.Opposite()] && opp.client != nil {
		opp.client.trySend(mustJSON(out("opponentBack", map[string]any{"gameId": g.id})))
	}
}

func (h *Hub) resumeMsg(g *game, color chess.Color) map[string]any {
	opp := g.playerFor(color.Opposite()).id
	st := g.status()
	colStr := "w"
	if color == chess.Black {
		colStr = "b"
	}
	return out("resume", map[string]any{
		"gameId":         g.id,
		"color":          colStr,
		"rated":          g.rated,
		"pool":           g.pool,
		"fen":            g.pos.FEN(),
		"sideToMove":     st.SideToMove,
		"status":         st.State,
		"check":          st.Check,
		"timeControl":    map[string]int64{"base": g.tc.Base, "inc": g.tc.Inc},
		"clock":          map[string]int64{"w": g.remainingMs(chess.White), "b": g.remainingMs(chess.Black)},
		"opponent":       map[string]any{"name": opp.Name, "rating": opp.RatingFor(categoryForPool(g.pool)), "anon": opp.Anon},
		"legalMoves":     g.legalMoves(),
		"moves":          g.moveLog(),
		"lastMove":       g.lastUci(),
		"opponentOnline": g.online[color.Opposite()],
	})
}

// handleDisconnect keeps the game alive (no abandon): it marks the player
// offline so they can reconnect and resume. The clock keeps running, so an
// absent player still flags normally.
func (h *Hub) handleDisconnect(c *Client) {
	h.dequeue(c)
	h.dropChallenge(c) // tear down any pending private invite this client created
	h.unwatchGame(c)   // a spectator (or a player who was also watching) leaving
	g := c.game
	if g == nil || g.over {
		return
	}
	color := g.colorForID(c.id.UserID)
	if g.playerFor(color).client != c {
		return // a newer connection already took over this seat
	}
	g.online[color] = false
	// Drop any pending offer so the still-connected player isn't left staring at a
	// request the now-absent player can't answer.
	if g.drawPending {
		g.drawPending = false
		h.broadcastPlayers(g, mustJSON(out("drawDeclined", map[string]any{"gameId": g.id})))
	}
	if g.takebackPending {
		g.takebackPending = false
		h.broadcastPlayers(g, mustJSON(out("takebackDeclined", map[string]any{"gameId": g.id})))
	}
	if opp := g.playerFor(color.Opposite()); g.online[color.Opposite()] && opp.client != nil {
		opp.client.trySend(mustJSON(out("opponentGone", map[string]any{"gameId": g.id})))
	}
}

func (h *Hub) broadcast(g *game, data []byte) {
	if g.white.client != nil {
		g.white.client.trySend(data)
	}
	if g.black.client != nil {
		g.black.client.trySend(data)
	}
	for c := range g.spectators {
		c.trySend(data)
	}
}

func (h *Hub) sendErr(c *Client, msg string) {
	c.trySend(mustJSON(out("error", map[string]any{"message": msg})))
}

// --- WebSocket entrypoint ---

// ServeWS upgrades the request to a WebSocket after verifying its ticket.
func (h *Hub) ServeWS(w http.ResponseWriter, r *http.Request) {
	id, err := auth.Verify(r.URL.Query().Get("ticket"), h.secret)
	if err != nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: []string{"*"}})
	if err != nil {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	spectate := r.URL.Query().Get("spectate") == "1"
	c := &Client{hub: h, conn: conn, id: id, send: make(chan []byte, sendBuffer), ctx: ctx, cancel: cancel, spectator: spectate}
	go c.writePump()
	c.trySend(mustJSON(out("hello", map[string]any{"name": id.Name, "anon": id.Anon, "rating": id.Rating})))
	h.register <- c // reattach + resume if this player has an active game

	c.readPump() // blocks until the connection closes

	h.unregister <- c
	cancel()
	conn.CloseNow()
}

func newID() string {
	b := make([]byte, 6)
	_, _ = crand.Read(b)
	return hex.EncodeToString(b)
}

func mustJSON(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}
