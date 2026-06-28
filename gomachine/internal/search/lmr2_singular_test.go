package search

import (
	"testing"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// withFlags returns DefaultParams with the two Wave-3 flags forced to the given
// values (everything else at its shipped default).
func withFlags(lmr2, singular bool) Params {
	p := DefaultParams()
	p.LMR2 = lmr2
	p.Singular = singular
	return p
}

var wave3FENs = []string{
	chess.StartFEN,
	"r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4", // Italian
	"r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1", // Kiwipete
	"8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1",                            // R endgame
}

// TestLMR2SingularOffPathDeterministic confirms that with both Wave-3 flags OFF
// (the shipped default) the search is deterministic — the new code adds no
// nondeterminism to the off path. (The off path is byte-identical by construction:
// extension is always 0 so newDepth==depth-1, and the LMR2 branch is gated behind
// the flag, leaving the original LMR else-branch untouched.)
func TestLMR2SingularOffPathDeterministic(t *testing.T) {
	for _, fen := range wave3FENs {
		pos, err := chess.ParseFEN(fen)
		if err != nil {
			t.Fatalf("parse %q: %v", fen, err)
		}
		a := NewWithParams(16, withFlags(false, false)).Search(pos, Limits{Depth: 9}, nil)
		b := NewWithParams(16, withFlags(false, false)).Search(pos, Limits{Depth: 9}, nil)
		if a.Nodes != b.Nodes || a.BestMove != b.BestMove || a.Score != b.Score {
			t.Errorf("non-deterministic off-path on %q: (%d,%s,%d) vs (%d,%s,%d)",
				fen, a.Nodes, a.BestMove, a.Score, b.Nodes, b.BestMove, b.Score)
		}
	}
}

// TestSingularExtensionFires confirms the singular path actually executes — a deep
// search with Singular on must apply at least one extension or multi-cut across the
// tree (otherwise the feature is silently inert and any SPRT would be measuring a
// no-op).
func TestSingularExtensionFires(t *testing.T) {
	pos, err := chess.ParseFEN(chess.StartFEN)
	if err != nil {
		t.Fatal(err)
	}
	s := NewWithParams(16, withFlags(false, true))
	s.Search(pos, Limits{Depth: 13}, nil)
	fired := s.DbgSingular() + s.DbgMultiCut()
	if fired == 0 {
		t.Fatalf("singular path never fired at depth 13 (singular=%d multicut=%d) — feature inert",
			s.DbgSingular(), s.DbgMultiCut())
	}
	t.Logf("singular fired: extensions=%d multicuts=%d", s.DbgSingular(), s.DbgMultiCut())
}

// TestSingularPreservesTactics is the end-to-end correctness gate for the
// excluded-move machinery: if exclusion corrupted the TT or returned the excluded
// move, the engine would miss forced tactics. With BOTH Wave-3 flags on it must
// still find the basic mate and win the hanging queen.
func TestSingularPreservesTactics(t *testing.T) {
	cases := []struct {
		name, fen, want string
		depth           int
	}{
		{"mate-in-1", "6k1/5ppp/8/8/8/8/8/R6K w - - 0 1", "a1a8", 4},
		{"win-queen", "4k3/8/8/8/7q/8/8/4K2R w - - 0 1", "h1h4", 8},
	}
	for _, c := range cases {
		pos, err := chess.ParseFEN(c.fen)
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		r := NewWithParams(16, withFlags(true, true)).Search(pos, Limits{Depth: c.depth}, nil)
		if r.BestMove.String() != c.want {
			t.Errorf("%s: best=%s want=%s (score %d) — exclusion may have corrupted search",
				c.name, r.BestMove, c.want, r.Score)
		}
	}
}

// TestWave3NoTreeExplosion checks that turning on aggressive LMR or singular does
// not balloon the fixed-depth node count. LMR2 should shrink the tree (it reduces
// more); singular grows it modestly (re-extensions). A >5x blow-up signals a bug
// (e.g. runaway re-extension or a broken exclusion).
func TestWave3NoTreeExplosion(t *testing.T) {
	for _, fen := range wave3FENs {
		pos, err := chess.ParseFEN(fen)
		if err != nil {
			t.Fatal(err)
		}
		off := NewWithParams(16, withFlags(false, false)).Search(pos, Limits{Depth: 11}, nil).Nodes
		se := NewWithParams(16, withFlags(false, true)).Search(pos, Limits{Depth: 11}, nil).Nodes
		lmr2 := NewWithParams(16, withFlags(true, false)).Search(pos, Limits{Depth: 11}, nil).Nodes
		both := NewWithParams(16, withFlags(true, true)).Search(pos, Limits{Depth: 11}, nil).Nodes
		t.Logf("%-50s off=%-9d se=%-9d lmr2=%-9d both=%-9d", fen[:minInt(len(fen), 50)], off, se, lmr2, both)
		if se > 5*off {
			t.Errorf("singular tree explosion on %q: %d nodes vs %d off (%.1fx)", fen, se, off, float64(se)/float64(off))
		}
		if both > 5*off {
			t.Errorf("lmr2+singular tree explosion on %q: %d nodes vs %d off (%.1fx)", fen, both, off, float64(both)/float64(off))
		}
	}
}
