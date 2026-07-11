package nnue

import (
	"os"
	"testing"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// TestSmokeEvalSanity is the "is the net fully retarded?" gate for a fresh (e.g. SB=4,
// self-annealed) full-threats checkpoint. It is NOT a strength read — a 4-superbatch net
// is barely trained — but material is the easiest signal any working net learns first, so
// a broken pipeline (bad fold, wrong threat index, bad quant) shows up as a flipped sign
// or an exploded magnitude here. All FENs are White-to-move so Eval() is from White's POV.
// Set KB_NET_PATH to the folded quantised.bin.
func TestSmokeEvalSanity(t *testing.T) {
	path := os.Getenv("KB_NET_PATH")
	if path == "" {
		t.Skip("set KB_NET_PATH to a folded quantised.bin")
	}
	n, err := LoadKBNet(path, 512, 16, 32, 8)
	if err != nil {
		t.Fatalf("LoadKBNet(%s): %v", path, err)
	}
	if n.IsLean() {
		t.Fatalf("%s imported as LEAN — expected the multilayer full-threats net (size dispatch?)", path)
	}

	cases := []struct {
		name     string
		fen      string
		lo, hi   int // acceptable eval range (cp, White POV)
	}{
		// Balanced start: a working net sits near equality (generous band for a 4sb net).
		{"startpos", "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", -300, 300},
		// White up a full queen: must be strongly positive.
		{"white+Q", "rnb1kbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", 300, 4000},
		// Black up a full queen: must be strongly negative.
		{"black+Q", "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNB1KBNR w KQkq - 0 1", -4000, -300},
		// White up a rook: positive, smaller magnitude. (black a8 rook gone → drop q right)
		{"white+R", "1nbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQk - 0 1", 100, 3000},
		// Black up a rook: negative. (white a1 rook gone → drop Q right)
		{"black+R", "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/1NBQKBNR w Kkq - 0 1", -3000, -100},
	}

	fail := false
	for _, c := range cases {
		pos, err := chess.ParseFEN(c.fen)
		if err != nil {
			t.Fatalf("%s: ParseFEN: %v", c.name, err)
		}
		ev := n.Eval(pos)
		ok := ev >= c.lo && ev <= c.hi
		if !ok {
			fail = true
		}
		t.Logf("  %-9s eval=%+5d cp  (want [%d,%d])  %s", c.name, ev, c.lo, c.hi, map[bool]string{true: "ok", false: "RETARDED"}[ok])
	}
	if fail {
		t.Fatalf("eval sanity FAILED — material signs/magnitudes are off; the fold/index/quant pipeline is broken. STOP.")
	}
	t.Logf("eval sanity PASSED — material is signed correctly; the pipeline is not retarded.")
}
