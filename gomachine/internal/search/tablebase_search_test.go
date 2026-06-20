//go:build cgo

package search

import (
	"testing"

	"github.com/timanthonyalexander/gomachine/internal/chess"
	"github.com/timanthonyalexander/gomachine/internal/syzygy"
)

// openTestTB loads the in-repo 5-man Syzygy set (next to data/book.bin). Tests
// skip when it's absent so a checkout without the gitignored tablebase still runs.
func openTestTB(t *testing.T) *syzygy.Tablebase {
	t.Helper()
	tb, err := syzygy.Open("../../data/syzygy")
	if err != nil {
		t.Skipf("no tablebase at ../../data/syzygy: %v", err)
	}
	return tb
}

func tbSearcher(tb *syzygy.Tablebase) *Searcher {
	p := DefaultParams()
	p.TBSearch = true
	s := NewWithParams(16, p)
	s.SetTablebase(tb)
	return s
}

// TestWDLInSearchCorrectness confirms the WDL probe overrides the heuristic eval
// with the exact game-theoretic verdict: a KQ-vs-K win returns a score in the TB
// band (above any eval, below a real mate), and a KB-vs-K draw returns ~0 even
// though the side is up a bishop. Without the probe, the draw would score ~+300.
func TestWDLInSearchCorrectness(t *testing.T) {
	tb := openTestTB(t)
	defer tb.Close()

	t.Run("KQvK is a TB win", func(t *testing.T) {
		pos, err := chess.ParseFEN("8/8/8/4k3/8/8/3QK3/8 w - - 0 1")
		if err != nil {
			t.Fatal(err)
		}
		// Shallow depth so the forced mate isn't found by search — the value must
		// then come from the WDL probe (TB band), not a mate score.
		r := tbSearcher(tb).Search(pos, Limits{Depth: 4}, nil)
		if r.Score < tbThreshold {
			t.Errorf("KQvK score = %d, want ≥ tbThreshold (%d) — WDL win not seen", r.Score, tbThreshold)
		}
		if r.Score >= mateThreshold {
			t.Errorf("KQvK score = %d reported as a mate; a TB win must rank below mates", r.Score)
		}
	})

	t.Run("KBvK is a TB draw", func(t *testing.T) {
		pos, err := chess.ParseFEN("2k5/8/2K5/8/8/8/8/5B2 w - - 0 1")
		if err != nil {
			t.Fatal(err)
		}
		r := tbSearcher(tb).Search(pos, Limits{Depth: 6}, nil)
		if r.Score != 0 {
			t.Errorf("KBvK (insufficient material, TB draw) score = %d, want 0 — probe didn't override the +bishop eval", r.Score)
		}
	})
}

// TestWDLInSearchGatedForWeakenedRanking is the safety gate: a leveled (weakened)
// bot ranks root moves via RootScores, which must NOT use the tablebase — else a
// 1200 bot would convert ≤MaxPieces endings perfectly and break levelForRating.
// Full-strength Search sees the TB win; RootScores (weakened) must stay in normal
// eval range on the same position.
func TestWDLInSearchGatedForWeakenedRanking(t *testing.T) {
	tb := openTestTB(t)
	defer tb.Close()

	pos, err := chess.ParseFEN("8/8/8/4k3/8/8/3QK3/8 w - - 0 1") // KQvK, TB win
	if err != nil {
		t.Fatal(err)
	}
	s := tbSearcher(tb)
	if full := s.Search(clone(pos), Limits{Depth: 4}, nil); full.Score < tbThreshold {
		t.Fatalf("full-strength Search should see the TB win, got %d", full.Score)
	}
	// Shallow depth so no forced mate is found either; any score ≥ tbThreshold here
	// could only come from a leaked TB probe.
	for _, rm := range s.RootScores(clone(pos), Limits{Depth: 2}, nil) {
		if rm.Score >= tbThreshold {
			t.Errorf("weakened RootScores leaked a TB/mate-band score %d for %s — gating failed", rm.Score, rm.Move)
		}
	}
}

// TestWDLInSearchParallelRace runs the WDL-probing search across multiple SMP
// workers on a tablebase position, so `go test -race` exercises concurrent
// ProbeWDL calls sharing one Fathom handle — the thread-safety claim that lets us
// probe lock-free at every internal node. It must not race or change the verdict.
func TestWDLInSearchParallelRace(t *testing.T) {
	tb := openTestTB(t)
	defer tb.Close()

	pos, err := chess.ParseFEN("8/8/8/4k3/8/8/3QK3/8 w - - 0 1")
	if err != nil {
		t.Fatal(err)
	}
	for _, threads := range []int{1, 4} {
		r := tbSearcher(tb).SearchParallel(clone(pos), Limits{Depth: 6}, nil, threads)
		if r.Score < tbThreshold && r.MateIn == 0 {
			t.Errorf("threads=%d: KQvK score = %d (mateIn %d), want a TB win or mate", threads, r.Score, r.MateIn)
		}
	}
}
