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
	for range workers {
		h.fillerEngines <- engine.NewWithThreads(ttMB, searchThreads)
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
)

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

	pos, _ := chess.ParseFEN(chess.StartFEN)
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
		startFen:  chess.StartFEN,
		filler:    true,
	}
	h.games[g.id] = g
	h.activeGames.Add(1)
	h.scheduleBotMove(g) // White (a bot) moves first
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
