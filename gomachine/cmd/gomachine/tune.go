package main

import (
	"flag"
	"fmt"
	"os"
	"runtime"
	"time"

	"github.com/timanthonyalexander/gomachine/internal/bench"
	"github.com/timanthonyalexander/gomachine/internal/eval"
	"github.com/timanthonyalexander/gomachine/internal/tune"
)

// cmdTune Texel-tunes the evaluation's knowledge-term weights.
func cmdTune(args []string) {
	fs := flag.NewFlagSet("tune", flag.ExitOnError)
	games := fs.Int("games", 1500, "self-play games to generate positions from")
	nodes := fs.Int("nodes", 5000, "nodes per move during self-play generation")
	target := fs.String("target", "result", "tuning target: result | stockfish")
	sfPath := fs.String("sf", "stockfish", "stockfish binary (for --target stockfish)")
	sfDepth := fs.Int("sf-depth", 8, "stockfish search depth for labeling")
	workers := fs.Int("workers", runtime.NumCPU(), "parallel stockfish labelers")
	passes := fs.Int("passes", 30, "max coordinate-descent passes")
	seed := fs.Int64("seed", 1, "RNG seed for generation")
	_ = fs.Parse(args)

	distill := *target == "stockfish"
	if *target != "result" && *target != "stockfish" {
		fmt.Fprintln(os.Stderr, "--target must be 'result' or 'stockfish'")
		os.Exit(1)
	}

	book, err := bench.EmbeddedBook()
	if err != nil {
		fmt.Fprintln(os.Stderr, "book:", err)
		os.Exit(1)
	}

	fmt.Printf("Generating positions from %d self-play games (%d nodes/move)…\n", *games, *nodes)
	t0 := time.Now()
	samples := tune.GenerateSelfPlay(book, *games, *nodes, *seed)
	fmt.Printf("  %d positions in %s\n", len(samples), time.Since(t0).Round(time.Second))
	if len(samples) < 1000 {
		fmt.Fprintln(os.Stderr, "too few positions; raise --games")
		os.Exit(1)
	}

	if distill {
		fmt.Printf("Labeling with Stockfish (depth %d, %d workers)…\n", *sfDepth, *workers)
		t1 := time.Now()
		if err := tune.LabelStockfish(samples, *sfPath, *sfDepth, *workers); err != nil {
			fmt.Fprintln(os.Stderr, "stockfish labeling:", err)
			os.Exit(1)
		}
		fmt.Printf("  labeled in %s\n", time.Since(t1).Round(time.Second))
	}

	w := eval.DefaultWeights()
	k := tune.FitK(samples, w)
	startMSE := mseFor(samples, w, k, distill)
	fmt.Printf("Fitted K=%.3f, start MSE=%.6f. Optimizing %d weights (target=%s)…\n",
		k, startMSE, len(w.Tunables()), *target)

	t2 := time.Now()
	finalMSE := tune.Optimize(samples, w, k, distill, *passes, func(s string) { fmt.Println("  " + s) })
	fmt.Printf("\nDone in %s.  MSE %.6f → %.6f\n", time.Since(t2).Round(time.Second), startMSE, finalMSE)
	fmt.Println("\nTuned weights (paste into eval.DefaultWeights):")
	fmt.Println(tune.GoLiteral(w))
}

// mseFor is a thin wrapper so the CLI can report the starting MSE.
func mseFor(samples []tune.Sample, w *eval.Weights, k float64, distill bool) float64 {
	return tune.MSE(samples, w, k, distill)
}
