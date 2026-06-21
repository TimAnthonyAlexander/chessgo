package search

import (
	"testing"
	"time"

	"github.com/timanthonyalexander/gomachine/internal/chess"
	"github.com/timanthonyalexander/gomachine/internal/nnue"
)

// TestNNUEPerf reports search NPS three ways on a fixed position/depth:
//
//	(a) HCE                — params.Nnue=false
//	(b) NNUE from-scratch  — params.Nnue=true, forceScratch (old slow path)
//	(c) NNUE incremental   — params.Nnue=true (Phase A)
//
// inc vs scratch use the same net, so identical search trees → the NPS ratio is a
// clean speedup measure. Not a pass/fail gate — run with `-run TestNNUEPerf -v`.
// Skipped under -short. NOTE: absolute NPS depends on machine load; read ratios.
func TestNNUEPerf(t *testing.T) {
	if testing.Short() {
		t.Skip("perf measurement; skipped under -short")
	}
	prev := nnue.Default()
	// Prefer the real trained net (sane evals → realistic search shape); fall back
	// to a random net if it isn't on disk. Eval COST is identical either way.
	if net, err := nnue.LoadNet("../../data/nnue/net.nnue"); err == nil {
		nnue.SetNet(net)
		t.Log("perf: using real net data/nnue/net.nnue")
	} else {
		nnue.SetNet(nnue.RandomNet(20240601))
		t.Logf("perf: no real net (%v); using RandomNet", err)
	}
	defer nnue.SetNet(prev)

	const fen = "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1"
	const depth = 10

	run := func(useNNUE, scratch bool) (uint64, time.Duration) {
		nnue.SetForceScratch(scratch)
		defer nnue.SetForceScratch(false)
		params := DefaultParams()
		params.Nnue = useNNUE
		s := NewWithParams(64, params)
		pos, _ := chess.ParseFEN(fen)
		start := time.Now()
		res := s.Search(pos, Limits{Depth: depth}, nil)
		return res.Nodes, time.Since(start)
	}

	nps := func(n uint64, d time.Duration) float64 {
		return float64(n) / d.Seconds()
	}

	hceN, hceT := run(false, false)
	scrN, scrT := run(true, true)
	incN, incT := run(true, false)

	hceNPS := nps(hceN, hceT)
	scrNPS := nps(scrN, scrT)
	incNPS := nps(incN, incT)

	t.Logf("depth %d, fen=%q (LOADED machine — ratios, not absolutes)", depth, fen)
	t.Logf("(a) HCE            : %10.0f nps  (%d nodes / %v)", hceNPS, hceN, hceT.Round(time.Millisecond))
	t.Logf("(b) NNUE scratch   : %10.0f nps  (%d nodes / %v)", scrNPS, scrN, scrT.Round(time.Millisecond))
	t.Logf("(c) NNUE increment : %10.0f nps  (%d nodes / %v)", incNPS, incN, incT.Round(time.Millisecond))
	t.Logf("speedup  inc/scratch = %.2fx     |     inc nps / HCE nps = %.2fx (HCE is %.1fx faster)",
		incNPS/scrNPS, incNPS/hceNPS, hceNPS/incNPS)
}
