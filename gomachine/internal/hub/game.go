package hub

import (
	mrand "math/rand/v2"
	"time"

	"github.com/timanthonyalexander/gomachine/internal/auth"
	"github.com/timanthonyalexander/gomachine/internal/chess"
	"github.com/timanthonyalexander/gomachine/internal/engine"
	"github.com/timanthonyalexander/gomachine/internal/variant"
)

// player is one side of a live game. A bot opponent has isBot=true and no
// clients (no socket); the hub plays its moves via the engine at `rating` (the
// rating-first ladder, engine.BestMoveForRating).
//
// `clients` is a SET, not a single socket: one account may have the same game
// open on several devices at once (laptop + phone). Every one of them receives
// the side's broadcasts and may move, so a move made on one appears on the other
// immediately. The side is "online" while at least one is connected.
type player struct {
	clients map[*Client]struct{}
	id      auth.Identity
	isBot   bool
	rating  int // target Elo for a bot side (drives configForRating); unused for humans

	// A bot side's manners, each rolled ONCE when the bot is created and then FIXED
	// for the whole game (like the chat persona — see botchat.go's chatPersona).
	// Some online opponents let you take a move back, some take a draw, some resign
	// when they're lost; which one you got is a property of the person, not of the
	// individual request. Rolling per REQUEST would mean re-asking until you got a
	// yes, which is both exploitable and nothing like playing a human. Meaningless
	// for a human side (they answer for themselves). See botoffers.go.
	takebackFriendly bool // grants takebacks
	acceptsDraws     bool // takes a draw when offered one in a position it isn't winning
	offersDraws      bool // offers a draw of its own in a dead-level game
	resigns          bool // resigns a lost game instead of playing it out
	asksTakeback     bool // asks for a takeback after blundering one away itself
	rematchFriendly  bool // takes a rematch when offered one after the game

	// presence is this bot's ONE fixed disposition for whether/how it is ever
	// absent during its own game — see presence.go's package doc. Rolled once
	// here like every manner above; presencePresent (the zero value) is inert,
	// so a human side's unset field never does anything either.
	presence botPresence
}

// newPlayer builds a human side seated on its first connection.
func newPlayer(c *Client) *player {
	return &player{clients: map[*Client]struct{}{c: {}}, id: c.id}
}

// newBotPlayer builds an engine side: an identity, a strength, a fixed set of
// manners, and no socket.
func newBotPlayer(id auth.Identity, rating int) *player {
	return &player{
		id:               id,
		isBot:            true,
		rating:           rating,
		takebackFriendly: mrand.Float64() < botTakebackAcceptChance,
		acceptsDraws:     mrand.Float64() < botAcceptDrawChance,
		offersDraws:      mrand.Float64() < botOfferDrawChance,
		resigns:          mrand.Float64() < botResignChance,
		asksTakeback:     mrand.Float64() < botAskTakebackChance,
		rematchFriendly:  mrand.Float64() < botRematchAcceptChance,
		presence:         rollBotPresence(),
	}
}

// newBotPlayerLike seats a FRESH bot side for the same person: same identity,
// same rating, same manners. A rematch is against the opponent you just played,
// so re-rolling their dispositions would mean the player who gave you a takeback
// last game arbitrarily refusing this one — which reads as two different people
// wearing one name. See rematch.go's bot rematch path.
func newBotPlayerLike(p *player) *player {
	clone := *p
	clone.clients = nil // a fresh seat holds no sockets, and a bot never has any
	return &clone
}

func (p *player) attach(c *Client) {
	if p.clients == nil {
		p.clients = map[*Client]struct{}{}
	}
	p.clients[c] = struct{}{}
}

func (p *player) detach(c *Client) { delete(p.clients, c) }

func (p *player) has(c *Client) bool {
	_, ok := p.clients[c]
	return ok
}

// connected reports whether any of this side's devices is still attached.
func (p *player) connected() bool { return len(p.clients) > 0 }

// send fans a pre-marshaled message out to every device on this side.
func (p *player) send(data []byte) {
	for c := range p.clients {
		c.trySend(data)
	}
}

// any returns one of this side's connections (nil if none). For the handful of
// places that need *a* client rather than all of them — starting a rematch from
// a finished game, say — where which one is arbitrary.
func (p *player) any() *Client {
	for c := range p.clients {
		return c
	}
	return nil
}

// game is a single live game held entirely in memory. The clock is server-
// authoritative: the side-to-move's time decreases from turnStart in real time.
type game struct {
	id        string
	white     *player
	black     *player
	state     variant.State // the live board, variant-agnostic (see internal/variant)
	tc        timeControl
	pool      string
	rated     bool
	moves     []string // UCI (standard/960); composite "<pieceUCI>:<duckSquare>" for duck
	sans      []string
	moveTimes []int64  // ms actually spent on each move (index i = think time for moves[i]); anti-cheat telemetry
	clockMs   [2]int64 // remaining ms, indexed by chess.Color (White=0, Black=1)
	turnStart time.Time
	over      bool
	online    [2]bool // per-color connection presence
	startFen  string
	variant   string // board ruleset id: "standard", "chess960" or "duck" (see internal/variant)

	// sqDesignationDeadline is Secret Queen's pre-game designation-phase
	// timer (checkSecretQueenDesignations): zero once both sides have
	// designated (or for every variant but secretqueen, always). It cannot
	// be derived from g.state the way "is side X designated" can
	// (secretQueenReady checks variant.HiddenState.OwnSecretSquare directly)
	// because a deadline is genuinely new per-game state with no State
	// equivalent — see hub.go's beginSecretQueenDesignation.
	sqDesignationDeadline time.Time

	// Pending draw / takeback offers. At most one of each may be outstanding; the
	// `*By` color is the side that made the offer. Any committed move clears both
	// (Lichess-style: a draw offer is declined by the opponent's reply, and a
	// stale takeback request is dropped once the position changes). A bot opponent
	// has no client to answer with, so the hub answers on its behalf after the
	// matching *AnswerAt beat, per that bot's fixed disposition — see botoffers.go.
	// A bot may also be the one OFFERING the draw (botOfferDraw).
	drawPending     bool
	drawBy          chess.Color
	takebackPending bool
	takebackBy      chess.Color

	// takebackAnswerAt / drawAnswerAt are when a bot opponent will answer the
	// standing offer of each kind — a short, human-ish beat rather than an instant
	// reflex reply. Zero means nobody owes an answer (no offer standing, or the
	// responder is human and answers for themselves). See botoffers.go.
	takebackAnswerAt time.Time
	drawAnswerAt     time.Time

	// The bot's own concessions, armed by considerBotConcession when its eval says
	// the game is level or lost and fired later by checkBotConcessions — so it
	// moves, sits there, and then gives up, rather than resigning in the same
	// instant as its move. Zero means nothing armed. botDrawOffered caps it at one
	// offer per game: a bot that asks every move until you cave is worse company
	// than one that never asks.
	botResignAt    time.Time
	botDrawOfferAt time.Time
	botDrawOffered bool

	// botTakebackAskAt / botTakebackAsked are the same arm-then-fire pattern for a
	// bot asking for ITS OWN move back after throwing something away (botoffers.go).
	// Capped at one per game for the same reason the draw offer is.
	botTakebackAskAt time.Time
	botTakebackAsked bool

	// botFullStrengthReplay makes the bot search its NEXT move at full strength
	// instead of its weakened rating. Set by applyTakeback when the side that got
	// its move back is a bot — i.e. the bot asked for a blunder back and the human
	// granted it. Without it the weakening ladder frequently reproduces the very
	// move that was just undone, so the bot asks for a takeback and then plays the
	// same blunder again, which is a worse look than never asking. Consumed once by
	// scheduleBotMove (bot.go).
	botFullStrengthReplay bool

	// rematchAnswerAt is when a bot will answer a rematch offer standing against
	// it, mirroring takebackAnswerAt/drawAnswerAt for the post-game window. Zero
	// means nobody owes an answer. See rematch.go.
	rematchAnswerAt time.Time

	// botEvals is each bot side's own search score (centipawns, from THAT bot's
	// point of view) for the last few moves it played, indexed by chess.Color. It
	// rides along free with every bot move (botMoveResult.evalCp), which is what
	// lets a bot judge "level" or "lost" without the hub ever running a search of
	// its own. Empty for a human side and for the self-search variants, which
	// return a move and no score.
	botEvals [2][]int

	// criticalThinksOwed counts, per bot side (indexed by chess.Color), how many
	// of ITS OWN next moves still owe a "critical moment" hard think — armed by
	// armCriticalThink (botoffers.go) when that side's own eval swings
	// ≥criticalSwingCp from the move before, consumed one at a time by
	// scheduleBotMove / scheduleSelfSearchBotMove when they snapshot state for
	// the next move. Zero means nothing owed. This is what lets a bot blitz a
	// quiet position and then visibly tank the move right after something
	// changes — the single most recognizable human tempo tell there is, and
	// until this the pacing model had no way to produce it.
	criticalThinksOwed [2]int

	// Rematch (see rematch.go). Only meaningful once the game has ended:
	// rematchArmedAt is stamped by armRematch at finish() and bounds the whole
	// rematch window (rematchTTL) regardless of whether an offer is ever made —
	// the finished game otherwise lives on only via each client's `lastGame`
	// pointer, so nothing else would ever reclaim it. rematchPending/rematchBy
	// track a standing offer within that window, mirroring drawPending/drawBy.
	rematchPending bool
	rematchBy      chess.Color
	rematchArmedAt time.Time
	// rematchOf is the finished game's id this game was created FROM via an
	// accepted rematch, "" for a normally-matched game. Carried into the
	// "matched" wire message so the client can tell the two apart.
	rematchOf string

	// filler is true for an engine-vs-engine "watch" game: it has no human
	// players, is never rated, and is NOT reported to onFinish (no persistence,
	// no Elo). It exists only to populate the spectator lobby.
	filler bool

	// arenaID is the running arena tournament this game was paired FROM, ""
	// for an ordinary game (public matchmaking, private challenge, rematch, or
	// bot fill). Set once at creation (arena.go's startArenaGame) and never
	// changed. finish() uses it to (a) tag the persisted game with the
	// tournament id and (b) return both human sides to that arena's pairing
	// pool automatically, rather than the game's own `.game`/`.clients`
	// bookkeeping needing any arena-specific field.
	arenaID string

	// spectators are read-only watchers of this game. They receive the same
	// state/end broadcasts as players but never affect the game; a slow one is
	// dropped by trySend like any client. Lazily allocated on first watcher.
	spectators map[*Client]struct{}

	// chatLog is a bounded, recent history of the in-game chat (both sides), kept
	// only so a fill-in bot opponent can reply in context. Human-vs-human games
	// don't need it but keep it too — it's tiny and the plumbing is uniform.
	chatLog []BotChatTurn

	// chat is the fill-in bot's fixed chat character for this game (nil for
	// human-vs-human / filler). chatCooldownUntil throttles its replies so it
	// answers a fast burst of human messages once, not line-by-line.
	chat              *chatPersona
	chatCooldownUntil time.Time

	// disconnectGraceSide / disconnectGraceAt are Feature A's automatic
	// disconnect-resolution timer (presence.go): disconnectGraceAt is when the
	// game resolves in favor of whichever side is still connected if
	// disconnectGraceSide's side hasn't come back by then (zero =
	// unarmed). Kept in sync by game.refreshDisconnectGrace, called from every
	// place online state can change — hub.go's handleDisconnect/attachToGame
	// and presence.go's fireBotDrop/fireBotReturn.
	disconnectGraceSide chess.Color
	disconnectGraceAt   time.Time

	// botDropAt / botReturnAt are Feature B's arm-then-fire timers for a
	// presenceDrops/presenceLeaves bot's one scripted absence (presence.go):
	// botDropAt is when it goes offline, botReturnAt is when a presenceDrops
	// bot (only) comes back. Zero means nothing armed/pending. See
	// armBotDrop/checkBotDrops.
	botDropAt   time.Time
	botReturnAt time.Time

	// teardownAt is set when a bot game ends and the farewell message is still in
	// flight; teardown is deferred until the farewell lands or this deadline passes.
	// The zero value means "teardown immediately" (the normal path for non-bot games
	// and for bot games whose farewell has already been delivered).
	teardownAt time.Time
}

// appendChat records a chat line (fromBot marks the bot side) into the bounded
// recent history used for fill-in bot replies. Oldest entries are dropped past
// botChatMaxHistory.
func (g *game) appendChat(fromBot bool, text string) {
	g.chatLog = append(g.chatLog, BotChatTurn{FromBot: fromBot, Text: text})
	if len(g.chatLog) > botChatMaxHistory {
		g.chatLog = g.chatLog[len(g.chatLog)-botChatMaxHistory:]
	}
}

// humanName returns the display name of the non-bot side in a human-vs-bot game
// (the bot's chat opponent). Falls back to White's name if both sides are bots
// (never the case where this is used — botVsHumanSide guards that).
func (g *game) humanName() string {
	if g.white.isBot {
		return g.black.id.Name
	}
	return g.white.id.Name
}

// colorForID returns which side the given identity id plays.
func (g *game) colorForID(id string) chess.Color {
	if g.white.id.UserID == id {
		return chess.White
	}
	return chess.Black
}

// sideToMove returns the color to move, variant-agnostically.
func (g *game) sideToMove() chess.Color { return g.state.Side() }

// boardFEN returns the (standard-shape) board FEN for the client renderer. Any
// auxiliary state (the duck square, the Crazyhouse pocket) rides separately in the
// wire's extras (see addExtras); the canonical FEN (g.state.FEN) is used only for
// reconstruction, not the wire.
func (g *game) boardFEN() string { return g.state.BoardFEN() }

// duckSquare returns the duck's current square ("" if unplaced), or "" for any
// variant without one — so the wire's "duck" field is always safe to include.
func (g *game) duckSquare() string { return g.state.Extras()["duck"] }

// addExtras merges the variant's auxiliary wire fields (the duck square, the
// Crazyhouse pocket, …) into a wire payload. A no-op for variants with none.
func (g *game) addExtras(m map[string]any) {
	for k, v := range g.state.Extras() {
		m[k] = v
	}
}

// lastUci returns the wire form of the last move played, or "". For duck this is
// just the PIECE portion of the composite ("e2e4:e5" -> "e2e4") — the duck target
// rides in the separate "duck" field.
func (g *game) lastUci() string {
	if len(g.moves) == 0 {
		return ""
	}
	return g.state.PrimaryUCI(g.moves[len(g.moves)-1])
}

// moveLog returns the full move history as {uci, san} pairs (for resume).
func (g *game) moveLog() []map[string]string {
	log := make([]map[string]string, len(g.moves))
	for i := range g.moves {
		log[i] = map[string]string{"uci": g.moves[i], "san": g.sans[i]}
	}
	return log
}

// startPly is the number of plies already played BEFORE the game's first
// recorded move — i.e. the half-move offset implied by a non-standard start
// position (a puzzle-seeded filler begins mid-game). It's 0 for games that begin
// from the opening (fullmove 1, White to move), so it only shifts the spectator
// move-list numbering for mid-game seeds. Derived from startFen; standard/960
// only (duck fillers don't exist), falling back to 0 on any parse trouble.
func (g *game) startPly() int {
	if g.startFen == "" {
		return 0
	}
	pos, err := chess.ParseFEN(g.startFen)
	if err != nil {
		return 0
	}
	plies := (int(pos.FullmoveNumber()) - 1) * 2
	if pos.SideToMove() == chess.Black {
		plies++
	}
	if plies < 0 {
		return 0
	}
	return plies
}

func (g *game) playerFor(c chess.Color) *player {
	if c == chess.White {
		return g.white
	}
	return g.black
}

// botPlayer returns the bot side and its color, or ok=false if this is a
// human-vs-human game. With a filler (engine-vs-engine) game both sides are
// bots; this returns whichever side is to move so callers schedule the right one.
func (g *game) botPlayer() (*player, chess.Color, bool) {
	side := g.state.Side()
	if p := g.playerFor(side); p.isBot {
		return p, side, true
	}
	if g.white.isBot {
		return g.white, chess.White, true
	}
	if g.black.isBot {
		return g.black, chess.Black, true
	}
	return nil, 0, false
}

func (g *game) colorOf(c *Client) (chess.Color, bool) {
	if g.white.has(c) {
		return chess.White, true
	}
	if g.black.has(c) {
		return chess.Black, true
	}
	return 0, false
}

// clocksRunning reports whether the clocks have started. Lichess-style: neither
// side's clock runs until it has made its first move, so the opening ply by each
// colour — the first two plies of the game — is untimed. From the moment both
// have moved (len >= 2), the side-to-move's clock always runs.
func (g *game) clocksRunning() bool { return len(g.moves) >= 2 }

// remainingMs is the live remaining time for color c (deducting elapsed time if
// it is currently c's turn and the clocks have started).
func (g *game) remainingMs(c chess.Color) int64 {
	rem := g.clockMs[c]
	if !g.over && g.clocksRunning() && g.sideToMove() == c {
		rem -= time.Since(g.turnStart).Milliseconds()
	}
	if rem < 0 {
		rem = 0
	}
	return rem
}

// applyMove validates and plays a move, updating the mover's clock. Returns the
// SAN and whether the move was legal. The board transition is variant-agnostic
// (g.state.Apply); the clock logic below is identical for every variant. The
// move string is plain UCI for standard/960 and the composite
// "<pieceUCI>:<duckSquare>" for duck — g.state knows how to parse its own.
func (g *game) applyMove(uci string) (string, bool) {
	side := g.state.Side() // pre-move side — read BEFORE g.state is reassigned
	next, san, ok := g.state.Apply(uci)
	if !ok {
		return "", false
	}

	now := time.Now()
	// The clock only runs once both sides have made their first move. Until then
	// (this side's opening ply) the move is untimed — no deduction, no increment.
	if g.clocksRunning() {
		g.clockMs[side] -= now.Sub(g.turnStart).Milliseconds()
		if g.clockMs[side] < 0 {
			g.clockMs[side] = 0
		}
		g.clockMs[side] += g.tc.Inc
	}

	g.state = next
	g.moves = append(g.moves, uci)
	g.sans = append(g.sans, san)
	g.moveTimes = append(g.moveTimes, now.Sub(g.turnStart).Milliseconds())
	g.turnStart = now
	g.clearOffers() // any move declines a pending draw and drops a stale takeback
	// Re-evaluate the disconnect grace timer, because THIS move may be the one
	// that starts the clocks: refreshDisconnectGrace refuses to arm while
	// clocksRunning() is false (that window belongs to firstMoveTimeout), so a
	// player who dropped after their own first move but before the reply landed
	// left nothing armed and nothing to arm it later — the game then sat until
	// their clock ran out, which on a 30+0 is the half-hour wait this feature
	// exists to prevent. Idempotent per absence (see its "already counting down"
	// guard), so calling it every move never restarts a running countdown.
	g.refreshDisconnectGrace()
	return san, true
}

// clearOffers drops any outstanding draw/takeback offer, including a bot's pending
// answer to either (there is no longer anything to answer). It deliberately leaves
// the bot's OWN armed concessions alone — those are not offers yet, and a bot that
// decided to resign does not change its mind because the opponent moved.
func (g *game) clearOffers() {
	g.drawPending = false
	g.takebackPending = false
	g.takebackAnswerAt = time.Time{}
	g.drawAnswerAt = time.Time{}
}

// fenHistory reconstructs the FEN of every prior position — start position
// through the position immediately before the current one — by replaying
// g.moves from g.startFen. It's the wire-shaped counterpart of g.state's
// internal Zobrist history (standardState.history): zugzwang's HTTP
// /bestmove (an external process, no shared position type) takes prior
// positions as FEN strings, not raw hash keys (WIRING_RECON.md §A). Only
// meaningful for the variants computeBotMove is ever used for
// (standard/960) — Duck/Crazyhouse use their own self-contained search
// (scheduleSelfSearchBotMove) and never call this. Runs on the Run
// goroutine (reads g.startFen/g.moves) but touches no shared state itself
// (variant.New builds a fresh, local replay state), so its result is safe
// to hand into a botSnapshot for a worker goroutine.
func (g *game) fenHistory() []string {
	if len(g.moves) == 0 {
		return nil
	}
	st, err := variant.New(g.variant, g.startFen)
	if err != nil {
		return nil
	}
	fens := make([]string, 0, len(g.moves))
	for _, mv := range g.moves {
		fens = append(fens, st.FEN())
		next, _, ok := st.Apply(mv)
		if !ok {
			break
		}
		st = next
	}
	return fens
}

// rebuildTo truncates the game to its first `plies` moves, reconstructing the
// position and repetition history from startFen by replaying them. Used to apply
// an agreed takeback. Clocks are intentionally left as-is (takeback is consensual);
// the turn timer restarts so neither side is charged for the negotiation.
func (g *game) rebuildTo(plies int) {
	st, err := variant.New(g.variant, g.startFen)
	if err != nil {
		return
	}
	for i := 0; i < plies; i++ {
		next, _, ok := st.Apply(g.moves[i])
		if !ok {
			break
		}
		st = next
	}
	g.state = st
	g.moves = g.moves[:plies]
	g.sans = g.sans[:plies]
	g.turnStart = time.Now()
}

// status adjudicates the current position (checkmate/stalemate/draws/ongoing for
// standard/960; king-capture/no-moves/move-cap for duck) — the variant decides.
func (g *game) status() engine.Status { return g.state.Status() }

// flaggedSide returns the color whose clock has run out, or false if neither.
func (g *game) flaggedSide() (chess.Color, bool) {
	if g.over {
		return 0, false
	}
	side := g.sideToMove()
	if g.remainingMs(side) <= 0 {
		return side, true
	}
	return 0, false
}

// snapshot builds the per-move state payload sent to both players. fen is the
// standard board FEN; variant-specific state rides in the extras merged on top —
// the duck square ("duck") for Duck, the pocket ("pocket") for Crazyhouse.
func (g *game) snapshot() map[string]any {
	st := g.status()
	var lastSan string
	if len(g.moves) > 0 {
		lastSan = g.sans[len(g.sans)-1]
	}
	snap := map[string]any{
		"gameId":     g.id,
		"variant":    g.variant,
		"fen":        g.boardFEN(),
		"duck":       g.duckSquare(), // kept for wire stability; "" for non-duck
		"sideToMove": st.SideToMove,
		"lastMove":   g.lastUci(),
		"san":        lastSan,
		"status":     st.State,
		"check":      st.Check,
		"clock":      map[string]int64{"w": g.remainingMs(chess.White), "b": g.remainingMs(chess.Black)},
		"ply":        len(g.moves),
		"legalMoves": g.legalMoves(),
	}
	g.addExtras(snap)
	return snap
}

// legalMoves returns the legal moves for the side to move (empty if over). For
// duck these are the PIECE moves (king captures included, no check filter — the
// duck targets are the client's to compute); otherwise standard UCI moves.
func (g *game) legalMoves() []string {
	if g.over {
		return []string{}
	}
	return g.state.LegalMoves()
}

// --- Secret Queen: per-viewer state (variant.HiddenState) ---
//
// Every variant above this point shares ONE payload with both players and
// every spectator (snapshot(), sendMatched, resumeMsg, spectateMsg) because
// their position genuinely IS public information. Secret Queen's isn't: see
// internal/variant/variant.go's HiddenState doc. The functions below are the
// hub's side of that split — hub.go's broadcastState/designateSecretQueen
// are the only callers.

// hiddenState reports whether g's ruleset needs a per-viewer payload
// (currently only Secret Queen) — the single switch point every call site
// below and in hub.go uses to decide whether the ordinary shared
// snapshot()/broadcast() path is still safe to use. Returns ok=false (hs
// nil) for every other variant, so nothing here executes for them.
func (g *game) hiddenState() (hs variant.HiddenState, ok bool) {
	hs, ok = g.state.(variant.HiddenState)
	return
}

// secretQueenReady reports whether BOTH sides have completed Secret Queen's
// designation phase — i.e. whether the game may actually be played yet. For
// every other variant this is unconditionally true (never gates anything).
// It reads OwnSecretSquare rather than a separate bool because, BEFORE the
// first move is played, "" unambiguously means "not designated yet" (a
// reveal — the only other way OwnSecretSquare can read "" — cannot have
// happened with zero moves on the board), so no extra state is needed to
// track this; sqDesignationDeadline (game.go's field doc) is the only piece
// that couldn't be derived the same way.
func (g *game) secretQueenReady() bool {
	hs, ok := g.hiddenState()
	if !ok {
		return true
	}
	return hs.OwnSecretSquare(chess.White) != "" && hs.OwnSecretSquare(chess.Black) != ""
}

// secretQueenViewerFields computes the fields that differ by recipient for a
// Secret Queen payload — legalMoves, secretSquare (or secretSquares once the
// game is over) and, mid-designation, needsDesignation. It is the SINGLE
// place this gating logic lives, shared by sendMatched, resumeMsg (both
// per-connection messages, called once per recipient already) and
// snapshotFor below (the per-viewer counterpart of the ordinary broadcast),
// so the "who may see what, and when" rule can't drift between those three
// call sites. viewer is the recipient's own side; callers for a spectator
// never call this at all (see snapshotFor's isPlayer branch) — a spectator
// gets legalMoves:[] and, once over, both secretSquares, with no "viewer"
// notion at all.
func secretQueenViewerFields(g *game, hs variant.HiddenState, viewer chess.Color) map[string]any {
	if g.over {
		// The result is decided — nothing left to protect. A post-game review
		// gets the full picture: both secret squares, though legalMoves is
		// moot (the game is over) and left empty for shape-stability with the
		// ongoing-game payload.
		return map[string]any{
			"legalMoves": []string{},
			"secretSquares": map[string]string{
				"w": hs.OwnSecretSquare(chess.White),
				"b": hs.OwnSecretSquare(chess.Black),
			},
		}
	}
	if !g.secretQueenReady() {
		return map[string]any{
			"needsDesignation": hs.OwnSecretSquare(viewer) == "",
			"legalMoves":       []string{},
		}
	}
	fields := map[string]any{"secretSquare": hs.OwnSecretSquare(viewer)}
	if g.state.Side() == viewer {
		fields["legalMoves"] = g.legalMoves() // the mover's own list — safe ONLY for the mover
	} else {
		fields["legalMoves"] = []string{}
	}
	return fields
}

// snapshotFor is the per-viewer counterpart of snapshot(), used only when
// g.hiddenState() reports ok (currently only Secret Queen — hub.go's
// broadcastState is the sole caller). The base fields are identical to
// snapshot()'s (and "fen" never differs by viewer — BoardFEN() never
// encodes the secret in the first place, only the wire's legalMoves and
// secretSquare fields carry information that must be withheld); only
// isPlayer/viewerColor change what secretQueenViewerFields adds on top.
// isPlayer=false is the spectator/neutral view (viewerColor is ignored).
func (g *game) snapshotFor(hs variant.HiddenState, viewerColor chess.Color, isPlayer bool) map[string]any {
	st := g.status()
	var lastSan string
	if len(g.moves) > 0 {
		lastSan = g.sans[len(g.sans)-1]
	}
	snap := map[string]any{
		"gameId":     g.id,
		"variant":    g.variant,
		"fen":        g.boardFEN(),
		"sideToMove": st.SideToMove,
		"lastMove":   g.lastUci(),
		"san":        lastSan,
		"status":     st.State,
		"check":      st.Check, // always false for Secret Queen (state.go's Status())
		"clock":      map[string]int64{"w": g.remainingMs(chess.White), "b": g.remainingMs(chess.Black)},
		"ply":        len(g.moves),
	}
	for k, v := range hs.Extras() { // public extras (currently: the last reveal) — safe for everyone
		snap[k] = v
	}
	if isPlayer {
		for k, v := range secretQueenViewerFields(g, hs, viewerColor) {
			snap[k] = v
		}
		return snap
	}
	// Spectator: never a secretSquare/needsDesignation field at all while the
	// game is ongoing; once over, the same full reveal a player gets.
	if g.over {
		snap["legalMoves"] = []string{}
		snap["secretSquares"] = map[string]string{
			"w": hs.OwnSecretSquare(chess.White),
			"b": hs.OwnSecretSquare(chess.Black),
		}
	} else {
		snap["legalMoves"] = []string{}
	}
	return snap
}
