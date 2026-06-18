package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"runtime"
	"time"

	"github.com/timanthonyalexander/gomachine/internal/bench"
	"github.com/timanthonyalexander/gomachine/internal/search"
)

// cmdBench dispatches `gomachine bench <subcommand>`.
func cmdBench(args []string) {
	if len(args) == 0 {
		benchUsage()
		os.Exit(2)
	}
	switch args[0] {
	case "sprt":
		cmdBenchSPRT(args[1:])
	case "vs-stockfish", "stockfish", "sf":
		cmdBenchStockfish(args[1:])
	case "-h", "--help", "help":
		benchUsage()
	default:
		fmt.Fprintf(os.Stderr, "unknown bench subcommand %q\n\n", args[0])
		benchUsage()
		os.Exit(2)
	}
}

func benchUsage() {
	fmt.Fprint(os.Stderr, `gomachine bench — engine strength feedback loop (in-process self-play SPRT)

Usage:
  gomachine bench sprt          [flags]   self-play: does --new beat --old?
  gomachine bench vs-stockfish  [flags]   absolute Elo anchor vs Stockfish

A patch is a search.Params diff. --old is the baseline config, --new is the
patch; both are built from the same binary and play game pairs (reversed colors,
shared opening) until the SPRT accepts H1 (improvement) or H0 (no improvement).

Param spec (comma-separated key=value), applied on top of the full-strength
default:
  tt=on|off  nullmove=on|off  nullr=<int>  lmr=on|off  checkext=on|off
  see=on|off  delta=on|off

Examples:
  # Validate the harness: a feature we KNOW helps should read as +Elo.
  gomachine bench sprt --new "" --old "lmr=off" --elo0 0 --elo1 10

  # Gate a future patch (once implemented behind a Params flag):
  gomachine bench sprt --new "see=on" --old "see=off" --elo0 0 --elo1 5
`)
}

func cmdBenchSPRT(args []string) {
	fs := flag.NewFlagSet("bench sprt", flag.ExitOnError)
	newSpec := fs.String("new", "", "patch param spec (e.g. \"lmr=off\")")
	oldSpec := fs.String("old", "", "baseline param spec (default: full-strength)")
	nodes := fs.Uint64("nodes", 25000, "fixed nodes per move (0 → use --movetime)")
	movetime := fs.Int("movetime", 0, "ms per move (only if --nodes 0)")
	tt := fs.Int("tt", 16, "transposition table size per engine (MB)")
	elo0 := fs.Float64("elo0", 0, "SPRT H0 bound (Elo)")
	elo1 := fs.Float64("elo1", 5, "SPRT H1 bound (Elo)")
	alpha := fs.Float64("alpha", 0.05, "false-accept-H1 rate")
	beta := fs.Float64("beta", 0.05, "false-accept-H0 rate")
	conc := fs.Int("concurrency", runtime.NumCPU(), "parallel game-pair workers")
	maxPairs := fs.Int("maxpairs", 40000, "hard cap on game pairs")
	bookPath := fs.String("book", "", "opening book (.epd/.fen or UCI move-lines); default: embedded")
	_ = fs.Parse(args)

	base := search.DefaultParams()
	newParams, err := bench.ParseParams(base, *newSpec)
	if err != nil {
		fmt.Fprintln(os.Stderr, "bad --new spec:", err)
		os.Exit(1)
	}
	oldParams, err := bench.ParseParams(base, *oldSpec)
	if err != nil {
		fmt.Fprintln(os.Stderr, "bad --old spec:", err)
		os.Exit(1)
	}

	book, err := bench.LoadBook(*bookPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "book:", err)
		os.Exit(1)
	}

	cfg := bench.Config{
		NewParams:   newParams,
		OldParams:   oldParams,
		NewName:     nameFor(*newSpec, "new"),
		OldName:     nameFor(*oldSpec, "old"),
		Nodes:       *nodes,
		MoveTime:    time.Duration(*movetime) * time.Millisecond,
		TTMB:        *tt,
		Elo0:        *elo0,
		Elo1:        *elo1,
		Alpha:       *alpha,
		Beta:        *beta,
		Concurrency: *conc,
		MaxPairs:    *maxPairs,
		Book:        book,
	}

	reporter := bench.NewReporter(cfg)
	reporter.Header()

	// Ctrl-C ends the run gracefully and prints the result so far.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	summary := bench.RunSPRT(ctx, cfg, func(p bench.Progress) {
		reporter.Update(p, false)
	})
	reporter.Final(summary)
}

func cmdBenchStockfish(args []string) {
	fs := flag.NewFlagSet("bench vs-stockfish", flag.ExitOnError)
	ourSpec := fs.String("new", "", "our engine's param spec (default: full strength)")
	sfPath := fs.String("sf", "stockfish", "path to the stockfish binary")
	sfElo := fs.Int("sf-elo", 1500, "Stockfish UCI_Elo (1320..3190); the anchor for our estimate")
	sfSkill := fs.Int("sf-skill", -1, "Stockfish Skill Level 0..20 (overrides --sf-elo if ≥0)")
	sfMovetime := fs.Int("sf-movetime", 100, "Stockfish ms per move")
	ourNodes := fs.Uint64("nodes", 0, "our fixed nodes per move (0 → use --movetime)")
	ourMovetime := fs.Int("movetime", 100, "our ms per move (if --nodes 0)")
	tt := fs.Int("tt", 16, "our transposition table size (MB)")
	games := fs.Int("games", 60, "number of games (rounded to color-swapped pairs)")
	conc := fs.Int("concurrency", 4, "parallel games (each spawns its own Stockfish)")
	bookPath := fs.String("book", "", "opening book (.epd/.fen or UCI move-lines); default: embedded")
	_ = fs.Parse(args)

	ourParams, err := bench.ParseParams(search.DefaultParams(), *ourSpec)
	if err != nil {
		fmt.Fprintln(os.Stderr, "bad --new spec:", err)
		os.Exit(1)
	}
	book, err := bench.LoadBook(*bookPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "book:", err)
		os.Exit(1)
	}

	// Stockfish strength options + a description for the report.
	sfOpts := map[string]string{}
	sfDesc := ""
	anchorElo := *sfElo
	if *sfSkill >= 0 {
		sfOpts["Skill Level"] = fmt.Sprintf("%d", *sfSkill)
		sfDesc = fmt.Sprintf("Stockfish (Skill %d)", *sfSkill)
		// Skill Level has no clean Elo anchor; we still report head-to-head vs the
		// nominal --sf-elo, but label it as skill-based.
	} else {
		sfOpts["UCI_LimitStrength"] = "true"
		sfOpts["UCI_Elo"] = fmt.Sprintf("%d", *sfElo)
		sfDesc = fmt.Sprintf("Stockfish (UCI_Elo %d)", *sfElo)
	}

	ourDesc := "gomachine"
	if *ourSpec != "" {
		ourDesc = "gomachine [" + *ourSpec + "]"
	}
	budget := fmt.Sprintf("ours %s/move · SF %dms/move · %d games · %d-way",
		ourBudgetDesc(*ourNodes, *ourMovetime), *sfMovetime, *games, *conc)

	cfg := bench.GauntletConfig{
		OurParams:   ourParams,
		OurNodes:    *ourNodes,
		OurMoveTime: time.Duration(*ourMovetime) * time.Millisecond,
		TTMB:        *tt,
		SFPath:      *sfPath,
		SFOptions:   sfOpts,
		SFElo:       anchorElo,
		SFBudget:    bench.UCIBudget{MoveTime: time.Duration(*sfMovetime) * time.Millisecond},
		Games:       *games,
		Concurrency: *conc,
		Book:        book,
	}

	reporter := bench.NewGauntletReporter(anchorElo, sfDesc, ourDesc, budget)
	reporter.Header()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	summary, err := bench.RunGauntlet(ctx, cfg, func(p bench.GauntletProgress) {
		reporter.Update(p, false)
	})
	if err != nil && ctx.Err() == nil {
		fmt.Fprintln(os.Stderr, "\ngauntlet error:", err)
		os.Exit(1)
	}
	reporter.Final(summary)
}

func ourBudgetDesc(nodes uint64, movetimeMs int) string {
	if nodes > 0 {
		return fmt.Sprintf("%d nodes", nodes)
	}
	return fmt.Sprintf("%dms", movetimeMs)
}

// nameFor produces a short engine label from a spec string.
func nameFor(spec, fallback string) string {
	if spec == "" {
		if fallback == "old" {
			return "baseline"
		}
		return "patch"
	}
	return spec
}
