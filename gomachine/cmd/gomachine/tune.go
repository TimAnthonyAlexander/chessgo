package main

import (
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/timanthonyalexander/gomachine/internal/bench"
	"github.com/timanthonyalexander/gomachine/internal/eval"
	"github.com/timanthonyalexander/gomachine/internal/tune"
)

// cmdTune fits the full eval (PSQT/material + knowledge terms, jointly) by Texel
// tuning: quiet self-play positions, WDL labels, Adam gradient descent. Emits
// paste-ready Go literals. The result MUST be SPRT-gated before shipping.
func cmdTune(args []string) {
	fs := flag.NewFlagSet("tune", flag.ExitOnError)
	games := fs.Int("games", 5000, "self-play games to generate positions from (~64 quiet positions each)")
	nodes := fs.Int("nodes", 5000, "nodes per move during self-play generation")
	epochs := fs.Int("epochs", 400, "Adam epochs")
	lr := fs.Float64("lr", 1.0, "Adam learning rate (cp/epoch)")
	decay := fs.Float64("decay", 0.01, "weight-decay toward PeSTO start (regularisation)")
	lambda := fs.Float64("lambda", 1.0, "WDL+eval blend: 1=pure result, <1 mixes in our search eval")
	valFrac := fs.Float64("val", 0.1, "fraction of positions held out for validation")
	seed := fs.Int64("seed", 1, "RNG seed for generation")
	epd := fs.String("epd", "", "load a quiet-labelled EPD dataset instead of self-play")
	out := fs.String("out", "", "write tuned tables to this Go file (e.g. internal/eval/tuned_tables.go)")
	_ = fs.Parse(args)

	var samples []tune.Sample
	t0 := time.Now()
	if *epd != "" {
		fmt.Printf("Loading positions from %s…\n", *epd)
		var err error
		if samples, err = tune.LoadEPD(*epd); err != nil {
			fmt.Fprintln(os.Stderr, "epd:", err)
			os.Exit(1)
		}
		fmt.Printf("  %d positions in %s\n", len(samples), time.Since(t0).Round(time.Second))
	} else {
		book, err := bench.EmbeddedBook()
		if err != nil {
			fmt.Fprintln(os.Stderr, "book:", err)
			os.Exit(1)
		}
		fmt.Printf("Generating quiet positions from %d self-play games (%d nodes/move)…\n", *games, *nodes)
		samples = tune.GenerateSelfPlay(book, *games, *nodes, *seed)
		fmt.Printf("  %d quiet positions in %s\n", len(samples), time.Since(t0).Round(time.Second))
	}
	if len(samples) < 5000 {
		fmt.Fprintln(os.Stderr, "too few positions; raise --games or check the EPD file")
		os.Exit(1)
	}

	// Deterministic train/val split (samples are already in game order; the holdout
	// is the tail, so val games don't overlap train games' positions).
	nVal := int(float64(len(samples)) * *valFrac)
	train, val := samples[:len(samples)-nVal], samples[len(samples)-nVal:]

	soft := 0
	for _, s := range samples {
		if s.HasSoft {
			soft++
		}
	}
	θ0 := eval.DefaultParams()
	k := tune.FitK(train, θ0)
	startTrain := tune.MSE(train, θ0, k, *lambda)
	startVal := tune.MSE(val, θ0, k, *lambda)
	fmt.Printf("Fitted K=%.3f.  %d/%d positions have a soft eval (lambda=%.2f).\n",
		k, soft, len(samples), *lambda)
	if soft == 0 && *lambda < 1 {
		fmt.Println("note: no soft evals in this dataset → blend inactive, tuning pure-WDL.")
	}
	fmt.Printf("start MSE: train %.6f  val %.6f.  Tuning %d params over %d epochs…\n",
		startTrain, startVal, len(θ0), *epochs)

	opt := tune.DefaultOptions()
	opt.Epochs, opt.LR, opt.Decay, opt.Lambda = *epochs, *lr, *decay, *lambda
	t1 := time.Now()
	θ, finalTrain := tune.Optimize(train, θ0, k, opt, func(s string) { fmt.Println("  " + s) })
	finalVal := tune.MSE(val, θ, k, *lambda)
	fmt.Printf("\nDone in %s.  train MSE %.6f → %.6f   val MSE %.6f → %.6f\n",
		time.Since(t1).Round(time.Second), startTrain, finalTrain, startVal, finalVal)
	if finalVal > startVal {
		fmt.Println("WARNING: validation MSE rose — likely overfit; raise --decay/--games or lower --epochs.")
	}

	// Material-drift diagnostic: piece values float during tuning (anchored only
	// by frozen K + decay), so surface how far each drifted from PeSTO.
	before, after := tune.PieceMeans(θ0), tune.PieceMeans(θ)
	names := [6]string{"P", "N", "B", "R", "Q", "K"}
	fmt.Print("piece-value drift (mean PSQT cp, mg/eg):")
	for pt := 0; pt < 6; pt++ {
		fmt.Printf("  %s %+.0f/%+.0f", names[pt], after[pt][0]-before[pt][0], after[pt][1]-before[pt][1])
	}
	fmt.Println()

	if *out != "" {
		if err := os.WriteFile(*out, []byte(tune.EmitGoFile(θ)), 0o644); err != nil {
			fmt.Fprintln(os.Stderr, "write:", err)
			os.Exit(1)
		}
		fmt.Printf("\nWrote tuned tables to %s.\n", *out)
		fmt.Println("Next: go build ./... && gomachine bench sprt --new \"tuned=on\" --old \"\" --movetime 100 --elo0 0 --elo1 6")
		return
	}
	fmt.Println("\nTuned eval (SPRT-gate before shipping — lower MSE ≠ more Elo):")
	fmt.Println(tune.EmitGo(θ))
}
