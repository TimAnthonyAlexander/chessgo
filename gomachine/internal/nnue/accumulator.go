package nnue

import (
	"fmt"
	"os"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// The eager incremental accumulator. The slow path (Net.Eval) rebuilds both
// perspective sums from scratch on every call; here we keep them updated across
// make/unmake so each node pays only a tiny per-move delta plus the output dot.
//
// Phase B: the accumulator is INT16 (the QA-scaled feature-transformer sum), and
// the output dot is integer SCReLU + descale (see quant.go). Integer adds are
// associative, so the incremental sum is *bit-identical* to a from-scratch
// rebuild — the G1 gate below asserts exact equality, strictly stronger than the
// float epsilon Phase A used.
//
// Key design choice (unchanged from Phase A): the accumulator is stored by
// ABSOLUTE color (a White-perspective half and a Black-perspective half), NOT by
// stm/opp. A move only changes piece placement, so both halves take a small
// delta; a NULL move changes no placement at all, so the accumulator is untouched
// and eval simply re-orients to the new side to move.

// assertAccumulator enables the load-bearing correctness gate (G1): on every
// eval, rebuild the accumulator from scratch and compare it to the incrementally
// maintained one (exact). Off by default. Turn on with NNUE_ASSERT=1.
var assertAccumulator = os.Getenv("NNUE_ASSERT") != ""

// SetDebugAssert toggles the incremental-vs-from-scratch accumulator gate at
// runtime (tests use it so CI catches desyncs without needing the env var).
func SetDebugAssert(b bool) { assertAccumulator = b }

// forceScratch makes the searcher's eval take the slow from-scratch path (still
// integer) — used only to A/B the incremental speedup (G5). NNUE_NOINCREMENTAL=1.
var forceScratch = os.Getenv("NNUE_NOINCREMENTAL") != ""

// ForceScratch reports whether the from-scratch eval path is forced (perf A/B).
func ForceScratch() bool { return forceScratch }

// SetForceScratch toggles the from-scratch eval path at runtime (perf A/B tests).
func SetForceScratch(b bool) { forceScratch = b }

// Accumulator holds the two absolute-color first-layer sums (int16, QA-scaled).
// Each is B0i plus the W0i columns of that color's active piece features.
//
// w/b are slices (not fixed arrays) so a net of ANY hidden width works; in the
// hot path they are sub-slices of a single contiguous backing array owned by the
// Stack (so there is no per-ply heap allocation, and slots stay cache-adjacent).
// A standalone Accumulator (debug/perf paths) gets its own slices via
// (*Net).newAccumulator. NOTE: because the fields are slices, a plain struct copy
// (`*dst = *src`) aliases the backing — Push/PushNull copy the CONTENTS instead.
type Accumulator struct {
	w []int16 // White-perspective half (len == net HL)
	b []int16 // Black-perspective half (len == net HL)
}

// newAccumulator returns a standalone accumulator sized for this net's width.
// Used by the debug (assert) and perf (forceScratch) paths, not the hot loop.
func (n *Net) newAccumulator() Accumulator {
	return Accumulator{w: make([]int16, n.HL), b: make([]int16, n.HL)}
}

// featChange is one piece appearing (add) or disappearing (!add) on a square.
type featChange struct {
	pc  chess.Piece
	sq  chess.Square
	add bool
}

// build fills acc from scratch for pos — same arithmetic and order as the int
// forward, so a from-scratch accumulator yields a bit-identical eval.
func (n *Net) build(acc *Accumulator, pos *chess.Position) {
	hl := n.HL
	copy(acc.w, n.B0i)
	copy(acc.b, n.B0i)
	var buf [maxActive]uint16
	for _, f := range AppendFeatures(buf[:0], pos, chess.White) {
		addCol(acc.w, n.W0i[int(f)*hl:int(f)*hl+hl])
	}
	for _, f := range AppendFeatures(buf[:0], pos, chess.Black) {
		addCol(acc.b, n.W0i[int(f)*hl:int(f)*hl+hl])
	}
}

// apply adds or subtracts one feature's column from both perspective halves.
func (n *Net) apply(acc *Accumulator, c featChange) {
	hl := n.HL
	iw := int(FeatureIndex(chess.White, c.pc, c.sq)) * hl
	ib := int(FeatureIndex(chess.Black, c.pc, c.sq)) * hl
	cw := n.W0i[iw : iw+hl]
	cb := n.W0i[ib : ib+hl]
	if c.add {
		addCol(acc.w, cw)
		addCol(acc.b, cb)
	} else {
		subCol(acc.w, cw)
		subCol(acc.b, cb)
	}
}

// evalFrom evaluates acc oriented to stm — integer SCReLU dot + descale.
func (n *Net) evalFrom(acc *Accumulator, stm chess.Color) int {
	hl := n.HL
	stmHalf, oppHalf := acc.w, acc.b
	if stm == chess.Black {
		stmHalf, oppHalf = acc.b, acc.w
	}
	qa := n.QA
	out := screluDot(stmHalf, n.W1i[:hl], qa)
	out += screluDot(oppHalf, n.W1i[hl:2*hl], qa)
	return n.descale(out)
}

// moveChanges decodes the per-move feature deltas from the PRE-move position
// (mirrors chess.DoMove exactly). Returns the count written into ch (≤4).
func moveChanges(pos *chess.Position, m chess.Move, ch *[4]featChange) int {
	us := pos.SideToMove()
	from := m.From()
	to := m.To()
	moving := pos.PieceOn(from)
	n := 0
	switch m.Type() {
	case chess.Normal:
		if cap := pos.PieceOn(to); cap != chess.NoPiece {
			ch[n] = featChange{cap, to, false}
			n++
		}
		ch[n] = featChange{moving, from, false}
		n++
		ch[n] = featChange{moving, to, true}
		n++
	case chess.Promotion:
		if cap := pos.PieceOn(to); cap != chess.NoPiece {
			ch[n] = featChange{cap, to, false}
			n++
		}
		ch[n] = featChange{moving, from, false} // the pawn leaves
		n++
		ch[n] = featChange{chess.MakePiece(us, m.Promo()), to, true}
		n++
	case chess.EnPassant:
		// The captured pawn sits behind the destination, not on it.
		capSq := chess.Square(int(to) - 8)
		if us == chess.Black {
			capSq = chess.Square(int(to) + 8)
		}
		ch[n] = featChange{pos.PieceOn(capSq), capSq, false}
		n++
		ch[n] = featChange{moving, from, false}
		n++
		ch[n] = featChange{moving, to, true}
		n++
	case chess.Castling:
		ch[n] = featChange{moving, from, false} // king
		n++
		ch[n] = featChange{moving, to, true}
		n++
		var rFrom, rTo chess.Square
		switch to {
		case chess.G1:
			rFrom, rTo = chess.H1, chess.F1
		case chess.C1:
			rFrom, rTo = chess.A1, chess.D1
		case chess.G8:
			rFrom, rTo = chess.H8, chess.F8
		case chess.C8:
			rFrom, rTo = chess.A8, chess.D8
		}
		rook := pos.PieceOn(rFrom)
		ch[n] = featChange{rook, rFrom, false}
		n++
		ch[n] = featChange{rook, rTo, true}
		n++
	}
	return n
}

// Stack is a per-searcher, ply-indexed accumulator stack. Push computes a child
// from its parent plus the move delta; Pop is a pointer decrement (the parent's
// accumulator is left in place and reused — no reverse-delta on unmake).
type Stack struct {
	net       *Net
	data      []Accumulator
	backing   []int16 // one contiguous buffer; each slot's w/b sub-slice it
	sp        int
	floatMode bool // route Eval through the float from-scratch path (int-vs-float A/B)
}

// NewStack allocates a stack deep enough for maxDepth plies. The per-ply
// accumulators (w/b halves) are carved from a single contiguous backing buffer
// sized to the net's width — so there is no per-node heap allocation regardless
// of hidden size, and adjacent plies stay cache-friendly.
func (n *Net) NewStack(maxDepth int) *Stack {
	hl := n.HL
	slots := maxDepth + 1
	backing := make([]int16, slots*2*hl)
	data := make([]Accumulator, slots)
	for i := 0; i < slots; i++ {
		off := i * 2 * hl
		data[i].w = backing[off : off+hl : off+hl]
		data[i].b = backing[off+hl : off+2*hl : off+2*hl]
	}
	return &Stack{net: n, data: data, backing: backing}
}

// Net returns the net this stack was built for (so the searcher can detect a
// hot-swapped default net and rebuild).
func (st *Stack) Net() *Net { return st.net }

// SetFloatMode makes Eval use the float from-scratch path (the NnueFloat param's
// int-vs-float quality SPRT). The integer accumulator is still maintained.
func (st *Stack) SetFloatMode(b bool) { st.floatMode = b }

// Reset rebuilds slot 0 from scratch for pos and points the stack at it.
func (st *Stack) Reset(pos *chess.Position) {
	st.sp = 0
	st.net.build(&st.data[0], pos)
}

// Push applies m (read from the PRE-move pos) onto a new top slot. Call it
// immediately BEFORE pos.DoMove.
func (st *Stack) Push(pos *chess.Position, m chess.Move) {
	src := &st.data[st.sp]
	dst := &st.data[st.sp+1]
	// Copy CONTENTS, not the slice headers (which would alias src's backing).
	copy(dst.w, src.w)
	copy(dst.b, src.b)
	var ch [4]featChange
	n := moveChanges(pos, m, &ch)
	for k := 0; k < n; k++ {
		st.net.apply(dst, ch[k])
	}
	st.sp++
}

// PushNull duplicates the top slot (a null move changes no placement). Call it
// immediately BEFORE pos.DoNullMove.
func (st *Stack) PushNull() {
	src := &st.data[st.sp]
	dst := &st.data[st.sp+1]
	copy(dst.w, src.w)
	copy(dst.b, src.b)
	st.sp++
}

// Pop discards the top slot (call after UndoMove/UndoNullMove).
func (st *Stack) Pop() { st.sp-- }

// Eval returns the static eval of the current (top) accumulator oriented to the
// side to move. When NNUE_ASSERT is set it first verifies the incremental
// accumulator against a from-scratch rebuild (the G1 gate).
func (st *Stack) Eval(pos *chess.Position) int {
	if assertAccumulator {
		st.assertConsistent(pos)
	}
	if st.floatMode {
		return st.net.Eval(pos)
	}
	if forceScratch {
		fresh := st.net.newAccumulator()
		st.net.build(&fresh, pos)
		return st.net.evalFrom(&fresh, pos.SideToMove())
	}
	return st.net.evalFrom(&st.data[st.sp], pos.SideToMove())
}

// assertConsistent panics if the incrementally-maintained top accumulator
// differs from a from-scratch rebuild AT ALL (integer adds are associative, so a
// correct incremental sum is bit-identical). Also flags any value that strays
// outside a safe int16 band (overflow guard).
func (st *Stack) assertConsistent(pos *chess.Position) {
	fresh := st.net.newAccumulator()
	st.net.build(&fresh, pos)
	top := &st.data[st.sp]
	for j := 0; j < st.net.HL; j++ {
		if top.w[j] != fresh.w[j] || top.b[j] != fresh.b[j] {
			panic(fmt.Sprintf(
				"nnue accumulator desync at sp=%d j=%d: w(inc=%d fresh=%d) b(inc=%d fresh=%d) stm=%v fen=%q",
				st.sp, j, top.w[j], fresh.w[j], top.b[j], fresh.b[j], pos.SideToMove(), pos.FEN()))
		}
		// Overflow guard: legal positions sum well inside int16; anything near the
		// rail means weights/feature counts could wrap silently in production.
		if top.w[j] > 30000 || top.w[j] < -30000 || top.b[j] > 30000 || top.b[j] < -30000 {
			panic(fmt.Sprintf("nnue accumulator near int16 overflow at sp=%d j=%d: w=%d b=%d fen=%q",
				st.sp, j, top.w[j], top.b[j], pos.FEN()))
		}
	}
}
