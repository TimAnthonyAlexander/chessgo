package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/timanthonyalexander/gomachine/internal/book"
	"github.com/timanthonyalexander/gomachine/internal/chess"
	"github.com/timanthonyalexander/gomachine/internal/engine"
)

// cmdCompileBook builds the opening book: it enumerates the unique positions in the
// first N plies of the Lichess opening lines (TSV: eco, name, pgn-in-SAN), searches
// each deeply, and writes a sorted book.bin. The start position is always included.
func cmdCompileBook(args []string) {
	fs := flag.NewFlagSet("compile-book", flag.ExitOnError)
	openings := fs.String("openings", "data/openings", "dir of Lichess opening TSVs (a.tsv..e.tsv)")
	out := fs.String("out", "data/book.bin", "output book file")
	movetime := fs.Int("movetime", 3000, "search budget per position (ms)")
	maxPlies := fs.Int("maxplies", 12, "how many opening plies to include per line")
	workers := fs.Int("workers", runtime.NumCPU(), "concurrent search engines")
	tt := fs.Int("tt", 64, "transposition table per worker (MB)")
	maxLines := fs.Int("maxlines", 0, "cap opening lines processed (0 = all; for quick tests)")
	_ = fs.Parse(args)

	// 1. Enumerate unique positions (key -> FEN), always including the start.
	positions := map[uint64]string{}
	start, _ := chess.ParseFEN(chess.StartFEN)
	positions[start.Key()] = chess.StartFEN

	lines, err := readOpeningLines(*openings)
	if err != nil {
		fmt.Fprintln(os.Stderr, "compile-book:", err)
		os.Exit(1)
	}
	if *maxLines > 0 && len(lines) > *maxLines {
		lines = lines[:*maxLines]
	}
	for _, sans := range lines {
		collectLine(sans, *maxPlies, positions)
	}
	fmt.Printf("compile-book: %d opening lines → %d unique positions (≤%d plies)\n", len(lines), len(positions), *maxPlies)

	// 2. Search every unique position concurrently on a pool of engines.
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
	var done int64
	total := int64(len(positions))
	budget := time.Duration(*movetime) * time.Millisecond

	var wg sync.WaitGroup
	t0 := time.Now()
	for w := 0; w < *workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			eng := engine.New(*tt)
			for j := range jobs {
				pos, err := chess.ParseFEN(j.fen)
				if err != nil {
					continue
				}
				res := eng.SearchDirect(pos, 0, budget, nil)
				if res.Move != chess.NullMove {
					mu.Lock()
					entries = append(entries, book.Entry{
						Key: j.key, Score: res.Score, Mate: res.MateIn,
						Depth: res.Depth, Move: res.Move.String(),
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

	// 3. Write the sorted, versioned artifact.
	if err := os.MkdirAll(filepath.Dir(*out), 0o755); err != nil {
		fmt.Fprintln(os.Stderr, "compile-book:", err)
		os.Exit(1)
	}
	if err := book.Write(*out, entries); err != nil {
		fmt.Fprintln(os.Stderr, "compile-book:", err)
		os.Exit(1)
	}
	fmt.Printf("compile-book: wrote %d positions → %s (engineVersion=%d, %s)\n",
		len(entries), *out, book.EngineVersion, time.Since(t0).Round(time.Second))
}

// readOpeningLines reads every *.tsv in dir and returns each line's SAN token list.
func readOpeningLines(dir string) ([][]string, error) {
	matches, err := filepath.Glob(filepath.Join(dir, "*.tsv"))
	if err != nil {
		return nil, err
	}
	if len(matches) == 0 {
		return nil, fmt.Errorf("no .tsv files in %s", dir)
	}
	var lines [][]string
	for _, path := range matches {
		raw, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		for i, row := range strings.Split(string(raw), "\n") {
			if i == 0 || row == "" { // header / blank
				continue
			}
			cols := strings.Split(row, "\t")
			if len(cols) < 3 {
				continue
			}
			lines = append(lines, sanTokens(cols[2]))
		}
	}
	return lines, nil
}

// sanTokens splits a PGN movetext into SAN tokens, dropping move numbers ("1.", "2...").
func sanTokens(pgn string) []string {
	var out []string
	for _, tok := range strings.Fields(pgn) {
		if tok == "" || isMoveNumber(tok) {
			continue
		}
		out = append(out, tok)
	}
	return out
}

func isMoveNumber(tok string) bool {
	for _, r := range tok {
		if (r < '0' || r > '9') && r != '.' {
			return false
		}
	}
	return true
}

// collectLine replays SAN moves from the start, recording each position's key→FEN
// up to maxPlies. Stops at the first SAN that doesn't match a legal move (defensive).
func collectLine(sans []string, maxPlies int, out map[uint64]string) {
	pos, _ := chess.ParseFEN(chess.StartFEN)
	for i, san := range sans {
		if i >= maxPlies {
			return
		}
		m, ok := matchSAN(pos, san)
		if !ok {
			return
		}
		var u chess.Undo
		pos.DoMove(m, &u)
		out[pos.Key()] = pos.FEN()
	}
}

// matchSAN finds the legal move whose SAN equals san (ignoring +, #, !, ? decorations).
func matchSAN(pos *chess.Position, san string) (chess.Move, bool) {
	want := cleanSAN(san)
	var ml chess.MoveList
	pos.GenerateLegal(&ml)
	for i := 0; i < ml.Len(); i++ {
		m := ml.Get(i)
		if cleanSAN(pos.SAN(m)) == want {
			return m, true
		}
	}
	return chess.NullMove, false
}

func cleanSAN(s string) string {
	return strings.NewReplacer("+", "", "#", "", "!", "", "?", "").Replace(s)
}
