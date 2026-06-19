package tune

import (
	"os"
	"path/filepath"
	"testing"
)

// TestLoadEPD checks the loader parses the common Texel EPD label formats
// (c9 result comments, [x.x] trailers, 4- and 6-field FENs) and skips junk.
func TestLoadEPD(t *testing.T) {
	content := `rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - c9 "1/2-1/2";
4R3/p5p1/5rk1/3B3p/2P3bP/5pP1/PP3P2/K7 b - - 2 1 c9 "1-0";
8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - [0.0]
r2q1rk1/pp2bppp/2n1pn2/3p4/3P4/2NBPN2/PP3PPP/R1BQ1RK1 b - - 0 1 c9 "0-1";

# a comment
garbage line with no parseable result token`

	path := filepath.Join(t.TempDir(), "sample.epd")
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	samples, err := LoadEPD(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(samples) != 4 {
		t.Fatalf("got %d samples, want 4", len(samples))
	}
	want := []float64{0.5, 1.0, 0.0, 0.0}
	for i, w := range want {
		if samples[i].Result != w {
			t.Errorf("sample %d result %.1f, want %.1f", i, samples[i].Result, w)
		}
		if len(samples[i].Trace.Entries) == 0 {
			t.Errorf("sample %d has an empty trace", i)
		}
		if samples[i].HasSoft {
			t.Errorf("sample %d should have no soft label", i)
		}
	}
}
