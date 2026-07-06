package nnue

import (
	"fmt"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// EnrichedStack is the per-searcher, ply-indexed INCREMENTAL accumulator for an
// EnrichedNet — the movetime path that replaces the from-scratch Eval. Per node
// the threat feature set changes in hard-to-predict ways (a moved piece, sliders
// whose rays open/close, captures), so rather than reason about the move-aware
// delta (the classic accumulator-bug source) we exploit two measured facts:
//
//   - feature enumeration is cheap (~233 ns: attack-gen is NOT the bottleneck);
//   - chess.Position is a pure value type, so copy + DoMove is cheap.
//
// So Push copies the position, makes the move on the copy, re-enumerates the
// child's full feature set, and applies only the MULTISET DIFF vs the parent.
// The diff is computed with an O(n) COUNT ARRAY (not a sort — sorting ~112
// features/perspective measured ~540 ns, a quarter of the node): decrement counts
// for parent features, increment for child, then apply the net per-feature delta,
// touching only active indices and zeroing them back out. Correct by construction
// (it is the exact symmetric difference, multiplicity preserved), so the
// from-scratch assert is a formality, not a slider-delta minefield.
type EnrichedStack struct {
	net     *EnrichedNet
	data    []enrichedSlot
	backing []int16
	counts  []int16 // reusable per-feature count scratch (len net.InputDim), kept all-zero between Pushes
	sc      enrichedScratch
	sp      int

	// move-aware push (enriched_delta.go) scratch: the small per-move sub/add
	// feature lists for each perspective, reused across Pushes to avoid alloc.
	dsubW, daddW, dsubB, daddB []uint16

	// Lazy (deferred) materialization state, one entry per slot. When the net has
	// lazyEnabled(), Push enumerates the changed-edge deltas EAGERLY (cheap, uses the
	// live pre-move board) and stores them here, but defers the 2 KB parent-copy +
	// column-apply until ensure() is called. A subtree that never evaluates skips that
	// apply entirely. pendMove == chess.NullMove marks a null push (child == parent).
	// Unused when lazy is off. pSub*/pAdd* are per-slot so a deferred chain doesn't
	// clobber the shared scratch.
	pendMove             []chess.Move
	dirty                []bool
	pSubW, pAddW         [][]uint16
	pSubB, pAddB         [][]uint16

	// In-place (copy-free) accumulator: a single pair of halves that Push mutates by
	// the delta and Pop restores via the inverse delta. Used when net.inPlaceEnabled().
	accW, accB []int16

	// batchApply scratch: the threat-only (f>=PsqSize) partitions of one applyDiff
	// call's sub/add lists, reused per call to avoid alloc.
	batchSub, batchAdd []uint16
}

type enrichedSlot struct {
	w, b   []int16  // perspective accumulator halves (len H), into the shared backing
	fw, fb []uint16 // active features (White-persp, Black-persp); own backing, UNSORTED
}

// NewStack allocates an EnrichedStack deep enough for maxDepth plies.
func (n *EnrichedNet) NewStack(maxDepth int) *EnrichedStack {
	h := n.H
	slots := maxDepth + 1
	backing := make([]int16, slots*2*h)
	data := make([]enrichedSlot, slots)
	for i := 0; i < slots; i++ {
		off := i * 2 * h
		data[i].w = backing[off : off+h : off+h]
		data[i].b = backing[off+h : off+2*h : off+2*h]
		data[i].fw = make([]uint16, 0, maxEnrichedActive)
		data[i].fb = make([]uint16, 0, maxEnrichedActive)
	}
	const dcap = 4 * maxEnrichedActive // generous: base deltas + affected-attacker edges
	return &EnrichedStack{
		net: n, data: data, backing: backing, counts: make([]int16, n.InputDim), sc: n.newScratch(),
		dsubW: make([]uint16, 0, dcap), daddW: make([]uint16, 0, dcap),
		dsubB: make([]uint16, 0, dcap), daddB: make([]uint16, 0, dcap),
		pendMove: make([]chess.Move, slots), dirty: make([]bool, slots),
		pSubW: makeSliceBufs(slots, dcap), pAddW: makeSliceBufs(slots, dcap),
		pSubB: makeSliceBufs(slots, dcap), pAddB: makeSliceBufs(slots, dcap),
		accW: make([]int16, h), accB: make([]int16, h),
		batchSub: make([]uint16, 0, dcap), batchAdd: make([]uint16, 0, dcap),
	}
}

// makeSliceBufs allocates n reusable uint16 buffers of the given capacity (the
// per-slot deferred delta lists for the lazy accumulator path).
func makeSliceBufs(n, capElems int) [][]uint16 {
	bufs := make([][]uint16, n)
	for i := range bufs {
		bufs[i] = make([]uint16, 0, capElems)
	}
	return bufs
}

// Net returns the net this stack was built for (so the searcher can detect a swap).
func (st *EnrichedStack) Net() *EnrichedNet { return st.net }

// Reset rebuilds slot 0 from scratch for pos and points the stack at it.
func (st *EnrichedStack) Reset(pos *chess.Position) {
	st.sp = 0
	if st.net.inPlaceEnabled() {
		st.net.buildAcc(st.accW, st.accB, pos)
		return
	}
	s := &st.data[0]
	st.net.buildAcc(s.w, s.b, pos)
	s.fw, s.fb = appendEnrichedFeaturesBoth(s.fw[:0], s.fb[:0], pos)
	if st.net.lazy {
		for i := range st.dirty {
			st.dirty[i] = false // slot 0 is materialized; the rest are stale/unused
		}
	}
}

// ensure materializes slot k (and any dirty ancestors) when lazy is on. It finds
// the nearest clean ancestor and replays the deferred pushes bottom-up, so each
// slot is built from an already-materialized parent. No-op if slot k is clean.
func (st *EnrichedStack) ensure(k int) {
	if !st.dirty[k] {
		return
	}
	lo := k
	for lo > 0 && st.dirty[lo] {
		lo-- // lo lands on the nearest clean (materialized) ancestor
	}
	for j := lo + 1; j <= k; j++ {
		if !st.dirty[j] {
			continue
		}
		if st.pendMove[j] == chess.NullMove {
			// Null push: child accumulator == parent (no piece/occupancy change).
			copy(st.data[j].w, st.data[j-1].w)
			copy(st.data[j].b, st.data[j-1].b)
		} else {
			st.applyDelta(j, j-1, st.pSubW[j], st.pAddW[j], st.pSubB[j], st.pAddB[j])
		}
		st.dirty[j] = false
	}
}

// applyDiff applies the multiset symmetric difference (child − parent) to acc via
// the count-array scratch: features dropped from parent are subtracted, features
// gained in child are added, with multiplicity. O(len(parent)+len(child)); the
// counts slice is left all-zero for the next call.
func (st *EnrichedStack) applyDiff(acc []int16, parent, child []uint16) {
	net := st.net
	if net.batchApply && net.int8FT {
		// Batched threat-column apply (profile-driven): base-768 columns (few per
		// move) go through the per-column int16 path; the many int8 THREAT columns are
		// collected and applied in ONE accumulator load+store pass via applyThreatBatch
		// instead of one pass per column. Like directApply this applies every occurrence
		// (no counts cancellation) — bit-exact because int16 add/sub commute/associate.
		off := PsqSize
		sub := st.batchSub[:0]
		add := st.batchAdd[:0]
		for _, f := range parent {
			if int(f) >= off {
				sub = append(sub, f)
			} else {
				net.ftSub(acc, int(f))
			}
		}
		for _, f := range child {
			if int(f) >= off {
				add = append(add, f)
			} else {
				net.ftAdd(acc, int(f))
			}
		}
		applyThreatBatch(acc, net.W0t8, net.H, sub, add, off)
		st.batchSub, st.batchAdd = sub, add
		return
	}
	if net.directApply {
		// Skip the multiset-diff bookkeeping: subtract every "parent" (removed) edge
		// and add every "child" (new) edge directly. Bit-exact — int16 column adds
		// commute & associate, so ordering/cancellation don't change the final acc; we
		// only re-apply the net-zero pairs the diff would have skipped. Wins when the
		// changed-edge lists are near-disjoint (they usually are — a moved piece's old
		// and new attacks target different squares), so cancellation was rare and the
		// scattered 20 KB counts-array traffic was mostly pure overhead.
		for _, f := range parent {
			net.ftSub(acc, int(f))
		}
		for _, f := range child {
			net.ftAdd(acc, int(f))
		}
		return
	}
	c := st.counts
	for _, f := range parent {
		c[f]--
	}
	for _, f := range child {
		c[f]++
	}
	pf := net.prefetchCols
	apply := func(list []uint16) {
		for i := 0; i < len(list); i++ {
			f := list[i]
			// Prefetch the next feature's weight column while this one applies —
			// the delta lists (move-aware path) are small (changed edges only), so
			// this hides the scattered-column miss without over-prefetching.
			if pf && i+1 < len(list) {
				net.prefetchCol(int(list[i+1]))
			}
			d := c[f]
			if d == 0 {
				continue
			}
			fi := int(f)
			if d > 0 {
				for ; d > 0; d-- {
					net.ftAdd(acc, fi)
				}
			} else {
				for ; d < 0; d++ {
					net.ftSub(acc, fi)
				}
			}
			c[f] = 0 // mark handled (dups + leave counts zeroed for next call)
		}
	}
	apply(parent)
	apply(child)
}

// Push computes the child slot from its parent plus the move delta. Call it
// immediately BEFORE pos.DoMove (m is read from the PRE-move pos); the move is
// replayed on a cheap value-type copy to get the child's features.
func (st *EnrichedStack) Push(pos *chess.Position, m chess.Move) {
	if st.net.inPlaceEnabled() {
		// Copy-free: compute the delta, stash it for the inverse-undo on Pop, and
		// apply it forward to the single accumulator (subtract removed, add new).
		subW, addW, subB, addB := st.computeDelta(pos, m)
		k := st.sp + 1
		st.pSubW[k] = append(st.pSubW[k][:0], subW...)
		st.pAddW[k] = append(st.pAddW[k][:0], addW...)
		st.pSubB[k] = append(st.pSubB[k][:0], subB...)
		st.pAddB[k] = append(st.pAddB[k][:0], addB...)
		st.pendMove[k] = m
		st.applyDiff(st.accW, subW, addW)
		st.applyDiff(st.accB, subB, addB)
		st.sp++
		return
	}
	if st.net.lazyEnabled() {
		// Defer: enumerate the changed-edge delta now (cheap, uses the live board),
		// stash it per-slot, and mark dirty. The 2 KB parent-copy + column-apply is
		// deferred to ensure() and skipped if this subtree never evaluates.
		subW, addW, subB, addB := st.computeDelta(pos, m)
		k := st.sp + 1
		st.pSubW[k] = append(st.pSubW[k][:0], subW...)
		st.pAddW[k] = append(st.pAddW[k][:0], addW...)
		st.pSubB[k] = append(st.pSubB[k][:0], subB...)
		st.pAddB[k] = append(st.pAddB[k][:0], addB...)
		st.pendMove[k] = m
		st.dirty[k] = true
		st.sp++
		return
	}
	if st.net.moveAware {
		st.pushMoveAware(pos, m)
		return
	}
	src := &st.data[st.sp]
	dst := &st.data[st.sp+1]
	copy(dst.w, src.w)
	copy(dst.b, src.b)

	child := *pos
	var u chess.Undo
	child.DoMove(m, &u)

	dst.fw, dst.fb = appendEnrichedFeaturesBoth(dst.fw[:0], dst.fb[:0], &child)
	st.applyDiff(dst.w, src.fw, dst.fw)
	st.applyDiff(dst.b, src.fb, dst.fb)
	st.sp++
}

// PushNull duplicates the top slot — a null move changes no piece placement or
// occupancy, so neither the accumulator nor the feature sets change.
func (st *EnrichedStack) PushNull() {
	if st.net.inPlaceEnabled() {
		st.pendMove[st.sp+1] = chess.NullMove // null: acc unchanged, nothing to undo
		st.sp++
		return
	}
	if st.net.lazyEnabled() {
		// Defer: a null child's accumulator equals its parent's. ensure() resolves
		// it (copy from parent) on demand. fw/fb are unused on the move-aware path.
		st.pendMove[st.sp+1] = chess.NullMove
		st.dirty[st.sp+1] = true
		st.sp++
		return
	}
	src := &st.data[st.sp]
	dst := &st.data[st.sp+1]
	copy(dst.w, src.w)
	copy(dst.b, src.b)
	dst.fw = append(dst.fw[:0], src.fw...)
	dst.fb = append(dst.fb[:0], src.fb...)
	st.sp++
}

// Pop discards the top slot (call after UndoMove/UndoNullMove). In the in-place
// path it first restores the accumulator by applying the inverse of the top ply's
// delta (applyDiff with add/sub swapped: re-add removed edges, re-remove new ones).
func (st *EnrichedStack) Pop() {
	if st.net.inPlaceEnabled() {
		k := st.sp
		if st.pendMove[k] != chess.NullMove {
			st.applyDiff(st.accW, st.pAddW[k], st.pSubW[k])
			st.applyDiff(st.accB, st.pAddB[k], st.pSubB[k])
		}
		st.sp--
		return
	}
	st.sp--
}

// Eval returns the static eval of the current (top) accumulator oriented to the
// side to move. With NNUE_ASSERT set it first checks the incremental accumulator
// against a from-scratch rebuild (int16 ⇒ must be EXACTLY equal).
func (st *EnrichedStack) Eval(pos *chess.Position) int {
	if st.net.lazy {
		st.ensure(st.sp) // materialize the deferred chain up to this node before reading it
	}
	n := st.net
	topW, topB := st.accW, st.accB
	if !n.inPlaceEnabled() {
		top := &st.data[st.sp]
		topW, topB = top.w, top.b
	}
	if assertAccumulator {
		fw := make([]int16, n.H)
		fb := make([]int16, n.H)
		n.buildAcc(fw, fb, pos)
		for j := 0; j < n.H; j++ {
			if topW[j] != fw[j] || topB[j] != fb[j] {
				panic(fmt.Sprintf("enriched accumulator drift at sp=%d j=%d: w(inc=%d fresh=%d) b(inc=%d fresh=%d) fen=%q",
					st.sp, j, topW[j], fw[j], topB[j], fb[j], pos.FEN()))
			}
		}
	}
	stm, opp := topW, topB
	if pos.SideToMove() == chess.Black {
		stm, opp = topB, topW
	}
	return n.evalFromHalves(stm, opp, materialBucket(pos, n.NB), &st.sc)
}
