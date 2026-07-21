package hub

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/timanthonyalexander/gomachine/internal/auth"
	"github.com/timanthonyalexander/gomachine/internal/chess"
	"github.com/timanthonyalexander/gomachine/internal/variant"
)

// newAntichessGame builds a minimal in-memory antichess game seeded from a
// crafted FEN, so tests can drive applyMove/status directly without a full
// hub/socket, mirroring newDuckGame/newTestCrazyhouseBotGame.
func newAntichessGame(t *testing.T, fen string) *game {
	t.Helper()
	st, err := variant.New(variantAntichess, fen)
	if err != nil {
		t.Fatalf("build antichess state: %v", err)
	}
	return &game{
		id:        "antichess-test",
		white:     &player{id: auth.Identity{UserID: "w"}},
		black:     &player{id: auth.Identity{UserID: "b"}},
		state:     st,
		tc:        timeControl{Base: 300_000, Inc: 0},
		clockMs:   [2]int64{300_000, 300_000},
		turnStart: time.Now(),
		online:    [2]bool{true, true},
		startFen:  fen,
		variant:   variantAntichess,
	}
}

// perftViaState walks the variant.State interface recursively (LegalMoves +
// Apply), the same shape the hub actually drives a game through — a
// second, interface-level cross-check of the internal/antichess perft counts
// already validated directly against python-chess's AntichessBoard oracle
// (Wave 1): start d1=20, d2=400.
func perftViaState(t *testing.T, st variant.State, depth int) uint64 {
	t.Helper()
	if depth == 0 {
		return 1
	}
	moves := st.LegalMoves()
	if depth == 1 {
		return uint64(len(moves))
	}
	var nodes uint64
	for _, m := range moves {
		next, _, ok := st.Apply(m)
		if !ok {
			t.Fatalf("Apply(%q) rejected a move LegalMoves() itself returned", m)
		}
		nodes += perftViaState(t, next, depth-1)
	}
	return nodes
}

func TestAntichessPerftViaVariantInterface(t *testing.T) {
	st, err := variant.New(variantAntichess, chess.StartFEN)
	if err != nil {
		t.Fatalf("variant.New(antichess): %v", err)
	}
	if got := perftViaState(t, st, 1); got != 20 {
		t.Errorf("perft(1) via variant.State = %d, want 20", got)
	}
	if got := perftViaState(t, st, 2); got != 400 {
		t.Errorf("perft(2) via variant.State = %d, want 400", got)
	}
}

// The forced en-passant position has exactly one legal move; the game must
// reject every other move and only accept the en-passant capture.
func TestAntichessGameForcesCapture(t *testing.T) {
	g := newAntichessGame(t, "4k3/8/8/8/pP6/8/8/4K3 b - b3 0 1")

	legal := g.legalMoves()
	if len(legal) != 1 || legal[0] != "a4b3" {
		t.Fatalf("legalMoves = %v, want exactly [a4b3] (forced en passant)", legal)
	}

	if _, ok := g.applyMove("e8d8"); ok {
		t.Error("a king move must be rejected while a capture is forced")
	}
	san, ok := g.applyMove("a4b3")
	if !ok || san == "" {
		t.Fatalf("forced en-passant capture rejected: san=%q ok=%v", san, ok)
	}
}

// A pawn reaching the last rank may promote to a KING (Antichess-only), and
// playing that move through the game produces the expected board FEN.
func TestAntichessGameKingPromotion(t *testing.T) {
	g := newAntichessGame(t, "4k3/P7/8/8/8/8/8/4K3 w - - 0 1")

	san, ok := g.applyMove("a7a8k")
	if !ok {
		t.Fatal("king promotion a7a8k rejected")
	}
	if san == "" {
		t.Error("king promotion must render a non-empty SAN")
	}
	if g.boardFEN()[0] != 'K' {
		t.Errorf("board FEN after promotion = %q, want it to start with the new White king", g.boardFEN())
	}
}

// Antichess's inverted win condition: a side to move with no legal move (here,
// no pieces at all) WINS, not draws — status() must report a decisive result,
// never "stalemate"/"draw", and Check must always be false (no check exists).
func TestAntichessStalemateIsAWin(t *testing.T) {
	g := newAntichessGame(t, "4k3/8/8/8/8/8/8/8 w - - 0 1")

	st := g.status()
	if st.Result != "1-0" {
		t.Fatalf("status = %+v, want a White win (1-0) — no pieces means White-to-move WINS", st)
	}
	if st.Check {
		t.Error("antichess status must never report check")
	}
	if st.State == "draw" || st.State == "stalemate" {
		t.Errorf("state = %q, must NOT be a draw/stalemate (Antichess inverts this into a win)", st.State)
	}
}

// Two rated-account Antichess queuers at the same pool must pair with EACH
// OTHER (variant "antichess", rated, opposite colors, no bot), mirroring
// TestDuckQueuePairs.
func TestAntichessQueuePairsWithAntichess(t *testing.T) {
	h := New(testSecret)
	go h.Run()
	srv := httptest.NewServer(http.HandlerFunc(h.ServeWS))
	defer srv.Close()

	a := dialRated(t, srv.URL, "ac1", "id-ac1", 1500)
	defer a.CloseNow()
	b := dialRated(t, srv.URL, "ac2", "id-ac2", 1520)
	defer b.CloseNow()
	readType(t, a, "hello")
	readType(t, b, "hello")

	send(t, a, map[string]any{"type": "queue", "pool": "3+0", "variant": "antichess"})
	send(t, b, map[string]any{"type": "queue", "pool": "3+0", "variant": "antichess"})

	ma := readType(t, a, "matched")
	mb := readType(t, b, "matched")
	for _, m := range []map[string]any{ma, mb} {
		if m["variant"] != variantAntichess {
			t.Errorf("matched variant = %v, want antichess", m["variant"])
		}
		if m["rated"] != true {
			t.Errorf("antichess game between two accounts must be rated, rated = %v", m["rated"])
		}
	}
	if ma["color"] == mb["color"] {
		t.Errorf("both players got color %v", ma["color"])
	}
}

// A standard queuer and an Antichess queuer at identical rating + time control
// must NEVER pair — they live under different queue keys.
func TestAntichessAndStandardNeverPair(t *testing.T) {
	h := New(testSecret)
	go h.Run()
	srv := httptest.NewServer(http.HandlerFunc(h.ServeWS))
	defer srv.Close()

	std := dialRated(t, srv.URL, "std2", "id-std2", 1500)
	defer std.CloseNow()
	ac := dialRated(t, srv.URL, "ac3", "id-ac3", 1500)
	defer ac.CloseNow()
	readType(t, std, "hello")
	readType(t, ac, "hello")

	send(t, std, map[string]any{"type": "queue", "pool": "3+0"}) // standard (bare key)
	send(t, ac, map[string]any{"type": "queue", "pool": "3+0", "variant": "antichess"})
	readType(t, std, "queued")
	readType(t, ac, "queued")

	expectNoMatch(t, std, 700*time.Millisecond)
}

// startBotGame with variant "antichess" routes entirely through the variant
// framework: a live antichess state, exactly one bot side, and RATED for a
// logged-in (non-anon) human on its own isolated "antichess" pool.
func TestStartBotGameAntichess(t *testing.T) {
	h := New(testSecret)
	human := &Client{id: auth.Identity{UserID: "u1", Name: "human", Rating: 1500}, send: make(chan []byte, sendBuffer)}
	h.startBotGame(human, timeControl{Base: 300_000, Inc: 0}, "3+0", variantAntichess)

	g := human.game
	if g == nil {
		t.Fatal("startBotGame did not attach a game")
	}
	if g.variant != variantAntichess {
		t.Errorf("variant = %q, want antichess", g.variant)
	}
	if g.state == nil {
		t.Fatal("an antichess bot game must have a live state")
	}
	if !g.rated {
		t.Error("an antichess bot game with a logged-in human must be rated (antichess pool)")
	}
	if g.white.isBot == g.black.isBot {
		t.Errorf("expected exactly one bot side, white=%v black=%v", g.white.isBot, g.black.isBot)
	}

	snap := g.snapshot()
	if snap["variant"] != variantAntichess {
		t.Errorf("snapshot variant = %v, want antichess", snap["variant"])
	}
	if snap["fen"] == "" {
		t.Error("antichess snapshot must carry a board fen")
	}
}

// Antichess routes to its own isolated rating category, independent of the clock.
func TestAntichessCategory(t *testing.T) {
	for _, pool := range []string{"1+0", "3+0", "10+0", "30+0"} {
		if got := categoryFor(pool, variantAntichess); got != "antichess" {
			t.Errorf("categoryFor(%q, antichess) = %q, want antichess", pool, got)
		}
	}
	if categoryFor("3+0", variantStandard) == "antichess" {
		t.Error("standard must not use the antichess category")
	}
}

// The Antichess queue key must not collide with the standard pool key.
func TestAntichessQueueKeyDistinct(t *testing.T) {
	if queueKey("3+0", variantAntichess) == queueKey("3+0", variantStandard) {
		t.Error("antichess must have a distinct queue key from standard")
	}
}

func TestNormalizeVariantAntichess(t *testing.T) {
	if got := normalizeVariant("antichess"); got != variantAntichess {
		t.Errorf("normalizeVariant(antichess) = %q, want antichess", got)
	}
}
