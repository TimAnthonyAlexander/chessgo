package nnue

import (
	"testing"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

const startFEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"

// TestMultiNetEvalDeterministicAndSane is the Phase-1 self-consistency gate: the
// from-scratch multilayer float forward must be deterministic and in a sane cp
// range across positions of different shape. (Bit-exact-vs-bullet comes later,
// when a real net exists; this needs no training.)
func TestMultiNetEvalDeterministicAndSane(t *testing.T) {
	n := RandomMultiNet(42, 256, 16, 32, 8)
	fens := []string{
		startFEN,
		"r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3",
		"8/8/8/4k3/8/4K3/4P3/8 w - - 0 1", // K+P endgame (low piece count → high bucket)
	}
	for _, fen := range fens {
		pos, err := chess.ParseFEN(fen)
		if err != nil {
			t.Fatalf("parse %q: %v", fen, err)
		}
		a := n.Eval(pos)
		b := n.Eval(pos)
		if a != b {
			t.Fatalf("non-deterministic eval for %q: %d vs %d", fen, a, b)
		}
		if a < -30000 || a > 30000 {
			t.Fatalf("insane eval for %q: %d", fen, a)
		}
	}
}

// TestMultiNetBucketsExercised confirms the per-bucket tail weights are actually
// selected by piece count and that Eval runs across the range without panicking.
func TestMultiNetBucketsExercised(t *testing.T) {
	n := RandomMultiNet(7, 128, 16, 32, 8)
	full, err := chess.ParseFEN(startFEN) // 32 pieces → high bucket
	if err != nil {
		t.Fatal(err)
	}
	bare, err := chess.ParseFEN("8/8/4k3/8/8/4K3/8/8 w - - 0 1") // 2 pieces → bucket 0
	if err != nil {
		t.Fatal(err)
	}
	if materialBucket(full, n.NB) == materialBucket(bare, n.NB) {
		t.Fatalf("expected different buckets for 32-piece vs 2-piece positions")
	}
	// Both must evaluate without panic.
	_ = n.Eval(full)
	_ = n.Eval(bare)
}

// TestMultiNetZeroNet: an all-zero net (zero weights, zero CpScale) evaluates to
// exactly 0 everywhere — a trivial but useful structural sanity check.
func TestMultiNetZeroNet(t *testing.T) {
	n := NewMultiNet(64, 16, 32, 4) // CpScale defaults to 1, weights all 0
	pos, err := chess.ParseFEN(startFEN)
	if err != nil {
		t.Fatal(err)
	}
	if got := n.Eval(pos); got != 0 {
		t.Fatalf("zero net eval = %d, want 0", got)
	}
}
