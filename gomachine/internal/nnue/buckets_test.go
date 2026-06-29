package nnue

import (
	"bytes"
	"math/rand"
	"strings"
	"testing"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// fenWithPieceCount builds a (rules-illegal but parseable) position with exactly
// k pieces on the board: two kings plus (k-2) knights, so outputBucket can be
// checked across the whole popcount range.
func fenWithPieceCount(k int) string {
	var sq [64]byte
	sq[0] = 'K'  // a1
	sq[63] = 'k' // h8
	placed := 2
	for i := 1; i < 63 && placed < k; i++ {
		if sq[i] == 0 {
			sq[i] = 'N'
			placed++
		}
	}
	var b strings.Builder
	for r := 7; r >= 0; r-- {
		empty := 0
		for f := 0; f < 8; f++ {
			c := sq[r*8+f]
			if c == 0 {
				empty++
				continue
			}
			if empty > 0 {
				b.WriteByte(byte('0' + empty))
				empty = 0
			}
			b.WriteByte(c)
		}
		if empty > 0 {
			b.WriteByte(byte('0' + empty))
		}
		if r > 0 {
			b.WriteByte('/')
		}
	}
	b.WriteString(" w - - 0 1")
	return b.String()
}

// TestOutputBucketFullRange pins the bucket index against bullet's
// MaterialCount<8> for EVERY legal piece count (2..32), not just a few samples.
// A mismatch here is the silent-corruption class: the net trains head X for a
// position the engine evaluates with head Y — passes other unit tests, quietly
// costs Elo. bullet: divisor = ceil(32/8) = 4, bucket = (popcount-2)/4.
func TestOutputBucketFullRange(t *testing.T) {
	const nb = 8
	n := NewNetSizeBuckets(64, nb)
	for k := 2; k <= 32; k++ {
		fen := fenWithPieceCount(k)
		pos, err := chess.ParseFEN(fen)
		if err != nil {
			t.Fatalf("k=%d: ParseFEN(%q): %v", k, fen, err)
		}
		if got := pos.Occupied().Count(); got != k {
			t.Fatalf("k=%d: built a position with %d pieces", k, got)
		}
		want := (k - 2) / 4 // bullet MaterialCount<8>
		if got := n.outputBucket(pos); got != want {
			t.Errorf("piece count %d: outputBucket=%d, want (k-2)/4=%d", k, got, want)
		}
	}
}

// randomBucketNet builds a deterministic random NB-bucket net of width hl, with
// the integer view populated and marked quantized (so Write emits GNN3 for NB>1).
func randomBucketNet(seed int64, hl, nb int) *Net {
	rng := rand.New(rand.NewSource(seed))
	n := NewNetSizeBuckets(hl, nb)
	for i := range n.W0 {
		n.W0[i] = float32(rng.NormFloat64()) * 0.1
	}
	for i := range n.B0 {
		n.B0[i] = float32(rng.NormFloat64()) * 0.1
	}
	for i := range n.W1 {
		n.W1[i] = float32(rng.NormFloat64()) * 0.1
	}
	for b := range n.B1 {
		n.B1[b] = float32(rng.NormFloat64()) * 0.1
	}
	n.CpScale = 100
	n.quantizeFromFloat()
	n.quantized = true // force the GNN3 (bucketed) write path
	return n
}

// TestOutputBucketFormula pins the bucket selection to bullet's MaterialCount<8>:
// divisor = ceil(32/8) = 4, bucket = (popcount(occ)-2)/4, clamped to [0,7].
func TestOutputBucketFormula(t *testing.T) {
	n := NewNetSizeBuckets(64, 8)
	cases := []struct {
		fen  string
		want int
	}{
		{chess.StartFEN, 7},                          // 32 pieces -> (32-2)/4 = 7
		{"8/8/8/4k3/8/4K3/8/8 w - - 0 1", 0},         // 2 kings  -> 0
		{"8/8/8/3qk3/8/4K3/8/8 w - - 0 1", 0},        // 3 pieces -> (3-2)/4 = 0
		{"4k3/8/8/8/8/8/PPPP4/4K3 w - - 0 1", 1},     // 6 pieces -> (6-2)/4 = 1
		{"4k3/pppp4/8/8/8/8/PPPP4/4K3 w - - 0 1", 2}, // 10 pieces -> (10-2)/4 = 2
	}
	for _, c := range cases {
		pos, err := chess.ParseFEN(c.fen)
		if err != nil {
			t.Fatalf("fen %q: %v", c.fen, err)
		}
		if got := n.outputBucket(pos); got != c.want {
			t.Errorf("outputBucket(%q) = %d, want %d (popcount=%d)",
				c.fen, got, c.want, pos.Occupied().Count())
		}
	}
	// NB==1 always selects bucket 0.
	single := NewNetSize(64)
	pos, _ := chess.ParseFEN(chess.StartFEN)
	if got := single.outputBucket(pos); got != 0 {
		t.Errorf("single-bucket net: outputBucket = %d, want 0", got)
	}
}

// TestGNN3RoundTrip saves a bucketed net (GNN3), reloads it, and asserts the
// reload is faithful: NB preserved, int weights identical, and the eval matches
// the original on a spread of positions (with pieces in different buckets).
func TestGNN3RoundTrip(t *testing.T) {
	const hl, nb = 64, 8
	net := randomBucketNet(99, hl, nb)

	var buf bytes.Buffer
	if err := net.Write(&buf); err != nil {
		t.Fatalf("write: %v", err)
	}
	got, err := ReadNet(&buf)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if got.NB != nb {
		t.Fatalf("NB not preserved: got %d want %d", got.NB, nb)
	}
	if !got.quantized {
		t.Fatal("reloaded GNN3 net not marked quantized")
	}
	if len(got.W1i) != nb*2*hl || len(got.B1i) != nb {
		t.Fatalf("bucket weight sizes wrong: W1i=%d (want %d), B1i=%d (want %d)",
			len(got.W1i), nb*2*hl, len(got.B1i), nb)
	}
	for i := range net.W1i {
		if got.W1i[i] != net.W1i[i] {
			t.Fatalf("W1i[%d] drift: %d vs %d", i, got.W1i[i], net.W1i[i])
		}
	}
	for b := range net.B1i {
		if got.B1i[b] != net.B1i[b] {
			t.Fatalf("B1i[%d] drift: %d vs %d", b, got.B1i[b], net.B1i[b])
		}
	}
	// Eval parity across positions that fall into different buckets.
	fens := []string{
		chess.StartFEN,
		"r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1",
		"8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1",
		"8/8/8/3qk3/8/4K3/8/8 w - - 0 1",
	}
	for _, fen := range fens {
		pos, err := chess.ParseFEN(fen)
		if err != nil {
			t.Fatalf("fen %q: %v", fen, err)
		}
		acc1 := net.newAccumulator()
		net.build(&acc1, pos)
		acc2 := got.newAccumulator()
		got.build(&acc2, pos)
		e1 := net.evalFrom(&acc1, pos.SideToMove(), net.outputBucket(pos))
		e2 := got.evalFrom(&acc2, pos.SideToMove(), got.outputBucket(pos))
		if e1 != e2 {
			t.Errorf("eval mismatch after round-trip for %q: %d vs %d", fen, e1, e2)
		}
	}
}

// TestBucketSelectsDistinctHead confirms a position's eval depends on ITS bucket
// only: zeroing one bucket's output weights changes eval for positions in that
// bucket and leaves others untouched.
func TestBucketSelectsDistinctHead(t *testing.T) {
	const hl, nb = 64, 8
	net := randomBucketNet(7, hl, nb)
	pos, _ := chess.ParseFEN(chess.StartFEN) // bucket 7
	b := net.outputBucket(pos)

	acc := net.newAccumulator()
	net.build(&acc, pos)
	before := net.evalFrom(&acc, pos.SideToMove(), b)

	// Perturb a DIFFERENT bucket's weights — eval for pos must not change.
	other := (b + 1) % nb
	net.W1i[other*2*hl] += 1000
	if after := net.evalFrom(&acc, pos.SideToMove(), b); after != before {
		t.Fatalf("eval changed (%d -> %d) when perturbing a different bucket %d (pos in %d)", before, after, other, b)
	}
	// Perturb the position's OWN bucket — eval must change.
	net.W1i[b*2*hl] += 1000
	if after := net.evalFrom(&acc, pos.SideToMove(), b); after == before {
		t.Fatalf("eval unchanged when perturbing the position's own bucket %d", b)
	}
}
