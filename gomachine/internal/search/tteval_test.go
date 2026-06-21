package search

import (
	"testing"

	"github.com/timanthonyalexander/gomachine/internal/chess"
	"github.com/timanthonyalexander/gomachine/internal/nnue"
)

// TestTTEvalBehaviorPreserving asserts the TT static-eval cache is a pure speed
// optimization: because the static eval is a deterministic function of the
// position, reusing a TT-cached eval yields the *same* value a fresh recompute
// would, so the search tree — and therefore best move, score, node count, and
// depth — must be byte-identical with the flag off vs on at fixed nodes. (This
// is why the feature is SPRT'd at movetime, not fixed nodes: at fixed nodes it
// is provably neutral; the win is wall-clock.)
//
// Run for both eval backends (HCE and NNUE), since the cache wraps evaluate()
// which dispatches to either.
func TestTTEvalBehaviorPreserving(t *testing.T) {
	fens := []string{
		"rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",            // startpos
		"r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1", // kiwipete
		"r1bq1rk1/pp2bppp/2n2n2/2pp4/3P4/2N1PN2/PP2BPPP/R1BQ1RK1 w - - 0 9",    // middlegame
		"8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1",                            // rook ending
		"8/5ppp/8/8/8/8/PPP5/4k1K1 w - - 0 1",                                  // pawn ending
	}

	run := func(t *testing.T, nnueOn bool) {
		base := DefaultParams()
		base.Nnue = nnueOn
		off, on := base, base
		off.TTEval = false
		on.TTEval = true

		for _, fen := range fens {
			pos, err := chess.ParseFEN(fen)
			if err != nil {
				t.Fatalf("ParseFEN(%q): %v", fen, err)
			}
			// Fresh TT per searcher so neither sees the other's entries; a node cap
			// keeps it fast while reaching depths where TT revisits (the cache's
			// payoff) actually occur.
			limits := Limits{Depth: 99, Nodes: 300_000}
			rOff := NewWithParams(32, off).Search(clone(pos), limits, nil)
			rOn := NewWithParams(32, on).Search(clone(pos), limits, nil)

			if rOff.BestMove != rOn.BestMove || rOff.Score != rOn.Score ||
				rOff.Nodes != rOn.Nodes || rOff.Depth != rOn.Depth {
				t.Errorf("TTEval changed behavior (nnue=%v) on %q:\n  off: move=%v score=%d nodes=%d depth=%d\n   on: move=%v score=%d nodes=%d depth=%d",
					nnueOn, fen,
					rOff.BestMove, rOff.Score, rOff.Nodes, rOff.Depth,
					rOn.BestMove, rOn.Score, rOn.Nodes, rOn.Depth)
			}
		}
	}

	t.Run("HCE", func(t *testing.T) { run(t, false) })

	t.Run("NNUE", func(t *testing.T) {
		if nnue.Default() == nil {
			prev := nnue.Default()
			nnue.SetNet(nnue.RandomNet(20240601))
			defer nnue.SetNet(prev)
		}
		run(t, true)
	})
}
