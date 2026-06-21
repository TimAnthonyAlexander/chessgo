package search

import (
	"testing"

	"github.com/timanthonyalexander/gomachine/internal/chess"
	"github.com/timanthonyalexander/gomachine/internal/nnue"
)

// TestNNUEAccumulatorInSearch drives a real alpha-beta search with the NNUE
// incremental accumulator AND the from-scratch equality gate enabled, over
// varied positions. Every static eval (negamax node, null-move child, quiescence
// stand-pat) recomputes the accumulator from scratch and panics on any drift, so
// a green run proves the incremental updates stay in sync through make/unmake,
// null moves, and qsearch. The diagnostic counters confirm those node types were
// actually reached.
func TestNNUEAccumulatorInSearch(t *testing.T) {
	if testing.Short() {
		t.Skip("skips under -short: the per-eval from-scratch rebuild is slow")
	}
	// A RandomNet is fine here: the in-search gate validates incremental == from-
	// scratch regardless of weights, and from a LEGAL root the search only ever
	// reaches legal positions (so eval values can't steer it anywhere unsound).
	prev := nnue.Default()
	nnue.SetNet(nnue.RandomNet(20240601))
	nnue.SetDebugAssert(true)
	defer func() {
		nnue.SetDebugAssert(false)
		nnue.SetNet(prev)
	}()

	// All roots are Legal() (the engine requires that — an illegal root lets the
	// search capture a king and crash, independent of eval). They cover castling,
	// captures, promotions (push + capture), en-passant, and an endgame.
	fens := []string{
		"r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1", // kiwipete: castles + captures
		"n3k3/1P6/8/8/8/8/8/4K3 w - - 0 1",                                     // push-promo + capture-promo
		"rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3",        // en-passant
		"8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1",                            // rook endgame
	}

	params := DefaultParams()
	params.Nnue = true

	var totalNull, totalQ uint64
	for _, fen := range fens {
		pos, err := chess.ParseFEN(fen)
		if err != nil {
			t.Fatalf("ParseFEN(%q): %v", fen, err)
		}
		s := NewWithParams(16, params)
		// Depth 12 with a node cap: enough that null-move (depth ≥ 3) and
		// quiescence both fire, bounded for runtime (the per-eval from-scratch
		// rebuild is heavy), and well clear of the extreme-depth regime. A panic
		// from the accumulator gate fails the test.
		res := s.Search(pos, Limits{Depth: 12, Nodes: 200000}, nil)
		if res.BestMove == chess.NullMove {
			t.Fatalf("no best move for %q", fen)
		}
		totalNull += s.DbgNullMoves()
		totalQ += s.DbgQNodes()
	}

	if totalNull == 0 {
		t.Fatal("gate never covered a null-move node (coverage gap)")
	}
	if totalQ == 0 {
		t.Fatal("gate never covered a quiescence node (coverage gap)")
	}
	t.Logf("accumulator gate covered %d null-move nodes and %d quiescence nodes", totalNull, totalQ)
}

// TestNNUERootScoresAccumulator exercises the RootScores path (weakened-bot
// ranking) with the gate on — a separate top-level entry that pushes a root move
// before recursing.
func TestNNUERootScoresAccumulator(t *testing.T) {
	if testing.Short() {
		t.Skip("skips under -short: per-eval from-scratch rebuild is slow")
	}
	prev := nnue.Default()
	nnue.SetNet(nnue.RandomNet(99))
	nnue.SetDebugAssert(true)
	defer func() {
		nnue.SetDebugAssert(false)
		nnue.SetNet(prev)
	}()

	params := DefaultParams()
	params.Nnue = true
	s := NewWithParams(16, params)
	pos, _ := chess.ParseFEN("r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1")
	roots := s.RootScores(pos, Limits{Depth: 4}, nil)
	if len(roots) == 0 {
		t.Fatal("RootScores returned no moves")
	}
}
