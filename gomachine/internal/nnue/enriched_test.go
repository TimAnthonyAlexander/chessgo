package nnue

import (
	"os"
	"sort"
	"testing"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// TestEnrichedLoadSanity loads a bullet enriched export (set ENRICHED_NET to its
// raw.bin) and checks the forward is sane: gross material has the correct sign and
// is side-to-move relative. Skipped if ENRICHED_NET is unset (CI/no-net runs).
func TestEnrichedLoadSanity(t *testing.T) {
	path := os.Getenv("ENRICHED_NET")
	if path == "" {
		t.Skip("set ENRICHED_NET to a bullet raw.bin to run")
	}
	n, err := ImportBulletEnrichedNet(path, 1024, 16, 32, 8)
	if err != nil {
		t.Fatal(err)
	}
	ev := func(fen string) int {
		pos, e := chess.ParseFEN(fen)
		if e != nil {
			t.Fatalf("%s: %v", fen, e)
		}
		return n.Eval(pos)
	}
	wQ := ev("4k3/8/8/8/8/8/8/3QK3 w - - 0 1") // White up a queen, White to move
	bQ := ev("3qk3/8/8/8/8/8/8/4K3 w - - 0 1") // Black up a queen, White to move
	wQb := ev("4k3/8/8/8/8/8/8/3QK3 b - - 0 1") // White up a queen, Black to move
	t.Logf("startpos=%d  Wqueen(wtm)=%d  Bqueen(wtm)=%d  Wqueen(btm)=%d",
		ev(chess.StartFEN), wQ, bQ, wQb)
	if wQ <= 0 {
		t.Errorf("White-up-a-queen (White to move) should be +, got %d", wQ)
	}
	if bQ >= 0 {
		t.Errorf("Black-up-a-queen (White to move) should be -, got %d", bQ)
	}
	if wQb >= 0 {
		t.Errorf("White-up-a-queen (Black to move) should be - (stm-relative), got %d", wQb)
	}
}

// threatFeatures filters appendEnrichedFeatures down to the threat block (index
// >= InputDim) for the given perspective, returning a sorted slice.
func threatFeatures(pos *chess.Position, persp chess.Color) []int {
	var buf [maxEnrichedActive]uint16
	feats := appendEnrichedFeatures(buf[:0], pos, persp)
	var out []int
	for _, f := range feats {
		if int(f) >= InputDim {
			out = append(out, int(f))
		}
	}
	sort.Ints(out)
	return out
}

// TestEnrichedThreatIndices hand-verifies the threat feature indexing against the
// formula the Rust map_features (examples/chessgo_enriched.rs) implements:
//
//	idx = 768 + ((relColor(att)*6+type(att))*12 + relColor(vic)*6+type(vic))*64 + orient(victimSq)
//
// Position: White Ne1... white knight b1, black knight c3, kings on e1/e8.
// The knights mutually attack (b1<->c3); the kings attack only empty squares.
// So there are exactly two physical threats, and each perspective sees both with
// its own colour-relabeling and square orientation.
func TestEnrichedThreatIndices(t *testing.T) {
	pos, err := chess.ParseFEN("4k3/8/8/8/8/2n5/8/1N2K3 w - - 0 1")
	if err != nil {
		t.Fatal(err)
	}

	// White perspective: White pieces are "own" (relColor 0), squares un-flipped.
	//  Wn b1 -> bn c3 : a=(0*6+1)=1, v=(1*6+1)=7, tsq=c3=18 -> 768+(1*12+7)*64+18 = 2002
	//  bn c3 -> Wn b1 : a=(1*6+1)=7, v=(0*6+1)=1, tsq=b1=1  -> 768+(7*12+1)*64+1  = 6209
	wantWhite := []int{2002, 6209}
	if got := threatFeatures(pos, chess.White); !equalInts(got, wantWhite) {
		t.Errorf("white-perspective threats = %v, want %v", got, wantWhite)
	}

	// Black perspective: Black pieces "own" (relColor 0), squares flipped (^56).
	//  Wn b1 -> bn c3 : a=7, v=1, tsq=c3^56=42 -> 768+(7*12+1)*64+42 = 6250
	//  bn c3 -> Wn b1 : a=1, v=7, tsq=b1^56=57 -> 768+(1*12+7)*64+57 = 2041
	wantBlack := []int{2041, 6250}
	if got := threatFeatures(pos, chess.Black); !equalInts(got, wantBlack) {
		t.Errorf("black-perspective threats = %v, want %v", got, wantBlack)
	}
}

// TestEnrichedFeatureBounds checks every emitted feature (base + threats) is in
// range for both perspectives across a few positions — a too-large index would
// read garbage W0 columns (and overflow training).
func TestEnrichedFeatureBounds(t *testing.T) {
	fens := []string{
		chess.StartFEN,
		"r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 1",
		"r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1",
		"8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1",
	}
	lim := InputDim + ThreatBlock
	for _, fen := range fens {
		pos, err := chess.ParseFEN(fen)
		if err != nil {
			t.Fatalf("%s: %v", fen, err)
		}
		for _, persp := range []chess.Color{chess.White, chess.Black} {
			var buf [maxEnrichedActive]uint16
			feats := appendEnrichedFeatures(buf[:0], pos, persp)
			if len(feats) > maxEnrichedActive {
				t.Fatalf("%s persp %d: %d features exceeds maxEnrichedActive %d", fen, persp, len(feats), maxEnrichedActive)
			}
			for _, f := range feats {
				if int(f) >= lim {
					t.Errorf("%s persp %d: feature %d >= input dim %d", fen, persp, f, lim)
				}
			}
		}
	}
}

func equalInts(a, b []int) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
