package main

import (
	"flag"
	"fmt"
	"os"

	"github.com/timanthonyalexander/gomachine/internal/book"
)

// cmdMergeBooks unions two books ADDITIVELY: every entry of --base is kept exactly
// as-is, and an entry of --overlay is added only for a key --base does NOT already
// have. The result is a strict superset of --base (base ∪ (overlay \ base)), so by
// the book's monotonicity (a hit is a zero-cost pre-search lookup; more entries can
// only help or be neutral) the merged book is guaranteed ≥ base.
//
// Use it to graft a broad Stockfish TREE book's coverage onto the validated flat
// book WITHOUT replacing any of the flat book's (deeper-searched) main-line moves:
//
//	gomachine merge-books --base data/book.bin --overlay data/book_sf_tree.bin --out data/book_merged.bin
func cmdMergeBooks(args []string) {
	fs := flag.NewFlagSet("merge-books", flag.ExitOnError)
	basePath := fs.String("base", "data/book.bin", "book kept verbatim; wins every key conflict")
	overlayPath := fs.String("overlay", "data/book_sf_tree.bin", "book whose entries are added only for keys base lacks")
	out := fs.String("out", "data/book_merged.bin", "output merged book")
	_ = fs.Parse(args)

	base, err := book.Load(*basePath)
	if err != nil || base == nil {
		fmt.Fprintln(os.Stderr, "merge-books: load base:", err)
		os.Exit(1)
	}
	overlay, err := book.Load(*overlayPath)
	if err != nil || overlay == nil {
		fmt.Fprintln(os.Stderr, "merge-books: load overlay:", err)
		os.Exit(1)
	}

	baseEntries := base.Entries()
	seen := make(map[uint64]bool, len(baseEntries))
	merged := make([]book.Entry, 0, len(baseEntries)+overlay.Len())
	for _, e := range baseEntries {
		seen[e.Key] = true
		merged = append(merged, e)
	}
	added := 0
	for _, e := range overlay.Entries() {
		if seen[e.Key] {
			continue // base wins the conflict — keep its (deeper) move
		}
		seen[e.Key] = true
		merged = append(merged, e)
		added++
	}

	if err := book.Write(*out, merged); err != nil {
		fmt.Fprintln(os.Stderr, "merge-books:", err)
		os.Exit(1)
	}
	fmt.Printf("merge-books: base %d + overlay %d → added %d new → %d total (%s)\n",
		len(baseEntries), overlay.Len(), added, len(merged), *out)
}
