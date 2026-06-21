package main

import (
	"bufio"
	"flag"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/timanthonyalexander/gomachine/internal/chess"
	"github.com/timanthonyalexander/gomachine/internal/eval"
	"github.com/timanthonyalexander/gomachine/internal/nnue"
	"github.com/timanthonyalexander/gomachine/internal/nnuetrain"
)

// defaultEPDs are the WDL datasets the trainer fits by default (~1.6M rows).
const defaultEPDs = "data/quiet-labeled.epd,data/augmented.epd,data/tb_eg.epd"

// cmdNNUETrain trains the (768→256)×2→1 perspective net (PLAN.md Phase 2) on the
// WDL EPD data and writes a Phase-1 net file. A finite-difference gradient check
// runs first (fail-fast): if it fails, we print and exit non-zero WITHOUT training.
func cmdNNUETrain(args []string) {
	def := nnuetrain.DefaultOptions()

	fs := flag.NewFlagSet("nnue-train", flag.ExitOnError)
	epd := fs.String("epd", defaultEPDs, "comma-separated WDL EPD files (used only when --flat is empty)")
	flat := fs.String("flat", "", "32-byte .flat training file (Stockfish-distilled; preferred over --epd)")
	limit := fs.Int("limit", 0, "cap positions loaded from --flat (0 = all; for fast smoke runs)")
	out := fs.String("out", "data/nnue/net.nnue", "output net file (Phase-1 format)")
	epochs := fs.Int("epochs", def.Epochs, "training epochs")
	batch := fs.Int("batch", def.Batch, "minibatch size")
	lr := fs.Float64("lr", def.LR, "Adam learning rate")
	gamma := fs.Float64("adam-gamma", def.Gamma, "per-epoch lr decay (lr *= gamma each epoch)")
	scaling := fs.Float64("scaling-factor", def.ScalingFactor, "cp 50%-win scaling factor (sigmoid(out/sf))")
	startLambda := fs.Float64("start-lambda", def.StartLambda, "λ at epoch 1 (eval-weight)")
	endLambda := fs.Float64("end-lambda", def.EndLambda, "λ at the final epoch")
	holdout := fs.Float64("holdout", def.Holdout, "fraction held out for validation")
	seed := fs.Int64("seed", def.Seed, "RNG seed (shuffle + weight init)")
	gradcheck := fs.Bool("gradcheck", false, "run only the gradient check and exit")
	_ = fs.Parse(args)

	// THE GATE: always run the gradient check first, fail-fast on a bad gradient.
	if !runGradCheck() {
		os.Exit(1)
	}
	if *gradcheck {
		return
	}

	opt := nnuetrain.DefaultOptions()
	opt.Epochs, opt.Batch, opt.LR, opt.Gamma = *epochs, *batch, *lr, *gamma
	opt.Holdout, opt.Seed = *holdout, *seed
	opt.ScalingFactor, opt.StartLambda, opt.EndLambda = *scaling, *startLambda, *endLambda

	// The .flat path uses the raw-record loader: it holds only the compact 32-byte
	// records in RAM (~4.8 GB for 150M positions) and decodes features per-batch,
	// instead of pre-extracting samples (~168 B/pos → OOM at scale). The EPD path
	// is small, so it keeps the in-RAM sample loader.
	var samplePath string
	var best *nnuetrain.Model
	if *flat != "" {
		fmt.Printf("Loading .flat from %s (limit %d, raw-record path)…\n", *flat, *limit)
		t0 := time.Now()
		d, n, err := nnuetrain.LoadFlatRaw(*flat, *limit)
		if err != nil {
			fmt.Fprintln(os.Stderr, "flat:", err)
			os.Exit(1)
		}
		samplePath = *flat
		fmt.Printf("  %d records (%.0f MB raw, %.2f GB est. @150M) in %s\n",
			n, float64(n)*32/(1<<20), 150e6*32/(1<<30), time.Since(t0).Round(time.Millisecond))
		if n < 100 {
			fmt.Fprintln(os.Stderr, "too few records; check --flat")
			os.Exit(1)
		}
		fmt.Printf("Training %d epochs, batch %d, lr %g, gamma %g, sf %g, λ %g→%g, holdout %.2f, seed %d…\n",
			opt.Epochs, opt.Batch, opt.LR, opt.Gamma, opt.ScalingFactor,
			opt.StartLambda, opt.EndLambda, opt.Holdout, opt.Seed)
		t1 := time.Now()
		best = nnuetrain.TrainRaw(d, opt, func(s string) { fmt.Println("  " + s) })
		fmt.Printf("Trained in %s.\n", time.Since(t1).Round(time.Second))
	} else {
		paths := strings.Split(*epd, ",")
		fmt.Printf("Loading EPD from %s…\n", *epd)
		t0 := time.Now()
		samples, lines, skipped, err := nnuetrain.LoadEPD(paths)
		if err != nil {
			fmt.Fprintln(os.Stderr, "epd:", err)
			os.Exit(1)
		}
		samplePath = paths[0]
		fmt.Printf("  %d samples (%d lines, %d skipped) in %s\n",
			len(samples), lines, skipped, time.Since(t0).Round(time.Millisecond))
		if len(samples) < 100 {
			fmt.Fprintln(os.Stderr, "too few samples; check --epd")
			os.Exit(1)
		}
		fmt.Printf("Training %d epochs, batch %d, lr %g, gamma %g, sf %g, λ %g→%g, holdout %.2f, seed %d…\n",
			opt.Epochs, opt.Batch, opt.LR, opt.Gamma, opt.ScalingFactor,
			opt.StartLambda, opt.EndLambda, opt.Holdout, opt.Seed)
		t1 := time.Now()
		best = nnuetrain.Train(samples, opt, func(s string) { fmt.Println("  " + s) })
		fmt.Printf("Trained in %s.\n", time.Since(t1).Round(time.Second))
	}

	if err := os.MkdirAll(filepath.Dir(*out), 0o755); err != nil {
		fmt.Fprintln(os.Stderr, "mkdir:", err)
		os.Exit(1)
	}
	if err := best.ToNet().Save(*out); err != nil {
		fmt.Fprintln(os.Stderr, "save:", err)
		os.Exit(1)
	}
	fmt.Printf("Wrote net to %s.\n", *out)

	sanityReport(*out, samplePath)
}

// gradCheckFENs is the fixed labelled batch the gate runs on (built from FENs, so
// it never needs the EPD data files).
var gradCheckFENs = []nnuetrain.FENSample{
	{FEN: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", Result: 0.5, Score: 20},
	{FEN: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1", Result: 1.0, Score: 150},
	{FEN: "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 0 1", Result: 0.0, Score: -80},
	{FEN: "8/5k2/8/4P1P1/1p6/7K/8/8 b - - 0 1", Result: 0.0, Score: -300},
	{FEN: "rnb1kbnr/pppppppp/8/8/8/8/PPPPPPPP/RNB1KBNR w KQkq - 0 1", Result: 1.0, Score: 900},
	{FEN: "8/8/1p1k4/1P6/8/3p3P/1r4P1/5K2 w - - 0 1", Result: 0.0, Score: -450},
	{FEN: "r1q1kb1r/6pp/b1p1pn2/2P1Np2/QP6/4P3/P2N2PP/R1BR2K1 b kq - 0 1", Result: 0.5, Score: 30},
	{FEN: "8/1P6/3p4/5P2/8/8/K5k1/8 b - - 0 1", Result: 1.0, Score: 500},
}

// runGradCheck runs the finite-difference gradient check on the fixed batch and
// returns true on PASS (< 1e-6 worst relative error).
func runGradCheck() bool {
	worst, details, err := nnuetrain.GradCheckFENs(gradCheckFENs, 12345, 16, 1e-4)
	if err != nil {
		fmt.Fprintln(os.Stderr, "gradcheck:", err)
		return false
	}
	fmt.Println("Gradient check (analytic vs central difference, float64):")
	for _, d := range details {
		fmt.Println("  " + d)
	}
	fmt.Printf("  worst relative error: %.3e\n", worst)
	if worst >= 1e-6 {
		fmt.Fprintf(os.Stderr, "GRADIENT CHECK FAILED: worst rel err %.3e >= 1e-6 — refusing to train.\n", worst)
		return false
	}
	fmt.Println("  PASS (< 1e-6)")
	return true
}

// sanityReport loads the saved net and prints reference evals plus an HCE
// correlation line over a small sample read from the first EPD file.
func sanityReport(path, samplePath string) {
	net, err := nnue.LoadNet(path)
	if err != nil {
		fmt.Fprintln(os.Stderr, "sanity load:", err)
		return
	}
	fmt.Println("\nSanity report (loaded net, cp from side-to-move):")
	checks := []struct{ name, fen string }{
		{"start position   ", "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"},
		{"after 1.e4       ", "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1"},
		{"white up a queen ", "rnb1kbnr/pppppppp/8/8/8/8/PPPPPPPP/RNB1KBNR w KQkq - 0 1"},
	}
	for _, c := range checks {
		pos, err := chess.ParseFEN(c.fen)
		if err != nil {
			continue
		}
		fmt.Printf("  %s nnue %+6d cp\n", c.name, net.Eval(pos))
	}
	hceCorrelation(net, samplePath, 2000)
}

// hceCorrelation prints the Pearson correlation between the net's eval and the
// hand-crafted eval over up to n positions read from path (a rough smell test —
// a fresh net should still trend positive). Best-effort; silent on read errors.
func hceCorrelation(net *nnue.Net, path string, n int) {
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()

	cfg := eval.Config{Mobility: true, Pawns: true, KingSafety: true, BishopPair: true, KingProx: true, W: eval.DefaultWeights()}
	var xs, ys []float64
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 1<<20)
	for sc.Scan() && len(xs) < n {
		fields := strings.Fields(strings.TrimSpace(sc.Text()))
		if len(fields) < 4 {
			continue
		}
		fen := strings.Join(fields[:4], " ")
		pos, err := chess.ParseFEN(fen)
		if err != nil {
			continue
		}
		xs = append(xs, float64(net.Eval(pos)))
		ys = append(ys, float64(eval.Evaluate(pos, cfg)))
	}
	if len(xs) < 2 {
		return
	}
	fmt.Printf("  HCE correlation over %d positions: r = %.3f\n", len(xs), pearson(xs, ys))
}

func pearson(x, y []float64) float64 {
	n := float64(len(x))
	var mx, my float64
	for i := range x {
		mx += x[i]
		my += y[i]
	}
	mx /= n
	my /= n
	var sxy, sxx, syy float64
	for i := range x {
		dx, dy := x[i]-mx, y[i]-my
		sxy += dx * dy
		sxx += dx * dx
		syy += dy * dy
	}
	if sxx == 0 || syy == 0 {
		return 0
	}
	return sxy / math.Sqrt(sxx*syy)
}
