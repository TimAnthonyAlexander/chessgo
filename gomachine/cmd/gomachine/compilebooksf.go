package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"github.com/timanthonyalexander/gomachine/internal/bench"
	"github.com/timanthonyalexander/gomachine/internal/book"
	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// cmdCompileBookSF builds the opening book by asking an EXTERNAL UCI engine
// (Stockfish) for the best move in each opening position, rather than searching
// with gomachine's own engine (that's `compile-book`). The two produce the same
// artifact format; only PV[0] is consulted at runtime (a book hit short-circuits
// search, engine.go bookMove), so what this bakes in is Stockfish's opening move
// for each of the ~5400 positions. Score/Mate/Depth are stored for display only and
// are on Stockfish's cp scale (side-to-move relative), NOT gomachine's — do not
// compare them against a gomachine-compiled book's stored Scores.
//
// This is the "compile via SF" candidate (C) in the book A/B/C: SPRT it against the
// gomachine-compiled book with `bench sprt --new "book=on" --old "book=on"
// --new-engine-book <this> --old-engine-book <gomachine book>`.
func cmdCompileBookSF(args []string) {
	fs := flag.NewFlagSet("compile-book-sf", flag.ExitOnError)
	openings := fs.String("openings", "data/openings", "dir of Lichess opening TSVs (a.tsv..e.tsv)")
	out := fs.String("out", "data/book_sf.bin", "output book file")
	sfPath := fs.String("sf", "stockfish", "external UCI engine binary (Stockfish)")
	depth := fs.Int("depth", 22, "fixed search depth per position (0 → use --movetime)")
	movetime := fs.Int("movetime", 0, "search budget per position (ms); used only when --depth 0")
	maxPlies := fs.Int("maxplies", 12, "how many opening plies to include per line")
	workers := fs.Int("workers", 8, "concurrent UCI engines (each is one SF process)")
	hash := fs.Int("hash", 256, "per-engine hash (MB)")
	threads := fs.Int("threads", 1, "threads per engine process")
	maxLines := fs.Int("maxlines", 0, "cap opening lines processed (0 = all; for quick tests)")
	_ = fs.Parse(args)

	// 1. Enumerate unique positions (key -> FEN), always including the start —
	//    IDENTICAL enumeration to cmdCompileBook so the two books cover the same keys.
	positions := map[uint64]string{}
	start, _ := chess.ParseFEN(chess.StartFEN)
	positions[start.Key()] = chess.StartFEN

	lines, err := readOpeningLines(*openings)
	if err != nil {
		fmt.Fprintln(os.Stderr, "compile-book-sf:", err)
		os.Exit(1)
	}
	if *maxLines > 0 && len(lines) > *maxLines {
		lines = lines[:*maxLines]
	}
	for _, sans := range lines {
		collectLine(sans, *maxPlies, positions)
	}
	fmt.Printf("compile-book-sf: %d opening lines → %d unique positions (≤%d plies)\n", len(lines), len(positions), *maxPlies)

	budget := bench.UCIBudget{}
	if *depth > 0 {
		budget.Depth = *depth
	} else {
		budget.MoveTime = time.Duration(*movetime) * time.Millisecond
	}
	sfOpts := map[string]string{"Hash": fmt.Sprintf("%d", *hash), "Threads": fmt.Sprintf("%d", *threads)}

	// 2. Search every unique position on a pool of external UCI engines.
	type job struct {
		key uint64
		fen string
	}
	jobs := make(chan job, len(positions))
	for k, f := range positions {
		jobs <- job{k, f}
	}
	close(jobs)

	entries := make([]book.Entry, 0, len(positions))
	var mu sync.Mutex
	var done, failed int64
	total := int64(len(positions))

	var wg sync.WaitGroup
	t0 := time.Now()
	for w := 0; w < *workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			eng, err := bench.StartUCI(*sfPath, sfOpts)
			if err != nil {
				fmt.Fprintln(os.Stderr, "compile-book-sf: cannot start engine:", err)
				return
			}
			defer eng.Close()
			for j := range jobs {
				_ = eng.NewGame()
				a, err := eng.AnalyzeBest(j.fen, nil, budget)
				if err != nil || a.BestMove == "" || len(a.PV) == 0 {
					atomic.AddInt64(&failed, 1)
				} else {
					mate := 0
					if a.IsMate {
						if a.Cp >= 0 {
							mate = 20000 - a.Cp // dist to giving mate (positive)
						} else {
							mate = -(20000 + a.Cp) // dist to being mated (negative)
						}
					}
					mu.Lock()
					entries = append(entries, book.Entry{
						Key: j.key, Score: a.Cp, Mate: mate,
						Depth: *depth, PV: a.PV,
					})
					mu.Unlock()
				}
				if n := atomic.AddInt64(&done, 1); n%50 == 0 || n == total {
					fmt.Printf("\r  searched %d/%d (%.0fs)", n, total, time.Since(t0).Seconds())
				}
			}
		}()
	}
	wg.Wait()
	fmt.Println()
	if failed > 0 {
		fmt.Printf("compile-book-sf: %d positions had no usable move (skipped)\n", failed)
	}

	// 3. Write the sorted, versioned artifact (same format as compile-book).
	if err := os.MkdirAll(filepath.Dir(*out), 0o755); err != nil {
		fmt.Fprintln(os.Stderr, "compile-book-sf:", err)
		os.Exit(1)
	}
	if err := book.Write(*out, entries); err != nil {
		fmt.Fprintln(os.Stderr, "compile-book-sf:", err)
		os.Exit(1)
	}
	fmt.Printf("compile-book-sf: wrote %d positions → %s (engineVersion=%d, %s)\n",
		len(entries), *out, book.EngineVersion, time.Since(t0).Round(time.Second))
}
