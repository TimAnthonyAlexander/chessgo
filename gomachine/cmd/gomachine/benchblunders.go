package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"time"

	"github.com/timanthonyalexander/gomachine/internal/bench"
	"github.com/timanthonyalexander/gomachine/internal/search"
)

// cmdBenchBlunders plays gomachine vs Stockfish many times, judges every gomachine
// move with a separate full-strength Stockfish, and mines the moves where the eval
// collapsed. Blind-spot blunders (gomachine's own eval was wrong, not just a deep
// tactic) are emitted as WDL-labelled EPD — hard-example training data for the eval.
func cmdBenchBlunders(args []string) {
	fs := flag.NewFlagSet("bench blunders", flag.ExitOnError)
	ourSpec := fs.String("new", "", "gomachine param spec (default: full strength)")
	sfPath := fs.String("sf", "stockfish", "path to the stockfish binary")
	sfElo := fs.Int("sf-elo", 0, "opponent Stockfish UCI_Elo (0 → full strength opponent)")
	sfSkill := fs.Int("sf-skill", -1, "opponent Stockfish Skill Level 0..20 (overrides --sf-elo if ≥0)")
	sfMovetime := fs.Int("sf-movetime", 100, "opponent ms per move")
	judgeMovetime := fs.Int("judge-movetime", 200, "full-strength judge ms per move (ground truth)")
	ourMovetime := fs.Int("movetime", 100, "gomachine ms per move")
	ourThreads := fs.Int("threads", 1, "gomachine Lazy SMP threads")
	tt := fs.Int("tt", 16, "gomachine transposition table size (MB)")
	games := fs.Int("games", 50, "number of games (rounded to color-swapped pairs)")
	conc := fs.Int("concurrency", 4, "parallel games (each spawns 2 Stockfish processes)")
	blunderWP := fs.Float64("blunder-wp", 0.30, "win-prob drop on one move to flag a blunder (Lichess blunder = 0.30)")
	blindWP := fs.Float64("blind-wp", 0.20, "win-prob gomachine overestimated the result by → blind spot (eval-trainable)")
	trainMaxCp := fs.Int("train-max-cp", 0, "emit to EPD only if the resulting position is ≤ this cp for gomachine (0 → not winning)")
	quietOnly := fs.Bool("quiet-only", true, "emit only quiet post-blunder positions to the EPD")
	confirmLoss := fs.Bool("confirm-loss", false, "emit only blunders in games gomachine did not go on to win")
	bookPath := fs.String("book", "", "opening book (.epd/.fen or UCI move-lines); default: embedded")
	engBookPath := fs.String("engine-book", "data/book.bin", "gomachine opening book (consulted when --new has book=on; \"\" disables)")
	tbPath := fs.String("tb-path", "data/syzygy", "Syzygy tablebase dir for gomachine (\"\" disables)")
	epdOut := fs.String("epd-out", "data/blunders/mined.epd", "training-set EPD output path (\"\" disables)")
	jsonOut := fs.String("json-out", "data/blunders/mined.json", "full blunder JSON output path (\"\" disables)")
	topN := fs.Int("top", 10, "print this many worst blunders to the console")
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

	// Opponent options (may be handicapped). Judge is ALWAYS full strength.
	oppOpts := map[string]string{}
	oppDesc := "Stockfish (full strength)"
	switch {
	case *sfSkill >= 0:
		oppOpts["Skill Level"] = fmt.Sprintf("%d", *sfSkill)
		oppDesc = fmt.Sprintf("Stockfish (Skill %d)", *sfSkill)
	case *sfElo > 0:
		oppOpts["UCI_LimitStrength"] = "true"
		oppOpts["UCI_Elo"] = fmt.Sprintf("%d", *sfElo)
		oppDesc = fmt.Sprintf("Stockfish (UCI_Elo %d)", *sfElo)
	}

	cfg := bench.BlunderConfig{
		OurParams:    ourParams,
		OurMoveTime:  time.Duration(*ourMovetime) * time.Millisecond,
		OurThreads:   *ourThreads,
		TTMB:         *tt,
		SFPath:       *sfPath,
		SFOptions:    oppOpts,
		SFBudget:     bench.UCIBudget{MoveTime: time.Duration(*sfMovetime) * time.Millisecond},
		JudgeOptions: map[string]string{}, // no limit → full strength
		JudgeBudget:  bench.UCIBudget{MoveTime: time.Duration(*judgeMovetime) * time.Millisecond},
		Games:        *games,
		Concurrency:  *conc,
		Book:         book,
		EngineBook:   loadEngineBook(*engBookPath),
		Tablebase:    loadTablebase(*tbPath),
		BlunderWP:    *blunderWP,
		BlindWP:      *blindWP,
		TrainMaxCp:   *trainMaxCp,
		QuietOnly:    *quietOnly,
		ConfirmLoss:  *confirmLoss,
	}

	fmt.Printf("\n♟  blunder hunt — gomachine vs %s · judge: full-strength SF @ %dms\n", oppDesc, *judgeMovetime)
	fmt.Printf("   %d games · gomachine %dms/%dt · flag win-drop ≥ %.0f%% · blind ≥ %.0f%%\n\n",
		*games, *ourMovetime, *ourThreads, *blunderWP*100, *blindWP*100)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	last := time.Now()
	summary, err := bench.RunBlunderHunt(ctx, cfg, func(p bench.BlunderProgress) {
		if time.Since(last) < 500*time.Millisecond {
			return
		}
		last = time.Now()
		fmt.Printf("\r  games %d · blunders %d (blind %d / horizon %d) · trainable %d · %s        ",
			p.Games, p.Blunders, p.BlindSpot, p.Horizon, p.Trainable, p.Elapsed.Round(time.Second))
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, "\nblunder hunt error:", err)
		os.Exit(1)
	}
	fmt.Println()

	printBlunderSummary(summary, cfg, *topN)
	writeBlunderOutputs(summary, cfg, *epdOut, *jsonOut)
}

func printBlunderSummary(s bench.BlunderSummary, cfg bench.BlunderConfig, topN int) {
	fmt.Printf("\n  ── result ── %d games · %d blunders · %d blind-spot · %d horizon · %d trainable · %s\n",
		s.Games, s.BlunderProgress.Blunders, s.BlindSpot, s.Horizon, s.Trainable, s.Elapsed.Round(time.Second))

	worst := append([]bench.Blunder(nil), s.Blunders...)
	sort.Slice(worst, func(i, j int) bool { return worst[i].WinDrop > worst[j].WinDrop })
	if topN > len(worst) {
		topN = len(worst)
	}
	if topN > 0 {
		fmt.Printf("\n  worst %d (win-drop = how far the bar fell; over = gomachine's own misjudgement):\n", topN)
	}
	for i := 0; i < topN; i++ {
		b := worst[i]
		fmt.Printf("\n  [%d] g%d %s move %d%s — played %s, best %s   win-drop %.0f%%  over %.0f%%  %s\n",
			i+1, b.Game, b.OurColor, b.MoveNo, sideDot(b.OurColor), b.MovePlayed, b.BestMove,
			b.WinDrop*100, b.OverWP*100, b.Class)
		fmt.Printf("      gomachine: %+dcp @ d%d   judge: %+d → %+d cp  (%.0f%% → %.0f%% win)   result %s\n",
			b.OurScoreCp, b.OurDepth, b.EvalBefore, b.EvalAfter, b.WinBefore*100, b.WinAfter*100, b.GameResult)
		fmt.Printf("      fen %s\n", b.FENBefore)
		if b.JudgePV != "" {
			fmt.Printf("      pv  %s\n", b.JudgePV)
		}
	}
}

func writeBlunderOutputs(s bench.BlunderSummary, cfg bench.BlunderConfig, epdOut, jsonOut string) {
	if jsonOut != "" {
		if err := ensureDir(jsonOut); err == nil {
			if f, err := os.Create(jsonOut); err == nil {
				if err := bench.WriteJSON(f, s.Blunders); err != nil {
					fmt.Fprintln(os.Stderr, "json:", err)
				}
				f.Close()
				fmt.Printf("\n  wrote %d blunders → %s\n", len(s.Blunders), jsonOut)
			} else {
				fmt.Fprintln(os.Stderr, "json:", err)
			}
		}
	}
	if epdOut != "" {
		if err := ensureDir(epdOut); err == nil {
			if f, err := os.Create(epdOut); err == nil {
				n, err := bench.WriteEPD(f, s.Blunders, cfg)
				f.Close()
				if err != nil {
					fmt.Fprintln(os.Stderr, "epd:", err)
				}
				fmt.Printf("  wrote %d training positions → %s\n", n, epdOut)
				fmt.Printf("  feed it in:  gomachine tune --epd %s --out internal/eval/tuned_tables.go\n", epdOut)
			} else {
				fmt.Fprintln(os.Stderr, "epd:", err)
			}
		}
	}
}

func ensureDir(path string) error {
	dir := filepath.Dir(path)
	if dir == "" || dir == "." {
		return nil
	}
	return os.MkdirAll(dir, 0o755)
}

func sideDot(color string) string {
	if color == "white" {
		return "."
	}
	return "..."
}
