package main

import (
	"flag"
	"fmt"
	"os"
	"sort"
	"time"

	"github.com/timanthonyalexander/gomachine/internal/bench"
	"github.com/timanthonyalexander/gomachine/internal/book"
	"github.com/timanthonyalexander/gomachine/internal/chess"
	"github.com/timanthonyalexander/gomachine/internal/engine"
)

// cmdBookDiff compares two opening books MOVE-by-move and quantifies the contrast.
//
// The books store each engine's own eval, and HCE cp ≠ NNUE cp (different scales),
// so a raw stored-Score diff is meaningless. Instead, for every position where the
// two books pick a DIFFERENT best move, we put both candidate moves on ONE common
// yardstick: search each resulting child at a fixed depth with the CURRENT engine
// (v9, via loadEnrichedDefault) and — for the biggest-contrast cases — with
// Stockfish. The reported delta is (new-move eval − old-move eval) from the mover's
// POV, in that judge's centipawns: positive ⇒ the new book's move is objectively
// better. Position FENs come from re-enumerating the same opening lines the book
// was built from (book entries are Zobrist-keyed, no FEN stored).
func cmdBookDiff(args []string) {
	fs := flag.NewFlagSet("book-diff", flag.ExitOnError)
	oldPath := fs.String("old", "data/book.bin", "old book (.bin)")
	newPath := fs.String("new", "data/book_new.bin", "new book (.bin)")
	openings := fs.String("openings", "data/openings", "dir of Lichess opening TSVs (must match the compile)")
	maxPlies := fs.Int("maxplies", 12, "opening plies to enumerate (must match the compile)")
	depth := fs.Int("depth", 16, "fixed search depth for OUR (v9) per-move eval")
	sfPath := fs.String("sf", "stockfish", "stockfish binary for the external check (\"\" to skip)")
	sfDepth := fs.Int("sf-depth", 20, "fixed depth for the Stockfish check")
	sfTop := fs.Int("sf-top", 25, "run Stockfish on this many of the biggest +Δ and −Δ disagreements each")
	_ = fs.Parse(args)

	// Our per-move eval must use the SAME net prod plays with (v9 lean-threats).
	loadEnrichedDefault()

	// 1. Re-enumerate the opening positions → key→FEN (books are keyed by Zobrist).
	positions := map[uint64]string{}
	start, _ := chess.ParseFEN(chess.StartFEN)
	positions[start.Key()] = chess.StartFEN
	lines, err := readOpeningLines(*openings)
	if err != nil {
		fmt.Fprintln(os.Stderr, "book-diff:", err)
		os.Exit(1)
	}
	for _, sans := range lines {
		collectLine(sans, *maxPlies, positions)
	}

	oldBook, err := book.Load(*oldPath)
	if err != nil || oldBook == nil {
		fmt.Fprintln(os.Stderr, "book-diff: load old:", err)
		os.Exit(1)
	}
	newBook, err := book.Load(*newPath)
	if err != nil || newBook == nil {
		fmt.Fprintln(os.Stderr, "book-diff: load new:", err)
		os.Exit(1)
	}

	// 2. Find move-disagreements (scale-independent).
	type diff struct {
		fen              string
		oldUCI, newUCI   string
		oldSAN, newSAN   string
		dOurs            int // newEval − oldEval, mover POV, OUR cp
		dSF              int // same, Stockfish cp (0 if not evaluated)
		sfDone           bool
	}
	var diffs []diff
	shared := 0
	for key, fen := range positions {
		oe, ok1 := oldBook.Lookup(key)
		ne, ok2 := newBook.Lookup(key)
		if !ok1 || !ok2 || len(oe.PV) == 0 || len(ne.PV) == 0 {
			continue
		}
		shared++
		if oe.PV[0] == ne.PV[0] {
			continue
		}
		diffs = append(diffs, diff{
			fen: fen, oldUCI: oe.PV[0], newUCI: ne.PV[0],
			oldSAN: sanOf(fen, oe.PV[0]), newSAN: sanOf(fen, ne.PV[0]),
		})
	}

	fmt.Printf("book-diff: %d shared positions, %d move-disagreements (%.1f%%)\n",
		shared, len(diffs), 100*float64(len(diffs))/float64(max(shared, 1)))
	if len(diffs) == 0 {
		return
	}

	// 3. Our (v9) eval of both moves at every disagreement (cheap; fixed depth).
	eng := engine.New(64)
	t0 := time.Now()
	for i := range diffs {
		on := ourMoveEval(eng, diffs[i].fen, diffs[i].oldUCI, *depth)
		nn := ourMoveEval(eng, diffs[i].fen, diffs[i].newUCI, *depth)
		diffs[i].dOurs = nn - on
		if (i+1)%50 == 0 || i+1 == len(diffs) {
			fmt.Printf("\r  our-eval %d/%d (%.0fs)", i+1, len(diffs), time.Since(t0).Seconds())
		}
	}
	fmt.Println()

	// Aggregate on OUR yardstick (the full set).
	betterN, worseN, evenN, sum := 0, 0, 0, 0
	for _, d := range diffs {
		sum += d.dOurs
		switch {
		case d.dOurs > 10:
			betterN++
		case d.dOurs < -10:
			worseN++
		default:
			evenN++
		}
	}
	sort.Slice(diffs, func(i, j int) bool { return diffs[i].dOurs > diffs[j].dOurs })
	median := diffs[len(diffs)/2].dOurs
	fmt.Printf("\n=== OUR (v9) verdict over all %d disagreements ===\n", len(diffs))
	fmt.Printf("  new better (>+10cp): %d   worse (<−10cp): %d   ~even: %d\n", betterN, worseN, evenN)
	fmt.Printf("  mean Δ %+.1f cp   median Δ %+d cp   (Δ = new-move eval − old-move eval, mover POV)\n",
		float64(sum)/float64(len(diffs)), median)

	// 4. Stockfish check on the biggest +Δ and −Δ cases.
	idx := pickExtremes(len(diffs), *sfTop)
	if *sfPath != "" && len(idx) > 0 {
		sf, err := bench.StartUCI(*sfPath, map[string]string{"Threads": "1", "Hash": "256"})
		if err != nil {
			fmt.Fprintln(os.Stderr, "  (stockfish unavailable:", err, "— skipping external check)")
		} else {
			defer sf.Close()
			for _, i := range idx {
				oc := sfMoveEval(sf, diffs[i].fen, diffs[i].oldUCI, *sfDepth)
				nc := sfMoveEval(sf, diffs[i].fen, diffs[i].newUCI, *sfDepth)
				diffs[i].dSF = nc - oc
				diffs[i].sfDone = true
			}
		}
	}

	// 5. Report the top contrasts (new most-better, then new most-worse).
	printTop := func(title string, rows []int) {
		fmt.Printf("\n%s\n", title)
		fmt.Printf("  %-4s %-6s %-6s %-8s %-8s  %s\n", "Δv9", "old", "new", "Δstock", "", "FEN")
		for _, i := range rows {
			d := diffs[i]
			sf := "   —"
			if d.sfDone {
				sf = fmt.Sprintf("%+5d", d.dSF)
			}
			fmt.Printf("  %+4d %-6s %-6s %-8s        %s\n", d.dOurs, d.oldSAN, d.newSAN, sf, d.fen)
		}
	}
	nTop := min(*sfTop, len(diffs))
	head := make([]int, 0, nTop)
	for i := 0; i < nTop; i++ {
		head = append(head, i)
	}
	tail := make([]int, 0, nTop)
	for i := len(diffs) - nTop; i < len(diffs); i++ {
		if i >= 0 {
			tail = append(tail, i)
		}
	}
	printTop("=== new book's move MOST BETTER (v9 cp) ===", head)
	printTop("=== new book's move MOST WORSE (v9 cp) ===", tail)
}

// pickExtremes returns the indices of the top-n and bottom-n of a sorted slice.
func pickExtremes(n, k int) []int {
	if k*2 >= n {
		out := make([]int, n)
		for i := range out {
			out[i] = i
		}
		return out
	}
	out := make([]int, 0, 2*k)
	for i := 0; i < k; i++ {
		out = append(out, i)
	}
	for i := n - k; i < n; i++ {
		out = append(out, i)
	}
	return out
}

// ourMoveEval plays uci from fen and returns the resulting position's eval from
// the MOVER's POV (centipawns, v9), searched to a fixed depth.
func ourMoveEval(eng *engine.Engine, fen, uci string, depth int) int {
	pos, err := chess.ParseFEN(fen)
	if err != nil {
		return 0
	}
	m, ok := pos.ParseUCIMove(uci)
	if !ok {
		return 0
	}
	var u chess.Undo
	pos.DoMove(m, &u)
	res := eng.SearchDirect(pos, depth, 0, nil) // child: opponent to move
	return -res.Score                           // flip to the mover's POV
}

// sfMoveEval is ourMoveEval's Stockfish counterpart: Stockfish's eval of the child
// (fen + uci) at a fixed depth, flipped to the mover's POV.
func sfMoveEval(sf *bench.UCIEngine, fen, uci string, depth int) int {
	cp, err := sf.Evaluate(fen, []string{uci}, bench.UCIBudget{Depth: depth})
	if err != nil {
		return 0
	}
	return -cp
}

// sanOf renders uci as SAN from fen (falls back to the UCI string).
func sanOf(fen, uci string) string {
	pos, err := chess.ParseFEN(fen)
	if err != nil {
		return uci
	}
	m, ok := pos.ParseUCIMove(uci)
	if !ok {
		return uci
	}
	return pos.SAN(m)
}
