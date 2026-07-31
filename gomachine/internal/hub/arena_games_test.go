package hub

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/timanthonyalexander/gomachine/internal/auth"
	"github.com/timanthonyalexander/gomachine/internal/chess"
	"github.com/timanthonyalexander/gomachine/internal/variant"
)

// --- doArenaGames: pure unit tests (no Run goroutine — reads h.games directly,
// exactly like the Run goroutine itself would) ---

func TestDoArenaGamesFiltersByArenaAndExcludesFinished(t *testing.T) {
	h := New(testSecret)
	h.games = map[string]*game{
		"g1": {
			id: "g1", arenaID: "A", pool: "3+0", variant: variantStandard, moves: []string{"e2e4"},
			white: &player{id: auth.Identity{UserID: "w1", Name: "Alice", Rating: 1800}},
			black: &player{id: auth.Identity{UserID: "b1", Name: "Bob", Rating: 1750, Title: "GM"}, isBot: true},
		},
		"g2-over": { // finished — must be excluded
			id: "g2", arenaID: "A", over: true, pool: "3+0", variant: variantStandard,
			white: &player{id: auth.Identity{UserID: "w2"}},
			black: &player{id: auth.Identity{UserID: "b2"}},
		},
		"g3-other-arena": { // a different tournament — must be excluded
			id: "g3", arenaID: "B", pool: "3+0", variant: variantStandard,
			white: &player{id: auth.Identity{UserID: "w3"}},
			black: &player{id: auth.Identity{UserID: "b3"}},
		},
	}

	got := h.doArenaGames("A")
	if len(got) != 1 {
		t.Fatalf("expected exactly 1 live game for arena A, got %d: %+v", len(got), got)
	}
	row := got[0]
	if row.GameID != "g1" {
		t.Errorf("GameID = %q, want g1", row.GameID)
	}
	if row.Pool != "3+0" || row.Variant != variantStandard {
		t.Errorf("pool/variant = %q/%q, want 3+0/%s", row.Pool, row.Variant, variantStandard)
	}
	if row.Ply != 1 {
		t.Errorf("Ply = %d, want 1 (one move played)", row.Ply)
	}
	if row.White.Name != "Alice" || row.White.Rating != 1800 {
		t.Errorf("White = %+v, want name Alice rating 1800", row.White)
	}
	if row.White.Title != nil {
		t.Errorf("White.Title = %v, want nil (titleless)", row.White.Title)
	}
	if row.White.Bot {
		t.Error("White.Bot should be false")
	}
	if row.Black.Title == nil || *row.Black.Title != "GM" {
		t.Errorf("Black.Title = %v, want GM", row.Black.Title)
	}
	if !row.Black.Bot {
		t.Error("Black.Bot should be true")
	}
}

func TestDoArenaGamesUnknownIDReturnsEmpty(t *testing.T) {
	h := New(testSecret)
	h.games = map[string]*game{
		"g1": {
			id: "g1", arenaID: "A", pool: "3+0", variant: variantStandard,
			white: &player{id: auth.Identity{UserID: "w1"}},
			black: &player{id: auth.Identity{UserID: "b1"}},
		},
	}

	if got := h.doArenaGames("NOT-A-REAL-TOURNAMENT"); len(got) != 0 {
		t.Fatalf("doArenaGames(unknown) = %d games, want 0", len(got))
	}
	if got := h.doArenaGames(""); len(got) != 0 {
		t.Fatalf("doArenaGames(\"\") = %d games, want 0", len(got))
	}
	if got := h.doArenaGames("A"); len(got) != 1 {
		t.Fatalf("sanity: doArenaGames(A) = %d, want 1 (unknown-id case shouldn't affect a known one)", len(got))
	}
}

// doArenaGames must never return a nil slice — the HTTP handler marshals
// straight through, and {"games":null} is a worse contract than {"games":[]}.
func TestDoArenaGamesNeverReturnsNil(t *testing.T) {
	h := New(testSecret)
	if got := h.doArenaGames("NOPE"); got == nil {
		t.Fatal("doArenaGames must return an empty slice, not nil")
	}
}

func TestDoArenaGamesOrdersByCombinedRatingDescending(t *testing.T) {
	h := New(testSecret)
	h.games = map[string]*game{
		"low": {
			id: "low", arenaID: "A", pool: "3+0", variant: variantStandard,
			white: &player{id: auth.Identity{UserID: "w-low", Rating: 1000}},
			black: &player{id: auth.Identity{UserID: "b-low", Rating: 1000}},
		},
		"high": {
			id: "high", arenaID: "A", pool: "3+0", variant: variantStandard,
			white: &player{id: auth.Identity{UserID: "w-high", Rating: 2200}},
			black: &player{id: auth.Identity{UserID: "b-high", Rating: 2200}},
		},
	}
	got := h.doArenaGames("A")
	if len(got) != 2 || got[0].GameID != "high" || got[1].GameID != "low" {
		ids := make([]string, len(got))
		for i, g := range got {
			ids[i] = g.GameID
		}
		t.Fatalf("order = %v, want [high low] (higher combined rating first — same rule as the Watch lobby)", ids)
	}
}

func TestDoArenaGamesCapsAtArenaGamesCap(t *testing.T) {
	h := New(testSecret)
	games := map[string]*game{}
	for i := 0; i < arenaGamesCap+5; i++ {
		id := fmt.Sprintf("g%d", i)
		games[id] = &game{
			id: id, arenaID: "A", pool: "3+0", variant: variantStandard,
			white: &player{id: auth.Identity{UserID: "w" + id, Rating: 1000 + i}},
			black: &player{id: auth.Identity{UserID: "b" + id, Rating: 1000}},
		}
	}
	h.games = games
	if got := h.doArenaGames("A"); len(got) != arenaGamesCap {
		t.Fatalf("len = %d, want the cap of %d", len(got), arenaGamesCap)
	}
}

// --- ArenaGames: WS-integration, exercising the real Run-goroutine channel
// round-trip (arenaGamesQueries), the same shape TestOnline exercises for
// onlineQueries. ---

func TestArenaGamesReportsLiveGameThenClearsOnFinish(t *testing.T) {
	h := New(testSecret)
	go h.Run()
	srv := httptest.NewServer(http.HandlerFunc(h.ServeWS))
	defer srv.Close()

	const arenaID = "ARENA-GAMES-1"
	h.SetArenaSnapshots([]ArenaSnapshot{{
		ID: arenaID, Pool: "3+0", Variant: "standard", Rated: true,
		EndsAtMs: time.Now().Add(time.Hour).UnixMilli(),
		Players: []ArenaPlayerSnapshot{
			{Sub: "id-ag-alice", Score: 5},
			{Sub: "id-ag-bob", Score: 5},
		},
	}})

	alice := dialAccount(t, srv.URL, "alice", "id-ag-alice", 1500)
	defer alice.CloseNow()
	bob := dialAccount(t, srv.URL, "bob", "id-ag-bob", 1500)
	defer bob.CloseNow()
	readType(t, alice, "hello")
	readType(t, bob, "hello")

	joinArenaEventually(t, alice, arenaID)
	readType(t, alice, "arenaWaiting")
	send(t, bob, map[string]any{"type": "joinArena", "tournamentId": arenaID})
	readType(t, bob, "arenaJoined")
	readType(t, alice, "matched")
	readType(t, bob, "matched")

	// An unrelated/unknown tournament id must stay empty even while a game is
	// live elsewhere.
	if got := h.ArenaGames("SOME-OTHER-ARENA"); len(got) != 0 {
		t.Errorf("ArenaGames(unrelated id) = %d, want 0", len(got))
	}

	var games []ArenaGameSummary
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		games = h.ArenaGames(arenaID)
		if len(games) == 1 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if len(games) != 1 {
		t.Fatalf("ArenaGames(%s) = %d games, want 1", arenaID, len(games))
	}
	row := games[0]
	if row.Pool != "3+0" || row.Variant != "standard" {
		t.Errorf("pool/variant = %q/%q, want 3+0/standard", row.Pool, row.Variant)
	}
	if row.White.Bot || row.Black.Bot {
		t.Error("neither side should be a bot in a human-vs-human arena game")
	}
	names := map[string]bool{row.White.Name: true, row.Black.Name: true}
	if !names["alice"] || !names["bob"] {
		t.Errorf("expected alice and bob among the sides, got white=%+v black=%+v", row.White, row.Black)
	}

	originalID := row.GameID

	// Finish the game. With only these two participants in the arena and no
	// third free player, returnToArenaPool's pairing pass repairs them
	// instantly (arena.go: a repeat pair is only avoided when a third free
	// player is available) — so the live listing may show a BRAND NEW game
	// right away. What must never happen is the FINISHED game still being
	// reported as live.
	send(t, alice, map[string]any{"type": "resign"})
	readType(t, alice, "end")
	readType(t, bob, "end")

	deadline = time.Now().Add(2 * time.Second)
	stillListed := true
	for time.Now().Before(deadline) {
		games = h.ArenaGames(arenaID)
		stillListed = false
		for _, g := range games {
			if g.GameID == originalID {
				stillListed = true
			}
		}
		if !stillListed {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if stillListed {
		t.Errorf("finished game %s is still reported live by ArenaGames after resign", originalID)
	}
}

func TestArenaGamesUnknownTournamentReturnsEmpty(t *testing.T) {
	h := New(testSecret)
	go h.Run()
	srv := httptest.NewServer(http.HandlerFunc(h.ServeWS))
	defer srv.Close()

	if got := h.ArenaGames("NEVER-EXISTED"); len(got) != 0 {
		t.Fatalf("ArenaGames(never-existed) = %d, want 0", len(got))
	}
}

// --- LivePlayerDetail: original live/fen fields untouched, new fields additive ---

func TestLivePlayerDetailAddsGameIDPoolAndOpponent(t *testing.T) {
	h := New(testSecret)
	st, err := variant.New(variantStandard, chess.StartFEN)
	if err != nil {
		t.Fatalf("variant.New: %v", err)
	}
	g := &game{
		id: "lp-g1", pool: "5+0", variant: variantStandard, startFen: chess.StartFEN, state: st,
		white: &player{id: auth.Identity{UserID: "alice", Name: "Alice", Rating: 1600}},
		black: &player{id: auth.Identity{UserID: "bob", Name: "Bob", Rating: 1550, Title: "IM"}},
	}
	h.markLive(g)

	// Original two-value LivePlayer must be exactly what it always was.
	live, fen := h.LivePlayer("alice")
	if !live {
		t.Fatal("alice should be live")
	}
	if fen != g.boardFEN() {
		t.Errorf("fen = %q, want %q", fen, g.boardFEN())
	}

	detail := h.LivePlayerDetail("alice")
	if !detail.Live || detail.FEN != fen {
		t.Fatalf("LivePlayerDetail live/fen = %v/%q, want true/%q", detail.Live, detail.FEN, fen)
	}
	if detail.GameID != "lp-g1" {
		t.Errorf("GameID = %q, want lp-g1", detail.GameID)
	}
	if detail.Pool != "5+0" {
		t.Errorf("Pool = %q, want 5+0", detail.Pool)
	}
	if detail.Opponent.Name != "Bob" || detail.Opponent.Rating != 1550 || detail.Opponent.Title != "IM" {
		t.Errorf("Opponent = %+v, want Bob/1550/IM", detail.Opponent)
	}

	// bob's own entry carries alice as HIS opponent.
	bobDetail := h.LivePlayerDetail("bob")
	if bobDetail.Opponent.Name != "Alice" || bobDetail.Opponent.Rating != 1600 {
		t.Errorf("bob's opponent = %+v, want Alice/1600", bobDetail.Opponent)
	}

	// Not live at all: zero value, Live false.
	if d := h.LivePlayerDetail("nobody"); d.Live || d.GameID != "" || d.Opponent.Name != "" {
		t.Errorf("LivePlayerDetail(nobody) = %+v, want zero value", d)
	}
	if d := h.LivePlayerDetail(""); d.Live {
		t.Error("empty sub must never be live")
	}
}

func TestLivePlayerDetailFENTracksMoves(t *testing.T) {
	h := New(testSecret)
	st, err := variant.New(variantStandard, chess.StartFEN)
	if err != nil {
		t.Fatalf("variant.New: %v", err)
	}
	g := &game{
		id: "lp-g2", pool: "3+0", variant: variantStandard, startFen: chess.StartFEN, state: st,
		white: &player{id: auth.Identity{UserID: "carol", Name: "carol"}},
		black: &player{id: auth.Identity{UserID: "dave", Name: "dave"}},
	}
	h.markLive(g)

	if _, ok := g.applyMove("e2e4"); !ok {
		t.Fatal("e2e4 should be legal")
	}
	h.refreshLive(g)

	live, fen := h.LivePlayer("carol")
	if !live || fen != g.boardFEN() {
		t.Fatalf("LivePlayer after move = %v/%q, want true/%q", live, fen, g.boardFEN())
	}
	detail := h.LivePlayerDetail("carol")
	if detail.FEN != g.boardFEN() {
		t.Errorf("LivePlayerDetail.FEN = %q, want %q (refreshLive must update it)", detail.FEN, g.boardFEN())
	}
	// gameId/pool/opponent are unaffected by a move.
	if detail.GameID != "lp-g2" || detail.Pool != "3+0" || detail.Opponent.Name != "dave" {
		t.Errorf("gameId/pool/opponent changed after a move: %+v", detail)
	}
}
