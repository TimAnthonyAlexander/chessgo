package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	neturl "net/url"
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
	botLevel := fs.Int("bot-level", 6, "fallback bot level (0..10) for anonymous players; rated players get a bot matched to their Elo")
	botDelay := fs.Duration("bot-delay", 15*time.Second, "wait before a bot opponent is offered")
	botSearchThreads := fs.Int("bot-search-threads", 1, "Lazy SMP threads per bot move (helps only the time-bounded top levels; keep workers*threads <= cores)")
	watchFillers := fs.Bool("watch-fillers", true, "keep engine-vs-engine games running to populate the Watch page (only while someone is watching)")
	watchTarget := fs.Int("watch-target", 5, "number of live games shown on the Watch page (real games padded with fillers up to this)")
	watchWorkers := fs.Int("watch-filler-workers", 2, "dedicated engine workers for self-play filler games (small, so they can't starve human bot-fill)")
	watchFenTheme := fs.String("watch-fen-theme", "pin", "puzzle theme whose positions seed self-play fillers from realistic midgames (empty = any theme; fetched from BaseAPI)")
	pprofAddr := fs.String("pprof", "", "if set (e.g. 127.0.0.1:6481), serve net/http/pprof on this address for profiling the Run goroutine")
	_ = fs.Parse(args)

	startPprof(*pprofAddr)

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
		h.EnableBotFill(*botLevel, *botDelay, workers, 16, *botSearchThreads)
		fmt.Printf("bot backfill on: Elo-matched (fallback level %d) after %s (%d search workers, %d SMP threads/move)\n", *botLevel, *botDelay, workers, *botSearchThreads)
	}
	if *watchFillers {
		h.EnableSpectatorFillers(*watchTarget, *watchWorkers, 8, 1)
		fmt.Printf("watch fillers on: up to %d shown games, padded by self-play on %d dedicated workers (only while watched)\n", *watchTarget, *watchWorkers)
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

	// Seed self-play watch fillers from realistic midgame positions (a pool of
	// puzzle FENs from BaseAPI). Fetched off the hot path; on any failure the
	// pool stays empty and fillers start from the opening. Delivered to the Run
	// goroutine via the hub's channel, so this can run concurrently and late.
	if *watchFillers {
		go func() {
			// One-shot at startup, but with retry/backoff: on a deploy the hub can
			// boot before BaseAPI/PHP-FPM is reachable. A single failed fetch would
			// otherwise leave fillers on the opening for the whole process lifetime
			// (the "all starting positions" symptom). Keep trying for a few minutes.
			backoff := 2 * time.Second
			for attempt := 1; ; attempt++ {
				fens := fetchFillerFENs(baseURL, secret, *watchFenTheme, 200)
				if len(fens) > 0 {
					h.SetFillerFENs(fens)
					fmt.Printf("watch fillers: seeded %d midgame FENs (theme=%q) from BaseAPI (attempt %d)\n", len(fens), *watchFenTheme, attempt)
					return
				}
				if attempt >= 10 {
					fmt.Println("watch fillers: no midgame FENs after 10 attempts; fillers start from the opening")
					return
				}
				time.Sleep(backoff)
				if backoff < 30*time.Second {
					backoff *= 2
				}
			}
		}()
	}

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
	// Top live games for the Watch page (public, no ticket). The poll itself is
	// the "someone is watching" signal that keeps self-play fillers topped up.
	mux.HandleFunc("GET /games", func(w http.ResponseWriter, _ *http.Request) {
		h.WatchPing()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(h.LobbyJSON())
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

// fetchFillerFENs pulls a pool of realistic midgame positions from BaseAPI to
// seed self-play watch fillers (GET /internal/filler-fens, hub-secret gated).
// Best-effort: any error returns an empty slice and the hub simply starts its
// fillers from the opening. Theme is passed through ("pin" by default).
func fetchFillerFENs(baseURL, secret, theme string, n int) []string {
	url := fmt.Sprintf("%s/internal/filler-fens?theme=%s&n=%d", baseURL, neturl.QueryEscape(theme), n)
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		fmt.Fprintf(os.Stderr, "fetch filler fens: %v\n", err)
		return nil
	}
	req.Header.Set("X-Hub-Secret", secret)

	resp, err := (&http.Client{Timeout: 8 * time.Second}).Do(req)
	if err != nil {
		fmt.Fprintf(os.Stderr, "fetch filler fens: %v\n", err)
		return nil
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		fmt.Fprintf(os.Stderr, "fetch filler fens: status %d\n", resp.StatusCode)
		return nil
	}

	var payload struct {
		Fens []string `json:"fens"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		fmt.Fprintf(os.Stderr, "fetch filler fens: decode: %v\n", err)
		return nil
	}

	return payload.Fens
}
