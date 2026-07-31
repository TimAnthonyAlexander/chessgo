package hub

import (
	"encoding/json"
	"sort"
	"time"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// watchWindow is how long after the last GET /games poll (or watch connect) the
// hub still considers "someone is watching". Fillers are only replenished while
// active; the frontend polls every ~2.5s, so this tolerates a few missed polls
// (e.g. a backgrounded tab) before fillers stop being topped up.
const watchWindow = 12 * time.Second

// lobbyMax is the number of games shown on the Watch page (top-N).
const lobbyMax = 5

// WatchPing records spectator interest. Called from the GET /games HTTP handler
// (another goroutine) — an atomic store, so no hub-goroutine hop is needed.
func (h *Hub) WatchPing() { h.lastWatchActivity.Store(time.Now().UnixNano()) }

// watchersActive reports whether anyone has looked at the Watch lobby recently.
// Run-goroutine only.
func (h *Hub) watchersActive() bool {
	last := h.lastWatchActivity.Load()
	if last == 0 {
		return false
	}
	return time.Since(time.Unix(0, last)) < watchWindow
}

// watchGame attaches a spectator to a live game and sends it the full current
// state. A spectator watches at most one game at a time. Read-only: their
// move/resign messages are ignored (they own no seat).
func (h *Hub) watchGame(c *Client, id string) {
	h.lastWatchActivity.Store(time.Now().UnixNano())
	h.unwatchGame(c) // leave any previous game first
	g := h.games[id]
	if g == nil || g.over {
		c.trySend(mustJSON(out("watchEnd", map[string]any{"gameId": id, "reason": "unavailable"})))
		return
	}
	if g.spectators == nil {
		g.spectators = map[*Client]struct{}{}
	}
	g.spectators[c] = struct{}{}
	c.watching = g
	c.trySend(mustJSON(h.spectateMsg(g)))
}

// unwatchGame detaches a spectator from whatever it was watching (no-op if not
// watching).
func (h *Hub) unwatchGame(c *Client) {
	g := c.watching
	if g == nil {
		return
	}
	if g.spectators != nil {
		delete(g.spectators, c)
	}
	c.watching = nil
}

// spectateMsg is the initial full-state payload for a new spectator: both named
// players, the position, clocks, and the full move history.
func (h *Hub) spectateMsg(g *game) map[string]any {
	st := g.status()
	cat := categoryFor(g.pool, g.variant)
	payload := map[string]any{
		"gameId":      g.id,
		"pool":        g.pool,
		"rated":       g.rated,
		"variant":     g.variant,
		"white":       sideInfo(g.white, cat),
		"black":       sideInfo(g.black, cat),
		"fen":         g.boardFEN(),
		"duck":        g.duckSquare(),
		"sideToMove":  st.SideToMove,
		"status":      st.State,
		"check":       st.Check,
		"timeControl": map[string]int64{"base": g.tc.Base, "inc": g.tc.Inc},
		"clock":       map[string]int64{"w": g.remainingMs(chess.White), "b": g.remainingMs(chess.Black)},
		"moves":       g.moveLog(),
		"lastMove":    g.lastUci(),
		"ply":         len(g.moves),
		"startPly":    g.startPly(), // half-move offset for a mid-game seed (filler); 0 from the opening
		"over":        g.over,
	}
	if g.arenaID != "" {
		payload["tournamentId"] = g.arenaID
	}
	return out("watching", payload)
}

// sideInfo is the public view of a player for spectators. It deliberately omits
// whether the side is a bot — neither fill-in bots nor self-play fillers should
// be distinguishable from human accounts on the client.
func sideInfo(p *player, cat string) map[string]any {
	return map[string]any{
		"name":   p.id.Name,
		"rating": p.id.RatingFor(cat),
		"anon":   p.id.Anon,
		"title":  p.id.Title, // "" for bots/anon/titleless accounts — never a placeholder
	}
}

// --- lobby snapshot (GET /games) ---

type sideSummary struct {
	Name   string `json:"name"`
	Rating int    `json:"rating"`
	Anon   bool   `json:"anon"`
	// Title is "" for bots/anon/titleless accounts — omitted from the wire via
	// omitempty rather than sent as a placeholder.
	Title string `json:"title,omitempty"`
}

// gameSummary is one row of the Watch lobby. filler is used only to order real
// games first; it is unexported so it never reaches the client.
type gameSummary struct {
	ID         string      `json:"id"`
	Pool       string      `json:"pool"`
	Rated      bool        `json:"rated"`
	Variant    string      `json:"variant"`
	White      sideSummary `json:"white"`
	Black      sideSummary `json:"black"`
	FEN        string      `json:"fen"`
	Duck       string      `json:"duck"` // duck square for duck games; "" otherwise
	SideToMove string      `json:"sideToMove"`
	LastMove   string      `json:"lastMove"`
	Ply        int         `json:"ply"`
	ClockW     int64       `json:"clockW"`
	ClockB     int64       `json:"clockB"`
	// TournamentID is "" (omitted) for an ordinary game — set when the game was
	// paired from a running arena, so the Watch lobby can offer "Back to
	// tournament" too if a tournament game is opened from here.
	TournamentID string `json:"tournamentId,omitempty"`

	filler bool // server-side ordering only; not serialized (unexported)
}

// moreInteresting reports whether a "most interesting first" listing of live
// games should sort game a ahead of game b: real (non-filler) games before
// fillers, then higher combined rating first ("top games"). This is the
// Watch lobby's ordering (publishLobby, below); arena-games reuses it
// verbatim (arena.go's doArenaGames) rather than inventing a second notion of
// "interesting" — arena games are never fillers, so for them it reduces to
// combined rating descending.
func moreInteresting(aFiller bool, aRating int, bFiller bool, bRating int) bool {
	if aFiller != bFiller {
		return !aFiller // real games first
	}
	return aRating > bRating
}

// publishLobby rebuilds the top-N live-game snapshot and publishes it as JSON for
// the HTTP handler. Run-goroutine only. Real games sort ahead of fillers, and
// higher combined rating first ("top games").
func (h *Hub) publishLobby() {
	summaries := make([]gameSummary, 0, len(h.games))
	for _, g := range h.games {
		if g.over {
			continue
		}
		cat := categoryFor(g.pool, g.variant)
		st := g.status()
		summaries = append(summaries, gameSummary{
			ID:           g.id,
			Pool:         g.pool,
			Rated:        g.rated,
			Variant:      g.variant,
			White:        sideSummary{g.white.id.Name, g.white.id.RatingFor(cat), g.white.id.Anon, g.white.id.Title},
			Black:        sideSummary{g.black.id.Name, g.black.id.RatingFor(cat), g.black.id.Anon, g.black.id.Title},
			FEN:          g.boardFEN(),
			Duck:         g.duckSquare(),
			SideToMove:   st.SideToMove,
			LastMove:     g.lastUci(),
			Ply:          len(g.moves),
			ClockW:       g.remainingMs(chess.White),
			ClockB:       g.remainingMs(chess.Black),
			TournamentID: g.arenaID,
			filler:       g.filler,
		})
	}
	sort.SliceStable(summaries, func(i, j int) bool {
		a, b := summaries[i], summaries[j]
		return moreInteresting(a.filler, a.White.Rating+a.Black.Rating, b.filler, b.White.Rating+b.Black.Rating)
	})
	if len(summaries) > lobbyMax {
		summaries = summaries[:lobbyMax]
	}
	if summaries == nil {
		summaries = []gameSummary{}
	}
	body, err := json.Marshal(map[string]any{"games": summaries, "max": lobbyMax})
	if err != nil {
		return
	}
	h.lobby.Store(&body)
}

// LobbyJSON returns the latest pre-marshaled Watch-lobby snapshot for the HTTP
// handler. Safe to call from any goroutine.
func (h *Hub) LobbyJSON() []byte {
	if p := h.lobby.Load(); p != nil {
		return *p
	}
	return []byte(`{"games":[],"max":5}`)
}
