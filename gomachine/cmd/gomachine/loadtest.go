package main

import (
	"context"
	"flag"
	"fmt"
	"math/rand/v2"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/timanthonyalexander/gomachine/internal/auth"
)

// cmdLoadtest drives synthetic WebSocket clients against a running hub to measure
// its realtime throughput and per-move latency under load. Clients queue in the
// same pool, the hub pairs them into human-vs-human games, and each client plays
// random legal moves on its turn — so the load exercises exactly the hub's single
// Run goroutine (matchmaking, move application, clocks) and its broadcast fan-out,
// with no engine/bot search involved (paired humans never trigger backfill).
//
// It mints its own tickets with the shared secret, so it needs only the hub
// running — not BaseAPI. (Games that reach a natural result still fire the hub's
// persistence POST; point the hub's BASEAPI_URL at nothing, or ignore the logged
// connection errors, for a pure-hub measurement.)
func cmdLoadtest(args []string) {
	fs := flag.NewFlagSet("loadtest", flag.ExitOnError)
	url := fs.String("url", "ws://127.0.0.1:6467/ws", "hub WebSocket URL")
	clients := fs.Int("clients", 100, "number of synthetic clients (paired into games)")
	pool := fs.String("pool", "3+0", "time-control pool to queue in")
	moveDelay := fs.Duration("move-delay", 0, "per-move think delay (0 = drive moves as fast as possible — max stress)")
	duration := fs.Duration("duration", 30*time.Second, "how long to sustain load")
	ramp := fs.Duration("ramp", 2*time.Second, "spread client connects over this window")
	secret := fs.String("secret", envOr("WS_TICKET_SECRET", "dev-insecure-secret"), "ticket HMAC secret (must match the hub)")
	_ = fs.Parse(args)

	if *clients < 2 {
		fmt.Fprintln(os.Stderr, "need at least 2 clients")
		os.Exit(2)
	}

	ctx, cancel := context.WithTimeout(context.Background(), *duration)
	defer cancel()

	m := &loadMetrics{}
	var wg sync.WaitGroup
	gap := time.Duration(0)
	if *clients > 0 {
		gap = *ramp / time.Duration(*clients)
	}

	fmt.Printf("loadtest: %d clients → %s pool %q, move-delay %v, for %v (ramp %v)\n",
		*clients, *url, *pool, *moveDelay, *duration, *ramp)

	// A per-run nonce keeps synthetic UserIDs unique across runs against the same
	// long-lived hub. Without it, a prior run's clients (which disconnect mid-game,
	// leaving games the hub correctly preserves for reconnect) would be reattached
	// on connect — and the fresh queue would bounce off "already in a game".
	runID := os.Getpid()

	start := time.Now()
	for i := 0; i < *clients; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			runLoadClient(ctx, runID, idx, *url, *pool, *secret, *moveDelay, m)
		}(i)
		if gap > 0 {
			select {
			case <-time.After(gap):
			case <-ctx.Done():
			}
		}
	}

	// Live progress every second until the run window closes.
	progressDone := make(chan struct{})
	go func() {
		t := time.NewTicker(1 * time.Second)
		defer t.Stop()
		var lastMoves int64
		for {
			select {
			case <-ctx.Done():
				close(progressDone)
				return
			case <-t.C:
				moves := m.moves.Load()
				fmt.Printf("  t=%4ds  conns=%d  games=%d  moves=%d (%d/s)  errs=%d\n",
					int(time.Since(start).Seconds()), m.conns.Load(), m.activeGames(),
					moves, moves-lastMoves, m.errs.Load())
				lastMoves = moves
			}
		}
	}()

	wg.Wait()
	<-progressDone
	m.report(time.Since(start))
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// runLoadClient connects one synthetic player, queues, and plays random legal
// moves on its turn until the context expires. When a game ends it re-queues so
// the client count stays a steady concurrent load for the whole run.
func runLoadClient(ctx context.Context, runID, idx int, url, pool, secret string, moveDelay time.Duration, m *loadMetrics) {
	// Anonymous identity (unrated games). UserID is unique per (run, client) so it
	// never collides with the shared empty reconnect key nor with a prior run's
	// still-live games; Anon=true keeps games casual. 1h expiry so it never lapses.
	name := fmt.Sprintf("load-%d-%d", runID, idx)
	id := auth.Identity{
		UserID: name,
		Anon:   true,
		Name:   name,
		Exp:    time.Now().Add(time.Hour).Unix(),
	}
	ticket := auth.Sign(id, secret)

	conn, _, err := websocket.Dial(ctx, url+"?ticket="+ticket, nil)
	if err != nil {
		if ctx.Err() == nil {
			m.errs.Add(1)
		}
		return
	}
	defer conn.CloseNow()
	conn.SetReadLimit(64 * 1024)
	m.conns.Add(1)

	myColor := "" // "w" | "b" once matched
	inGame := false
	awaitingEcho := false
	var sentAt time.Time

	send := func(v any) bool {
		wctx, c := context.WithTimeout(ctx, 5*time.Second)
		defer c()
		if err := wsjson.Write(wctx, conn, v); err != nil {
			return false
		}
		return true
	}

	// Enter the queue.
	if !send(map[string]any{"type": "queue", "pool": pool}) {
		return
	}

	// makeMove picks a random legal move and sends it, recording send time for
	// the echo-latency measurement.
	makeMove := func(legal []string) bool {
		if len(legal) == 0 {
			return true
		}
		if moveDelay > 0 {
			select {
			case <-time.After(moveDelay):
			case <-ctx.Done():
				return false
			}
		}
		mv := legal[rand.IntN(len(legal))]
		sentAt = time.Now()
		awaitingEcho = true
		if !send(map[string]any{"type": "move", "move": mv}) {
			return false
		}
		m.moves.Add(1)
		return true
	}

	for {
		var msg map[string]any
		if err := wsjson.Read(ctx, conn, &msg); err != nil {
			// On shutdown (ctx expired) resign any live game with a detached
			// context so the hub tears it down instead of keeping a ghost game
			// alive for reconnect — which would otherwise accumulate across runs.
			if inGame {
				rctx, rc := context.WithTimeout(context.Background(), time.Second)
				_ = wsjson.Write(rctx, conn, map[string]any{"type": "resign"})
				rc()
				m.gamesEnded.Add(1)
			}
			return
		}
		typ, _ := msg["type"].(string)
		switch typ {
		case "matched":
			myColor, _ = msg["color"].(string)
			inGame = true
			m.gamesStarted.Add(1)
			if sideToMove(msg) == myColor {
				if !makeMove(legalMoves(msg)) {
					return
				}
			}
		case "state", "resume":
			if awaitingEcho {
				m.recordLatency(time.Since(sentAt))
				awaitingEcho = false
			}
			// Only move on a live position and our turn. A terminal status can
			// still carry legal moves + our side to move (e.g. an insufficient-
			// material draw is broadcast just before the game's `end`); moving
			// into that already-finishing game would draw a "no active game" error.
			if status(msg) == "ongoing" && sideToMove(msg) == myColor {
				if !makeMove(legalMoves(msg)) {
					return
				}
			}
		case "end":
			m.gamesEnded.Add(1)
			inGame = false
			awaitingEcho = false
			myColor = ""
			// Re-queue for another game to keep the load steady.
			if ctx.Err() != nil || !send(map[string]any{"type": "queue", "pool": pool}) {
				return
			}
		case "error":
			m.errs.Add(1)
			if msgText, ok := msg["message"].(string); ok {
				m.noteErr(msgText)
			}
		}
	}
}

// sideToMove reads the side to move from a matched/state/resume message. The
// matched message has no sideToMove field (the game just started → white).
func sideToMove(msg map[string]any) string {
	if s, ok := msg["sideToMove"].(string); ok {
		return s
	}
	return "w"
}

// status reads the adjudication status (ongoing | checkmate | stalemate |
// draw-*). The matched message has no status field → treat as ongoing.
func status(msg map[string]any) string {
	if s, ok := msg["status"].(string); ok {
		return s
	}
	return "ongoing"
}

// legalMoves extracts the UCI legal-move list from a message ([]any of strings).
func legalMoves(msg map[string]any) []string {
	raw, ok := msg["legalMoves"].([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(raw))
	for _, v := range raw {
		if s, ok := v.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

// --- metrics ---

// loadMetrics aggregates counters across all client goroutines. Latency uses the
// shared lock-free latHist (bounded memory regardless of throughput).
type loadMetrics struct {
	conns        atomic.Int64
	moves        atomic.Int64
	gamesStarted atomic.Int64
	gamesEnded   atomic.Int64
	errs         atomic.Int64
	lat          latHist

	errSample atomic.Pointer[string] // first error message text seen
}

// noteErr records the first server error message text for the report.
func (m *loadMetrics) noteErr(text string) {
	if m.errSample.Load() == nil {
		m.errSample.CompareAndSwap(nil, &text)
	}
}

func (m *loadMetrics) activeGames() int64            { return m.gamesStarted.Load() - m.gamesEnded.Load() }
func (m *loadMetrics) recordLatency(d time.Duration) { m.lat.add(d) }

func (m *loadMetrics) report(elapsed time.Duration) {
	moves := m.moves.Load()
	secs := elapsed.Seconds()
	fmt.Println("\n=== loadtest results ===")
	fmt.Printf("duration:        %v\n", elapsed.Round(time.Millisecond))
	fmt.Printf("connections:     %d\n", m.conns.Load())
	fmt.Printf("games started:   %d  (ended %d)\n", m.gamesStarted.Load(), m.gamesEnded.Load())
	fmt.Printf("moves applied:   %d\n", moves)
	fmt.Printf("move throughput: %.0f moves/sec  (this is the hub Run-goroutine rate)\n", float64(moves)/secs)
	fmt.Printf("errors:          %d", m.errs.Load())
	if s := m.errSample.Load(); s != nil {
		fmt.Printf("  (first: %q)", *s)
	}
	fmt.Println()
	m.lat.report("move→echo latency (send move → receive resulting state broadcast)")
}
