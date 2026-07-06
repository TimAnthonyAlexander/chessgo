package search

import (
	"testing"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// ttBucketFENs — a small spread of tactical/positional FENs for the cluster-on
// search sanity checks.
var ttBucketFENs = []string{
	chess.StartFEN,
	"r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1",
	"r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3",
	"8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1",
	"4k3/8/8/8/7q/8/8/4K2R w - - 0 1",
}

// TestTTBucketDirectMappedMapping confirms that a shift-0 table is the classic
// direct-mapped layout: one slot per key at index (key & (slots-1)), the same
// single-slot mapping the pre-bucketing table used (byte-identical addressing).
func TestTTBucketDirectMappedMapping(t *testing.T) {
	tt := NewTT(16, 0)
	if tt.bucketShift != 0 {
		t.Fatalf("shift-0 table has bucketShift=%d, want 0", tt.bucketShift)
	}
	sz := uint64(len(tt.slots))
	if tt.bucketMask != sz-1 {
		t.Fatalf("shift-0 bucketMask=%d, want slots-1=%d", tt.bucketMask, sz-1)
	}
	// A stored key must land in exactly slots[key & (slots-1)] and nowhere else.
	key := uint64(0xDEADBEEFCAFEBABE)
	tt.store(key, chess.Move(0x123), 42, 5, 0, ttExact, ttEvalNone)
	want := key & (sz - 1)
	nonEmpty := 0
	var got uint64
	for i := range tt.slots {
		if tt.slots[i].data.Load() != 0 {
			nonEmpty++
			got = uint64(i)
		}
	}
	if nonEmpty != 1 || got != want {
		t.Fatalf("shift-0 store touched %d slots (last idx %d), want exactly 1 at %d", nonEmpty, got, want)
	}
	if e, ok := tt.probe(key); !ok || e.move != chess.Move(0x123) || e.depth != 5 {
		t.Fatalf("shift-0 probe roundtrip failed: ok=%v e=%+v", ok, e)
	}
}

// TestTTBucketMultiKeyRetention is the core bucketing test: four DISTINCT keys
// that map to the SAME bucket (they share the low index bits, differing only in
// bits at/above log2(slots)). A shift-0 direct-mapped table collides all four on
// one slot and keeps only the last; the shift-2 bucketed table places them in the
// four independent slots of the shared cache line and retrieves all four.
func TestTTBucketMultiKeyRetention(t *testing.T) {
	bucketed := NewTT(16, 2)
	if bucketed.bucketShift != 2 {
		t.Fatalf("shift-2 table has bucketShift=%d, want 2", bucketed.bucketShift)
	}
	sz := uint64(len(bucketed.slots))

	// Keys differ only by multiples of the slot count, so key&(slots-1) (the
	// direct-mapped index) and key&bucketMask (the bucket index) are all identical
	// — same direct-mapped slot AND same bucket.
	const c = uint64(1234567)
	var keys [4]uint64
	for i := range keys {
		keys[i] = c + uint64(i)*sz
	}
	// Sanity: all share the bucket index but are distinct keys.
	for i := 1; i < len(keys); i++ {
		if keys[i]&bucketed.bucketMask != keys[0]&bucketed.bucketMask {
			t.Fatalf("test setup: keys[%d] not in the same bucket as keys[0]", i)
		}
		if keys[i] == keys[0] {
			t.Fatalf("test setup: keys[%d] not distinct", i)
		}
	}

	for i, k := range keys {
		bucketed.store(k, chess.Move(1000+i), 10+i, 4+i, 0, ttExact, ttEvalNone)
	}
	// All four must probe back with their own move/depth.
	for i, k := range keys {
		e, ok := bucketed.probe(k)
		if !ok {
			t.Fatalf("bucketed: key[%d] evicted — 4-slot scan should retain all four", i)
		}
		if e.move != chess.Move(1000+i) || e.depth != int8(4+i) {
			t.Fatalf("bucketed: key[%d] wrong entry: move=%v depth=%d", i, e.move, e.depth)
		}
	}

	// Direct-mapped: the same four keys collide on one slot; only the last written
	// survives (distinct keys → unconditional overwrite).
	direct := NewTT(16, 0)
	for i, k := range keys {
		direct.store(k, chess.Move(1000+i), 10+i, 4+i, 0, ttExact, ttEvalNone)
	}
	survivors := 0
	for _, k := range keys {
		if _, ok := direct.probe(k); ok {
			survivors++
		}
	}
	if survivors != 1 {
		t.Fatalf("direct-mapped kept %d of 4 same-slot keys, want 1 (the demonstration of bucket retention)", survivors)
	}
	if _, ok := direct.probe(keys[3]); !ok {
		t.Fatalf("direct-mapped should retain the LAST-written key")
	}
}

// TestTTBucketVictimPrefersEmptyThenShallow checks store's victim policy inside a
// full bucket: same-key replace, then empty slots, then the shallowest / oldest
// entry.
func TestTTBucketVictimSelection(t *testing.T) {
	tt := NewTT(16, 2)
	sz := uint64(len(tt.slots))
	const c = uint64(42)
	k := func(i int) uint64 { return c + uint64(i)*sz } // all share one bucket

	// Fill the 4-slot bucket with depths 8,6,4,2 (keys 0..3).
	depths := []int{8, 6, 4, 2}
	for i, d := range depths {
		tt.store(k(i), chess.Move(200+i), 0, d, 0, ttExact, ttEvalNone)
	}
	// A same-key store with GREATER depth must replace in place (not consume a victim).
	tt.store(k(1), chess.Move(999), 0, 20, 0, ttExact, ttEvalNone)
	if e, ok := tt.probe(k(1)); !ok || e.depth != 20 || e.move != chess.Move(999) {
		t.Fatalf("same-key deeper store did not replace in place: ok=%v e=%+v", ok, e)
	}
	// A same-key store with LOWER depth (same generation) must be rejected (guard).
	tt.store(k(1), chess.Move(111), 0, 3, 0, ttExact, ttEvalNone)
	if e, _ := tt.probe(k(1)); e.depth != 20 {
		t.Fatalf("shallower same-gen same-key store overwrote a deeper entry (depth now %d)", e.depth)
	}
	// A brand-new key (5th) into the full bucket must evict the SHALLOWEST entry
	// (depth 2, key index 3) and leave the deeper entries intact.
	newKey := k(4)
	tt.store(newKey, chess.Move(777), 0, 9, 0, ttExact, ttEvalNone)
	if _, ok := tt.probe(newKey); !ok {
		t.Fatalf("new key not stored into a full bucket")
	}
	if _, ok := tt.probe(k(3)); ok {
		t.Fatalf("full-bucket store did not evict the shallowest entry (depth 2)")
	}
	for _, i := range []int{0, 1} { // depths 8 and (now) 20 must survive
		if _, ok := tt.probe(k(i)); !ok {
			t.Fatalf("full-bucket store wrongly evicted a deep entry key[%d]", i)
		}
	}
}

// TestTTBucketSearchSane runs a real search with the bucketed TT enabled and
// asserts it completes, returns a legal best move, and a sane (non-mate-garbage)
// score on a spread of FENs — the behavior gate for cluster=on.
func TestTTBucketSearchSane(t *testing.T) {
	p := DefaultParams()
	p.TTBucketShift = 2
	for _, fen := range ttBucketFENs {
		pos, err := chess.ParseFEN(fen)
		if err != nil {
			t.Fatalf("parse %q: %v", fen, err)
		}
		r := NewWithParams(16, p).Search(pos, Limits{Depth: 10}, nil)
		if r.BestMove == chess.NullMove {
			t.Fatalf("%s: cluster search returned no move", fen)
		}
		if !isLegalMove(pos, r.BestMove) {
			t.Fatalf("%s: cluster search returned illegal move %s", fen, r.BestMove)
		}
		if r.Score > mateScore || r.Score < -mateScore {
			t.Fatalf("%s: cluster search returned corrupt score %d", fen, r.Score)
		}
	}
}

// TestTTBucketParallelSearchSane stresses the shared bucketed TT across Lazy-SMP
// workers: the shift is fixed at table creation, so all workers scan the same
// cluster layout. Must terminate cleanly with a legal move.
func TestTTBucketParallelSearchSane(t *testing.T) {
	p := DefaultParams()
	p.TTBucketShift = 2
	pos, _ := chess.ParseFEN("r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1")
	r := NewWithParams(32, p).SearchParallel(pos, Limits{Nodes: 200000}, nil, 4)
	if r.BestMove == chess.NullMove {
		t.Fatal("parallel cluster search returned no move")
	}
	if !isLegalMove(pos, r.BestMove) {
		t.Fatalf("parallel cluster search returned illegal move %s", r.BestMove)
	}
}

func isLegalMove(pos *chess.Position, m chess.Move) bool {
	var ml chess.MoveList
	pos.GenerateLegal(&ml)
	for i := 0; i < ml.Len(); i++ {
		if ml.Get(i) == m {
			return true
		}
	}
	return false
}
