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
	"github.com/timanthonyalexander/gomachine/internal/book"
	"github.com/timanthonyalexander/gomachine/internal/chess"
	"github.com/timanthonyalexander/gomachine/internal/engine"
	"github.com/timanthonyalexander/gomachine/internal/search"
	"github.com/timanthonyalexander/gomachine/internal/syzygy"
)

// loadEngineBook loads the precomputed opening book for the bench engines. An
// empty path means "no book". A missing/corrupt/version-mismatched file is a
// warning, not a fatal error — the run continues book-less (so `book=on` is then
// inert). On success it prints the entry count so it's visible the book is live.
func loadEngineBook(path string) *book.Book {
	if path == "" {
		return nil
	}
	b, err := book.Load(path)
	if err != nil {
		fmt.Fprintf(os.Stderr, "engine book %q: %v (continuing without it)\n", path, err)
		return nil
	}
	if b == nil {
		fmt.Fprintf(os.Stderr, "engine book %q: ignored (format/version mismatch) — continuing without it\n", path)
		return nil
	}
	fmt.Fprintf(os.Stderr, "engine book: %d positions loaded from %s\n", b.Len(), path)
	return b
}

// loadTablebase opens a Syzygy tablebase directory for the bench engines. An
// empty path means "no tablebase". A failure to open (missing dir, no files, or a
// cgo-less build) is a warning, not fatal — the run continues tablebase-less (so
// `tb=on` is then inert). On success it prints the max piece count so it's visible
// the tablebase is live.
func loadTablebase(path string) *syzygy.Tablebase {
	if path == "" {
		return nil
	}
	tb, err := syzygy.Open(path)
	if err != nil {
		fmt.Fprintf(os.Stderr, "tablebase %q: %v (continuing without it)\n", path, err)
		return nil
	}
	fmt.Fprintf(os.Stderr, "tablebase: up to %d-piece Syzygy loaded from %s\n", tb.MaxPieces(), path)
	return tb
}

// loadTablebaseDefault auto-discovers a Syzygy tablebase for the prod serve/hub
// paths — no flag or deployment change needed. It tries, in order: the SYZYGY_PATH
// env override, then `data/syzygy` (an in-repo, gitignored sidecar next to the
// committed opening book `data/book.bin`; the working dir is gomachine/ in both the
// dev screen and the systemd unit, so this resolves the same way the book does).
// The first that opens wins; if none do it returns nil (silent no-op, so the engine
// just searches everything). A non-empty `flagPath` short-circuits the search.
//
// In-repo (not ~/) is deliberate: the files then share the repo's ownership and
// gitignore, and live with the rest of the engine's data assets.
func loadTablebaseDefault(flagPath string) *syzygy.Tablebase {
	candidates := []string{os.Getenv("SYZYGY_PATH"), "data/syzygy"}
	if flagPath != "" {
		candidates = []string{flagPath}
	}
	for _, p := range candidates {
		if p == "" {
			continue
		}
		if tb, err := syzygy.Open(p); err == nil {
			fmt.Printf("tablebase: up to %d-piece Syzygy loaded from %s\n", tb.MaxPieces(), p)
			return tb
		}
	}
	return nil
}

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
	case "game":
		cmdBenchGame(args[1:])
	case "calibrate", "levels":
		cmdBenchCalibrate(args[1:])
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
	engBookPath := fs.String("engine-book", "data/book.bin", "precomputed engine opening book consulted when a side has book=on (\"\" disables)")
	tbPath := fs.String("tb-path", "", "Syzygy tablebase directory, probed when a side has tb=on (\"\" disables)")
	newThreads := fs.Int("new-threads", 1, "Lazy SMP threads for --new (use with --movetime)")
	oldThreads := fs.Int("old-threads", 1, "Lazy SMP threads for --old")
	newMovetime := fs.Int("new-movetime", 0, "ms/move for --new only (asymmetric TC; 0 → shared --movetime). Needs --nodes 0")
	oldMovetime := fs.Int("old-movetime", 0, "ms/move for --old only (asymmetric TC; 0 → shared --movetime)")
	newDepth := fs.Int("new-depth", 0, "max search depth for --new (0 → unbounded; caps on top of the time budget)")
	oldDepth := fs.Int("old-depth", 0, "max search depth for --old (0 → unbounded)")
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
		NewMoveTime: time.Duration(*newMovetime) * time.Millisecond,
		OldMoveTime: time.Duration(*oldMovetime) * time.Millisecond,
		NewDepth:    *newDepth,
		OldDepth:    *oldDepth,
		TTMB:        *tt,
		Elo0:        *elo0,
		Elo1:        *elo1,
		Alpha:       *alpha,
		Beta:        *beta,
		Concurrency: *conc,
		MaxPairs:    *maxPairs,
		Book:        book,
		EngineBook:  loadEngineBook(*engBookPath),
		Tablebase:   loadTablebase(*tbPath),
		NewThreads:  *newThreads,
		OldThreads:  *oldThreads,
		NewLevel:    -1, // full strength (SPRT tests search.Params, not levels)
		OldLevel:    -1,
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
	ourThreads := fs.Int("threads", 1, "our Lazy SMP threads")
	tt := fs.Int("tt", 16, "our transposition table size (MB)")
	games := fs.Int("games", 60, "number of games (rounded to color-swapped pairs)")
	conc := fs.Int("concurrency", 4, "parallel games (each spawns its own Stockfish)")
	bookPath := fs.String("book", "", "opening book (.epd/.fen or UCI move-lines); default: embedded")
	engBookPath := fs.String("engine-book", "data/book.bin", "precomputed engine opening book consulted when --new has book=on (\"\" disables)")
	tbPath := fs.String("tb-path", "", "Syzygy tablebase directory, probed when --new has tb=on (\"\" disables)")
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
		OurThreads:  *ourThreads,
		TTMB:        *tt,
		SFPath:      *sfPath,
		SFOptions:   sfOpts,
		SFElo:       anchorElo,
		SFBudget:    bench.UCIBudget{MoveTime: time.Duration(*sfMovetime) * time.Millisecond},
		Games:       *games,
		Concurrency: *conc,
		Book:        book,
		EngineBook:  loadEngineBook(*engBookPath),
		Tablebase:   loadTablebase(*tbPath),
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

// cmdBenchGame plays a single game (gomachine vs Stockfish) and prints the moves
// + result — for watching, not measuring.
func cmdBenchGame(args []string) {
	fs := flag.NewFlagSet("bench game", flag.ExitOnError)
	sfPath := fs.String("sf", "stockfish", "path to the stockfish binary")
	sfSkill := fs.Int("sf-skill", 20, "Stockfish Skill Level 0..20 (20 = full strength)")
	sfElo := fs.Int("sf-elo", 0, "if >0, limit Stockfish to this UCI_Elo instead of Skill")
	movetime := fs.Int("movetime", 300, "ms per move for BOTH engines")
	ourColor := fs.String("color", "white", "gomachine's color: white|black")
	threads := fs.Int("threads", 1, "gomachine Lazy SMP threads")
	fenFlag := fs.String("fen", chess.StartFEN, "starting FEN")
	_ = fs.Parse(args)

	pos, err := chess.ParseFEN(*fenFlag)
	if err != nil {
		fmt.Fprintln(os.Stderr, "invalid fen:", err)
		os.Exit(1)
	}
	sfOpts := map[string]string{}
	sfDesc := fmt.Sprintf("Stockfish (Skill %d)", *sfSkill)
	if *sfElo > 0 {
		sfOpts["UCI_LimitStrength"] = "true"
		sfOpts["UCI_Elo"] = fmt.Sprintf("%d", *sfElo)
		sfDesc = fmt.Sprintf("Stockfish (UCI_Elo %d)", *sfElo)
	} else {
		sfOpts["Skill Level"] = fmt.Sprintf("%d", *sfSkill)
	}

	sf, err := bench.StartUCI(*sfPath, sfOpts)
	if err != nil {
		fmt.Fprintln(os.Stderr, "stockfish:", err)
		os.Exit(1)
	}
	defer sf.Close()

	ours := engine.New(64)
	ourSide := chess.White
	if strings.HasPrefix(strings.ToLower(*ourColor), "b") {
		ourSide = chess.Black
	}
	budget := bench.UCIBudget{MoveTime: time.Duration(*movetime) * time.Millisecond}
	ourLim := search.Limits{MoveTime: time.Duration(*movetime) * time.Millisecond}

	fmt.Printf("\n  gomachine (%s) vs %s   ·   %dms/move\n  start: %s\n\n",
		*ourColor, sfDesc, *movetime, *fenFlag)

	startFEN := pos.FEN()
	var history []uint64
	var moves []string
	ply := 0
	for ; ply < 600; ply++ {
		st := engine.Adjudicate(pos, history)
		if st.State != "ongoing" {
			printGameEnd(st.State, st.Result, ourSide, ply)
			return
		}
		if contains(st.ClaimableDraws, "threefold") || contains(st.ClaimableDraws, "fifty") {
			fmt.Printf("\n  ½-½ draw (%s) after %d moves\n", st.ClaimableDraws[0], ply/2)
			return
		}

		var uci, san string
		if pos.SideToMove() == ourSide {
			res := ours.PlayThreads(pos, ourLim, history, *threads)
			uci = res.Move.String()
			san = pos.SAN(res.Move)
		} else {
			uci, err = sf.BestMove(startFEN, moves, budget)
			if err != nil {
				fmt.Fprintln(os.Stderr, "stockfish move error:", err)
				return
			}
			m, ok := pos.ParseUCIMove(uci)
			if !ok {
				fmt.Fprintf(os.Stderr, "stockfish illegal move %q\n", uci)
				return
			}
			san = pos.SAN(m)
		}
		m, _ := pos.ParseUCIMove(uci)
		if pos.SideToMove() == chess.White {
			fmt.Printf("%d. %-7s", (ply/2)+1, san)
		} else {
			fmt.Printf("%-7s\n", san)
		}
		history = append(history, pos.Key())
		var u chess.Undo
		pos.DoMove(m, &u)
		moves = append(moves, uci)
	}
	fmt.Printf("\n  reached move cap (%d plies)\n", ply)
}

func printGameEnd(state, result string, ourSide chess.Color, ply int) {
	fmt.Printf("\n\n  game over: %s  (%s)  after %d moves\n", state, result, (ply+1)/2)
	if state == "checkmate" {
		winnerWhite := result == "1-0"
		ourWin := (winnerWhite && ourSide == chess.White) || (!winnerWhite && ourSide == chess.Black)
		if ourWin {
			fmt.Println("  🏆 gomachine WINS")
		} else {
			fmt.Println("  💀 gomachine got mated")
		}
	}
}

func contains(s []string, v string) bool {
	for _, x := range s {
		if x == v {
			return true
		}
	}
	return false
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

// cmdBenchCalibrate measures each difficulty level's absolute Elo via a self-play
// ladder anchored to a known full-strength number (the Stockfish anchor). Feeds
// the rating↔level calibration (SPEC §11).
func cmdBenchCalibrate(args []string) {
	fs := flag.NewFlagSet("bench calibrate", flag.ExitOnError)
	maxLevel := fs.Int("max-level", 10, "calibrate levels 0..max-level")
	pairs := fs.Int("pairs", 100, "game pairs per adjacent-level match")
	conc := fs.Int("concurrency", runtime.NumCPU(), "parallel game-pair workers")
	tt := fs.Int("tt", 16, "transposition table size per engine (MB)")
	anchorElo := fs.Float64("anchor-elo", 2720, "known absolute Elo of full strength at --anchor-movetime")
	anchorMT := fs.Int("anchor-movetime", 100, "movetime (ms) at which --anchor-elo was measured")
	bookPath := fs.String("book", "", "opening book; default: embedded")
	_ = fs.Parse(args)

	book, err := bench.LoadBook(*bookPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "book:", err)
		os.Exit(1)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	fmt.Printf("♟  level calibration — self-play ladder (levels 0..%d, %d pairs/rung)\n", *maxLevel, *pairs)
	fmt.Printf("   anchored: full strength @ %dms ≡ %.0f Elo (Stockfish anchor)\n\n", *anchorMT, *anchorElo)

	t0 := time.Now()
	levels := bench.Calibrate(ctx, book, *maxLevel, *pairs, *conc, *tt,
		*anchorElo, time.Duration(*anchorMT)*time.Millisecond,
		func(s string) { fmt.Println(s) })

	fmt.Printf("\n  level   Elo    Δ vs below   advertised (ratingForLevel)   gap\n")
	for _, l := range levels {
		advertised := 600 + 180*l.Level // mirrors hub ratingForLevel
		fmt.Printf("   %2d   %5.0f    %+6.0f          %5d                 %+5.0f\n",
			l.Level, l.Elo, l.Delta, advertised, l.Elo-float64(advertised))
	}
	fmt.Printf("\nDone in %s. (advertised = current hub ratingForLevel; gap>0 means the\n", time.Since(t0).Round(time.Second))
	fmt.Println("level plays STRONGER than it advertises → recalibrate ratingForLevel/levels.go.")
}
