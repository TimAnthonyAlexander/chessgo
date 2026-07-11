package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"math"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/timanthonyalexander/gomachine/internal/bench"
)

// abiturParticipant is the JSON shape of one engine in an Abitur config file.
type abiturParticipant struct {
	Name       string            `json:"name"`
	Path       string            `json:"path"`
	Args       []string          `json:"args,omitempty"`
	Env        map[string]string `json:"env,omitempty"`
	Dir        string            `json:"dir,omitempty"`
	Options    map[string]string `json:"options,omitempty"`
	MoveTimeMs int               `json:"movetime_ms,omitempty"`
	Nodes      uint64            `json:"nodes,omitempty"`
	Depth      int               `json:"depth,omitempty"`
	Elo        int               `json:"elo,omitempty"`
}

// abiturConfigFile is the JSON shape of a whole Abitur run.
type abiturConfigFile struct {
	Games        int                 `json:"games"`
	Concurrency  int                 `json:"concurrency"`
	Book         string              `json:"book,omitempty"`
	Gauntlet     string              `json:"gauntlet,omitempty"`
	Participants []abiturParticipant `json:"participants"`
}

func (p abiturParticipant) toBench() bench.Participant {
	var env []string
	for k, v := range p.Env {
		env = append(env, k+"="+v)
	}
	b := bench.UCIBudget{Nodes: p.Nodes, Depth: p.Depth}
	if p.MoveTimeMs > 0 {
		b.MoveTime = time.Duration(p.MoveTimeMs) * time.Millisecond
	}
	return bench.Participant{
		Name: p.Name, Path: p.Path, Args: p.Args, Env: env, Dir: p.Dir,
		Options: p.Options, Budget: b, Elo: p.Elo,
	}
}

// cmdBenchAbitur runs the multi-engine gauntlet ("Abitur") from a JSON config.
func cmdBenchAbitur(args []string) {
	fs := flag.NewFlagSet("bench abitur", flag.ExitOnError)
	configPath := fs.String("config", "abitur.json", "JSON config file (participants, games, book)")
	games := fs.Int("games", 0, "override games-per-pair (0 = use config)")
	concurrency := fs.Int("concurrency", 0, "override concurrency (0 = use config)")
	gauntlet := fs.String("gauntlet", "", "only play matches involving this participant name (empty = full round-robin)")
	bookPath := fs.String("book", "", "override opening book path (empty = use config)")
	_ = fs.Parse(args)

	raw, err := os.ReadFile(*configPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "abitur: cannot read config:", err)
		os.Exit(1)
	}
	var cf abiturConfigFile
	if err := json.Unmarshal(raw, &cf); err != nil {
		fmt.Fprintln(os.Stderr, "abitur: bad config JSON:", err)
		os.Exit(1)
	}
	if len(cf.Participants) < 2 {
		fmt.Fprintln(os.Stderr, "abitur: need at least 2 participants")
		os.Exit(1)
	}
	if *games > 0 {
		cf.Games = *games
	}
	if *concurrency > 0 {
		cf.Concurrency = *concurrency
	}
	if *gauntlet != "" {
		cf.Gauntlet = *gauntlet
	}
	if *bookPath != "" {
		cf.Book = *bookPath
	}
	if cf.Games <= 0 {
		cf.Games = 100
	}
	if cf.Concurrency <= 0 {
		cf.Concurrency = 4
	}

	var openings []bench.Opening
	if cf.Book != "" {
		openings, err = bench.LoadBook(cf.Book)
		if err != nil {
			fmt.Fprintln(os.Stderr, "abitur: cannot load book:", err)
			os.Exit(1)
		}
	}

	parts := make([]bench.Participant, len(cf.Participants))
	for i, p := range cf.Participants {
		parts[i] = p.toBench()
	}

	cfg := bench.AbiturConfig{
		Participants: parts,
		Games:        cf.Games,
		Concurrency:  cf.Concurrency,
		Book:         openings,
		Gauntlet:     cf.Gauntlet,
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	go func() { <-sig; fmt.Fprintln(os.Stderr, "\nabitur: interrupt — finishing current pairs…"); cancel() }()

	fmt.Printf("Abitur — %d participants, %d games/pair, concurrency %d",
		len(parts), cf.Games, cf.Concurrency)
	if cf.Gauntlet != "" {
		fmt.Printf(", gauntlet vs %q", cf.Gauntlet)
	}
	if cf.Book != "" {
		fmt.Printf(", book %s (%d openings)", cf.Book, len(openings))
	}
	fmt.Println()
	for _, p := range parts {
		fmt.Printf("  %-16s %s  budget=%s  elo=%s\n", p.Name, p.Path, budgetStr(p.Budget), eloStr(p.Elo))
	}
	fmt.Println()

	start := time.Now()
	results, rows, err := bench.RunAbitur(ctx, cfg, func(pr bench.PairResult) {
		printPair(pr)
	}, printProgress)
	if err != nil {
		fmt.Fprintln(os.Stderr, "\nabitur:", err)
		// Still print whatever standings we can from partial results.
	}
	fmt.Printf("\n=== Standings (after %s) ===\n", time.Since(start).Round(time.Second))
	printStandings(rows)
	_ = results
}

// printProgress streams a live tally as a match runs. Throttled to the 1st pair,
// every 5th, and the last — enough to prove liveness and watch the estimate
// converge in a tailed log, without spamming a line per pair.
func printProgress(mp bench.MatchProgress) {
	if mp.PairsDone != 1 && mp.PairsDone%5 != 0 && mp.PairsDone != mp.PairsTotal {
		return
	}
	elo := fmt.Sprintf("%+.0f ± %.0f", mp.EloDiff, mp.Err95)
	if math.IsInf(mp.EloDiff, 0) || math.IsNaN(mp.EloDiff) {
		elo = "n/a"
	}
	fmt.Printf("  … %-16s vs %-16s  %2d/%d pairs  W%d D%d L%d  %5.1f%%  Elo %s  [%s]\n",
		mp.A, mp.B, mp.PairsDone, mp.PairsTotal, mp.WinsA, mp.Draws, mp.WinsB,
		100*mp.ScoreA, elo, mp.Elapsed.Round(time.Second))
}

func printPair(pr bench.PairResult) {
	elo := fmt.Sprintf("%+.0f ± %.0f", pr.EloDiff, pr.Err95)
	if math.IsInf(pr.EloDiff, 0) || math.IsNaN(pr.EloDiff) {
		elo = "n/a (0% or 100%)"
	}
	fmt.Printf("%-16s vs %-16s  %d games  W%d D%d L%d  %5.1f%%  Elo(A−B) %s  [%s]\n",
		pr.A, pr.B, pr.Games, pr.WinsA, pr.Draws, pr.WinsB, 100*pr.ScoreA, elo,
		pr.Elapsed.Round(time.Second))
}

func printStandings(rows []bench.StandingRow) {
	// rows already sorted by score desc.
	fmt.Printf("%-16s %6s %6s %6s %6s  %7s  %10s\n", "engine", "games", "W", "D", "L", "score", "elo(anchor)")
	for _, r := range rows {
		anchor := "—"
		if r.HasAnchor {
			anchor = fmt.Sprintf("%.0f", r.AnchorElo)
		}
		fmt.Printf("%-16s %6d %6d %6d %6d  %6.1f%%  %10s\n",
			r.Name, r.Games, r.Wins, r.Draws, r.Losses, 100*r.Score, anchor)
	}
}

func budgetStr(b bench.UCIBudget) string {
	switch {
	case b.MoveTime > 0:
		return b.MoveTime.String()
	case b.Nodes > 0:
		return fmt.Sprintf("%dn", b.Nodes)
	case b.Depth > 0:
		return fmt.Sprintf("d%d", b.Depth)
	default:
		return "100ms"
	}
}

func eloStr(e int) string {
	if e <= 0 {
		return "?"
	}
	return fmt.Sprintf("%d", e)
}
