package main

import (
	"fmt"
	"math/bits"
	"sync/atomic"
	"time"
)

// latHist is a lock-free latency histogram: counts land in power-of-two
// microsecond buckets (bucket i holds samples whose µs value has bit-length i),
// so memory is bounded regardless of sample volume and any number of goroutines
// can record concurrently. Percentiles are reported as bucket upper bounds, i.e.
// approximate to within a factor of two — adequate for load-test sizing.
type latHist struct {
	count atomic.Int64
	sumUs atomic.Int64
	maxUs atomic.Int64
	bkts  [40]atomic.Int64
}

func (h *latHist) add(d time.Duration) {
	us := d.Microseconds()
	if us < 1 {
		us = 1
	}
	h.count.Add(1)
	h.sumUs.Add(us)
	for {
		cur := h.maxUs.Load()
		if us <= cur || h.maxUs.CompareAndSwap(cur, us) {
			break
		}
	}
	b := bits.Len64(uint64(us)) // 1µs→1, 2-3µs→2, 4-7µs→3, …
	if b >= len(h.bkts) {
		b = len(h.bkts) - 1
	}
	h.bkts[b].Add(1)
}

// percentileUs returns the upper bound (µs) of the bucket containing the pth
// percentile latency.
func (h *latHist) percentileUs(p float64) int64 {
	total := h.count.Load()
	if total == 0 {
		return 0
	}
	target := int64(p * float64(total))
	var cum int64
	for b := 0; b < len(h.bkts); b++ {
		cum += h.bkts[b].Load()
		if cum >= target {
			return int64(1) << b
		}
	}
	return h.maxUs.Load()
}

func (h *latHist) meanUs() float64 {
	n := h.count.Load()
	if n == 0 {
		return 0
	}
	return float64(h.sumUs.Load()) / float64(n)
}

// report prints the percentile block under the given label.
func (h *latHist) report(label string) {
	n := h.count.Load()
	if n == 0 {
		fmt.Printf("%s: no samples\n", label)
		return
	}
	fmt.Printf("%s:\n", label)
	fmt.Printf("  samples: %d\n", n)
	fmt.Printf("  mean:    %s\n", usStr(int64(h.meanUs())))
	fmt.Printf("  p50≤:    %s\n", usStr(h.percentileUs(0.50)))
	fmt.Printf("  p95≤:    %s\n", usStr(h.percentileUs(0.95)))
	fmt.Printf("  p99≤:    %s\n", usStr(h.percentileUs(0.99)))
	fmt.Printf("  max:     %s\n", usStr(h.maxUs.Load()))
	fmt.Println("  (percentiles are power-of-two bucket upper bounds — approximate)")
}

func usStr(us int64) string {
	if us < 1000 {
		return fmt.Sprintf("%dµs", us)
	}
	return fmt.Sprintf("%.2fms", float64(us)/1000)
}
