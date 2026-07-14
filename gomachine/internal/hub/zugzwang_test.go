package hub

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/timanthonyalexander/gomachine/internal/auth"
	"github.com/timanthonyalexander/gomachine/internal/chess"
	"github.com/timanthonyalexander/gomachine/internal/variant"
)

// testZugzwangURL is the address a real `zugzwang serve` is expected at for
// the live tests below (ZUGZWANG_TEST_URL env override; default matches
// docs/COMMANDS.md's dev port). These tests are best-effort integration
// checks against a real external process, not unit tests — they skip
// cleanly (not fail) when nothing is listening, so `go test ./...` stays
// green on a machine without zugzwang running (e.g. CI).
func testZugzwangURL() string {
	if v := os.Getenv("ZUGZWANG_TEST_URL"); v != "" {
		return v
	}
	return "http://127.0.0.1:6476"
}

func skipUnlessZugzwangUp(t *testing.T) *zugzwangClient {
	t.Helper()
	z := newZugzwangClient(testZugzwangURL(), 4*time.Second)
	ctx, cancel := context.WithTimeout(context.Background(), 1*time.Second)
	defer cancel()
	if !z.Healthy(ctx) {
		t.Skipf("no zugzwang reachable at %s (set ZUGZWANG_TEST_URL, or start `zugzwang serve`); skipping live integration test", testZugzwangURL())
	}
	return z
}

// A real zugzwang instance must answer /bestmove with a legal move for the
// opening position at a mid-ladder rating — the exact call shape
// computeBotMove makes for a human bot-fill game.
func TestZugzwangClientBestMove_Live(t *testing.T) {
	z := skipUnlessZugzwangUp(t)

	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	res, err := z.BestMove(ctx, chess.StartFEN, nil, 1500, 300*time.Millisecond, 0)
	if err != nil {
		t.Fatalf("BestMove: %v", err)
	}
	if res.Move == chess.NullMove {
		t.Fatal("expected a legal move from the opening position, got NullMove")
	}

	pos, _ := chess.ParseFEN(chess.StartFEN)
	legal := false
	for _, m := range pos.LegalMoveStrings(chess.SqNone) {
		if m == res.Move.String() {
			legal = true
			break
		}
	}
	if !legal {
		t.Fatalf("zugzwang returned %q, not a legal opening move", res.Move.String())
	}
}

// A depth-capped, movetime-capped call (the filler shape) must also return a
// legal move.
func TestZugzwangClientBestMove_FillerShape(t *testing.T) {
	z := skipUnlessZugzwangUp(t)

	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	res, err := z.BestMove(ctx, chess.StartFEN, nil, 2000, fillerMoveTimeCap, fillerSearchDepth)
	if err != nil {
		t.Fatalf("BestMove: %v", err)
	}
	if res.Move == chess.NullMove {
		t.Fatal("expected a legal move, got NullMove")
	}
}

// End-to-end: a bot-fill game scheduled through the normal hub path
// (scheduleBotMove -> computeBotMove -> zugzwangBestMove) against a real
// zugzwang produces a legal move on h.botMoves.
func TestScheduleBotMove_ViaZugzwang_Live(t *testing.T) {
	skipUnlessZugzwangUp(t)

	h := New(testSecret)
	h.SetZugzwangClient(testZugzwangURL(), 4*time.Second, true)
	h.EnableBotFill(6, time.Minute, 1, 8, 1)

	g := newTestBotGame(t)
	h.games[g.id] = g
	h.scheduleBotMove(g)

	select {
	case r := <-h.botMoves:
		if r.gameID != g.id {
			t.Fatalf("botMoves result for wrong game: %q", r.gameID)
		}
		if _, _, ok := g.state.Apply(r.uci); !ok {
			t.Fatalf("zugzwang-sourced move %q is illegal on the game position", r.uci)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("no bot move arrived via zugzwang within 15s")
	}
}

// When zugzwang is unreachable and the emergency in-process fallback is
// enabled (the default), a bot move still arrives — computed locally —
// instead of the live game stalling forever.
func TestComputeBotMove_EmergencyFallbackFires(t *testing.T) {
	h := New(testSecret)
	// Port 1 is a privileged port nothing listens on; the connection is
	// refused immediately rather than timing out, keeping this test fast.
	h.SetZugzwangClient("http://127.0.0.1:1", 300*time.Millisecond, true)
	h.EnableBotFill(6, time.Minute, 1, 8, 1)

	g := newTestBotGame(t)
	h.games[g.id] = g
	h.scheduleBotMove(g)

	select {
	case r := <-h.botMoves:
		if _, _, ok := g.state.Apply(r.uci); !ok {
			t.Fatalf("emergency in-process move %q is illegal on the game position", r.uci)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("emergency in-process fallback never produced a move")
	}
}

// When zugzwang is unreachable and the emergency fallback is DISABLED, the
// bot move is dropped rather than silently computed in-process — no move
// should arrive.
func TestComputeBotMove_EmergencyFallbackDisabled(t *testing.T) {
	h := New(testSecret)
	h.SetZugzwangClient("http://127.0.0.1:1", 300*time.Millisecond, false)
	h.EnableBotFill(6, time.Minute, 1, 8, 1)

	g := newTestBotGame(t)
	h.games[g.id] = g
	h.scheduleBotMove(g)

	select {
	case r := <-h.botMoves:
		t.Fatalf("expected no bot move with the fallback disabled, got %q", r.uci)
	case <-time.After(2 * time.Second):
		// expected: dropped, not delivered.
	}
}

// End-to-end: a Crazyhouse bot-fill game's self-search move now comes from
// zugzwang's /crazyhouse/bestmove (scheduleBotMove -> scheduleSelfSearchBotMove
// -> selfSearchMove -> zugzwang.CrazyhouseBestMove), not gomachine's in-process
// crazyhouse.BestMove — the move must still be legal on the game's state.
func TestScheduleSelfSearchBotMove_Crazyhouse_ViaZugzwang_Live(t *testing.T) {
	skipUnlessZugzwangUp(t)

	h := New(testSecret)
	h.SetZugzwangClient(testZugzwangURL(), 4*time.Second, true)

	g := newTestCrazyhouseBotGame(t)
	h.games[g.id] = g
	h.scheduleBotMove(g)

	select {
	case r := <-h.botMoves:
		if r.gameID != g.id {
			t.Fatalf("botMoves result for wrong game: %q", r.gameID)
		}
		if _, _, ok := g.state.Apply(r.uci); !ok {
			t.Fatalf("zugzwang-sourced crazyhouse move %q is illegal on the game position", r.uci)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("no crazyhouse bot move arrived via zugzwang within 15s")
	}
}

// When zugzwang is unreachable, a Crazyhouse self-search bot move still
// arrives via the emergency in-process fallback (variant.SelfSearchMove) —
// the same safety net standard-chess bot-fill already has.
func TestSelfSearchMove_Crazyhouse_EmergencyFallbackFires(t *testing.T) {
	h := New(testSecret)
	h.SetZugzwangClient("http://127.0.0.1:1", 300*time.Millisecond, true)

	g := newTestCrazyhouseBotGame(t)
	h.games[g.id] = g
	h.scheduleBotMove(g)

	select {
	case r := <-h.botMoves:
		if _, _, ok := g.state.Apply(r.uci); !ok {
			t.Fatalf("emergency in-process crazyhouse move %q is illegal on the game position", r.uci)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("emergency in-process fallback never produced a crazyhouse move")
	}
}

// newTestCrazyhouseBotGame builds a minimal Crazyhouse human-vs-bot game
// (White bot, Black human) from the opening, mirroring newTestBotGame below
// but on the crazyhouse variant/pool.
func newTestCrazyhouseBotGame(t *testing.T) *game {
	t.Helper()
	st, err := variant.New(variantCrazyhouse, chess.StartFEN)
	if err != nil {
		t.Fatalf("variant.New(crazyhouse): %v", err)
	}
	return &game{
		id:        newID(),
		state:     st,
		tc:        timeControl{Base: 300_000, Inc: 0},
		white:     &player{id: newBotIdentity(1500), isBot: true, rating: 1500},
		black:     &player{id: auth.Identity{UserID: "human-test"}, isBot: false},
		startFen:  chess.StartFEN,
		variant:   variantCrazyhouse,
		clockMs:   [2]int64{300_000, 300_000},
		turnStart: time.Now(),
		online:    [2]bool{true, true},
	}
}

// newTestBotGame builds a minimal standard-chess human-vs-bot game (White
// bot, Black human) from the opening, suitable for exercising
// scheduleBotMove/computeBotMove directly without going through matchmaking
// or a live Run loop. White is the bot so it's already the bot's turn at the
// start position (scheduleBotMove no-ops if it isn't the bot's move).
func newTestBotGame(t *testing.T) *game {
	t.Helper()
	st, err := variant.New(variantStandard, chess.StartFEN)
	if err != nil {
		t.Fatalf("variant.New: %v", err)
	}
	return &game{
		id:        newID(),
		state:     st,
		tc:        timeControl{Base: 300_000, Inc: 0},
		white:     &player{id: newBotIdentity(1500), isBot: true, rating: 1500},
		black:     &player{id: auth.Identity{UserID: "human-test"}, isBot: false},
		startFen:  chess.StartFEN,
		variant:   variantStandard,
		clockMs:   [2]int64{300_000, 300_000},
		turnStart: time.Now(),
		online:    [2]bool{true, true},
	}
}
