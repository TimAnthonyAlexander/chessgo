package hub

import (
	mrand "math/rand/v2"
	"time"

	"github.com/timanthonyalexander/gomachine/internal/chess"
	"github.com/timanthonyalexander/gomachine/internal/engine"
)

// EnableSpectatorFillers turns on engine-vs-engine "watch" games that keep the
// Watch lobby populated when there aren't enough real games. They run on a
// SEPARATE, deliberately small engine pool so they can never starve human
// bot-fill, and (via checkFillers) only while someone is actually watching.
// `target` is the desired number of live games shown; fillers pad real games up
// to it. Call before Run.
func (h *Hub) EnableSpectatorFillers(target, workers, ttMB, searchThreads int) {
	if target < 1 {
		target = 1
	}
	if workers < 1 {
		workers = 1
	}
	h.fillerOn = true
	h.fillerTarget = target
	h.fillerEngines = make(chan *engineHandle, workers)
	h.fillerFensCh = make(chan []string, 1)
	for range workers {
		h.fillerEngines <- engine.NewWithThreads(ttMB, searchThreads)
	}
}

// SetFillerFENs hands the hub a pool of realistic midgame positions to seed
// self-play watch fillers from (fetched from BaseAPI's puzzle set). Safe to call
// from any goroutine at any time; the pool is applied on the Run goroutine. An
// empty pool (or fillers disabled) leaves fillers starting from the opening.
func (h *Hub) SetFillerFENs(fens []string) {
	if h.fillerFensCh == nil {
		return
	}
	select {
	case h.fillerFensCh <- fens:
	default: // a pool is already queued; the latest call simply wins next time
	}
}

// checkFillers tops up self-play games on the ticker. JIT: it does nothing unless
// someone is watching. It never kills a running filler — only stops adding — so
// in-flight games always finish naturally (and drain once watchers leave). At
// most one is started per tick to ramp engine load gently rather than in a burst.
func (h *Hub) checkFillers() {
	if !h.fillerOn || !h.watchersActive() {
		return
	}
	real, filler := 0, 0
	for _, g := range h.games {
		if g.over {
			continue
		}
		if g.filler {
			filler++
		} else {
			real++
		}
	}
	// Pad up to the target, counting real games first. A busy lobby (real >=
	// target) wants zero fillers, so existing ones simply finish and aren't
	// replaced.
	if want := h.fillerTarget - real; filler < want {
		h.startFillerGame()
	}
}

// fillerPools are the time controls self-play games use — blitz/rapid so they
// move along and turn over at a watchable pace.
var fillerPools = []string{"3+0", "3+2", "5+0", "5+3", "10+0"}

const (
	fillerRatingMin  = 1100
	fillerRatingMax  = 2300
	fillerPairJitter = 110 // how far the two opponents' ratings may diverge

	// fillerPuzzleChance is the share of fillers seeded from a realistic midgame
	// position (a puzzle FEN) rather than the opening — when a FEN pool is loaded.
	// Two near-equal engines from the start position tend to drawish, samey games;
	// midgame positions are more decisive and varied, so the lobby looks alive.
	fillerPuzzleChance = 0.8
)

// pickFillerStart chooses the seed position for a new filler: usually a random
// realistic midgame FEN (when a pool is loaded), occasionally the opening. The
// candidate is validated; anything unparseable falls back to the start position,
// so a bad/empty pool degrades gracefully to today's behavior. Runs on the Run
// goroutine (reads h.fillerFens), so no locking is needed.
func (h *Hub) pickFillerStart() string {
	if len(h.fillerFens) == 0 || mrand.Float64() >= fillerPuzzleChance {
		return chess.StartFEN
	}
	cand := h.fillerFens[mrand.IntN(len(h.fillerFens))]
	if _, err := chess.ParseFEN(cand); err != nil {
		return chess.StartFEN
	}

	return cand
}

// startFillerGame creates one engine-vs-engine game with two believable, near-
// equally-rated fake opponents. It's filler=true: unrated, never persisted.
func (h *Hub) startFillerGame() {
	pool := fillerPools[mrand.IntN(len(fillerPools))]
	tc, ok := parseTimeControl(pool)
	if !ok {
		return
	}
	base := fillerRatingMin + mrand.IntN(fillerRatingMax-fillerRatingMin+1)
	rW := clampBotRating(base + mrand.IntN(2*fillerPairJitter+1) - fillerPairJitter)
	rB := clampBotRating(base + mrand.IntN(2*fillerPairJitter+1) - fillerPairJitter)

	startFen := h.pickFillerStart()
	pos, err := chess.ParseFEN(startFen)
	if err != nil { // defensive: pickFillerStart only returns validated FENs
		pos, _ = chess.ParseFEN(chess.StartFEN)
		startFen = chess.StartFEN
	}
	g := &game{
		id:    newID(),
		white: &player{id: newBotIdentity(rW), isBot: true, level: levelForRating(rW)},
		black: &player{id: newBotIdentity(rB), isBot: true, level: levelForRating(rB)},
		pos:   pos,
		tc:    tc,
		pool:  pool,
		// Display as Rated so the lobby looks like real ranked play. This is the
		// single source of truth both the /games summary and the spectator
		// "watching" payload read, so overview and spectate stay consistent. It is
		// purely cosmetic: the `filler` flag (not `rated`) is what gates persistence
		// and Elo in finish(), so a filler game is never recorded regardless.
		rated:     true,
		clockMs:   [2]int64{tc.Base, tc.Base},
		turnStart: time.Now(),
		online:    [2]bool{true, true},
		startFen:  startFen,
		filler:    true,
	}
	h.games[g.id] = g
	h.activeGames.Add(1)
	// Schedule the side to move (a bot). From the opening that's White; from a
	// midgame seed it may be Black — scheduleBotMove keys off pos.SideToMove().
	h.scheduleBotMove(g)
}

// clampBotRating keeps a displayed rating inside the bot rating band.
func clampBotRating(r int) int {
	if r < botRatingMin {
		return botRatingMin
	}
	if r > botRatingMax {
		return botRatingMax
	}
	return r
}
