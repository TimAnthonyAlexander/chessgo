package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"runtime"
	"strings"
	"time"

	"github.com/timanthonyalexander/gomachine/internal/bench"
	"github.com/timanthonyalexander/gomachine/internal/search"
)

// cmdBenchSPSA tunes the engine's promoted integer search margins by SPSA self-play.
// It reuses the bench game harness (reversed-color pairs); each iteration perturbs
// every param at once, plays a batch of θ⁺ vs θ⁻, and nudges θ toward the stronger
// side. θ is checkpointed every iteration so a long run is resumable/inspectable.
//
// Objective time control: --nodes (fixed nodes, fast & reproducible — the default)
// or --movetime. Fixed-nodes is fine as a FAST objective for tuning the MAGNITUDE of
// already-on margins, but the converged params should be FINAL-VALIDATED at movetime
// via `bench sprt` before flipping the defaults (fixed-nodes misleads for on/off
// prune decisions; see docs/ENGINE_STRENGTH.md §14.4).
func cmdBenchSPSA(args []string) {
	fs := flag.NewFlagSet("bench spsa", flag.ExitOnError)
	paramsSpec := fs.String("params", "", "tuning set: name:min:max[:initial[:cend]] comma-separated; empty → default set (singularmargin:1:6, seequietmargin:50:300, captseemargin:10:120, nullmover:1:4)")
	baseSpec := fs.String("base", "", "base param spec the tuned fields are written into (rest held fixed); default: full-strength")
	nodes := fs.Uint64("nodes", 25000, "fixed nodes per move (0 → use --movetime); the fast objective")
	movetime := fs.Int("movetime", 0, "ms per move (only if --nodes 0); slower but the honest final-validation TC")
	iters := fs.Int("iterations", 200, "number of SPSA iterations")
	pairs := fs.Int("pairs", 16, "game pairs played per iteration (batch size)")
	a := fs.Float64("a", 10.0, "SPSA learning-rate numerator (a); bigger = faster but noisier steps")
	c := fs.Float64("c", 2.0, "SPSA perturbation multiplier (c); per-param perturbation = max(c/k^gamma, 1)·cend")
	bigA := fs.Float64("bigA", 0, "SPSA stability constant A (0 → 0.1·iterations)")
	alpha := fs.Float64("alpha", 0.602, "learning-rate decay exponent")
	gamma := fs.Float64("gamma", 0.101, "perturbation decay exponent")
	tt := fs.Int("tt", 16, "transposition table size per engine (MB)")
	conc := fs.Int("concurrency", runtime.NumCPU(), "parallel game-pair workers per batch")
	seed := fs.Int64("seed", 1, "RNG seed (Rademacher draws + per-batch book shuffles); reproducible")
	bookPath := fs.String("book", "", "opening book (.epd/.fen or UCI move-lines); default: embedded")
	engBookPath := fs.String("engine-book", "data/book.bin", "precomputed engine opening book consulted when a side has book=on (\"\" disables)")
	tbPath := fs.String("tb-path", "", "Syzygy tablebase directory, probed when a side has tb=on (\"\" disables)")
	checkpoint := fs.String("checkpoint", "", "θ checkpoint log path (empty → spsa_<timestamp>.log in cwd)")
	_ = fs.Parse(args)

	base, err := bench.ParseParams(search.DefaultParams(), *baseSpec)
	if err != nil {
		fmt.Fprintln(os.Stderr, "bad --base spec:", err)
		os.Exit(1)
	}
	params, err := bench.ParseSPSASpec(*paramsSpec, base)
	if err != nil {
		fmt.Fprintln(os.Stderr, "bad --params:", err)
		os.Exit(1)
	}
	book, err := bench.LoadBook(*bookPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "book:", err)
		os.Exit(1)
	}
	cpPath := *checkpoint
	if cpPath == "" {
		cpPath = fmt.Sprintf("spsa_%s.log", time.Now().Format("20060102_150405"))
	}

	cfg := bench.SPSAConfig{
		Params:       params,
		Base:         base,
		Nodes:        *nodes,
		MoveTime:     time.Duration(*movetime) * time.Millisecond,
		TTMB:         *tt,
		Concurrency:  *conc,
		PairsPerIter: *pairs,
		Iterations:   *iters,
		A:            *a,
		C:            *c,
		ABig:         *bigA,
		Alpha:        *alpha,
		Gamma:        *gamma,
		Seed:         *seed,
		Book:         book,
		EngineBook:   loadEngineBook(*engBookPath),
		Tablebase:    loadTablebase(*tbPath),
		Checkpoint:   cpPath,
	}

	budget := fmt.Sprintf("%d nodes/move", *nodes)
	if *nodes == 0 {
		budget = fmt.Sprintf("%dms/move", *movetime)
	}
	fmt.Printf("\n♟  SPSA tune — %d iterations × %d pairs/iter (%s, %d-way, seed %d)\n",
		*iters, *pairs, budget, *conc, *seed)
	fmt.Printf("   a=%g c=%g A=%g alpha=%g gamma=%g   checkpoint=%s\n", *a, *c, cfg.ABig, *alpha, *gamma, cpPath)
	fmt.Printf("   tuning %d param(s):\n", len(params))
	for _, p := range params {
		fmt.Printf("     %-18s [%d..%d]  init=%d  cend=%g\n", p.Name, p.Min, p.Max, p.Initial, p.CEnd)
	}
	fmt.Println()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	res := bench.RunSPSA(ctx, cfg, func(it bench.SPSAIter) {
		fmt.Printf("  k=%4d  score=%.3f  ak=%.4f ck=%.3f  θ=%s  [%s]\n",
			it.K, it.BatchScore, it.AK, it.CK,
			thetaStr(params, it.ThetaInt), it.Elapsed.Round(time.Second))
	})

	printSPSAResult(res)
}

func thetaStr(params []bench.SPSAParam, theta []int) string {
	var b strings.Builder
	for i, p := range params {
		if i > 0 {
			b.WriteString(" ")
		}
		fmt.Fprintf(&b, "%s=%d", p.Name, theta[i])
	}
	return b.String()
}

func printSPSAResult(res bench.SPSAResult) {
	fmt.Printf("\n══ SPSA converged after %d iterations ══\n\n", res.Iters)
	fmt.Println("converged integer params:")
	for i, p := range res.Params {
		fmt.Printf("  %-18s = %d   (range [%d..%d], started %d)\n", p.Name, res.ThetaInt[i], p.Min, p.Max, p.Initial)
	}

	diff := bench.DiffParams(search.DefaultParams(), res.Final)
	fmt.Printf("\ndiff vs current DefaultParams(): %s\n", diff)
	if diff == "(identical — sanity/noise run)" {
		fmt.Println("(no field changed from its current default — nothing to paste)")
		return
	}
	fmt.Println("\nready-to-paste DefaultParams() field values:")
	def := search.DefaultParams()
	for i, p := range res.Params {
		cur := spsaCurrentValue(def, p.Name)
		if cur == res.ThetaInt[i] {
			continue
		}
		fmt.Printf("  %s: %d → %d\n", spsaGoFieldName(p.Name), cur, res.ThetaInt[i])
	}
	fmt.Println("\nNEXT: SPRT-validate at movetime before flipping the default, e.g.")
	fmt.Printf("  gomachine bench sprt --new \"%s\" --old \"\" --movetime 100 --elo0 0 --elo1 5\n",
		spsaSprtSpec(def, res))
}

// spsaCurrentValue / spsaGoFieldName mirror the small set of tunable fields so the
// final report can show a clean Go-field diff without reflection.
func spsaCurrentValue(p search.Params, name string) int {
	switch name {
	case "singularmargin":
		return p.SingularMargin
	case "singularmindepth":
		return p.SingularMinDepth
	case "seequietmargin":
		return p.SEEQuietMargin
	case "seequietmaxdepth":
		return p.SEEQuietMaxDepth
	case "captseemargin":
		return p.CaptSEEMargin
	case "captseemaxdepth":
		return p.CaptSEEMaxDepth
	case "nullmover":
		return p.NullMoveR
	case "doubleextmargin":
		return p.DoubleExtMargin
	}
	return 0
}

func spsaGoFieldName(name string) string {
	switch name {
	case "singularmargin":
		return "SingularMargin"
	case "singularmindepth":
		return "SingularMinDepth"
	case "seequietmargin":
		return "SEEQuietMargin"
	case "seequietmaxdepth":
		return "SEEQuietMaxDepth"
	case "captseemargin":
		return "CaptSEEMargin"
	case "captseemaxdepth":
		return "CaptSEEMaxDepth"
	case "nullmover":
		return "NullMoveR"
	case "doubleextmargin":
		return "DoubleExtMargin"
	}
	return name
}

// spsaSprtSpec builds the bench-sprt --new spec string (the bench.ParseParams short
// keys) for only the fields that changed, so the suggested validation command is
// copy-pasteable.
func spsaSprtSpec(def search.Params, res bench.SPSAResult) string {
	var toks []string
	for i, p := range res.Params {
		if spsaCurrentValue(def, p.Name) == res.ThetaInt[i] {
			continue
		}
		toks = append(toks, fmt.Sprintf("%s=%d", spsaSprtKey(p.Name), res.ThetaInt[i]))
	}
	return strings.Join(toks, ",")
}

// spsaSprtKey maps a tunable field to the key bench.ParseParams understands.
func spsaSprtKey(name string) string {
	switch name {
	case "singularmargin":
		return "singularmargin"
	case "singularmindepth":
		return "singulardepth"
	case "seequietmargin":
		return "seequietmargin"
	case "seequietmaxdepth":
		return "seequietmaxdepth"
	case "captseemargin":
		return "captseemargin"
	case "captseemaxdepth":
		return "captseemaxdepth"
	case "nullmover":
		return "nullr"
	case "doubleextmargin":
		return "doubleextmargin"
	}
	return name
}
