package hub

import (
	"testing"

	"github.com/timanthonyalexander/gomachine/internal/auth"
	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// makeHumanGame builds a minimal standard game between two account identities,
// enough to exercise the anti-cheat live-player index.
func makeHumanGame(id string, whiteSub, blackSub string) *game {
	pos, _ := chess.ParseFEN(chess.StartFEN)
	return &game{
		id:       id,
		startFen: chess.StartFEN,
		pos:      pos,
		variant:  variantStandard,
		white:    &player{id: auth.Identity{UserID: whiteSub}},
		black:    &player{id: auth.Identity{UserID: blackSub}},
	}
}

func TestLivePlayerTracksBothSides(t *testing.T) {
	h := New("secret")
	g := makeHumanGame("g1", "alice", "bob")

	h.markLive(g)

	for _, sub := range []string{"alice", "bob"} {
		live, fen := h.LivePlayer(sub)
		if !live {
			t.Fatalf("%s should be live after markLive", sub)
		}
		if fen != chess.StartFEN {
			t.Fatalf("%s live fen = %q, want start position", sub, fen)
		}
	}

	if live, _ := h.LivePlayer("carol"); live {
		t.Fatal("a player not in any game must not be live")
	}
	if live, _ := h.LivePlayer(""); live {
		t.Fatal("empty sub must never be live")
	}
}

func TestUnmarkLiveClearsBothSides(t *testing.T) {
	h := New("secret")
	g := makeHumanGame("g1", "alice", "bob")

	h.markLive(g)
	h.unmarkLive(g)

	if live, _ := h.LivePlayer("alice"); live {
		t.Fatal("alice should be cleared after unmarkLive")
	}
	if live, _ := h.LivePlayer("bob"); live {
		t.Fatal("bob should be cleared after unmarkLive")
	}
}

func TestRefreshLiveUpdatesFEN(t *testing.T) {
	h := New("secret")
	g := makeHumanGame("g1", "alice", "bob")
	h.markLive(g)

	if _, ok := g.applyMove("e2e4"); !ok {
		t.Fatal("e2e4 should be legal from the start position")
	}
	h.refreshLive(g)

	_, fen := h.LivePlayer("alice")
	if fen == chess.StartFEN || fen == "" {
		t.Fatalf("live fen should advance after a move, got %q", fen)
	}
	// Board is now the post-1.e4 position — the exact-match check BaseAPI runs.
	if got := g.boardFEN(); fen != got {
		t.Fatalf("refreshed fen %q != current board %q", fen, got)
	}
}

// Filler (engine-vs-engine) games must never populate the live index — they have
// no human players to flag.
func TestFillerGamesAreNotLive(t *testing.T) {
	h := New("secret")
	g := makeHumanGame("f1", "bot-1", "bot-2")
	g.filler = true

	h.markLive(g)

	if live, _ := h.LivePlayer("bot-1"); live {
		t.Fatal("filler side must not be tracked as live")
	}
}

// Each committed move records a think-time, parallel to moves (anti-cheat
// move-time telemetry).
func TestMoveTimesCaptured(t *testing.T) {
	g := makeHumanGame("g1", "alice", "bob")

	for _, uci := range []string{"e2e4", "e7e5", "g1f3"} {
		if _, ok := g.applyMove(uci); !ok {
			t.Fatalf("%s should be legal", uci)
		}
	}
	if len(g.moveTimes) != len(g.moves) {
		t.Fatalf("moveTimes (%d) must be parallel to moves (%d)", len(g.moveTimes), len(g.moves))
	}
	if len(g.moveTimes) != 3 {
		t.Fatalf("expected 3 recorded move times, got %d", len(g.moveTimes))
	}
	for i, mt := range g.moveTimes {
		if mt < 0 {
			t.Fatalf("move time %d is negative: %d", i, mt)
		}
	}
}

// A bot side of a human-vs-bot game is not tracked (only the human is).
func TestBotSideNotTracked(t *testing.T) {
	h := New("secret")
	g := makeHumanGame("hb1", "alice", "bot-9")
	g.black.isBot = true

	h.markLive(g)

	if live, _ := h.LivePlayer("alice"); !live {
		t.Fatal("the human side should be live")
	}
	if live, _ := h.LivePlayer("bot-9"); live {
		t.Fatal("the bot side should not be tracked")
	}
}
