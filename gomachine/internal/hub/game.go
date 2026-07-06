package hub

import (
	"time"

	"github.com/timanthonyalexander/gomachine/internal/auth"
	"github.com/timanthonyalexander/gomachine/internal/chess"
	"github.com/timanthonyalexander/gomachine/internal/engine"
	"github.com/timanthonyalexander/gomachine/internal/variant"
)

// player is one side of a live game. A bot opponent has isBot=true and a nil
// client (no socket); the hub plays its moves via the engine at `rating` (the
// rating-first ladder, engine.BestMoveForRating).
type player struct {
	client *Client
	id     auth.Identity
	isBot  bool
	rating int // target Elo for a bot side (drives configForRating); unused for humans
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

	// Pending draw / takeback offers. At most one of each may be outstanding; the
	// `*By` color is the side that made the offer. Any committed move clears both
	// (Lichess-style: a draw offer is declined by the opponent's reply, and a
	// stale takeback request is dropped once the position changes). Against a bot
	// opponent (no client) the offer is simply never answered.
	drawPending     bool
	drawBy          chess.Color
	takebackPending bool
	takebackBy      chess.Color

	// filler is true for an engine-vs-engine "watch" game: it has no human
	// players, is never rated, and is NOT reported to onFinish (no persistence,
	// no Elo). It exists only to populate the spectator lobby.
	filler bool

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
// (never the case where this is used — chatBotSide guards that).
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
	switch c {
	case g.white.client:
		return chess.White, true
	case g.black.client:
		return chess.Black, true
	}
	return 0, false
}

func (g *game) opponent(c *Client) *Client {
	if g.white.client == c {
		return g.black.client
	}
	return g.white.client
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
	return san, true
}

// clearOffers drops any outstanding draw/takeback offer.
func (g *game) clearOffers() {
	g.drawPending = false
	g.takebackPending = false
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
