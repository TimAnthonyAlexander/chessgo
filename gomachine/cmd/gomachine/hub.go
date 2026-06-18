package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"os"
	"runtime"
	"time"

	"github.com/timanthonyalexander/gomachine/internal/auth"
	"github.com/timanthonyalexander/gomachine/internal/hub"
)

// cmdVerifyTicket verifies a WebSocket ticket against the shared secret (debug /
// cross-language check against BaseAPI's minter).
func cmdVerifyTicket(args []string) {
	fs := flag.NewFlagSet("verifyticket", flag.ExitOnError)
	secret := fs.String("secret", os.Getenv("WS_TICKET_SECRET"), "shared HMAC secret")
	_ = fs.Parse(args)
	if fs.NArg() < 1 {
		fmt.Fprintln(os.Stderr, "usage: gomachine verifyticket -secret <secret> <token>")
		os.Exit(2)
	}
	id, err := auth.Verify(fs.Arg(0), *secret)
	if err != nil {
		fmt.Fprintln(os.Stderr, "INVALID:", err)
		os.Exit(1)
	}
	fmt.Printf("OK  name=%q anon=%v sub=%q rating=%d exp=%d\n", id.Name, id.Anon, id.UserID, id.Rating, id.Exp)
}

// cmdHub starts the realtime WebSocket server (matchmaking + live games).
func cmdHub(args []string) {
	fs := flag.NewFlagSet("hub", flag.ExitOnError)
	addr := fs.String("addr", "127.0.0.1:6467", "listen address")
	bots := fs.Bool("bots", true, "offer a bot opponent to a player waiting longer than -bot-delay")
	botLevel := fs.Int("bot-level", 6, "bot difficulty level (0..10)")
	botDelay := fs.Duration("bot-delay", 15*time.Second, "wait before a bot opponent is offered")
	_ = fs.Parse(args)

	secret := os.Getenv("WS_TICKET_SECRET")
	if secret == "" {
		secret = "dev-insecure-secret"
		fmt.Fprintln(os.Stderr, "warning: WS_TICKET_SECRET not set; using an insecure dev secret")
	}

	h := hub.New(secret)
	if *bots {
		workers := runtime.NumCPU() / 2
		if workers < 1 {
			workers = 1
		}
		h.EnableBotFill(*botLevel, *botDelay, workers, 16)
		fmt.Printf("bot backfill on: level %d after %s (%d search workers)\n", *botLevel, *botDelay, workers)
	}
	go h.Run()

	// Persist finished games via BaseAPI (wired in the next step). For now, log.
	h.OnFinish(func(g hub.FinishedGame) {
		fmt.Printf("game %s done: %s (%s) pool=%s rated=%v moves=%d\n",
			g.ID, g.Result, g.Reason, g.Pool, g.Rated, len(g.Moves))
	})

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", h.ServeWS)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
	})
	// Live lobby counts for the homepage (public, no ticket).
	mux.HandleFunc("GET /stats", func(w http.ResponseWriter, _ *http.Request) {
		online, games := h.Stats()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]int64{"playersOnline": online, "activeGames": games})
	})

	fmt.Printf("gomachine hub (realtime) listening on http://%s  (ws at /ws)\n", *addr)
	if err := http.ListenAndServe(*addr, mux); err != nil {
		fmt.Fprintln(os.Stderr, "hub error:", err)
		os.Exit(1)
	}
}
