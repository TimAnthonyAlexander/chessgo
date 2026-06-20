package search

import (
	"sync/atomic"
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

// ttEntry is the UNPACKED view of a table slot, returned by probe.
type ttEntry struct {
	key   uint64
	move  chess.Move
	score int16
	depth int8
	flag  ttFlag
	age   uint8
}

// ttSlot is the stored form: two atomic words using Hyatt's lockless XOR scheme.
// `data` packs move/score/depth/flag/age into 64 bits; `lock` stores key^data.
// A reader that observes a torn pair (data from one write, lock from another)
// computes lock^data != key and treats it as a miss — so concurrent access is
// safe without locks, at the cost of the occasional benign miss. Single-threaded
// access is always consistent, so behavior is identical to a plain table.
//
//	bits  0-31  move (uint32)
//	bits 32-47  score (int16)
//	bits 48-55  depth (uint8, 0..127)
//	bits 56-57  flag  (2 bits)
//	bits 58-63  age   (6 bits, wraps — only a replacement heuristic)
type ttSlot struct {
	lock atomic.Uint64
	data atomic.Uint64
}

func packData(move chess.Move, score int16, depth int8, flag ttFlag, age uint8) uint64 {
	return uint64(uint32(move)) |
		uint64(uint16(score))<<32 |
		uint64(uint8(depth))<<48 |
		uint64(flag&0x3)<<56 |
		uint64(age&0x3F)<<58
}

func unpackData(data uint64) (move chess.Move, score int16, depth int8, flag ttFlag, age uint8) {
	move = chess.Move(uint32(data))
	score = int16(uint16(data >> 32))
	depth = int8(uint8(data >> 48))
	flag = ttFlag((data >> 56) & 0x3)
	age = uint8((data >> 58) & 0x3F)
	return
}

// TT is a fixed-size, power-of-two, lock-free transposition table with
// depth-preferred, age-aware replacement.
type TT struct {
	slots []ttSlot
	mask  uint64
	age   uint8 // bumped once per search BEFORE any worker starts (then read-only)
}

// NewTT allocates a table of approximately sizeMB megabytes (rounded down to a
// power-of-two slot count).
func NewTT(sizeMB int) *TT {
	if sizeMB < 1 {
		sizeMB = 1
	}
	slotBytes := int(unsafe.Sizeof(ttSlot{}))
	n := (sizeMB * 1024 * 1024) / slotBytes
	size := 1
	for size*2 <= n {
		size *= 2
	}
	return &TT{slots: make([]ttSlot, size), mask: uint64(size - 1)}
}

// NewSearchAge bumps the generation counter so the next search prefers fresh
// entries. Must be called single-threaded, before any parallel worker starts.
func (tt *TT) NewSearchAge() { tt.age++ }

// Clear zeroes the table.
func (tt *TT) Clear() {
	for i := range tt.slots {
		tt.slots[i].data.Store(0)
		tt.slots[i].lock.Store(0)
	}
	tt.age = 0
}

func (tt *TT) probe(key uint64) (ttEntry, bool) {
	slot := &tt.slots[key&tt.mask]
	data := slot.data.Load()
	if data == 0 {
		return ttEntry{}, false
	}
	lock := slot.lock.Load()
	if lock^data != key {
		return ttEntry{}, false // empty, different key, or torn read
	}
	move, score, depth, flag, age := unpackData(data)
	if flag == ttNone {
		return ttEntry{}, false
	}
	return ttEntry{key: key, move: move, score: score, depth: depth, flag: flag, age: age}, true
}

// store writes an entry, adjusting mate scores to be relative to the current
// node (ply-independent on disk). Depth-preferred within the same generation.
func (tt *TT) store(key uint64, move chess.Move, score, depth, ply int, flag ttFlag) {
	if depth > 127 {
		depth = 127
	}
	slot := &tt.slots[key&tt.mask]

	// Depth-preferred replacement: keep a deeper same-generation entry of the
	// same key. (Read may be slightly stale under races — it is only a heuristic.)
	if old := slot.data.Load(); old != 0 {
		if slot.lock.Load()^old == key {
			_, _, oldDepth, _, oldAge := unpackData(old)
			if oldAge == (tt.age&0x3F) && int(oldDepth) > depth {
				return
			}
		}
	}

	sc := score
	if sc > tbThreshold {
		sc += ply
	} else if sc < -tbThreshold {
		sc -= ply
	}
	data := packData(move, int16(sc), int8(depth), flag, tt.age)
	slot.data.Store(data)
	slot.lock.Store(key ^ data)
}

// scoreFromTT converts a stored score back to the current node's ply frame.
func (e ttEntry) scoreFromTT(ply int) int {
	sc := int(e.score)
	if sc > tbThreshold {
		sc -= ply
	} else if sc < -tbThreshold {
		sc += ply
	}
	return sc
}
