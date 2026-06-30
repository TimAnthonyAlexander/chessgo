package nnue

import (
	"fmt"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// MultiAccumulator is MultiNet's feature-transformer accumulator, stored by
// ABSOLUTE color (a White-perspective half and a Black-perspective half) like
// the int16 Net accumulator — so a null move touches nothing and eval simply
// re-orients to the side to move.
//
// It is INT16 (the W0i quantization, QA=ftQA): the per-move Push is then the same
// fast int16 SIMD addCol/subCol as v6, and incremental == from-scratch is EXACT
// (int adds are associative). The float accumulator's 4 KB copy + scalar delta was
// the single biggest per-node cost (~2.8 µs vs v6's ~0.4 µs); int16 halves the
// copy and SIMD-izes the delta.
type MultiAccumulator struct {
	w []int16 // White-perspective half (len H)
	b []int16 // Black-perspective half (len H)
}

// newAcc returns a zeroed accumulator sized for this net's width.
func (n *MultiNet) newAcc() MultiAccumulator {
	return MultiAccumulator{w: make([]int16, n.H), b: make([]int16, n.H)}
}

// buildAcc fills acc from scratch for pos (absolute color) from the int16 FT
// weights, using the SIMD addCol kernel for each active feature's column.
func (n *MultiNet) buildAcc(acc *MultiAccumulator, pos *chess.Position) {
	h := n.H
	copy(acc.w, n.B0i)
	copy(acc.b, n.B0i)
	var buf [maxActive]uint16
	for _, f := range AppendFeatures(buf[:0], pos, chess.White) {
		addCol(acc.w, n.W0i[int(f)*h:int(f)*h+h])
	}
	for _, f := range AppendFeatures(buf[:0], pos, chess.Black) {
		addCol(acc.b, n.W0i[int(f)*h:int(f)*h+h])
	}
}

// applyAcc adds or subtracts one feature's int16 column from both perspective
// halves (the per-move delta) via addCol/subCol. featChange and FeatureIndex are
// shared with the v6 path, so the delta decoding (moveChanges) is identical.
func (n *MultiNet) applyAcc(acc *MultiAccumulator, c featChange) {
	h := n.H
	iw := int(FeatureIndex(chess.White, c.pc, c.sq)) * h
	ib := int(FeatureIndex(chess.Black, c.pc, c.sq)) * h
	if c.add {
		addCol(acc.w, n.W0i[iw:iw+h])
		addCol(acc.b, n.W0i[ib:ib+h])
	} else {
		subCol(acc.w, n.W0i[iw:iw+h])
		subCol(acc.b, n.W0i[ib:ib+h])
	}
}

// evalFromAcc orients acc to pos's side to move, applies the SCReLU feature
// activation, and runs the multilayer tail — the output half shared with the
// from-scratch Eval.
func (n *MultiNet) evalFromAcc(acc *MultiAccumulator, pos *chess.Position) int {
	stmHalf, oppHalf := acc.w, acc.b
	if pos.SideToMove() == chess.Black {
		stmHalf, oppHalf = acc.b, acc.w
	}
	sc := n.newScratch() // non-hot (from-scratch) path; MultiStack.Eval reuses its own
	return n.evalInto(stmHalf, oppHalf, materialBucket(pos, n.NB), &sc)
}

// multiScratch holds the per-eval working buffers (activation + tail layers) so
// the hot path (MultiStack.Eval) reuses them instead of allocating ~5 KB/eval —
// the per-eval make() calls were a large fraction of the multilayer eval cost.
type multiScratch struct {
	ft []float32 // 2H float activation (float tail path)
	aq []uint8   // 2H u8 activation (int8 L1 path)
	l2 []float32 // D2 (tail layer-1 output)
	l3 []float32 // D3 (tail layer-2 output)
}

func (n *MultiNet) newScratch() multiScratch {
	return multiScratch{
		ft: make([]float32, 2*n.H),
		aq: make([]uint8, 2*n.H),
		l2: make([]float32, n.D2),
		l3: make([]float32, n.D3),
	}
}

// evalInto activates the two oriented int16 accumulator halves and runs the tail
// into the caller's scratch — no allocation. int8L1 selects the u8/int8 L1 path.
func (n *MultiNet) evalInto(stmHalf, oppHalf []int16, bk int, sc *multiScratch) int {
	h := n.H
	if n.int8L1 {
		quantU8I16(sc.aq[:h], stmHalf) // SCReLU(int16/QA) + quantize to u8
		quantU8I16(sc.aq[h:], oppHalf)
		return n.tailEvalInt8(sc.aq, bk, sc.l2, sc.l3)
	}
	screluActivateI16(sc.ft[:h], stmHalf) // stm half → SCReLU (int16 → float)
	screluActivateI16(sc.ft[h:], oppHalf) // opp half → SCReLU
	return n.tailEval(sc.ft, bk, sc.l2, sc.l3)
}

// MultiStack is MultiNet's per-searcher, ply-indexed accumulator stack, mirroring
// the int16 Stack: Push computes a child from its parent plus the move delta, Pop
// is a pointer decrement (no reverse-delta on unmake). Slots are carved from one
// contiguous float backing buffer, so there is no per-node heap allocation. No
// lazy/deferred mode (the multilayer eval is heavy enough that the deferred
// walk-back tradeoff doesn't apply the same way; revisit with int8).
type MultiStack struct {
	net     *MultiNet
	data    []MultiAccumulator
	backing []int16
	sc      multiScratch // reused per-eval working buffers (no per-eval alloc)
	sp      int
}

// NewStack allocates a MultiStack deep enough for maxDepth plies.
func (n *MultiNet) NewStack(maxDepth int) *MultiStack {
	h := n.H
	slots := maxDepth + 1
	backing := make([]int16, slots*2*h)
	data := make([]MultiAccumulator, slots)
	for i := 0; i < slots; i++ {
		off := i * 2 * h
		data[i].w = backing[off : off+h : off+h]
		data[i].b = backing[off+h : off+2*h : off+2*h]
	}
	return &MultiStack{net: n, data: data, backing: backing, sc: n.newScratch()}
}

// Net returns the net this stack was built for (so the searcher can detect a
// hot-swapped default multilayer net and rebuild).
func (st *MultiStack) Net() *MultiNet { return st.net }

// Reset rebuilds slot 0 from scratch for pos and points the stack at it.
func (st *MultiStack) Reset(pos *chess.Position) {
	st.sp = 0
	st.net.buildAcc(&st.data[0], pos)
}

// Push applies m (read from the PRE-move pos) onto a new top slot. Call it
// immediately BEFORE pos.DoMove.
func (st *MultiStack) Push(pos *chess.Position, m chess.Move) {
	src := &st.data[st.sp]
	dst := &st.data[st.sp+1]
	copy(dst.w, src.w)
	copy(dst.b, src.b)
	var ch [4]featChange
	k := moveChanges(pos, m, &ch)
	for i := 0; i < k; i++ {
		st.net.applyAcc(dst, ch[i])
	}
	st.sp++
}

// PushNull duplicates the top slot (a null move changes no placement).
func (st *MultiStack) PushNull() {
	src := &st.data[st.sp]
	dst := &st.data[st.sp+1]
	copy(dst.w, src.w)
	copy(dst.b, src.b)
	st.sp++
}

// Pop discards the top slot (call after UndoMove/UndoNullMove).
func (st *MultiStack) Pop() { st.sp-- }

// Eval returns the static eval of the current (top) accumulator oriented to the
// side to move. With NNUE_ASSERT set it first checks the incremental accumulator
// against a from-scratch rebuild (float: within a small tolerance, since adds are
// not associative — a real delta bug is off by a whole column, far above it).
func (st *MultiStack) Eval(pos *chess.Position) int {
	if assertAccumulator {
		fresh := st.net.newAcc()
		st.net.buildAcc(&fresh, pos)
		top := &st.data[st.sp]
		for j := 0; j < st.net.H; j++ {
			// int16 accumulator ⇒ incremental must EXACTLY equal from-scratch.
			if top.w[j] != fresh.w[j] || top.b[j] != fresh.b[j] {
				panic(fmt.Sprintf("multinet accumulator drift at sp=%d j=%d: w(inc=%d fresh=%d) b(inc=%d fresh=%d) fen=%q",
					st.sp, j, top.w[j], fresh.w[j], top.b[j], fresh.b[j], pos.FEN()))
			}
		}
	}
	acc := &st.data[st.sp]
	stmHalf, oppHalf := acc.w, acc.b
	if pos.SideToMove() == chess.Black {
		stmHalf, oppHalf = acc.b, acc.w
	}
	return st.net.evalInto(stmHalf, oppHalf, materialBucket(pos, st.net.NB), &st.sc)
}
