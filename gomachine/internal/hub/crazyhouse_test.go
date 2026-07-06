package hub

import (
	"testing"

	"github.com/timanthonyalexander/gomachine/internal/auth"
)

// startBotGame with variant "crazyhouse" routes entirely through the variant
// framework (no crazyhouse-specific hub code): it builds a live state, seats one
// bot, carries the pocket in the snapshot, and is RATED for a logged-in human on
// its own isolated "crazyhouse" pool (categoryFor → "crazyhouse").
func TestStartBotGameCrazyhouse(t *testing.T) {
	h := New(testSecret)
	human := &Client{id: auth.Identity{UserID: "u1", Name: "human", Rating: 1500}, send: make(chan []byte, sendBuffer)}
	h.startBotGame(human, timeControl{Base: 300_000, Inc: 0}, "3+0", variantCrazyhouse)

	g := human.game
	if g == nil {
		t.Fatal("startBotGame did not attach a game")
	}
	if g.variant != variantCrazyhouse {
		t.Errorf("variant = %q, want crazyhouse", g.variant)
	}
	if !g.rated {
		t.Error("a crazyhouse bot game with a logged-in human must be rated (crazyhouse pool)")
	}
	if g.white.isBot == g.black.isBot {
		t.Errorf("expected exactly one bot side, white=%v black=%v", g.white.isBot, g.black.isBot)
	}

	snap := g.snapshot()
	if snap["variant"] != variantCrazyhouse {
		t.Errorf("snapshot variant = %v, want crazyhouse", snap["variant"])
	}
	if _, ok := snap["pocket"]; !ok {
		t.Error("crazyhouse snapshot must carry a pocket field (from Extras)")
	}
	if snap["fen"] == "" {
		t.Error("crazyhouse snapshot must carry a board fen")
	}
}

// A Crazyhouse queue key must not collide with the standard pool key (variant
// namespacing), so a Crazyhouse queuer never pairs with a standard one.
func TestCrazyhouseQueueKeyDistinct(t *testing.T) {
	if queueKey("3+0", variantCrazyhouse) == queueKey("3+0", variantStandard) {
		t.Error("crazyhouse must have a distinct queue key from standard")
	}
}

// Crazyhouse routes to its own isolated rating category, independent of the clock.
func TestCrazyhouseCategory(t *testing.T) {
	for _, pool := range []string{"1+0", "3+0", "10+0", "30+0"} {
		if got := categoryFor(pool, variantCrazyhouse); got != "crazyhouse" {
			t.Errorf("categoryFor(%q, crazyhouse) = %q, want crazyhouse", pool, got)
		}
	}
	if categoryFor("3+0", variantStandard) == "crazyhouse" {
		t.Error("standard must not use the crazyhouse category")
	}
}
