package main

import (
	"bytes"
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

	// Persist finished games via BaseAPI (it owns MySQL + ratings). Fire-and-forget
	// off the hub goroutine so a slow/failed POST never stalls live play.
	baseURL := os.Getenv("BASEAPI_URL")
	if baseURL == "" {
		baseURL = "http://127.0.0.1:6464"
	}
	h.OnFinish(func(g hub.FinishedGame) {
		fmt.Printf("game %s done: %s (%s) pool=%s rated=%v moves=%d\n",
			g.ID, g.Result, g.Reason, g.Pool, g.Rated, len(g.Moves))
		go persistGame(baseURL, secret, g)
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

// persistGame POSTs a finished game to BaseAPI's internal results endpoint,
// authenticated by the shared hub secret. Runs in its own goroutine; errors are
// logged, never fatal (the live game is already over and broadcast).
func persistGame(baseURL, secret string, g hub.FinishedGame) {
	body, err := json.Marshal(map[string]any{
		"id":     g.ID,
		"pool":   g.Pool,
		"rated":  g.Rated,
		"result": g.Result,
		"reason": g.Reason,
		"white":  map[string]any{"uid": g.White.UserID, "name": g.White.Name, "anon": g.White.Anon, "bot": g.WhiteBot, "rating": g.White.Rating},
		"black":  map[string]any{"uid": g.Black.UserID, "name": g.Black.Name, "anon": g.Black.Anon, "bot": g.BlackBot, "rating": g.Black.Rating},
		"moves":  g.Moves,
		"sans":   g.SANs,
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "persist game %s: marshal: %v\n", g.ID, err)
		return
	}
	req, err := http.NewRequest(http.MethodPost, baseURL+"/internal/games", bytes.NewReader(body))
	if err != nil {
		fmt.Fprintf(os.Stderr, "persist game %s: %v\n", g.ID, err)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Hub-Secret", secret)

	resp, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
	if err != nil {
		fmt.Fprintf(os.Stderr, "persist game %s: %v\n", g.ID, err)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		fmt.Fprintf(os.Stderr, "persist game %s: status %d\n", g.ID, resp.StatusCode)
	}
}
