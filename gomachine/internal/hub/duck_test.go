package hub

import (
	"testing"
	"time"

	"github.com/timanthonyalexander/gomachine/internal/auth"
	"github.com/timanthonyalexander/gomachine/internal/duckchess"
)

// newDuckGame builds a minimal in-memory duck game seeded from a crafted FEN, so
// tests can drive applyMove/status directly without a full hub/socket.
func newDuckGame(t *testing.T, fen string) *game {
	t.Helper()
	ds, err := duckchess.Parse(fen, "")
	if err != nil {
		t.Fatalf("parse duck fen: %v", err)
	}
	return &game{
		id:        "duck-test",
		white:     &player{id: auth.Identity{UserID: "w"}},
		black:     &player{id: auth.Identity{UserID: "b"}},
		duck:      &ds,
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
	if g.sideToMove() != g.duck.Side() {
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
	if got := g.duck.SideChar(); got != "b" {
		t.Errorf("rebuilt side to move = %q, want b", got)
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
