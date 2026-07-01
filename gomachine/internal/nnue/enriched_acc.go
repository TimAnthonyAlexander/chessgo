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
	}
}

// Net returns the net this stack was built for (so the searcher can detect a swap).
func (st *EnrichedStack) Net() *EnrichedNet { return st.net }

// Reset rebuilds slot 0 from scratch for pos and points the stack at it.
func (st *EnrichedStack) Reset(pos *chess.Position) {
	st.sp = 0
	s := &st.data[0]
	st.net.buildAcc(s.w, s.b, pos)
	s.fw, s.fb = appendEnrichedFeaturesBoth(s.fw[:0], s.fb[:0], pos)
}

// applyDiff applies the multiset symmetric difference (child − parent) to acc via
// the count-array scratch: features dropped from parent are subtracted, features
// gained in child are added, with multiplicity. O(len(parent)+len(child)); the
// counts slice is left all-zero for the next call.
func (st *EnrichedStack) applyDiff(acc []int16, parent, child []uint16) {
	c := st.counts
	for _, f := range parent {
		c[f]--
	}
	for _, f := range child {
		c[f]++
	}
	net := st.net
	apply := func(list []uint16) {
		for _, f := range list {
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
	src := &st.data[st.sp]
	dst := &st.data[st.sp+1]
	copy(dst.w, src.w)
	copy(dst.b, src.b)
	dst.fw = append(dst.fw[:0], src.fw...)
	dst.fb = append(dst.fb[:0], src.fb...)
	st.sp++
}

// Pop discards the top slot (call after UndoMove/UndoNullMove).
func (st *EnrichedStack) Pop() { st.sp-- }

// Eval returns the static eval of the current (top) accumulator oriented to the
// side to move. With NNUE_ASSERT set it first checks the incremental accumulator
// against a from-scratch rebuild (int16 ⇒ must be EXACTLY equal).
func (st *EnrichedStack) Eval(pos *chess.Position) int {
	n := st.net
	top := &st.data[st.sp]
	if assertAccumulator {
		fw := make([]int16, n.H)
		fb := make([]int16, n.H)
		n.buildAcc(fw, fb, pos)
		for j := 0; j < n.H; j++ {
			if top.w[j] != fw[j] || top.b[j] != fb[j] {
				panic(fmt.Sprintf("enriched accumulator drift at sp=%d j=%d: w(inc=%d fresh=%d) b(inc=%d fresh=%d) fen=%q",
					st.sp, j, top.w[j], fw[j], top.b[j], fb[j], pos.FEN()))
			}
		}
	}
	stm, opp := top.w, top.b
	if pos.SideToMove() == chess.Black {
		stm, opp = top.b, top.w
	}
	return n.evalFromHalves(stm, opp, materialBucket(pos, n.NB), &st.sc)
}
