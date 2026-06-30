package nnue

import (
	"math/rand"
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
	wQ := ev("4k3/8/8/8/8/8/8/3QK3 w - - 0 1")  // White up a queen, White to move
	bQ := ev("3qk3/8/8/8/8/8/8/4K3 w - - 0 1")  // Black up a queen, White to move
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

// TestEnrichedLeanLoadSanity loads a bullet LEAN single-layer+threats export (set
// LEAN_NET to its raw.bin) and checks the forward is sane + side-to-move-relative.
func TestEnrichedLeanLoadSanity(t *testing.T) {
	path := os.Getenv("LEAN_NET")
	if path == "" {
		t.Skip("set LEAN_NET to a bullet lean raw.bin to run")
	}
	n, err := ImportBulletLeanNet(path, 512, 8)
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
	wQ := ev("4k3/8/8/8/8/8/8/3QK3 w - - 0 1")
	bQ := ev("3qk3/8/8/8/8/8/8/4K3 w - - 0 1")
	wQb := ev("4k3/8/8/8/8/8/8/3QK3 b - - 0 1")
	t.Logf("lean: startpos=%d Wq(wtm)=%d Bq(wtm)=%d Wq(btm)=%d", ev(chess.StartFEN), wQ, bQ, wQb)
	if wQ <= 0 {
		t.Errorf("White-up-a-queen (wtm) should be +, got %d", wQ)
	}
	if bQ >= 0 {
		t.Errorf("Black-up-a-queen (wtm) should be -, got %d", bQ)
	}
	if wQb >= 0 {
		t.Errorf("White-up-a-queen (btm) should be - (stm-relative), got %d", wQb)
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

// TestEnrichedInt8Closeness checks the int8 L1 PTQ stays close to the float
// forward (the quantization-quality gate, like MultiNet's). Set ENRICHED_NET.
func TestEnrichedInt8Closeness(t *testing.T) {
	path := os.Getenv("ENRICHED_NET")
	if path == "" {
		t.Skip("set ENRICHED_NET")
	}
	fl, err := ImportBulletEnrichedNet(path, 512, 16, 32, 8)
	if err != nil {
		t.Fatal(err)
	}
	q8, err := ImportBulletEnrichedNet(path, 512, 16, 32, 8)
	if err != nil {
		t.Fatal(err)
	}
	q8.QuantizeForInt8()
	fens := []string{
		chess.StartFEN,
		"r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 1",
		"r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1",
		"2r3k1/pp2bppp/2n1pn2/q7/3P4/2N1PN2/PP2BPPP/2RQ1RK1 w - - 0 1",
		"8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1",
		"r2q1rk1/1b1nbppp/p2ppn2/1p6/3NPP2/1BN1B3/PPP3PP/R2Q1RK1 w - - 0 1",
	}
	var maxAbs, sumAbs int
	for _, f := range fens {
		pos, e := chess.ParseFEN(f)
		if e != nil {
			t.Fatal(e)
		}
		d := fl.Eval(pos) - q8.Eval(pos)
		if d < 0 {
			d = -d
		}
		sumAbs += d
		if d > maxAbs {
			maxAbs = d
		}
	}
	t.Logf("int8-vs-float: mean %.1f cp, max %d cp over %d FENs", float64(sumAbs)/float64(len(fens)), maxAbs, len(fens))
	if maxAbs > 40 {
		t.Errorf("int8 PTQ too far from float: max %d cp (>40)", maxAbs)
	}
}

// TestEnrichedInt8ClosenessBroad evals float vs int8 over many DIVERSE positions
// reached by pseudo-random play, to distinguish genuine PTQ error (small, fat
// tail) from a quantization bug (huge outliers). Set ENRICHED_NET.
func TestEnrichedInt8ClosenessBroad(t *testing.T) {
	path := os.Getenv("ENRICHED_NET")
	if path == "" {
		t.Skip("set ENRICHED_NET")
	}
	fl, _ := ImportBulletEnrichedNet(path, 512, 16, 32, 8)
	q8, _ := ImportBulletEnrichedNet(path, 512, 16, 32, 8)
	q8.QuantizeForInt8() // int8 tail L1
	q8.QuantizeFTInt8()  // int8 FT threat columns (clamps if not FT-QAT'd → expect loss here)

	rng := rand.New(rand.NewSource(1))
	var diffs []int
	for g := 0; g < 60; g++ {
		pos, _ := chess.ParseFEN(chess.StartFEN)
		for ply := 0; ply < 40; ply++ {
			var ml chess.MoveList
			pos.GenerateLegal(&ml)
			if ml.Len() == 0 {
				break
			}
			if ply >= 6 { // skip the book-ish opening
				d := fl.Eval(pos) - q8.Eval(pos)
				if d < 0 {
					d = -d
				}
				diffs = append(diffs, d)
			}
			m := ml.Get(rng.Intn(ml.Len()))
			var u chess.Undo
			pos.DoMove(m, &u)
		}
	}
	sort.Ints(diffs)
	var sum int
	for _, d := range diffs {
		sum += d
	}
	n := len(diffs)
	t.Logf("int8-vs-float over %d positions: mean %.1f cp, median %d, p95 %d, p99 %d, max %d cp",
		n, float64(sum)/float64(n), diffs[n/2], diffs[n*95/100], diffs[n*99/100], diffs[n-1])
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
