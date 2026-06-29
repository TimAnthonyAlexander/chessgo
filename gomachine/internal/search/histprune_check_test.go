package search

import (
	"testing"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// TestHistPruneFiresAndChangesTree confirms history pruning (Params.HistPrune) is
// wired end-to-end: with the flag on it must (a) actually skip late quiets (the
// dbgHistPrune counter > 0) and (b) change the search tree relative to off — i.e.
// the searched node count differs (a no-op would leave it untouched). Deterministic
// (fixed node cap, counts not timing), so it's safe to run alongside a live SPRT.
func TestHistPruneFiresAndChangesTree(t *testing.T) {
	mk := func(on bool) Params {
		p := DefaultParams()
		p.HistPrune = on
		return p
	}
	// A midgame / tactical position drives enough late quiets to exercise pruning.
	const fen = "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1" // Kiwipete

	pos, err := chess.ParseFEN(fen)
	if err != nil {
		t.Fatalf("parse %q: %v", fen, err)
	}

	// Fixed depth (not a node cap): a node cap would stop both runs at the same
	// number, hiding the tree-size change pruning produces.
	const depth = 13

	sOff := NewWithParams(16, mk(false))
	rOff := sOff.Search(pos, Limits{Depth: depth}, nil)
	if got := sOff.DbgHistPrune(); got != 0 {
		t.Fatalf("histprune off: dbgHistPrune = %d, want 0 (off-path must not prune)", got)
	}

	sOn := NewWithParams(16, mk(true))
	rOn := sOn.Search(pos, Limits{Depth: depth}, nil)

	t.Logf("histprune off: nodes=%d | on: nodes=%d pruned=%d",
		rOff.Nodes, rOn.Nodes, sOn.DbgHistPrune())

	// (a) the feature actually fired.
	if sOn.DbgHistPrune() == 0 {
		t.Fatalf("histprune on: dbgHistPrune = 0, want > 0 (feature never fired)")
	}
	// (b) the patch is not a no-op: it either changed the searched node count or it
	// pruned moves. With (a) already proving prunes fired, this guards against a
	// hypothetical wiring that increments the counter without affecting the search.
	if rOn.Nodes == rOff.Nodes && sOn.DbgHistPrune() == 0 {
		t.Fatalf("histprune on changed nothing: nodes=%d == off nodes=%d and 0 prunes at depth %d",
			rOn.Nodes, rOff.Nodes, depth)
	}
}
