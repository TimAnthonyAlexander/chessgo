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

// cmdCompileBookSFTree builds the opening book as a BREADTH-first Stockfish tree,
// instead of following a curated list of named opening lines (that's compile-book /
// compile-book-sf, whose depth is capped by however far the ECO lines happen to go).
//
// From the start position it repeatedly: searches a node with SF at MultiPV=K, stores
// SF's #1 move as that position's book entry (PV[0] is all the runtime consults), and
// enqueues the child after each of SF's top-K moves whose score is within a cp-window
// of the best (so dubious sidelines are pruned). Dedup is by exact Zobrist key; growth
// stops at a max ply or a total-position cap.
//
// The point vs the flat book is COVERAGE: because we branch the opponent's plausible
// replies (not just our own line), the book keeps firing when the opponent leaves main
// theory, rather than dropping straight into live 100ms search. Same on-disk format as
// compile-book; SPRT it against the flat SF book, then Abitur-gate before prod.
func cmdCompileBookSFTree(args []string) {
	fs := flag.NewFlagSet("compile-book-sf-tree", flag.ExitOnError)
	out := fs.String("out", "data/book_sf_tree.bin", "output book file")
	sfPath := fs.String("sf", "stockfish", "external UCI engine binary (Stockfish)")
	depth := fs.Int("depth", 20, "SF search depth per node")
	multipv := fs.Int("multipv", 3, "SF MultiPV: branch this many root moves per node")
	cpWindow := fs.Int("cp-window", 40, "only branch moves within this many cp of the node's best move")
	maxPly := fs.Int("max-ply", 20, "stop expanding past this ply from the start")
	maxPos := fs.Int("max-positions", 50000, "total position cap (stop enqueuing new nodes past this)")
	workers := fs.Int("workers", 12, "concurrent SF processes")
	hash := fs.Int("hash", 256, "per-engine hash (MB)")
	_ = fs.Parse(args)

	budget := bench.UCIBudget{Depth: *depth}
	sfOpts := map[string]string{
		"Hash":    fmt.Sprintf("%d", *hash),
		"Threads": "1",
		"MultiPV": fmt.Sprintf("%d", *multipv),
	}

	type node struct {
		key uint64
		fen string
		ply int
	}

	// A buffered work queue: total nodes ever enqueued is capped at maxPos, so the
	// buffer can hold every pending item and a send never blocks (no deadlock while
	// enqueuing under the lock). pending tracks outstanding work so we know when to close.
	work := make(chan node, *maxPos+*workers+8)
	var (
		mu      sync.Mutex
		visited = make(map[uint64]bool, *maxPos)
		entries = make([]book.Entry, 0, *maxPos)
		count   int // nodes enqueued (== positions that will be stored)
		pending sync.WaitGroup
		done    int64
		failed  int64
	)

	start, _ := chess.ParseFEN(chess.StartFEN)
	visited[start.Key()] = true
	count = 1
	pending.Add(1)
	work <- node{start.Key(), chess.StartFEN, 0}
	go func() { pending.Wait(); close(work) }()

	// child returns the position/key after playing moveUCI from parentFEN.
	child := func(parentFEN, moveUCI string) (uint64, string, bool) {
		pos, err := chess.ParseFEN(parentFEN)
		if err != nil {
			return 0, "", false
		}
		m, legal := pos.ParseUCIMove(moveUCI)
		if !legal {
			return 0, "", false
		}
		var u chess.Undo
		pos.DoMove(m, &u)
		return pos.Key(), pos.FEN(), true
	}

	if err := os.MkdirAll(filepath.Dir(*out), 0o755); err != nil {
		fmt.Fprintln(os.Stderr, "compile-book-sf-tree:", err)
		os.Exit(1)
	}

	// Atomic checkpoint: snapshot entries under the lock, write to a temp file, then
	// rename over *out (atomic on the same fs). A crash/reboot during the multi-hour
	// run loses at most one interval of work, and *out is never a half-written file.
	writeCheckpoint := func(tag string) {
		mu.Lock()
		snap := make([]book.Entry, len(entries))
		copy(snap, entries)
		mu.Unlock()
		tmp := *out + ".tmp"
		if err := book.Write(tmp, snap); err != nil {
			fmt.Fprintln(os.Stderr, "\ncheckpoint write:", err)
			return
		}
		if err := os.Rename(tmp, *out); err != nil {
			fmt.Fprintln(os.Stderr, "\ncheckpoint rename:", err)
			return
		}
		fmt.Printf("\n  [%s] checkpoint: saved %d positions → %s\n", tag, len(snap), *out)
	}

	t0 := time.Now()
	fmt.Printf("compile-book-sf-tree: SF depth %d, MultiPV %d, cp-window %d, max-ply %d, cap %d, %d workers\n",
		*depth, *multipv, *cpWindow, *maxPly, *maxPos, *workers)

	ckStop := make(chan struct{})
	var ckWG sync.WaitGroup
	ckWG.Add(1)
	go func() {
		defer ckWG.Done()
		tk := time.NewTicker(5 * time.Minute)
		defer tk.Stop()
		for {
			select {
			case <-tk.C:
				writeCheckpoint("ckpt")
			case <-ckStop:
				return
			}
		}
	}()

	for w := 0; w < *workers; w++ {
		go func() {
			eng, err := bench.StartUCI(*sfPath, sfOpts)
			if err != nil {
				fmt.Fprintln(os.Stderr, "compile-book-sf-tree: cannot start engine:", err)
				return
			}
			defer eng.Close()
			for nd := range work {
				_ = eng.NewGame()
				lines, err := eng.AnalyzeMultiPV(nd.fen, nil, budget, *multipv)
				if err != nil || len(lines) == 0 || lines[0].BestMove == "" {
					atomic.AddInt64(&failed, 1)
					pending.Done()
					continue
				}
				best := lines[0]
				mate := 0
				if best.IsMate {
					if best.Cp >= 0 {
						mate = 20000 - best.Cp
					} else {
						mate = -(20000 + best.Cp)
					}
				}

				mu.Lock()
				entries = append(entries, book.Entry{
					Key: nd.key, Score: best.Cp, Mate: mate, Depth: *depth, PV: best.PV,
				})
				if nd.ply+1 <= *maxPly {
					for _, ln := range lines {
						if best.Cp-ln.Cp > *cpWindow { // lines are multipv-sorted → rest are worse
							break
						}
						if count >= *maxPos {
							break
						}
						ck, cf, ok := child(nd.fen, ln.BestMove)
						if !ok || visited[ck] {
							continue
						}
						visited[ck] = true
						count++
						pending.Add(1)
						work <- node{ck, cf, nd.ply + 1}
					}
				}
				mu.Unlock()

				if n := atomic.AddInt64(&done, 1); n%100 == 0 {
					mu.Lock()
					q := len(work)
					c := count
					mu.Unlock()
					fmt.Printf("\r  processed %d, enqueued %d/%d, queue %d (%.0fs)   ", n, c, *maxPos, q, time.Since(t0).Seconds())
				}
				pending.Done()
			}
		}()
	}

	pending.Wait()
	close(ckStop)
	ckWG.Wait()
	fmt.Println()
	if failed > 0 {
		fmt.Printf("compile-book-sf-tree: %d nodes had no usable move (skipped)\n", failed)
	}

	if err := book.Write(*out, entries); err != nil {
		fmt.Fprintln(os.Stderr, "compile-book-sf-tree:", err)
		os.Exit(1)
	}
	fmt.Printf("compile-book-sf-tree: wrote %d positions → %s (engineVersion=%d, %s)\n",
		len(entries), *out, book.EngineVersion, time.Since(t0).Round(time.Second))
}
