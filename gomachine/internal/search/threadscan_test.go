package search

// Throwaway multi-thread NPS scaling anchor (rough). Run explicitly:
//   go test ./internal/search/ -run ThreadScanNPS -v -timeout 300s
// Mirrors SearchParallel but sums AGGREGATE nodes across all Lazy-SMP workers
// (SearchParallel returns only the winning thread's Result.Nodes, which
// undercounts total throughput). Fixed wall budget per config so aggNPS is
// directly comparable across thread counts. Not a committed test — delete after.

import (
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/timanthonyalexander/gomachine/internal/chess"
	"github.com/timanthonyalexander/gomachine/internal/nnue"
)

func TestThreadScanNPS(t *testing.T) {
	n, err := nnue.ImportBulletLeanNet("../../data/nnue/lean.bin", 512, 8)
	if err != nil {
		t.Fatalf("load net: %v", err)
	}
	n.QuantizeFTInt8()
	n.SetMoveAware(true)
	nnue.SetEnriched(n)

	pos, err := chess.ParseFEN("r1bqk2r/pp2bppp/2n1pn2/2pp4/3P1B2/2PBPN2/PP3PPP/RN1QK2R w KQkq - 0 8")
	if err != nil {
		t.Fatal(err)
	}

	const budget = 3 * time.Second
	base := 0.0
	for _, threads := range []int{1, 2, 4, 6, 8, 12} {
		s := NewWithParams(256, DefaultParams())
		limits := Limits{MoveTime: budget}
		start := time.Now()
		var agg uint64
		if threads <= 1 {
			r := s.Search(pos, limits, nil)
			agg = r.Nodes
		} else {
			s.tt.NewSearchAge()
			results := make([]Result, threads)
			var wg sync.WaitGroup
			for i := 0; i < threads; i++ {
				wg.Add(1)
				worker := s
				if i > 0 {
					worker = newWithSharedTT(s.tt, s.params)
				}
				go func(i int, w *Searcher) {
					defer wg.Done()
					p := *pos
					results[i] = w.runID(&p, limits, nil)
				}(i, worker)
			}
			wg.Wait()
			for i := range results {
				agg += results[i].Nodes
			}
		}
		el := time.Since(start).Seconds()
		nps := float64(agg) / el
		if threads == 1 {
			base = nps
		}
		fmt.Printf("threads=%2d  aggNodes=%11d  elapsed=%5.2fs  aggNPS=%10.0f  scaling=%.2fx\n",
			threads, agg, el, nps, nps/base)
	}
}
