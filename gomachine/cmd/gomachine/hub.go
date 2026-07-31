package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	neturl "net/url"
	"os"
	"runtime"
	"strings"
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
	botDelay := fs.Duration("bot-delay", 4*time.Second, "wait before a bot opponent is offered")
	botSearchThreads := fs.Int("bot-search-threads", 1, "Lazy SMP threads per bot move (helps only the time-bounded top levels; keep workers*threads <= cores)")
	watchFillers := fs.Bool("watch-fillers", true, "keep engine-vs-engine games running to populate the Watch page (only while someone is watching)")
	watchTarget := fs.Int("watch-target", 5, "number of live games shown on the Watch page (real games padded with fillers up to this)")
	watchWorkers := fs.Int("watch-filler-workers", 2, "dedicated engine workers for self-play filler games (small, so they can't starve human bot-fill)")
	watchFenTheme := fs.String("watch-fen-theme", "pin", "puzzle theme whose positions seed self-play fillers from realistic midgames (empty = any theme; fetched from BaseAPI)")
	tbPath := fs.String("tb-path", "", "Syzygy tablebase dir; empty auto-discovers (SYZYGY_PATH env, then data/syzygy)")
	zugzwangURL := fs.String("zugzwang-url", envOr("ZUGZWANG_URL", "http://127.0.0.1:6476"), "zugzwang engine base URL — the routine bot-move + watch-filler compute backend (env ZUGZWANG_URL)")
	zugzwangTimeoutFlag := fs.Duration("zugzwang-timeout", 5*time.Second, "per-attempt HTTP timeout for a zugzwang /bestmove call (one retry on failure)")
	emergencyInProc := fs.Bool("emergency-inproc", true, "fall back to gomachine's in-process engine if zugzwang is unreachable after retrying (logged loudly each time); zugzwang is the routine backend — this is a last-resort safety net so a live game never freezes. Disable to hard-fail (drop the move) instead of silently degrading to in-process search")
	arenas := fs.Bool("arenas", true, "poll BaseAPI for running Arena tournaments and pair their participants")
	arenaBotWorkers := fs.Int("arena-bot-workers", 3, "dedicated engine workers for arena bot-vs-bot moves — its OWN pool, separate from -watch-filler-workers, so a large tournament field can't crowd out (or be crowded out by) the Watch page")
	pprofAddr := fs.String("pprof", "", "if set (e.g. 127.0.0.1:6481), serve net/http/pprof on this address for profiling the Run goroutine")
	_ = fs.Parse(args)

	startPprof(*pprofAddr)

	secret := os.Getenv("WS_TICKET_SECRET")
	if secret == "" {
		secret = "dev-insecure-secret"
		fmt.Fprintln(os.Stderr, "warning: WS_TICKET_SECRET not set; using an insecure dev secret")
	}
	// Needed before Run (SetArenaClient) as well as after (persistence/bot-chat/
	// filler-FEN fetches below), so resolve it once, up front.
	baseURL := os.Getenv("BASEAPI_URL")
	if baseURL == "" {
		baseURL = "http://127.0.0.1:6464"
	}

	h := hub.New(secret)
	// zugzwang is the ROUTINE bot-move + watch-filler compute backend (an
	// external HTTP process); gomachine's own in-process engine pools below
	// become emergency-only (SetZugzwangClient's doc + Hub.zugzwang field
	// doc). Wire this up before EnableBotFill/EnableSpectatorFillers so both
	// pools are built as the (now emergency-only) fallback from the start.
	h.SetZugzwangClient(*zugzwangURL, *zugzwangTimeoutFlag, *emergencyInProc)
	healthCtx, healthCancel := context.WithTimeout(context.Background(), 2*time.Second)
	zugzwangUp := h.ZugzwangHealthy(healthCtx)
	healthCancel()
	if zugzwangUp {
		fmt.Printf("zugzwang engine reachable at %s (emergency-inproc=%v)\n", *zugzwangURL, *emergencyInProc)
	} else {
		fmt.Fprintf(os.Stderr, "warning: zugzwang engine NOT reachable at %s yet — bot moves will rely on the emergency in-process fallback (emergency-inproc=%v) until it comes up\n", *zugzwangURL, *emergencyInProc)
	}
	// (main() already installed the prod eval net before dispatch, so every
	// bot/filler engine built below uses it.)
	// Auto-discover a Syzygy tablebase and attach it BEFORE the engine pools are
	// built, so every bot/filler engine probes endgames at the root.
	h.SetTablebase(loadTablebaseDefault(*tbPath))
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
	if *arenas {
		h.EnableArenaBotEngines(*arenaBotWorkers, 8, 1)
		h.SetArenaClient(baseURL, secret)
		fmt.Printf("arena tournaments on: polling BaseAPI's active-arenas feed every 5s and pairing participants (%d dedicated bot-vs-bot workers)\n", *arenaBotWorkers)
	}
	go h.Run()

	// Persist finished games via BaseAPI (it owns MySQL + ratings). Fire-and-forget
	// off the hub goroutine so a slow/failed POST never stalls live play.
	h.OnFinish(func(g hub.FinishedGame) {
		fmt.Printf("game %s done: %s (%s) pool=%s rated=%v moves=%d\n",
			g.ID, g.Result, g.Reason, g.Pool, g.Rated, len(g.Moves))
		go persistGame(baseURL, secret, g)
	})

	// A fill-in bot opponent chats like a person: BaseAPI's OpenAI endpoint
	// generates the short lines; the hub owns the when/how-often/pacing. The hub
	// calls this OFF its Run goroutine, so the blocking HTTP request is fine.
	h.OnBotChat(func(req hub.BotChatRequest) []string {
		return fetchBotChat(baseURL, secret, req)
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
	// Internal anti-cheat probe (secret-gated, no ticket): is identity `sub`
	// currently in a live, non-filler game, and if so what board are they on?
	// BaseAPI uses this to flag engine-analysis calls made mid-game. Returns
	// { live: bool, fen: string }. The FEN lets the caller escalate when the
	// analyzed position IS the one the user is playing.
	mux.HandleFunc("GET /internal/live-player", func(w http.ResponseWriter, r *http.Request) {
		if secret != "" && r.Header.Get("X-Hub-Secret") != secret {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		d := h.LivePlayerDetail(r.URL.Query().Get("sub"))
		w.Header().Set("Content-Type", "application/json")
		// live/fen are the original anti-cheat probe's fields, byte-identical to
		// before this endpoint carried anything else. gameId/pool/opponent are
		// additive — present only when live (nothing meaningful to report
		// otherwise) — for a profile page's "playing now" link.
		body := map[string]any{"live": d.Live, "fen": d.FEN}
		if d.Live {
			body["gameId"] = d.GameID
			body["pool"] = d.Pool
			body["opponent"] = map[string]any{"name": d.Opponent.Name, "title": d.Opponent.Title, "rating": d.Opponent.Rating}
		}
		_ = json.NewEncoder(w).Encode(body)
	})
	// Live games currently being played inside a running tournament
	// (secret-gated, no ticket): a tournament page's "watch what's being
	// played right now" next to standings. Only live (not over) games whose
	// arenaID matches id; an unknown/ended tournament id returns an empty
	// list, never an error. See hub.ArenaGames.
	mux.HandleFunc("GET /internal/arena-games", func(w http.ResponseWriter, r *http.Request) {
		if secret != "" && r.Header.Get("X-Hub-Secret") != secret {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		games := h.ArenaGames(r.URL.Query().Get("id"))
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"games": games})
	})
	// Server-side private challenge registration (secret-gated, no ticket):
	// BaseAPI pre-registers an already-accepted user-to-user challenge with no
	// creator connected, so both named players can join independently, later,
	// over the ordinary WS `joinChallenge` message. See
	// hub.RegisterServerChallenge / hub.ServerChallengeRequest.
	mux.HandleFunc("POST /internal/challenge", func(w http.ResponseWriter, r *http.Request) {
		if secret != "" && r.Header.Get("X-Hub-Secret") != secret {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		var body struct {
			Code        string `json:"code"`
			Pool        string `json:"pool"`
			Color       string `json:"color"`
			Rated       bool   `json:"rated"`
			Variant     string `json:"variant"`
			Fen         string `json:"fen"`
			CreatorSub  string `json:"creatorSub"`
			OpponentSub string `json:"opponentSub"`
			TTLSeconds  int64  `json:"ttlSeconds"`
		}
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "bad json body"})
			return
		}
		err := h.RegisterServerChallenge(hub.ServerChallengeRequest{
			Code: body.Code, Pool: body.Pool, Color: body.Color, Rated: body.Rated,
			Variant: body.Variant, FEN: body.Fen, CreatorSub: body.CreatorSub,
			OpponentSub: body.OpponentSub, TTL: time.Duration(body.TTLSeconds) * time.Second,
		})
		if err != nil {
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
	})
	// Presence lookup for a friends list (secret-gated, no ticket): which of the
	// given identity subs currently have a live WebSocket connection.
	mux.HandleFunc("GET /internal/online", func(w http.ResponseWriter, r *http.Request) {
		if secret != "" && r.Header.Get("X-Hub-Secret") != secret {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		var subs []string
		for _, s := range strings.Split(r.URL.Query().Get("subs"), ",") {
			if s = strings.TrimSpace(s); s != "" {
				subs = append(subs, s)
			}
		}
		online := h.Online(subs)
		if online == nil {
			online = []string{}
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string][]string{"online": online})
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
	payload := map[string]any{
		"id":        g.ID,
		"pool":      g.Pool,
		"rated":     g.Rated,
		"variant":   g.Variant,
		"result":    g.Result,
		"reason":    g.Reason,
		"white":     map[string]any{"uid": g.White.UserID, "name": g.White.Name, "anon": g.White.Anon, "bot": g.WhiteBot, "rating": g.White.Rating},
		"black":     map[string]any{"uid": g.Black.UserID, "name": g.Black.Name, "anon": g.Black.Anon, "bot": g.BlackBot, "rating": g.Black.Rating},
		"moves":     g.Moves,
		"sans":      g.SANs,
		"moveTimes": g.MoveTimes,
		// startFen is the position the game began from — chess.StartFEN for a
		// normal game, but non-standard for Chess960 or a custom-FEN challenge.
		// BaseAPI's current GameResultController ignores unknown body fields, so
		// this is a forward-compatible addition, not a contract break.
		"startFen": g.StartFEN,
	}
	// tournamentId is added ONLY for an arena game — an ordinary game's body is
	// byte-identical to before this field existed (key simply absent, not just
	// empty), per the fixed hub/BaseAPI arena contract.
	if g.TournamentID != "" {
		payload["tournamentId"] = g.TournamentID
	}
	body, err := json.Marshal(payload)
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

// fetchBotChat asks BaseAPI to generate short, human-like chat lines for a
// fill-in bot opponent (POST /internal/bot-chat, hub-secret gated). Best-effort:
// any error or timeout returns nil, and the bot simply stays quiet. Runs on the
// hub's off-loop chat goroutine, so a slow OpenAI call never touches live play.
func fetchBotChat(baseURL, secret string, req hub.BotChatRequest) []string {
	body, err := json.Marshal(req)
	if err != nil {
		return nil
	}
	httpReq, err := http.NewRequest(http.MethodPost, baseURL+"/internal/bot-chat", bytes.NewReader(body))
	if err != nil {
		return nil
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("X-Hub-Secret", secret)

	resp, err := (&http.Client{Timeout: 12 * time.Second}).Do(httpReq)
	if err != nil {
		fmt.Fprintf(os.Stderr, "bot chat: %v\n", err)
		return nil
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		fmt.Fprintf(os.Stderr, "bot chat: status %d\n", resp.StatusCode)
		return nil
	}

	var payload struct {
		Messages []string `json:"messages"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		fmt.Fprintf(os.Stderr, "bot chat: decode: %v\n", err)
		return nil
	}
	return payload.Messages
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
