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
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/timanthonyalexander/gomachine/internal/auth"
	"github.com/timanthonyalexander/gomachine/internal/chess"
	"github.com/timanthonyalexander/gomachine/internal/syzygy"
	"github.com/timanthonyalexander/gomachine/internal/variant"
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
	// sessions indexes every live player connection by identity id, so one
	// account signed in on several devices (laptop + phone) is knowable. When a
	// game starts, ALL of that account's connections are seated in it
	// (joinOtherSessions) — a side is a set of sockets, not one — so the same
	// game is playable from either device and stays in sync move by move.
	sessions map[string]map[*Client]struct{}
	// rematchWindows indexes finished games still eligible for a rematch
	// (armed by armRematch at finish(), keyed by game id) so the ticker can
	// reclaim them after rematchTTL — see rematch.go.
	rematchWindows map[string]*game
	onFinish       func(FinishedGame)

	// registerChallenges funnels a BaseAPI-registered server-side challenge
	// (RegisterServerChallenge, serverchallenge.go) onto the Run goroutine:
	// h.challenges is otherwise touched only there, so the "code already
	// taken" check and the map write must happen together. The caller (an
	// HTTP handler goroutine) blocks on the per-request result channel.
	registerChallenges chan registerChallengeReq

	// onlineQueries funnels a presence lookup (Online) onto the Run goroutine —
	// h.sessions is likewise Run-goroutine-only state.
	onlineQueries chan onlineQuery

	// arenaGamesQueries funnels a "what's live in this tournament right now"
	// lookup (ArenaGames) onto the Run goroutine — h.games is likewise
	// Run-goroutine-only state (see arena.go's doArenaGames).
	arenaGamesQueries chan arenaGamesQuery

	// Arena tournaments (arena.go): BaseAPI is the source of truth for which
	// tournaments are running and who's in them; the hub only ever PAIRS
	// participants and plays the games. arenaClient polls BaseAPI off the Run
	// goroutine (nil until SetArenaClient); each poll's result (or a direct
	// test injection) arrives over arenaSnapshotCh, always non-nil so it's
	// safe to select on whether or not arenas are enabled at all. h.arenas is
	// the Run-goroutine-only cache (tournament id -> live pairing state) built
	// from the latest snapshot — a BaseAPI outage simply stops refreshing it;
	// the hub keeps pairing/serving off the last known snapshot rather than
	// crashing or stalling.
	arenaClient     *arenaClient
	arenaSnapshotCh chan []ArenaSnapshot
	arenas          map[string]*arenaState

	// Bot backfill: if a player waits longer than a randomized per-player delay
	// (see randomBotFillDelay; botDelay is now only a legacy on/off default) with no human match,
	// pair them with an engine-driven opponent. Moves are computed off the Run
	// goroutine by a pool of engines and applied back via botMoves.
	botFill  bool
	botLevel int
	botDelay time.Duration
	engines  chan *engineHandle // concurrency permits (nil until EnableBotFill); also the EMERGENCY in-process search pool — see zugzwang below
	botMoves chan botMoveResult // bot moves ready to apply (on the Run goroutine)
	tb       *syzygy.Tablebase  // optional Syzygy tablebase, attached to every pooled engine (nil = disabled)

	// Zugzwang HTTP backend: the ROUTINE bot-move + watch-filler compute path
	// since 2026-07-14 (SetZugzwangClient) — search runs in zugzwang, an
	// external process, over its stateless /bestmove endpoint, not in
	// gomachine's in-process engine. `engines`/`fillerEngines` above are kept
	// around as (a) a concurrency permit for in-flight zugzwang requests and
	// (b) a warm EMERGENCY fallback: if zugzwang doesn't answer after one
	// retry and emergencyInProc is true, computeBotMove falls back to the
	// permit's own in-process *engine.Engine so a live game never freezes —
	// logged loudly each time it fires. If zugzwang is nil (not configured;
	// e.g. tests), the hub computes in-process directly with no HTTP attempt
	// and no fallback logging, exactly like before this backend existed.
	zugzwang        *zugzwangClient
	emergencyInProc bool

	// Fill-in bot chat: a backfill bot opponent chats like a person (opening
	// hello + occasional short replies). The text is produced by botChatFn (wired
	// to BaseAPI's OpenAI endpoint) OFF the Run goroutine; finished lines come
	// back over botChats and broadcast through the normal chat path. nil botChatFn
	// disables it. See botchat.go.
	botChatFn BotChatFunc
	botChats  chan botChatResult

	// Spectator fillers: engine-vs-engine games kept running so the Watch page
	// is never empty. They run on a SEPARATE, small engine pool so they can't
	// starve human bot-fill, and only while someone is actually watching (JIT) —
	// the GET /games poll stamps lastWatchActivity. In-flight fillers always
	// finish naturally; we just stop replenishing once nobody is watching.
	fillerOn          bool
	fillerTarget      int                // desired total live games shown (real first, padded)
	fillerEngines     chan *engineHandle // dedicated filler concurrency permits / emergency search pool (nil until enabled)
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

	// livePlayers indexes non-bot identities that are currently in a live,
	// non-filler game, so an out-of-band caller (BaseAPI anti-cheat, a profile
	// page's "playing now" link) can ask "is this user playing right now, and
	// what's their board/game/opponent?" without touching the Run goroutine's
	// maps. Written on the Run goroutine alongside playerGames (markLive/
	// unmarkLive); read via LivePlayer/LivePlayerDetail from the HTTP goroutine.
	livePlayers sync.Map // key: identity UserID (string) -> livePlayerEntry
}

// livePlayerEntry is the sync.Map value backing the live-player index: the
// current board FEN (the original anti-cheat probe's payload) plus the game
// id, pool, and opponent identity a profile page's "playing now" link needs.
// Stored per human side at markLive time; refreshLive only ever touches fen.
type livePlayerEntry struct {
	fen      string
	gameID   string
	pool     string
	opponent LivePlayerOpponent
}

// LivePlayerOpponent is the opposing side of a LivePlayerDetail's game — the
// zero value (empty name/title, 0 rating) whenever the subject isn't live.
type LivePlayerOpponent struct {
	Name   string `json:"name"`
	Title  string `json:"title"`
	Rating int    `json:"rating"`
}

// LivePlayerDetail is what GET /internal/live-player reports about an
// identity's current game: Live/FEN are the original anti-cheat probe's
// fields, unchanged; GameID/Pool/Opponent are additive, for a profile page's
// "playing now" link. The zero value (Live: false) is what an identity not
// currently in a live, non-filler game gets.
type LivePlayerDetail struct {
	Live     bool
	FEN      string
	GameID   string
	Pool     string
	Opponent LivePlayerOpponent
}

// LivePlayer reports whether the identity id is currently in a live, non-filler
// game and, if so, that game's current board FEN. Safe to call from any
// goroutine (backed by a sync.Map). The FEN lets the caller distinguish "used
// the analysis board" from "analyzed the exact position they are playing".
// Kept exactly as-is (signature and behavior) — see LivePlayerDetail for the
// richer, additive lookup.
func (h *Hub) LivePlayer(id string) (live bool, fen string) {
	if id == "" {
		return false, ""
	}
	v, ok := h.livePlayers.Load(id)
	if !ok {
		return false, ""
	}
	e, _ := v.(livePlayerEntry)
	return true, e.fen
}

// LivePlayerDetail reports everything LivePlayer does (Live/FEN, unchanged)
// plus the game id, pool, and opponent identity — enough for a profile page's
// "playing now" link. Safe to call from any goroutine (same sync.Map).
func (h *Hub) LivePlayerDetail(id string) LivePlayerDetail {
	if id == "" {
		return LivePlayerDetail{}
	}
	v, ok := h.livePlayers.Load(id)
	if !ok {
		return LivePlayerDetail{}
	}
	e, _ := v.(livePlayerEntry)
	return LivePlayerDetail{Live: true, FEN: e.fen, GameID: e.gameID, Pool: e.pool, Opponent: e.opponent}
}

// opponentInfoFor is the LivePlayerOpponent view of a game's other side, used
// by markLive to seat each human's live-player entry with the OTHER side's
// identity (white's entry carries black's info, and vice versa).
func opponentInfoFor(p *player, cat string) LivePlayerOpponent {
	return LivePlayerOpponent{Name: p.id.Name, Title: p.id.Title, Rating: p.id.RatingFor(cat)}
}

// markLive records both non-bot sides of g as in-game. Called on the Run
// goroutine at game start (paired with the playerGames writes).
func (h *Hub) markLive(g *game) {
	if g.filler {
		return
	}
	fen := g.boardFEN()
	cat := categoryFor(g.pool, g.variant)
	if !g.white.isBot {
		h.livePlayers.Store(g.white.id.UserID, livePlayerEntry{
			fen: fen, gameID: g.id, pool: g.pool, opponent: opponentInfoFor(g.black, cat),
		})
	}
	if !g.black.isBot {
		h.livePlayers.Store(g.black.id.UserID, livePlayerEntry{
			fen: fen, gameID: g.id, pool: g.pool, opponent: opponentInfoFor(g.white, cat),
		})
	}
}

// refreshLive updates the stored board FEN for g's live sides after a move.
// gameID/pool/opponent never change mid-game, so only fen is touched.
func (h *Hub) refreshLive(g *game) {
	if g.filler {
		return
	}
	fen := g.boardFEN()
	if !g.white.isBot {
		if v, ok := h.livePlayers.Load(g.white.id.UserID); ok {
			e, _ := v.(livePlayerEntry)
			e.fen = fen
			h.livePlayers.Store(g.white.id.UserID, e)
		}
	}
	if !g.black.isBot {
		if v, ok := h.livePlayers.Load(g.black.id.UserID); ok {
			e, _ := v.(livePlayerEntry)
			e.fen = fen
			h.livePlayers.Store(g.black.id.UserID, e)
		}
	}
}

// unmarkLive clears both sides of g from the live index (game teardown).
func (h *Hub) unmarkLive(g *game) {
	h.livePlayers.Delete(g.white.id.UserID)
	h.livePlayers.Delete(g.black.id.UserID)
}

// Stats returns live lobby counts (connected clients, active games). Safe to call
// from any goroutine.
func (h *Hub) Stats() (online, games int64) {
	return h.onlineClients.Load(), h.activeGames.Load()
}

// maxOnlineQuerySubs caps a single presence lookup so an oversized request list
// can't make the hub goroutine do unbounded work per call.
const maxOnlineQuerySubs = 200

// onlineQuery is one presence lookup funneled onto the Run goroutine — see
// Online and Hub.onlineQueries.
type onlineQuery struct {
	subs   []string
	result chan []string
}

// Online reports the subset of subs that currently have at least one live
// WebSocket connection (backs a friends list). Safe to call from any goroutine;
// subs beyond maxOnlineQuerySubs are ignored. The lookup is a single O(len(subs))
// pass over the existing session index (h.sessions), run inline in the Run
// goroutine's select — cheap, and it can never block the hub loop for longer
// than that one pass.
func (h *Hub) Online(subs []string) []string {
	if len(subs) > maxOnlineQuerySubs {
		subs = subs[:maxOnlineQuerySubs]
	}
	resultCh := make(chan []string, 1)
	h.onlineQueries <- onlineQuery{subs: subs, result: resultCh}
	return <-resultCh
}

// doOnline runs on the Run goroutine: h.sessions is keyed by identity id, and a
// non-empty connection set means that account has at least one live socket.
func (h *Hub) doOnline(subs []string) []string {
	online := make([]string, 0, len(subs))
	for _, sub := range subs {
		if conns := h.sessions[sub]; len(conns) > 0 {
			online = append(online, sub)
		}
	}
	return online
}

// FinishedGame is handed to the persistence hook when a game ends.
type FinishedGame struct {
	ID        string
	Pool      string
	Rated     bool
	Variant   string // "standard" | "chess960" | "duck"
	White     auth.Identity
	Black     auth.Identity
	WhiteBot  bool // bot opponents have a non-anon identity (for display) but no account
	BlackBot  bool
	Result    string // "1-0" | "0-1" | "1/2-1/2"
	Reason    string
	Moves     []string
	SANs      []string
	MoveTimes []int64 // ms spent per move (anti-cheat move-time telemetry), parallel to Moves
	// StartFEN is the position the game began from: chess.StartFEN for a normal
	// game, RandomChess960FEN() for Chess960, or a challenge's custom FEN. Only
	// non-standard for Chess960 and a custom-FEN challenge — a replay/PGN
	// consumer that assumes the classic start otherwise is safe to ignore it.
	StartFEN string
	// TournamentID is the running arena this game was paired from, "" for an
	// ordinary game. The persistence caller (cmd/gomachine/hub.go's
	// persistGame) only adds the field to BaseAPI's request body when this is
	// non-empty, so an ordinary game's POST is byte-identical to before.
	TournamentID string
}

// New creates a Hub authenticating tickets with the given shared secret.
func New(secret string) *Hub {
	return &Hub{
		secret:         secret,
		register:       make(chan *Client),
		unregister:     make(chan *Client),
		commands:       make(chan command, 256),
		pools:          map[string][]*Client{},
		games:          map[string]*game{},
		playerGames:    map[string]*game{},
		challenges:     map[string]*challenge{},
		sessions:       map[string]map[*Client]struct{}{},
		rematchWindows: map[string]*game{},
		botMoves:       make(chan botMoveResult, 64),
		botChats:       make(chan botChatResult, 64),

		registerChallenges: make(chan registerChallengeReq),
		onlineQueries:      make(chan onlineQuery),
		arenaGamesQueries:  make(chan arenaGamesQuery),

		arenaSnapshotCh: make(chan []ArenaSnapshot, 1),
		arenas:          map[string]*arenaState{},
	}
}

// SetTablebase attaches a Syzygy endgame tablebase that every bot/filler engine
// will probe at the root. Call BEFORE EnableBotFill / EnableSpectatorFillers so
// the pools are built with it attached. nil disables it.
func (h *Hub) SetTablebase(tb *syzygy.Tablebase) { h.tb = tb }

// SetZugzwangClient wires the hub's bot-move + watch-filler compute path to
// zugzwang's stateless HTTP /bestmove endpoint at baseURL — the routine
// backend; gomachine's in-process engine pools become emergency-only (see the
// zugzwang field doc on Hub). `timeout` bounds each HTTP attempt (one retry
// happens on failure, so a stalled call costs at most ~2×timeout before the
// emergency fallback or a dropped move). `emergencyInProc` gates whether a
// request that fails after retrying may fall back to the in-process engine
// pool; when false, a bot move is simply dropped (loudly logged) if zugzwang
// stays unreachable — the caller can re-derive it next time scheduleBotMove
// fires. Call before Run; not calling this at all leaves the hub computing
// bot moves in-process directly (no HTTP attempt), e.g. in tests.
func (h *Hub) SetZugzwangClient(baseURL string, timeout time.Duration, emergencyInProc bool) {
	h.zugzwang = newZugzwangClient(baseURL, timeout)
	h.emergencyInProc = emergencyInProc
}

// ZugzwangHealthy reports whether the configured zugzwang backend answers
// GET /healthz within ctx's deadline. false if no backend is configured.
// Safe to call from any goroutine (a fresh HTTP request, no shared state) —
// intended for a one-shot startup log, not a hot path.
func (h *Hub) ZugzwangHealthy(ctx context.Context) bool {
	return h.zugzwang != nil && h.zugzwang.Healthy(ctx)
}

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
		case r := <-h.botChats:
			h.deliverBotChat(r)
		case fens := <-h.fillerFensCh:
			// A fetched pool of realistic midgame FENs (from BaseAPI) — assigned on
			// the Run goroutine so startFillerGame can read it lock-free.
			h.fillerFens = fens
		case req := <-h.registerChallenges:
			req.result <- h.doRegisterServerChallenge(req)
		case q := <-h.onlineQueries:
			q.result <- h.doOnline(q.subs)
		case q := <-h.arenaGamesQueries:
			q.result <- h.doArenaGames(q.tournamentID)
		case snaps := <-h.arenaSnapshotCh:
			h.applyArenaSnapshots(snaps)
		case <-ticker.C:
			h.checkClocks()
			h.matchWaiting()
			h.checkBotFill()
			h.checkFillers()
			h.checkChallenges()
			h.checkRematches()
			h.checkArenas()
			h.publishLobby()
		}
	}
}

func (h *Hub) handle(cmd command) {
	c := cmd.client
	switch cmd.msg.Type {
	case "queue":
		h.queue(c, cmd.msg.Pool, cmd.msg.Variant)
	case "cancel":
		h.dequeue(c)
		c.trySend(mustJSON(out("idle", nil)))
	case "resume":
		h.resumeRequest(c)
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
		h.createChallenge(c, cmd.msg.Pool, cmd.msg.Color, cmd.msg.Rated, cmd.msg.Variant, cmd.msg.Fen)
	case "joinChallenge":
		h.joinChallenge(c, cmd.msg.Code)
	case "cancelChallenge":
		h.cancelChallenge(c)
	case "rematchOffer":
		h.rematchOffer(c)
	case "rematchAccept":
		h.rematchAccept(c)
	case "rematchDecline":
		h.rematchDecline(c)
	case "rematchCancel":
		h.rematchCancel(c)
	case "joinArena":
		h.joinArena(c, cmd.msg.TournamentID)
	case "leaveArena":
		h.leaveArena(c)
	}
}

// --- matchmaking ---

func (h *Hub) queue(c *Client, pool, variant string) {
	// Already playing — on THIS connection or on another device signed into the
	// same account. Never start a second game: seat this connection in the game
	// that's already running and resume it, which is what the player actually
	// wants when they hit "play" on their phone mid-laptop-game.
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
	variant = normalizeVariant(variant)
	h.dequeue(c)
	now := time.Now()
	c.queuedAt = now
	c.botFillDelay = randomBotFillDelay()
	// Key the queue by (pool, variant): standard keeps the bare pool key, so
	// standard matchmaking is byte-identical; a variant only ever pairs within its
	// own key. The tc/category are derived from the pool part (splitQueueKey).
	key := queueKey(pool, variant)
	// Pair immediately only with a rating-close opponent (within this fresh
	// arrival's tight tolerance). Otherwise wait — matchWaiting widens the
	// acceptable gap over time, and bot backfill catches a lone long-waiter.
	if other := h.bestOpponent(c, key, now); other != nil {
		h.dequeue(other)
		h.startGame(other, c, tc, pool, variant)
		return
	}
	c.pool = key
	h.pools[key] = append(h.pools[key], c)
	c.trySend(mustJSON(out("queued", map[string]any{"pool": pool, "variant": variant})))
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

func (h *Hub) startGame(a, b *Client, tc timeControl, pool, variant string) {
	white, black := a, b
	if mrand.IntN(2) == 1 {
		white, black = b, a
	}
	// Public pairing is rated only if both sides are accounts; startGameWith further
	// gates by variant (standard → time-control pools, duck → the duck pool, 960
	// unrated). The queue key carries the variant through (standard threads bare).
	h.startGameWith(white, black, tc, pool, !white.id.Anon && !black.id.Anon, variant, "", "", "")
}

// startGameWith creates a game between two clients with explicit colors and a
// caller-decided rated flag. Shared by public matchmaking (random colors, rated
// iff both accounts), private challenges (creator's color/rated preference,
// optionally a custom fen), an accepted rematch (rematchOf carries the
// finished game's id forward, "" otherwise) and arena pairing (arenaID names
// the running tournament this game was paired from, "" for every other
// caller — a rematch of an arena game is deliberately NOT tagged: rematches
// are a separate feature, and a tournament's own pairing loop already
// re-pairs its participants after every game). Returns the new game — the
// arenaID is set on it BEFORE sendMatched below, so "matched" carries the
// tournament id from the very first wire message.
func (h *Hub) startGameWith(white, black *Client, tc timeControl, pool string, rated bool, variantID string, rematchOf string, fen string, arenaID string) *game {
	// Starting any new game retires whatever rematch window either side's
	// previous finished game still held open — offering a rematch to someone
	// who already started playing again makes no sense, and leaving the
	// window armed would otherwise leak a stale broadcast to them mid-game.
	h.retireRematch(white.lastGame)
	h.retireRematch(black.lastGame)
	variantID = normalizeVariant(variantID)
	// Rating eligibility by variant. Standard chess feeds the time-control Glicko
	// pools; Duck Chess, Crazyhouse and Antichess each feed their own isolated pool
	// (categoryFor routes each). Chess960 alone stays unrated (no dedicated pool).
	// This is the single funnel for both public matchmaking and private
	// challenges, so gating rated here covers every started game.
	rated = rated && (variantID == variantStandard || variantID == variantDuck ||
		variantID == variantCrazyhouse || variantID == variantAntichess)
	// The start position is the classic start FEN, a random Fischer-random start
	// for Chess960, or (a private challenge only) a validated custom fen.
	// g.startFen MUST be this FEN (not chess.StartFEN), or a takeback rebuild
	// would replay from the wrong root. Duck begins from the standard start
	// with the duck unplaced — variant.New handles that; g.state is the single
	// source of board truth.
	startFen := chess.StartFEN
	switch {
	case variantID == variantChess960:
		// Chess960's own randomized start always wins — a custom fen is never
		// honoured here (callers must not offer one; validateCustomStartFEN
		// already rejects that combination at creation/registration time, so
		// this is a defensive belt-and-braces, not the primary guard).
		startFen = chess.RandomChess960FEN()
	case fen != "":
		startFen = fen
		// A custom start position must never move ratings — a hand-picked
		// position isn't a fair skill signal, whatever was requested.
		rated = false
	}
	st, err := variant.New(variantID, startFen)
	if err != nil {
		return nil // defensive: our start FENs always parse
	}
	g := &game{
		id:        newID(),
		white:     newPlayer(white),
		black:     newPlayer(black),
		state:     st,
		tc:        tc,
		pool:      pool,
		rated:     rated,
		clockMs:   [2]int64{tc.Base, tc.Base},
		turnStart: time.Now(),
		online:    [2]bool{true, true},
		startFen:  startFen,
		variant:   variantID,
		rematchOf: rematchOf,
		arenaID:   arenaID,
	}
	white.game, black.game = g, g
	h.games[g.id] = g
	h.playerGames[white.id.UserID] = g
	h.playerGames[black.id.UserID] = g
	h.markLive(g)
	h.activeGames.Add(1)
	h.sendMatched(g, white, chess.White)
	h.sendMatched(g, black, chess.Black)
	// Any other device signed into either account is now stale — tell it, so its
	// lobby offers to open the game instead of letting the player queue again.
	h.joinOtherSessions(g, white)
	h.joinOtherSessions(g, black)
	return g
}

func (h *Hub) sendMatched(g *game, c *Client, color chess.Color) {
	opp := g.playerFor(color.Opposite()).id
	colStr := "w"
	if color == chess.Black {
		colStr = "b"
	}
	payload := map[string]any{
		"gameId":      g.id,
		"color":       colStr,
		"rated":       g.rated,
		"pool":        g.pool,
		"variant":     g.variant,
		"fen":         g.boardFEN(),
		"duck":        g.duckSquare(),
		"timeControl": map[string]int64{"base": g.tc.Base, "inc": g.tc.Inc},
		"clock":       map[string]int64{"w": g.clockMs[chess.White], "b": g.clockMs[chess.Black]},
		"opponent":    map[string]any{"name": opp.Name, "rating": opp.RatingFor(categoryFor(g.pool, g.variant)), "anon": opp.Anon, "title": opp.Title},
		"legalMoves":  g.legalMoves(),
		"rematch":     g.rematchOf != "", // true iff this game was created by an accepted rematch
	}
	if g.arenaID != "" {
		payload["tournamentId"] = g.arenaID
	}
	g.addExtras(payload)
	c.trySend(mustJSON(out("matched", payload)))
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
	if g.sideToMove() != color {
		h.sendErr(c, "not your turn")
		return
	}
	if _, ok := g.applyMove(uci); !ok {
		h.sendErr(c, "illegal move")
		return
	}
	h.refreshLive(g) // keep the anti-cheat live-board FEN current
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

// broadcastPlayers sends to the two seated players only (not spectators) — every
// device on each side. Offers and chat are private to the participants. A bot
// side has no clients, so the offer simply goes unanswered — the frontend never
// learns the opponent is a bot.
func (h *Hub) broadcastPlayers(g *game, data []byte) {
	g.white.send(data)
	g.black.send(data)
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
	if g.sideToMove() != requester && target >= 1 {
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
	g.appendChat(false, text)
	h.broadcastPlayers(g, mustJSON(out("chat", map[string]any{
		"gameId": g.id,
		"by":     colorStr(color),
		"name":   c.id.Name,
		"text":   text,
	})))
	// If the opponent is a fill-in bot, it may answer (in context, after a beat).
	h.maybeReplyChat(g)
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
		// A flag is a loss only if the opponent can still mate. Standard/960 check
		// material; Duck Chess always can (a king is always capturable) — g.state
		// answers for the variant.
		if g.state.CanMate(opp) {
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

	// Filler (engine-vs-engine) games have no human clients to rematch, so
	// they never open a rematch window (armRematch would just index a game
	// nothing ever references).
	if !g.filler {
		h.armRematch(g)
	}

	// Filler (engine-vs-engine) games are never persisted or rated.
	if h.onFinish != nil && !g.filler {
		h.onFinish(FinishedGame{
			ID: g.id, Pool: g.pool, Rated: g.rated, Variant: g.variant,
			White: g.white.id, Black: g.black.id,
			WhiteBot: g.white.isBot, BlackBot: g.black.isBot,
			Result: result, Reason: reason, Moves: g.moves, SANs: g.sans,
			MoveTimes: g.moveTimes, StartFEN: g.startFen,
			TournamentID: g.arenaID,
		})
	}

	// An arena game's two human sides go back into that arena's pairing pool
	// automatically (if the arena is still running) rather than needing to
	// re-send joinArena — see arena.go. A no-op for g.arenaID == "".
	h.returnToArenaPool(g)
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
	// Clear each device's pointer to the game, but KEEP the per-side client sets:
	// the rematch window (armRematch/startRematch) still needs to reach the
	// participants after the game is gone from the indexes.
	for _, p := range []*player{g.white, g.black} {
		for c := range p.clients {
			c.game = nil
		}
	}
	for c := range g.spectators {
		c.watching = nil
	}
	g.spectators = nil
	delete(h.games, g.id)
	delete(h.playerGames, g.white.id.UserID)
	delete(h.playerGames, g.black.id.UserID)
	h.unmarkLive(g)
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
	if h.sessions[key] == nil {
		h.sessions[key] = map[*Client]struct{}{}
	}
	h.sessions[key][c] = struct{}{}

	if g := h.activeGameFor(c); g != nil {
		h.attachToGame(c, g)
	}
}

// activeGameFor returns the live game this connection's IDENTITY is already
// playing (not just this connection: the same account on another device counts),
// or nil. This is the single "am I already in a game?" question — asking
// `c.game != nil` only sees the one connection and lets a second device queue
// into a second game while the first is still running.
func (h *Hub) activeGameFor(c *Client) *game {
	if c.spectator || c.id.UserID == "" {
		return nil
	}
	g := h.playerGames[c.id.UserID]
	if g == nil || g.over {
		return nil
	}
	return g
}

// sessionLive reports whether c is still a live, hub-known connection for
// identity sub — the SAME question activeGameFor/attachToGame answer for a
// live game's "am I still connected, or did this device drop?" (multi-device
// resume), and the same index handleRegister adds a connection to and
// handleDisconnect removes it from. A parked server-side challenge slot
// (challenge.waitingClient) reuses this rather than inventing a second
// liveness signal: once handleDisconnect has processed a connection's drop,
// it is gone from h.sessions and this reports false; a still-open connection
// (including the exact one being asked about) reports true.
func (h *Hub) sessionLive(sub string, c *Client) bool {
	if sub == "" || c == nil {
		return false
	}
	_, ok := h.sessions[sub][c]
	return ok
}

// attachToGame seats c in g ALONGSIDE whatever other devices this account
// already has open on it, and sends it a full resume so it can render the game
// from scratch. Every attached device then receives the same broadcasts, so a
// move played on one shows up on the others immediately. Idempotent: attaching a
// connection that is already seated just re-sends the snapshot.
func (h *Hub) attachToGame(c *Client, g *game) {
	color := g.colorForID(c.id.UserID)
	p := g.playerFor(color)
	wasOffline := !p.connected()
	p.attach(c)
	g.online[color] = true
	c.game = g
	h.dequeue(c)       // a connection in a game is never also waiting in a pool
	h.dropChallenge(c) // …nor holding a pending invite
	c.trySend(mustJSON(h.resumeMsg(g, color)))

	// Only a genuine offline→online transition is news to the opponent; a second
	// device joining a side that was already connected changes nothing for them.
	if wasOffline && g.online[color.Opposite()] {
		g.playerFor(color.Opposite()).send(mustJSON(out("opponentBack", map[string]any{"gameId": g.id})))
	}
}

// joinOtherSessions seats this identity's OTHER connections in the game that
// just started on one of them — the phone, while you were matched on the laptop.
// Each gets a full resume, so the game simply opens there too and stays in sync
// from the first move. Attaching also pulls them out of any queue or pending
// invite (attachToGame does that), which they must leave anyway: otherwise
// matchmaking or bot backfill could drop them into a SECOND game moments later.
func (h *Hub) joinOtherSessions(g *game, seat *Client) {
	if g.filler {
		return
	}
	for c := range h.sessions[seat.id.UserID] {
		if c == seat {
			continue
		}
		h.attachToGame(c, g)
	}
}

// resumeRequest answers a client's explicit "do I have a game?" — used by a
// second device to take the seat over after an activeGame notice, and as a
// cheap re-check when an app comes back to the foreground on a socket that has
// been open (and therefore un-registered) the whole time.
func (h *Hub) resumeRequest(c *Client) {
	if g := h.activeGameFor(c); g != nil {
		h.attachToGame(c, g)
		return
	}
	// No game — report what the client IS doing rather than a blanket "idle",
	// which would otherwise wipe a waiting client's own searching/invite UI.
	if c.pool != "" {
		tcPool, variant := splitQueueKey(c.pool)
		c.trySend(mustJSON(out("queued", map[string]any{"pool": tcPool, "variant": variant})))
		return
	}
	if c.challengeCode != "" {
		return
	}
	c.trySend(mustJSON(out("idle", nil)))
}

func (h *Hub) resumeMsg(g *game, color chess.Color) map[string]any {
	opp := g.playerFor(color.Opposite()).id
	st := g.status()
	colStr := "w"
	if color == chess.Black {
		colStr = "b"
	}
	payload := map[string]any{
		"gameId":         g.id,
		"color":          colStr,
		"rated":          g.rated,
		"pool":           g.pool,
		"variant":        g.variant,
		"fen":            g.boardFEN(),
		"duck":           g.duckSquare(),
		"sideToMove":     st.SideToMove,
		"status":         st.State,
		"check":          st.Check,
		"timeControl":    map[string]int64{"base": g.tc.Base, "inc": g.tc.Inc},
		"clock":          map[string]int64{"w": g.remainingMs(chess.White), "b": g.remainingMs(chess.Black)},
		"opponent":       map[string]any{"name": opp.Name, "rating": opp.RatingFor(categoryFor(g.pool, g.variant)), "anon": opp.Anon, "title": opp.Title},
		"legalMoves":     g.legalMoves(),
		"moves":          g.moveLog(),
		"lastMove":       g.lastUci(),
		"opponentOnline": g.online[color.Opposite()],
	}
	if g.arenaID != "" {
		payload["tournamentId"] = g.arenaID
	}
	g.addExtras(payload)
	return out("resume", payload)
}

// handleDisconnect keeps the game alive (no abandon): it marks the player
// offline so they can reconnect and resume. The clock keeps running, so an
// absent player still flags normally.
func (h *Hub) handleDisconnect(c *Client) {
	if key := c.id.UserID; key != "" && h.sessions[key] != nil {
		delete(h.sessions[key], c)
		if len(h.sessions[key]) == 0 {
			delete(h.sessions, key)
		}
	}
	h.dequeue(c)
	h.dropChallenge(c)          // tear down any pending private invite this client created
	h.unwatchGame(c)            // a spectator (or a player who was also watching) leaving
	h.retireRematch(c.lastGame) // no one left to offer/accept a rematch with
	// Drop this connection from whatever arena WAITING pool it's parked in
	// (never touches a currently-playing arena game — that's g.arenaID, and
	// finish() re-derives who to return to the pool from the game's own
	// clients, which survive a reconnect; this per-connection field would not).
	h.clearArenaMembership(c)
	g := c.game
	if g == nil || g.over {
		return
	}
	color := g.colorForID(c.id.UserID)
	p := g.playerFor(color)
	p.detach(c)
	if p.connected() {
		return // the account still has this game open on another device
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
	if g.online[color.Opposite()] {
		g.playerFor(color.Opposite()).send(mustJSON(out("opponentGone", map[string]any{"gameId": g.id})))
	}
}

func (h *Hub) broadcast(g *game, data []byte) {
	g.white.send(data)
	g.black.send(data)
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
	c.trySend(mustJSON(out("hello", map[string]any{"name": id.Name, "anon": id.Anon, "rating": id.Rating, "title": id.Title})))
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
