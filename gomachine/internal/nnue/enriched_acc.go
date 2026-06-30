package nnue

import (
	"fmt"
	"slices"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// EnrichedStack is the per-searcher, ply-indexed INCREMENTAL accumulator for an
// EnrichedNet — the movetime path that replaces the from-scratch Eval. Per node
// the threat feature set changes in hard-to-predict ways (a moved piece, sliders
// whose rays open/close, captures), so rather than reason about the move-aware
// delta (the classic accumulator-bug source) we exploit two measured facts:
//
//   - feature enumeration is cheap (~269 ns: attack-gen is NOT the bottleneck);
//   - chess.Position is a pure value type, so copy + DoMove is cheap.
//
// So Push copies the position, makes the move on the copy, re-enumerates the
// child's full feature set, and applies only the MULTISET DIFF vs the parent
// (sorted-merge: removed -> subCol, added -> addCol). This is correct by
// construction — it literally computes the symmetric difference of the exact
// feature sets — so the from-scratch assert is a formality, not a slider-delta
// minefield. The win over from-scratch is applying ~tens of delta columns instead
// of ~224 (both perspectives) every node.
type EnrichedStack struct {
	net     *EnrichedNet
	data    []enrichedSlot
	backing []int16
	sc      enrichedScratch
	sp      int
}

type enrichedSlot struct {
	w, b   []int16  // perspective accumulator halves (len H), into the shared backing
	fw, fb []uint16 // SORTED active features (White-persp, Black-persp); own backing
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
	return &EnrichedStack{net: n, data: data, backing: backing, sc: n.newScratch()}
}

// Net returns the net this stack was built for (so the searcher can detect a swap).
func (st *EnrichedStack) Net() *EnrichedNet { return st.net }

// sortedFeatures fills dst (reset to len 0) with pos's sorted active features for
// the given perspective.
func sortedFeatures(dst []uint16, pos *chess.Position, persp chess.Color) []uint16 {
	dst = appendEnrichedFeatures(dst[:0], pos, persp)
	slices.Sort(dst)
	return dst
}

// Reset rebuilds slot 0 from scratch for pos and points the stack at it.
func (st *EnrichedStack) Reset(pos *chess.Position) {
	st.sp = 0
	s := &st.data[0]
	st.net.buildAcc(s.w, s.b, pos)
	s.fw = sortedFeatures(s.fw, pos, chess.White)
	s.fb = sortedFeatures(s.fb, pos, chess.Black)
}

// applyDiff walks two SORTED feature multisets (parent, child) and applies the
// symmetric difference to acc: indices only in parent are subtracted, indices
// only in child are added. Multiplicity is preserved (a duplicate index that
// drops from 2->1 yields exactly one subCol).
func (n *EnrichedNet) applyDiff(acc []int16, parent, child []uint16) {
	h := n.H
	i, j := 0, 0
	for i < len(parent) && j < len(child) {
		switch {
		case parent[i] == child[j]:
			i++
			j++
		case parent[i] < child[j]:
			f := int(parent[i])
			subCol(acc, n.W0i[f*h:f*h+h])
			i++
		default:
			f := int(child[j])
			addCol(acc, n.W0i[f*h:f*h+h])
			j++
		}
	}
	for ; i < len(parent); i++ {
		f := int(parent[i])
		subCol(acc, n.W0i[f*h:f*h+h])
	}
	for ; j < len(child); j++ {
		f := int(child[j])
		addCol(acc, n.W0i[f*h:f*h+h])
	}
}

// Push computes the child slot from its parent plus the move delta. Call it
// immediately BEFORE pos.DoMove (m is read from the PRE-move pos); the move is
// replayed on a cheap value-type copy to get the child's features.
func (st *EnrichedStack) Push(pos *chess.Position, m chess.Move) {
	src := &st.data[st.sp]
	dst := &st.data[st.sp+1]
	copy(dst.w, src.w)
	copy(dst.b, src.b)

	child := *pos
	var u chess.Undo
	child.DoMove(m, &u)

	dst.fw = sortedFeatures(dst.fw, &child, chess.White)
	dst.fb = sortedFeatures(dst.fb, &child, chess.Black)
	st.net.applyDiff(dst.w, src.fw, dst.fw)
	st.net.applyDiff(dst.b, src.fb, dst.fb)
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
