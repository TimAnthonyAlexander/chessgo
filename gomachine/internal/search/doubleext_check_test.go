package search

import (
	"testing"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// TestDoubleExtFiresAndChangesTree confirms double extensions (Params.DoubleExt,
// on top of singular extensions) are wired end-to-end: with Singular on in both
// runs and DoubleExt flipped on, the search must (a) actually apply a double
// extension (dbgDoubleExt > 0) where off applies none, and (b) change the search
// tree relative to off (the searched node count differs — extending a singular
// move 2 plies instead of 1 grows its subtree). Deterministic (fixed depth,
// counts not timing), so it's safe to run alongside a live SPRT.
func TestDoubleExtFiresAndChangesTree(t *testing.T) {
	mk := func(on bool) Params {
		p := DefaultParams()
		p.Singular = true // singular must be on for double extensions to exist
		p.DoubleExt = on
		return p
	}
	// A sharp middlegame produces singular moves; double extensions need depth ≥
	// singularMinDepth (8), so search deep enough that wide-margin singulars appear.
	const fen = "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1" // Kiwipete

	pos, err := chess.ParseFEN(fen)
	if err != nil {
		t.Fatalf("parse %q: %v", fen, err)
	}

	// Fixed depth (not a node cap): a node cap would stop both runs at the same
	// number, hiding the tree-size change the double extension produces.
	const depth = 14

	sOff := NewWithParams(16, mk(false))
	rOff := sOff.Search(pos, Limits{Depth: depth}, nil)
	if got := sOff.DbgDoubleExt(); got != 0 {
		t.Fatalf("doubleext off: dbgDoubleExt = %d, want 0 (off-path must not double-extend)", got)
	}

	sOn := NewWithParams(16, mk(true))
	rOn := sOn.Search(pos, Limits{Depth: depth}, nil)

	t.Logf("doubleext off: nodes=%d | on: nodes=%d doubleExt=%d",
		rOff.Nodes, rOn.Nodes, sOn.DbgDoubleExt())

	// (a) the feature actually fired.
	if sOn.DbgDoubleExt() == 0 {
		t.Fatalf("doubleext on: dbgDoubleExt = 0, want > 0 (feature never fired) at depth %d", depth)
	}
	// (b) the patch is not a no-op: extending a move 2 plies instead of 1 must
	// have changed the searched node count.
	if rOn.Nodes == rOff.Nodes {
		t.Fatalf("doubleext on changed nothing: nodes=%d == off nodes=%d at depth %d",
			rOn.Nodes, rOff.Nodes, depth)
	}
}
