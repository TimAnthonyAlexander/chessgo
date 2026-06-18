package hub

import (
	"time"

	"github.com/timanthonyalexander/gomachine/internal/auth"
	"github.com/timanthonyalexander/gomachine/internal/chess"
	"github.com/timanthonyalexander/gomachine/internal/engine"
)

// player is one side of a live game.
type player struct {
	client *Client
	id     auth.Identity
}

// game is a single live game held entirely in memory. The clock is server-
// authoritative: the side-to-move's time decreases from turnStart in real time.
type game struct {
	id        string
	white     *player
	black     *player
	pos       *chess.Position
	tc        timeControl
	pool      string
	rated     bool
	moves     []string // UCI
	sans      []string
	clockMs   [2]int64 // remaining ms, indexed by chess.Color (White=0, Black=1)
	turnStart time.Time
	history   []uint64 // prior-position Zobrist keys (repetition)
	over      bool
	startFen  string
}

func (g *game) playerFor(c chess.Color) *player {
	if c == chess.White {
		return g.white
	}
	return g.black
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

// remainingMs is the live remaining time for color c (deducting elapsed time if
// it is currently c's turn).
func (g *game) remainingMs(c chess.Color) int64 {
	rem := g.clockMs[c]
	if !g.over && g.pos.SideToMove() == c {
		rem -= time.Since(g.turnStart).Milliseconds()
	}
	if rem < 0 {
		rem = 0
	}
	return rem
}

// applyMove validates and plays a UCI move, updating the mover's clock. Returns
// the SAN and whether the move was legal.
func (g *game) applyMove(uci string) (string, bool) {
	m, ok := g.pos.ParseUCIMove(uci)
	if !ok {
		return "", false
	}
	san := g.pos.SAN(m)

	now := time.Now()
	side := g.pos.SideToMove()
	g.clockMs[side] -= now.Sub(g.turnStart).Milliseconds()
	if g.clockMs[side] < 0 {
		g.clockMs[side] = 0
	}
	g.clockMs[side] += g.tc.Inc

	g.history = append(g.history, g.pos.Key())
	var u chess.Undo
	g.pos.DoMove(m, &u)
	g.moves = append(g.moves, uci)
	g.sans = append(g.sans, san)
	g.turnStart = now
	return san, true
}

// status adjudicates the current position (checkmate/stalemate/draws/ongoing).
func (g *game) status() engine.Status {
	return engine.Adjudicate(g.pos, g.history)
}

// flaggedSide returns the color whose clock has run out, or false if neither.
func (g *game) flaggedSide() (chess.Color, bool) {
	if g.over {
		return 0, false
	}
	side := g.pos.SideToMove()
	if g.remainingMs(side) <= 0 {
		return side, true
	}
	return 0, false
}

// snapshot builds the per-move state payload sent to both players.
func (g *game) snapshot() map[string]any {
	st := g.status()
	var lastMove, lastSan string
	if len(g.moves) > 0 {
		lastMove = g.moves[len(g.moves)-1]
		lastSan = g.sans[len(g.sans)-1]
	}
	return map[string]any{
		"gameId":     g.id,
		"fen":        g.pos.FEN(),
		"sideToMove": st.SideToMove,
		"lastMove":   lastMove,
		"san":        lastSan,
		"status":     st.State,
		"check":      st.Check,
		"clock":      map[string]int64{"w": g.remainingMs(chess.White), "b": g.remainingMs(chess.Black)},
		"ply":        len(g.moves),
		"legalMoves": g.legalMoves(),
	}
}

// legalMoves returns the UCI legal moves for the side to move (empty if over).
func (g *game) legalMoves() []string {
	if g.over {
		return []string{}
	}
	return g.pos.LegalMoveStrings(chess.SqNone)
}
