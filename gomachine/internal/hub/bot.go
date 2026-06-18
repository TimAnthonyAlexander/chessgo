package hub

import (
	mrand "math/rand/v2"
	"strconv"
	"strings"
	"time"

	"github.com/timanthonyalexander/gomachine/internal/auth"
	"github.com/timanthonyalexander/gomachine/internal/chess"
	"github.com/timanthonyalexander/gomachine/internal/engine"
)

// engineHandle is a pooled search engine used to compute bot moves.
type engineHandle = engine.Engine

// botMoveResult is a bot move computed off the Run goroutine, ready to apply.
type botMoveResult struct {
	gameID string
	ply    int // move count when the bot started thinking (staleness guard)
	uci    string
}

// botSnapshot is an immutable copy of everything a worker needs to pick a move,
// so it never touches live game state from another goroutine.
type botSnapshot struct {
	gameID      string
	ply         int
	fen         string
	history     []uint64
	level       int
	remainingMs int64
	legalCount  int
}

// EnableBotFill turns on bot backfill: a player waiting longer than `delay` with
// no human match is paired with an engine opponent at `level`. `workers` pooled
// engines (each `ttMB` of transposition table) bound concurrent bot thinking.
// Call before Run so the configuration is visible to the Run goroutine.
func (h *Hub) EnableBotFill(level int, delay time.Duration, workers, ttMB int) {
	if workers < 1 {
		workers = 1
	}
	h.botFill = true
	h.botLevel = level
	h.botDelay = delay
	h.engines = make(chan *engineHandle, workers)
	for range workers {
		h.engines <- engine.New(ttMB)
	}
}

// checkBotFill promotes any player who has waited past botDelay into a bot game.
// Humans are always preferred: two waiting players pair instantly in queue(), so
// only a lone, long-waiting player is ever backfilled. Runs on the ticker.
func (h *Hub) checkBotFill() {
	if !h.botFill {
		return
	}
	now := time.Now()
	for pool := range h.pools {
		var kept, promote []*Client
		for _, c := range h.pools[pool] {
			if now.Sub(c.queuedAt) >= h.botDelay {
				promote = append(promote, c)
			} else {
				kept = append(kept, c)
			}
		}
		if len(kept) == 0 {
			delete(h.pools, pool)
		} else {
			h.pools[pool] = kept
		}
		tc, ok := parseTimeControl(pool)
		if !ok {
			continue
		}
		for _, c := range promote {
			c.pool = ""
			h.startBotGame(c, tc, pool)
		}
	}
}

// startBotGame pairs a human with a fresh random bot opponent. To the client it
// looks like any other match (name + rating in the matched payload).
func (h *Hub) startBotGame(human *Client, tc timeControl, pool string) {
	if human.game != nil {
		return
	}
	bot := newBotIdentity()
	pos, _ := chess.ParseFEN(chess.StartFEN)
	g := &game{
		id:        newID(),
		pos:       pos,
		tc:        tc,
		pool:      pool,
		rated:     false, // bot games are never rated
		clockMs:   [2]int64{tc.Base, tc.Base},
		turnStart: time.Now(),
		online:    [2]bool{true, true},
		startFen:  chess.StartFEN,
	}

	humanColor := chess.White
	if mrand.IntN(2) == 1 {
		humanColor = chess.Black
	}
	if humanColor == chess.White {
		g.white = &player{client: human, id: human.id}
		g.black = &player{id: bot, isBot: true}
	} else {
		g.white = &player{id: bot, isBot: true}
		g.black = &player{client: human, id: human.id}
	}

	human.game = g
	h.games[g.id] = g
	h.playerGames[human.id.UserID] = g
	h.activeGames.Add(1)

	h.sendMatched(g, human, humanColor)
	h.scheduleBotMove(g) // if the bot plays White, it moves first
}

// scheduleBotMove starts async move computation when it is the bot's turn.
func (h *Hub) scheduleBotMove(g *game) {
	if !h.botFill || g.over {
		return
	}
	_, botColor, ok := g.botPlayer()
	if !ok || g.pos.SideToMove() != botColor {
		return
	}
	go h.computeBotMove(botSnapshot{
		gameID:      g.id,
		ply:         len(g.moves),
		fen:         g.pos.FEN(),
		history:     append([]uint64(nil), g.history...),
		level:       h.botLevel,
		remainingMs: g.remainingMs(botColor),
		legalCount:  len(g.pos.LegalMoveStrings(chess.SqNone)),
	})
}

// computeBotMove runs OFF the Run goroutine: search for a move, pace it to feel
// human (the delay is real time, so it comes off the bot's clock), then hand it
// back via botMoves for application on the Run goroutine.
func (h *Hub) computeBotMove(s botSnapshot) {
	pos, err := chess.ParseFEN(s.fen)
	if err != nil {
		return
	}
	start := time.Now()
	eng := <-h.engines
	res := eng.BestMove(pos, s.level, s.history)
	h.engines <- eng
	if res.Move == chess.NullMove {
		return
	}

	delay := botThinkDelay(s.remainingMs, s.legalCount)
	if elapsed := time.Since(start); elapsed < delay {
		time.Sleep(delay - elapsed)
	}

	select {
	case h.botMoves <- botMoveResult{gameID: s.gameID, ply: s.ply, uci: res.Move.String()}:
	case <-time.After(2 * time.Second):
		// Run goroutine wedged/gone; drop rather than leak.
	}
}

// applyBotMove plays a computed bot move on the Run goroutine, guarding against a
// stale game (ended, resigned, or already advanced while the bot was thinking).
func (h *Hub) applyBotMove(r botMoveResult) {
	g := h.games[r.gameID]
	if g == nil || g.over {
		return
	}
	if _, botColor, ok := g.botPlayer(); !ok || g.pos.SideToMove() != botColor || len(g.moves) != r.ply {
		return
	}
	if _, ok := g.applyMove(r.uci); !ok {
		return
	}
	h.broadcast(g, mustJSON(out("state", g.snapshot())))
	if st := g.status(); st.State != "ongoing" {
		h.finish(g, st.Result, st.State)
	}
	// After a bot move it is the human's turn; the next bot move is scheduled when
	// the human replies (in move()).
}

// botThinkDelay returns a randomized, human-ish pause before the bot's move,
// never spending more than ~40% of its remaining clock (so it won't flag itself).
func botThinkDelay(remainingMs int64, legalCount int) time.Duration {
	ms := 400 + mrand.IntN(1400) // ~0.4–1.8s baseline
	if legalCount > 28 {
		ms += mrand.IntN(900) // more options → think a little longer
	}
	if mrand.Float64() < 0.15 {
		ms += mrand.IntN(2200) // occasional longer ponder
	}
	if maxMs := int(remainingMs * 4 / 10); ms > maxMs {
		ms = maxMs
	}
	if ms < 150 {
		ms = 150
	}
	return time.Duration(ms) * time.Millisecond
}

// --- fake identity ---

func newBotIdentity() auth.Identity {
	return auth.Identity{
		UserID: "bot-" + newID(),
		Anon:   false, // rendered like an account so the rating shows
		Name:   fakeUsername(),
		Rating: 900 + mrand.IntN(1100), // ~900–2000
	}
}

var (
	botAdjs = []string{
		"Swift", "Silent", "Iron", "Lazy", "Cosmic", "Mad", "Quiet", "Turbo",
		"Sneaky", "Royal", "Frozen", "Hyper", "Grim", "Lucky", "Vivid", "Rusty",
		"Brave", "Sly", "Noble", "Wild", "Solar", "Crimson", "Velvet", "Atomic",
	}
	botNouns = []string{
		"Knight", "Pawn", "Rook", "Bishop", "Gambit", "Castle", "Falcon", "Otter",
		"Endgame", "Blitz", "Zugzwang", "Patzer", "Walrus", "Penguin", "Mongoose",
		"Tactician", "Capybara", "Comet", "Viper", "Badger", "Phoenix", "Raven",
	}
)

// fakeUsername builds a believable, varied handle (no external faker dependency).
func fakeUsername() string {
	a := botAdjs[mrand.IntN(len(botAdjs))]
	n := botNouns[mrand.IntN(len(botNouns))]
	switch mrand.IntN(5) {
	case 0:
		return strings.ToLower(a + "_" + n)
	case 1:
		return a + n + strconv.Itoa(mrand.IntN(99))
	case 2:
		return strings.ToLower(n) + strconv.Itoa(1985+mrand.IntN(25)) // looks like a birth year
	case 3:
		return a + n
	default:
		return n + strconv.Itoa(mrand.IntN(9999))
	}
}
