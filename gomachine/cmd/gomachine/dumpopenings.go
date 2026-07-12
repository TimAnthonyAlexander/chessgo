package main

import (
	"bufio"
	"flag"
	"fmt"
	"os"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// cmdDumpOpenings writes a diverse opening suite (one FEN per line) by replaying
// each ECO line (data/openings/*.tsv) to a fixed ply and emitting that position.
// Deduped. Used as the `--book` for book-vs-book SPRTs so games start from HUNDREDS
// of distinct openings instead of the 16 embedded ones — the embedded set makes a
// fixed-nodes (deterministic) self-play SPRT have an effective sample of ~16, which
// blows up the real error bars. A big suite restores genuine per-pair independence.
func cmdDumpOpenings(args []string) {
	fs := flag.NewFlagSet("dump-openings", flag.ExitOnError)
	openings := fs.String("openings", "data/openings", "dir of Lichess opening TSVs (a.tsv..e.tsv)")
	out := fs.String("out", "data/opening_suite.epd", "output FEN suite (one per line)")
	ply := fs.Int("ply", 8, "replay each line to this many plies (shorter lines emit their final position)")
	minPly := fs.Int("min-ply", 6, "skip lines that don't reach at least this many plies")
	_ = fs.Parse(args)

	lines, err := readOpeningLines(*openings)
	if err != nil {
		fmt.Fprintln(os.Stderr, "dump-openings:", err)
		os.Exit(1)
	}

	seen := map[uint64]bool{}
	var fens []string
	for _, sans := range lines {
		pos, _ := chess.ParseFEN(chess.StartFEN)
		n := 0
		for i, san := range sans {
			if i >= *ply {
				break
			}
			m, ok := matchSAN(pos, san)
			if !ok {
				break
			}
			var u chess.Undo
			pos.DoMove(m, &u)
			n++
		}
		if n < *minPly {
			continue
		}
		k := pos.Key()
		if seen[k] {
			continue
		}
		seen[k] = true
		fens = append(fens, pos.FEN())
	}

	f, err := os.Create(*out)
	if err != nil {
		fmt.Fprintln(os.Stderr, "dump-openings:", err)
		os.Exit(1)
	}
	defer f.Close()
	w := bufio.NewWriter(f)
	for _, fen := range fens {
		fmt.Fprintln(w, fen)
	}
	w.Flush()
	fmt.Printf("dump-openings: wrote %d unique openings (ply≤%d, min %d) → %s\n", len(fens), *ply, *minPly, *out)
}
