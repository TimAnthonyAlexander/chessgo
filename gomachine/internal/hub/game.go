package hub

import (
	"strings"
	"time"

	"github.com/timanthonyalexander/gomachine/internal/auth"
	"github.com/timanthonyalexander/gomachine/internal/chess"
	"github.com/timanthonyalexander/gomachine/internal/duckchess"
	"github.com/timanthonyalexander/gomachine/internal/engine"
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
	pos       *chess.Position
	duck      *duckchess.State // non-nil ONLY for variant=="duck"; standard/960 use pos
	tc        timeControl
	pool      string
	rated     bool
	moves     []string // UCI (standard/960); composite "<pieceUCI>:<duckSquare>" for duck
	sans      []string
	clockMs   [2]int64 // remaining ms, indexed by chess.Color (White=0, Black=1)
	turnStart time.Time
	history   []uint64 // prior-position Zobrist keys (repetition); unused for duck
	over      bool
	online    [2]bool // per-color connection presence
	startFen  string
	variant   string // board ruleset: "standard", "chess960" or "duck"

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
}

// colorForID returns which side the given identity id plays.
func (g *game) colorForID(id string) chess.Color {
	if g.white.id.UserID == id {
		return chess.White
	}
	return chess.Black
}

// isDuck reports whether this is a Duck Chess game (branches the whole game flow
// onto internal/duckchess instead of the standard chess core).
func (g *game) isDuck() bool { return g.variant == variantDuck }

// sideToMove returns the color to move, variant-agnostically. Standard/960 read
// the chess position; duck reads the duck state (g.pos may be a stale start).
func (g *game) sideToMove() chess.Color {
	if g.isDuck() {
		return g.duck.Side()
	}
	return g.pos.SideToMove()
}

// boardFEN returns the (standard) board FEN. For duck the duck rides separately
// (see duckSquare) and is never inside the FEN.
func (g *game) boardFEN() string {
	if g.isDuck() {
		return g.duck.FEN()
	}
	return g.pos.FEN()
}

// duckSquare returns the duck's current square ("" if unplaced), or "" for any
// non-duck variant — so the wire's "duck" field is always safe to include.
func (g *game) duckSquare() string {
	if g.isDuck() {
		return g.duck.DuckString()
	}
	return ""
}

// lastUci returns the last move played, or "". For duck it returns just the PIECE
// portion of the composite ("e2e4:e5" -> "e2e4") — the wire's lastMove is the
// piece move; the duck target rides in the separate "duck" field.
func (g *game) lastUci() string {
	if len(g.moves) == 0 {
		return ""
	}
	last := g.moves[len(g.moves)-1]
	if g.isDuck() {
		if piece, _, ok := strings.Cut(last, ":"); ok {
			return piece
		}
	}
	return last
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
	if g.variant == variantDuck || g.startFen == "" {
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
	side := g.pos.SideToMove()
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
// SAN and whether the move was legal. Duck games take the composite path; all
// other variants use the standard chess core (byte-identical to before duck).
func (g *game) applyMove(uci string) (string, bool) {
	if g.isDuck() {
		return g.applyDuckMove(uci)
	}
	m, ok := g.pos.ParseUCIMove(uci)
	if !ok {
		return "", false
	}
	san := g.pos.SAN(m)

	now := time.Now()
	side := g.pos.SideToMove()
	// The clock only runs once both sides have made their first move. Until then
	// (this side's opening ply) the move is untimed — no deduction, no increment.
	if g.clocksRunning() {
		g.clockMs[side] -= now.Sub(g.turnStart).Milliseconds()
		if g.clockMs[side] < 0 {
			g.clockMs[side] = 0
		}
		g.clockMs[side] += g.tc.Inc
	}

	g.history = append(g.history, g.pos.Key())
	var u chess.Undo
	g.pos.DoMove(m, &u)
	g.moves = append(g.moves, uci)
	g.sans = append(g.sans, san)
	g.turnStart = now
	g.clearOffers() // any move declines a pending draw and drops a stale takeback
	return san, true
}

// applyDuckMove validates and applies a composite Duck Chess move
// "<pieceUCI>:<duckSquare>", mirroring server/duck.go's handleDuckMove. The clock
// logic is variant-agnostic (identical to the standard path); duck games keep NO
// Zobrist repetition history (termination comes from duck status, not threefold).
func (g *game) applyDuckMove(composite string) (string, bool) {
	ns, pm, _, err := g.duck.ApplyComposite(composite)
	if err != nil {
		return "", false
	}
	// SAN is rendered relative to the PRE-move state (g.duck), with the new duck
	// square — same call shape as the HTTP handler.
	san := g.duck.SAN(pm, ns.Duck())

	now := time.Now()
	side := g.sideToMove() // pre-move side (read before g.duck is reassigned)
	if g.clocksRunning() {
		g.clockMs[side] -= now.Sub(g.turnStart).Milliseconds()
		if g.clockMs[side] < 0 {
			g.clockMs[side] = 0
		}
		g.clockMs[side] += g.tc.Inc
	}

	g.duck = &ns
	g.moves = append(g.moves, composite)
	g.sans = append(g.sans, san)
	g.turnStart = now
	g.clearOffers()
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
	if g.isDuck() {
		g.rebuildDuckTo(plies)
		return
	}
	pos, err := chess.ParseFEN(g.startFen)
	if err != nil {
		return
	}
	hist := make([]uint64, 0, plies)
	for i := 0; i < plies; i++ {
		m, ok := pos.ParseUCIMove(g.moves[i])
		if !ok {
			break
		}
		hist = append(hist, pos.Key())
		var u chess.Undo
		pos.DoMove(m, &u)
	}
	g.pos = pos
	g.history = hist
	g.moves = g.moves[:plies]
	g.sans = g.sans[:plies]
	g.turnStart = time.Now()
}

// rebuildDuckTo reconstructs a duck game to its first `plies` moves by replaying
// the composite moves from the start (duck unplaced) through duckchess. Duck games
// have no Zobrist history, so nothing repetition-related is rebuilt.
func (g *game) rebuildDuckTo(plies int) {
	ds, err := duckchess.Parse(g.startFen, "")
	if err != nil {
		return
	}
	for i := 0; i < plies; i++ {
		ns, _, _, aerr := ds.ApplyComposite(g.moves[i])
		if aerr != nil {
			break
		}
		ds = ns
	}
	g.duck = &ds
	g.moves = g.moves[:plies]
	g.sans = g.sans[:plies]
	g.turnStart = time.Now()
}

// status adjudicates the current position (checkmate/stalemate/draws/ongoing for
// standard/960; duck terminal semantics for duck).
func (g *game) status() engine.Status {
	if g.isDuck() {
		return g.duckStatus()
	}
	return engine.Adjudicate(g.pos, g.history)
}

// duckStatus maps duckchess terminal detection onto the hub's engine.Status shape.
// There is no check in Duck Chess (Check is always false); a win is either a king
// capture or the loser having no legal piece move; the move cap forces a draw.
func (g *game) duckStatus() engine.Status {
	st := engine.Status{State: "ongoing", Check: false, SideToMove: g.duck.SideChar()}
	switch g.duck.Status() {
	case duckchess.Ongoing:
		// still playing
	case duckchess.Draw:
		st.State, st.Result = "draw-move-cap", "1/2-1/2"
	case duckchess.WhiteWin:
		st.State, st.Result = duckTerminalReason(g.duck), "1-0"
	case duckchess.BlackWin:
		st.State, st.Result = duckTerminalReason(g.duck), "0-1"
	}
	return st
}

// duckTerminalReason distinguishes the two ways a Duck Chess game is won: a
// captured (missing) king vs. the side to move having no legal piece move.
func duckTerminalReason(st *duckchess.State) string {
	var whiteKing, blackKing bool
	for sq := chess.Square(0); sq < 64; sq++ {
		switch st.PieceOn(sq) {
		case chess.WhiteKing:
			whiteKing = true
		case chess.BlackKing:
			blackKing = true
		}
	}
	if !whiteKing || !blackKing {
		return "king-captured"
	}
	return "no-legal-moves"
}

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

// snapshot builds the per-move state payload sent to both players. For duck games
// fen is the board FEN, duck is the duck's square, legalMoves are the piece moves,
// and check is always false; non-duck games send duck="".
func (g *game) snapshot() map[string]any {
	st := g.status()
	var lastSan string
	if len(g.moves) > 0 {
		lastSan = g.sans[len(g.sans)-1]
	}
	return map[string]any{
		"gameId":     g.id,
		"variant":    g.variant,
		"fen":        g.boardFEN(),
		"duck":       g.duckSquare(),
		"sideToMove": st.SideToMove,
		"lastMove":   g.lastUci(),
		"san":        lastSan,
		"status":     st.State,
		"check":      st.Check,
		"clock":      map[string]int64{"w": g.remainingMs(chess.White), "b": g.remainingMs(chess.Black)},
		"ply":        len(g.moves),
		"legalMoves": g.legalMoves(),
	}
}

// legalMoves returns the legal moves for the side to move (empty if over). For
// duck these are the PIECE moves (king captures included, no check filter — the
// duck targets are the client's to compute); otherwise standard UCI moves.
func (g *game) legalMoves() []string {
	if g.over {
		return []string{}
	}
	if g.isDuck() {
		pms := g.duck.LegalPieceMoves()
		moves := make([]string, len(pms))
		for i, m := range pms {
			moves[i] = m.UCI()
		}
		return moves
	}
	return g.pos.LegalMoveStrings(chess.SqNone)
}
