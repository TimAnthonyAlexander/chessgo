package search

import (
	"unsafe"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// ttFlag is the bound type of a stored score.
type ttFlag uint8

const (
	ttNone ttFlag = iota
	ttExact
	ttLower // fail-high: score is a lower bound
	ttUpper // fail-low: score is an upper bound
)

// ttEntry is a transposition-table slot (SPEC §4.6). Full key stored for
// correctness in v1.
type ttEntry struct {
	key   uint64
	move  chess.Move
	score int16
	depth int8
	flag  ttFlag
	age   uint8
}

// TT is a fixed-size, power-of-two transposition table with depth-preferred,
// age-aware replacement.
type TT struct {
	entries []ttEntry
	mask    uint64
	age     uint8
}

// NewTT allocates a table of approximately sizeMB megabytes (rounded down to a
// power-of-two entry count).
func NewTT(sizeMB int) *TT {
	if sizeMB < 1 {
		sizeMB = 1
	}
	entryBytes := int(unsafe.Sizeof(ttEntry{}))
	n := (sizeMB * 1024 * 1024) / entryBytes
	size := 1
	for size*2 <= n {
		size *= 2
	}
	return &TT{entries: make([]ttEntry, size), mask: uint64(size - 1)}
}

// NewSearchAge bumps the generation counter so the next search prefers fresh
// entries over stale ones.
func (tt *TT) NewSearchAge() { tt.age++ }

// Clear zeroes the table.
func (tt *TT) Clear() {
	for i := range tt.entries {
		tt.entries[i] = ttEntry{}
	}
	tt.age = 0
}

func (tt *TT) probe(key uint64) (ttEntry, bool) {
	e := tt.entries[key&tt.mask]
	if e.flag != ttNone && e.key == key {
		return e, true
	}
	return ttEntry{}, false
}

// store writes an entry, adjusting mate scores to be relative to the current
// node (ply-independent on disk).
func (tt *TT) store(key uint64, move chess.Move, score, depth, ply int, flag ttFlag) {
	if depth > 127 {
		depth = 127
	}
	e := &tt.entries[key&tt.mask]
	// Depth-preferred replacement: keep a deeper entry of the same key from the
	// current search; otherwise overwrite.
	if e.flag != ttNone && e.key == key && e.age == tt.age && e.depth > int8(depth) {
		return
	}
	sc := score
	if sc > mateThreshold {
		sc += ply
	} else if sc < -mateThreshold {
		sc -= ply
	}
	e.key = key
	e.move = move
	e.score = int16(sc)
	e.depth = int8(depth)
	e.flag = flag
	e.age = tt.age
}

// scoreFromTT converts a stored score back to the current node's ply frame.
func (e ttEntry) scoreFromTT(ply int) int {
	sc := int(e.score)
	if sc > mateThreshold {
		sc -= ply
	} else if sc < -mateThreshold {
		sc += ply
	}
	return sc
}
