package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"math/rand/v2"
	"net/http"
	"os"
	"sync"
	"sync/atomic"
	"time"
)

// cmdEngineLoad drives concurrent /bestmove requests at a running engine
// (`gomachine serve`) to measure its search-throughput wall: the engine answers
// from a bounded pool of `-workers` engines (default 4), so once in-flight
// requests exceed the pool the extra ones block on `acquire` and show up as
// latency, not lost work. This is the path bot moves and /analyze hammer, and the
// one a PHP engine would replace — so it's the real "AI concurrency" limit.
//
// Requests cycle a small set of positions across game phases so the pool's warm
// transposition tables don't unrealistically short-circuit repeated searches.
func cmdEngineLoad(args []string) {
	fs := flag.NewFlagSet("engineload", flag.ExitOnError)
	url := fs.String("url", "http://127.0.0.1:6466", "engine base URL")
	concurrency := fs.Int("concurrency", 8, "number of concurrent in-flight requests")
	movetime := fs.Int("movetime", 100, "per-search time budget (ms); 0 to use -depth/-level")
	depth := fs.Int("depth", 0, "fixed search depth (overrides movetime if >0)")
	level := fs.Int("level", -1, "difficulty level 0..10 (overrides movetime/depth if >=0)")
	duration := fs.Duration("duration", 15*time.Second, "how long to sustain load")
	_ = fs.Parse(args)

	if *concurrency < 1 {
		fmt.Fprintln(os.Stderr, "need at least 1 concurrent request")
		os.Exit(2)
	}

	// Build the per-request limits once (same for every request).
	limits := map[string]any{}
	switch {
	case *level >= 0:
		limits["level"] = *level
	case *depth > 0:
		limits["depth"] = *depth
	default:
		limits["movetime"] = *movetime
	}
	limitDesc := fmt.Sprintf("movetime=%dms", *movetime)
	if *depth > 0 {
		limitDesc = fmt.Sprintf("depth=%d", *depth)
	}
	if *level >= 0 {
		limitDesc = fmt.Sprintf("level=%d", *level)
	}

	ctx, cancel := context.WithTimeout(context.Background(), *duration)
	defer cancel()

	m := &engineMetrics{}
	client := &http.Client{Timeout: 60 * time.Second}

	fmt.Printf("engineload: %d concurrent /bestmove (%s) at %s for %v\n",
		*concurrency, limitDesc, *url, *duration)

	// Progress: requests/sec each second.
	go func() {
		t := time.NewTicker(1 * time.Second)
		defer t.Stop()
		var last int64
		startp := time.Now()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				req := m.reqs.Load()
				fmt.Printf("  t=%4ds  searches=%d (%d/s)  errs=%d\n",
					int(time.Since(startp).Seconds()), req, req-last, m.errs.Load())
				last = req
			}
		}
	}()

	var wg sync.WaitGroup
	start := time.Now()
	for w := 0; w < *concurrency; w++ {
		wg.Add(1)
		go func(seed int) {
			defer wg.Done()
			engineWorker(ctx, seed, *url, client, limits, m)
		}(w)
	}
	wg.Wait()
	m.report(time.Since(start), *concurrency)
}

// enginePositions span opening/middlegame/endgame so a worker's reused engine
// (with a warm TT) isn't repeatedly handed an identical position.
var enginePositions = []string{
	"rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
	"r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3",
	"r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1",
	"r2q1rk1/pp2bppp/2n1pn2/2pp4/3P1B2/2PBPN2/PP3PPP/RN1Q1RK1 w - - 0 9",
	"2rq1rk1/pp1bppbp/2np1np1/8/3NP3/2N1BP2/PPPQ2PP/2KR1B1R w - - 0 11",
	"8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1",
	"8/8/4k3/8/2p5/8/B6P/4K3 w - - 0 1",
	"6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1",
}

func engineWorker(ctx context.Context, seed int, baseURL string, client *http.Client, limits map[string]any, m *engineMetrics) {
	// Each worker keeps requests in flight back-to-back; the engine's pool, not the
	// client, is what bounds concurrent searches.
	i := seed
	for ctx.Err() == nil {
		fen := enginePositions[i%len(enginePositions)]
		i++
		body, _ := json.Marshal(map[string]any{"fen": fen, "limits": limits})
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+"/bestmove", bytes.NewReader(body))
		if err != nil {
			m.errs.Add(1)
			continue
		}
		req.Header.Set("Content-Type", "application/json")

		t0 := time.Now()
		resp, err := client.Do(req)
		if err != nil {
			if ctx.Err() == nil {
				m.errs.Add(1)
			}
			continue
		}
		var out struct {
			BestMove *string `json:"bestmove"`
			Nodes    uint64  `json:"nodes"`
			Depth    int     `json:"depth"`
			Error    string  `json:"error"`
		}
		dec := json.NewDecoder(resp.Body)
		decErr := dec.Decode(&out)
		resp.Body.Close()
		lat := time.Since(t0)

		if decErr != nil || resp.StatusCode >= 300 || out.Error != "" {
			m.errs.Add(1)
			if out.Error != "" {
				m.noteErr(out.Error)
			}
			continue
		}
		m.reqs.Add(1)
		m.nodes.Add(out.Nodes)
		m.lat.add(lat)
		// Vary the seed walk so workers don't lock-step on the same position.
		if rand.IntN(8) == 0 {
			i++
		}
	}
}

// --- metrics ---

type engineMetrics struct {
	reqs  atomic.Int64
	nodes atomic.Uint64
	errs  atomic.Int64
	lat   latHist

	errSample atomic.Pointer[string]
}

func (m *engineMetrics) noteErr(text string) {
	if m.errSample.Load() == nil {
		m.errSample.CompareAndSwap(nil, &text)
	}
}

func (m *engineMetrics) report(elapsed time.Duration, concurrency int) {
	secs := elapsed.Seconds()
	reqs := m.reqs.Load()
	nodes := m.nodes.Load()
	fmt.Println("\n=== engineload results ===")
	fmt.Printf("duration:        %v\n", elapsed.Round(time.Millisecond))
	fmt.Printf("concurrency:     %d in-flight requests\n", concurrency)
	fmt.Printf("searches:        %d\n", reqs)
	fmt.Printf("search rate:     %.1f searches/sec  (the engine pool's move-resolution rate)\n", float64(reqs)/secs)
	fmt.Printf("aggregate nps:   %.2f Mnps  (total nodes across all concurrent searches)\n", float64(nodes)/secs/1e6)
	fmt.Printf("errors:          %d", m.errs.Load())
	if s := m.errSample.Load(); s != nil {
		fmt.Printf("  (first: %q)", *s)
	}
	fmt.Println()
	m.lat.report("per-search latency (request → bestmove response)")
}
