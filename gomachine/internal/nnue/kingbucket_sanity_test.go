package nnue

import (
	"os"
	"testing"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// TestKingBucketNetSanity is the Rust↔Go feature-contract gate: it loads a
// bullet-trained king-bucket lean net (KB_NET=<path>) exactly as prod would
// (ImportBulletLeanNet + QuantizeFTInt8 + move-aware) and evaluates a handful of
// positions with known-sign expectations. If the Go feature indexing does NOT match
// what bullet trained, the eval is noise — startpos won't be ~0 and a side up a queen
// won't read strongly in its favor. A clean pass here (after a healthy training loss)
// is the empirical proof the two feature sets agree. No-op unless KB_NET is set.
//
//	KB_NET=/path/to/net.bin GOEXPERIMENT=simd go1.27rc1 test ./internal/nnue/ \
//	    -run TestKingBucketNetSanity -v
func TestKingBucketNetSanity(t *testing.T) {
	path := os.Getenv("KB_NET")
	if path == "" {
		t.Skip("set KB_NET to a bullet king-bucket lean net to run the sanity gate")
	}
	n, err := ImportBulletLeanNet(path, 512, 8)
	if err != nil {
		t.Fatalf("import %s: %v", path, err)
	}
	n.QuantizeFTInt8()
	n.SetMoveAware(true)

	cases := []struct {
		name, fen string
		// wantSign: +1 => eval should be strongly positive (stm clearly better),
		// -1 strongly negative, 0 near-equal (|eval| small).
		wantSign int
	}{
		{"startpos", chess.StartFEN, 0},
		{"white+Q, white to move", "rnb1kbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", +1},
		{"white+Q, black to move", "rnb1kbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1", -1},
		{"black+Q, black to move", "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNB1KBNR b KQkq - 0 1", +1},
		{"white+R, white to move", "1nbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQk - 0 1", +1},
	}
	strong := 250 // cp threshold for "clearly winning" (a queen/rook up)
	small := 150   // cp threshold for "near-equal" startpos
	for _, c := range cases {
		pos, err := chess.ParseFEN(c.fen)
		if err != nil {
			t.Fatalf("%s: parse: %v", c.name, err)
		}
		cp := n.Eval(pos) // side-to-move-relative centipawns
		t.Logf("%-26s eval = %+5d cp (stm-relative)", c.name, cp)
		switch c.wantSign {
		case 0:
			if cp > small || cp < -small {
				t.Errorf("%s: eval %+d cp not near-equal (|.|>%d) — features likely SCRAMBLED", c.name, cp, small)
			}
		case +1:
			if cp < strong {
				t.Errorf("%s: eval %+d cp not strongly positive (<%d) — features likely SCRAMBLED", c.name, cp, strong)
			}
		case -1:
			if cp > -strong {
				t.Errorf("%s: eval %+d cp not strongly negative (>-%d) — features likely SCRAMBLED", c.name, cp, strong)
			}
		}
	}
}
