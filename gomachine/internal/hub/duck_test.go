package hub

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/timanthonyalexander/gomachine/internal/auth"
	"github.com/timanthonyalexander/gomachine/internal/variant"
)

// newDuckGame builds a minimal in-memory duck game seeded from a crafted FEN, so
// tests can drive applyMove/status directly without a full hub/socket.
func newDuckGame(t *testing.T, fen string) *game {
	t.Helper()
	st, err := variant.New(variantDuck, fen)
	if err != nil {
		t.Fatalf("build duck state: %v", err)
	}
	return &game{
		id:        "duck-test",
		white:     &player{id: auth.Identity{UserID: "w"}},
		black:     &player{id: auth.Identity{UserID: "b"}},
		state:     st,
		tc:        timeControl{Base: 300_000, Inc: 0},
		clockMs:   [2]int64{300_000, 300_000},
		turnStart: time.Now(),
		online:    [2]bool{true, true},
		startFen:  fen,
		variant:   variantDuck,
	}
}

// A scripted duck game must run through applyMove to a king capture and report the
// capturer as the winner via status(). Composite moves are "<pieceUCI>:<duck>".
func TestDuckGameKingCapture(t *testing.T) {
	// White queen e2, black king e8, white king e1 — a few plies from a king grab.
	g := newDuckGame(t, "4k3/8/8/8/8/8/4Q3/4K3 w - - 0 1")

	if st := g.status(); st.State != "ongoing" {
		t.Fatalf("fresh position status = %q, want ongoing", st.State)
	}

	// Qe2-e7, Ke8-d8, Qe7xd8 (captures the black king). Duck moves to a fresh empty
	// square each turn and never blocks the capturing move.
	script := []string{"e2e7:a1", "e8d8:h1", "e7d8:a2"}
	for i, mv := range script {
		san, ok := g.applyMove(mv)
		if !ok {
			t.Fatalf("move %d %q rejected", i, mv)
		}
		if san == "" {
			t.Fatalf("move %d %q returned empty SAN", i, mv)
		}
	}

	if got := g.duckSquare(); got != "a2" {
		t.Errorf("duck square = %q, want a2", got)
	}

	st := g.status()
	if st.State != "king-captured" || st.Result != "1-0" {
		t.Fatalf("terminal status = %q result = %q, want king-captured / 1-0", st.State, st.Result)
	}
	if st.Check {
		t.Errorf("duck status must never report check")
	}

	// The snapshot must carry the duck-specific wire fields.
	snap := g.snapshot()
	if snap["variant"] != variantDuck {
		t.Errorf("snapshot variant = %v, want duck", snap["variant"])
	}
	if snap["duck"] != "a2" {
		t.Errorf("snapshot duck = %v, want a2", snap["duck"])
	}
	if snap["lastMove"] != "e7d8" {
		t.Errorf("snapshot lastMove = %v, want e7d8 (piece part only)", snap["lastMove"])
	}
	if snap["check"] != false {
		t.Errorf("snapshot check = %v, want false", snap["check"])
	}
}

// Illegal or malformed composite moves must be rejected without mutating state.
func TestDuckGameRejectsIllegalMove(t *testing.T) {
	g := newDuckGame(t, "4k3/8/8/8/8/8/4Q3/4K3 w - - 0 1")

	for _, mv := range []string{"e2e4", "e1e2:e1", "e2e2:a1", "d2d4:a1"} {
		if _, ok := g.applyMove(mv); ok {
			t.Errorf("applyMove(%q) accepted an illegal/malformed move", mv)
		}
	}
	if len(g.moves) != 0 {
		t.Fatalf("rejected moves must not append: moves=%v", g.moves)
	}
	if g.status().SideToMove != "w" {
		t.Fatalf("side to move changed after rejected moves")
	}
}

// A duck takeback rebuilds the duck state by replaying the surviving composites.
func TestDuckRebuildTo(t *testing.T) {
	g := newDuckGame(t, "4k3/8/8/8/8/8/4Q3/4K3 w - - 0 1")
	for _, mv := range []string{"e2e7:a1", "e8d8:h1"} {
		if _, ok := g.applyMove(mv); !ok {
			t.Fatalf("setup move %q rejected", mv)
		}
	}
	g.rebuildTo(1) // roll back black's reply
	if len(g.moves) != 1 {
		t.Fatalf("after rebuildTo(1): moves=%v", g.moves)
	}
	if g.duckSquare() != "a1" {
		t.Errorf("rebuilt duck square = %q, want a1", g.duckSquare())
	}
	if got := g.status().SideToMove; got != "b" {
		t.Errorf("rebuilt side to move = %q, want b", got)
	}
}

// queueKey/splitQueueKey must round-trip, and standard must keep the BARE pool key
// so standard matchmaking is byte-identical to the pre-variant behavior.
func TestQueueKeyRoundTrip(t *testing.T) {
	cases := []struct{ pool, variant string }{
		{"3+0", variantStandard},
		{"5+0", variantDuck},
		{"10+5", variantChess960},
		{"1+0", ""}, // empty variant is treated as standard
	}
	for _, tcx := range cases {
		key := queueKey(tcx.pool, tcx.variant)
		gotPool, gotVariant := splitQueueKey(key)
		wantVariant := tcx.variant
		if wantVariant == "" {
			wantVariant = variantStandard
		}
		if gotPool != tcx.pool || gotVariant != wantVariant {
			t.Errorf("queueKey/split(%q,%q) -> key %q -> (%q,%q), want (%q,%q)",
				tcx.pool, tcx.variant, key, gotPool, gotVariant, tcx.pool, wantVariant)
		}
	}
	if k := queueKey("3+0", variantStandard); k != "3+0" {
		t.Errorf("standard must use the bare pool key, got %q", k)
	}
	if k := queueKey("3+0", ""); k != "3+0" {
		t.Errorf("empty variant must use the bare pool key, got %q", k)
	}
	if queueKey("3+0", variantDuck) == "3+0" {
		t.Error("duck must NOT collide with the bare standard pool key")
	}
}

// startBotGame with variant "duck" builds a Duck game: a live duck state, exactly
// one bot side, and RATED for a logged-in (non-anon) human — Duck feeds its own
// isolated "duck" Glicko pool (same gate as startGameWith).
func TestStartBotGameDuck(t *testing.T) {
	h := New(testSecret)
	human := &Client{id: auth.Identity{UserID: "u1", Name: "human", Rating: 1500}, send: make(chan []byte, sendBuffer)}
	h.startBotGame(human, timeControl{Base: 300_000, Inc: 0}, "5+0", variantDuck)

	g := human.game
	if g == nil {
		t.Fatal("startBotGame did not attach a game")
	}
	if g.variant != variantDuck {
		t.Errorf("variant = %q, want duck", g.variant)
	}
	if g.state == nil {
		t.Fatal("a duck bot game must have a live state")
	}
	if !g.rated {
		t.Error("a duck bot game with a logged-in human must be rated (duck pool)")
	}
	if g.white.isBot == g.black.isBot {
		t.Errorf("expected exactly one bot side, white=%v black=%v", g.white.isBot, g.black.isBot)
	}
}

// Two Duck queuers (both accounts) in the same time control pair into a Duck game
// (variant duck, rated on the isolated duck pool, opposite colors) — proving the
// (pool, variant) queue key pairs Duck with Duck.
func TestDuckQueuePairs(t *testing.T) {
	h := New(testSecret)
	go h.Run()
	srv := httptest.NewServer(http.HandlerFunc(h.ServeWS))
	defer srv.Close()

	a := dialRated(t, srv.URL, "d1", "id-d1", 1500)
	defer a.CloseNow()
	b := dialRated(t, srv.URL, "d2", "id-d2", 1520)
	defer b.CloseNow()
	readType(t, a, "hello")
	readType(t, b, "hello")

	send(t, a, map[string]any{"type": "queue", "pool": "3+0", "variant": "duck"})
	send(t, b, map[string]any{"type": "queue", "pool": "3+0", "variant": "duck"})

	ma := readType(t, a, "matched")
	mb := readType(t, b, "matched")
	for _, m := range []map[string]any{ma, mb} {
		if m["variant"] != variantDuck {
			t.Errorf("matched variant = %v, want duck", m["variant"])
		}
		if m["rated"] != true {
			t.Errorf("duck game between two accounts must be rated, rated = %v", m["rated"])
		}
	}
	if ma["color"] == mb["color"] {
		t.Errorf("both players got color %v", ma["color"])
	}
}

// A standard queuer and a Duck queuer at identical rating + time control must NEVER
// pair — they live under different queue keys.
func TestDuckAndStandardNeverPair(t *testing.T) {
	h := New(testSecret)
	go h.Run()
	srv := httptest.NewServer(http.HandlerFunc(h.ServeWS))
	defer srv.Close()

	std := dialRated(t, srv.URL, "std", "id-std", 1500)
	defer std.CloseNow()
	duck := dialRated(t, srv.URL, "duck", "id-duck-x", 1500)
	defer duck.CloseNow()
	readType(t, std, "hello")
	readType(t, duck, "hello")

	send(t, std, map[string]any{"type": "queue", "pool": "3+0"}) // standard (bare key)
	send(t, duck, map[string]any{"type": "queue", "pool": "3+0", "variant": "duck"})
	readType(t, std, "queued")
	readType(t, duck, "queued")

	expectNoMatch(t, std, 700*time.Millisecond)
}

// A lone Duck queuer past the bot-fill delay is promoted to a Duck bot game, and a
// scheduled duck bot move (computed off the Run goroutine, returned via botMoves)
// applies a legal composite — placing the duck on the board.
func TestDuckBotBackfill(t *testing.T) {
	h := New(testSecret)
	h.EnableBotFill(6, 50*time.Millisecond, 1, 8, 1) // engine pool unused by the duck path
	go h.Run()
	srv := httptest.NewServer(http.HandlerFunc(h.ServeWS))
	defer srv.Close()

	a := dialRated(t, srv.URL, "ducker", "id-duck-bf", 1400)
	defer a.CloseNow()
	readType(t, a, "hello")

	send(t, a, map[string]any{"type": "queue", "pool": "3+0", "variant": "duck"})
	readType(t, a, "queued")

	m := readType(t, a, "matched")
	if m["variant"] != variantDuck {
		t.Fatalf("matched variant = %v, want duck", m["variant"])
	}
	if m["rated"] != true {
		t.Errorf("duck bot game for a logged-in human must be rated, rated = %v", m["rated"])
	}

	// If the human is White they move first (bot replies); if Black the bot (White)
	// already moved. Rank 5/6 is always empty after any first White move (pawns reach
	// rank 4, knights rank 3), so "e5" is a legal duck placement.
	if m["color"] == "w" {
		legal, _ := m["legalMoves"].([]any)
		if len(legal) == 0 {
			t.Fatal("no legal moves in matched payload")
		}
		send(t, a, map[string]any{"type": "move", "move": legal[0].(string) + ":e5"})
		if st := readType(t, a, "state"); st["duck"] != "e5" {
			t.Errorf("after our move duck = %v, want e5", st["duck"])
		}
	}

	// The bot's reply: a legal composite applied on the Run goroutine places the duck.
	bs := readType(t, a, "state")
	if bs["variant"] != variantDuck {
		t.Errorf("bot state variant = %v, want duck", bs["variant"])
	}
	if ds, _ := bs["duck"].(string); ds == "" {
		t.Error("bot state duck square empty; a legal composite should place the duck")
	}
}

func TestNormalizeVariantDuck(t *testing.T) {
	for in, want := range map[string]string{
		"duck":     variantDuck,
		"chess960": variantChess960,
		"standard": variantStandard,
		"":         variantStandard,
		"bogus":    variantStandard,
	} {
		if got := normalizeVariant(in); got != want {
			t.Errorf("normalizeVariant(%q) = %q, want %q", in, got, want)
		}
	}
}
