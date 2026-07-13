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

// ttEvalNone is the stored sentinel for "no static eval cached" (a node that was
// in check stores no eval). It sits well outside any real static-eval magnitude,
// so it can never collide with a genuine cached value.
const ttEvalNone = int16(-32768)

// ttEntry is the UNPACKED view of a table slot, returned by probe.
type ttEntry struct {
	key   uint64
	move  chess.Move
	score int16
	eval  int16 // cached static eval (ttEvalNone when none was stored)
	depth int8
	flag  ttFlag
	age   uint8
}

// ttSlot is the stored form: two atomic words using Hyatt's lockless XOR scheme.
// `data` packs move/score/eval/depth/flag/age into 64 bits; `lock` stores key^data.
// A reader that observes a torn pair (data from one write, lock from another)
// computes lock^data != key and treats it as a miss — so concurrent access is
// safe without locks, at the cost of the occasional benign miss. Single-threaded
// access is always consistent, so behavior is identical to a plain table.
//
// A chess Move occupies only its low 16 bits (from6|to6|type2|promo2), so it
// packs into 16 bits here, freeing room for the cached static eval — the slot
// stays two words (no memory growth, lock-free scheme unchanged).
//
//	bits  0-15  move  (uint16)
//	bits 16-31  score (int16)
//	bits 32-47  eval  (int16, cached static eval; ttEvalNone = none)
//	bits 48-55  depth (uint8, 0..127)
//	bits 56-57  flag  (2 bits)
//	bits 58-63  age   (6 bits, wraps — only a replacement heuristic)
type ttSlot struct {
	lock atomic.Uint64
	data atomic.Uint64
}

func packData(move chess.Move, score, eval int16, depth int8, flag ttFlag, age uint8) uint64 {
	return uint64(uint16(move)) |
		uint64(uint16(score))<<16 |
		uint64(uint16(eval))<<32 |
		uint64(uint8(depth))<<48 |
		uint64(flag&0x3)<<56 |
		uint64(age&0x3F)<<58
}

func unpackData(data uint64) (move chess.Move, score, eval int16, depth int8, flag ttFlag, age uint8) {
	move = chess.Move(uint16(data))
	score = int16(uint16(data >> 16))
	eval = int16(uint16(data >> 32))
	depth = int8(uint8(data >> 48))
	flag = ttFlag((data >> 56) & 0x3)
	age = uint8((data >> 58) & 0x3F)
	return
}

// TT is a fixed-size, power-of-two, lock-free transposition table with
// depth-preferred, age-aware replacement.
//
// Bucketing (bucketShift): the table is addressed as numBuckets = slots>>bucketShift
// clusters of (1<<bucketShift) slots each. A key selects a bucket via bucketMask and
// its base slot index is (key & bucketMask) << bucketShift; probe scans all slots in
// the bucket (already resident in the same 64-byte cache line for a 4-slot cluster),
// and store picks the best victim of the bucket. bucketShift==0 is the classic
// direct-mapped table (one slot per key, bucketMask == slots-1) and is byte-identical
// to the pre-bucketing behavior. Each slot stays independently self-consistent via
// the Hyatt XOR scheme, so scanning several slots is race-safe.
type TT struct {
	slots       []ttSlot
	bucketMask  uint64 // (numBuckets - 1); selects the bucket index
	bucketShift uint   // log2(slots per bucket): 0 = direct-mapped, 2 = 4-slot clusters
	age         uint8  // bumped once per search BEFORE any worker starts (then read-only)
}

// NewTT allocates a table of approximately sizeMB megabytes (rounded down to a
// power-of-two slot count). bucketShift sets the cluster width (0 = direct-mapped,
// 2 = 4 slots per 64-byte line); total memory is independent of it. The shift is
// clamped down if the table is too small to hold at least one bucket.
func NewTT(sizeMB int, bucketShift uint) *TT {
	if sizeMB < 1 {
		sizeMB = 1
	}
	slotBytes := int(unsafe.Sizeof(ttSlot{}))
	n := (sizeMB * 1024 * 1024) / slotBytes
	size := 1
	for size*2 <= n {
		size *= 2
	}
	for bucketShift > 0 && (size>>bucketShift) < 1 {
		bucketShift-- // pathologically tiny table: shrink the cluster to fit
	}
	numBuckets := size >> bucketShift
	slots := make([]ttSlot, size)
	// Back the large, randomly-accessed table with transparent huge pages where the
	// OS is in THP=madvise mode (our amd64 boxes) — cuts TLB misses on probe/store.
	// Advisory and byte-identical: changes only page backing, never table contents.
	adviseHugePages(unsafe.Pointer(&slots[0]), uintptr(size)*unsafe.Sizeof(ttSlot{}))
	return &TT{
		slots:       slots,
		bucketMask:  uint64(numBuckets - 1),
		bucketShift: bucketShift,
	}
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

// prefetch brings the slot for key toward L1 ahead of a probe, hiding the memory
// latency of the (large, randomly-accessed) table. Cheap PREFETCHT0 on amd64,
// no-op elsewhere. Bit-exact: a prefetch never changes results.
func (tt *TT) prefetch(key uint64) {
	// Prefetch the bucket's base slot — the line covering all slots in the cluster.
	base := (key & tt.bucketMask) << tt.bucketShift
	ttPrefetchT0(unsafe.Pointer(&tt.slots[base]))
}

func (tt *TT) probe(key uint64) (ttEntry, bool) {
	base := (key & tt.bucketMask) << tt.bucketShift
	n := uint64(1) << tt.bucketShift
	for i := uint64(0); i < n; i++ {
		slot := &tt.slots[base+i]
		data := slot.data.Load()
		if data == 0 {
			continue // empty slot
		}
		lock := slot.lock.Load()
		if lock^data != key {
			continue // different key or torn read
		}
		move, score, eval, depth, flag, age := unpackData(data)
		if flag == ttNone {
			continue
		}
		return ttEntry{key: key, move: move, score: score, eval: eval, depth: depth, flag: flag, age: age}, true
	}
	return ttEntry{}, false
}

// store writes an entry, adjusting mate scores to be relative to the current
// node (ply-independent on disk). Depth-preferred within the same generation.
// eval is the node's cached static eval (ttEvalNone when none — e.g. in check).
func (tt *TT) store(key uint64, move chess.Move, score, depth, ply int, flag ttFlag, eval int16) {
	if depth > 127 {
		depth = 127
	}
	base := (key & tt.bucketMask) << tt.bucketShift
	n := uint64(1) << tt.bucketShift

	// Choose the slot to write within the bucket:
	//  1. Same-key slot → replace it (keeping the existing depth-preferred,
	//     same-generation guard: a deeper same-gen entry of this key is kept).
	//  2. Else an empty slot (data==0), if any.
	//  3. Else the lowest-priority victim, where a slot's replacement priority is
	//     its depth, DISCOUNTED by 8 when it belongs to an OLDER generation
	//     (age != tt.age) — stale entries are cheaper to evict, and the discount
	//     also breaks depth ties toward the older generation. argmin over the
	//     bucket, first slot winning an exact tie.
	// (Reads may be slightly stale under races — replacement is only a heuristic;
	// each slot is written self-consistently via the Hyatt XOR pair below.)
	targetOff := uint64(0)
	if n > 1 {
		var (
			haveSameKey bool
			haveEmpty   bool
			victimOff   uint64
			victimPrio  int
			victimInit  bool
		)
		curGen := tt.age & 0x3F
		for i := uint64(0); i < n; i++ {
			slot := &tt.slots[base+i]
			old := slot.data.Load()
			if old == 0 {
				if !haveEmpty {
					haveEmpty = true
					victimOff = i // empty always wins victim selection
				}
				continue
			}
			_, _, _, oldDepth, _, oldAge := unpackData(old)
			if slot.lock.Load()^old == key {
				if oldAge == curGen && int(oldDepth) > depth {
					return // keep the deeper same-generation entry of this key
				}
				haveSameKey = true
				targetOff = i
				break
			}
			if !haveEmpty { // only rank victims until an empty slot is found
				prio := int(oldDepth)
				if oldAge != curGen {
					prio -= 8
				}
				if !victimInit || prio < victimPrio {
					victimInit = true
					victimPrio = prio
					victimOff = i
				}
			}
		}
		if !haveSameKey {
			targetOff = victimOff
		}
	} else {
		// Direct-mapped fast path (byte-identical to the pre-bucketing table):
		// depth-preferred same-generation guard on the single slot.
		if old := tt.slots[base].data.Load(); old != 0 {
			if tt.slots[base].lock.Load()^old == key {
				_, _, _, oldDepth, _, oldAge := unpackData(old)
				if oldAge == (tt.age&0x3F) && int(oldDepth) > depth {
					return
				}
			}
		}
	}

	slot := &tt.slots[base+targetOff]
	sc := score
	if sc > tbThreshold {
		sc += ply
	} else if sc < -tbThreshold {
		sc -= ply
	}
	data := packData(move, int16(sc), eval, int8(depth), flag, tt.age)
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
