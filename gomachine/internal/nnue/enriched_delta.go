package nnue

import "github.com/timanthonyalexander/gomachine/internal/chess"

// Move-aware incremental push: compute the base+threat feature DELTA of a move
// DIRECTLY, in O(delta), instead of re-enumerating the child's full feature set
// and multiset-diffing it (the O(active-features) path in enriched_acc.go).
//
// Profiling the lean threats net at movetime (coalla/AVX-512, 2026-07-01) showed
// the accumulator push is ~47% of engine CPU. Of that, the full attack
// enumeration (~11%) and the count-array diff over the full ~100-200-feature
// lists (~13%) are pure overhead — only a handful of features actually change per
// move. This path removes both; the remaining cost is the true column add/subs.
//
// Correctness model (validated exhaustively by the NNUE_ASSERT from-scratch
// rebuild in Eval, which must match int16-for-int16):
//
// A threat edge (attacker A@asq -> victim V@vsq) can only change if
//  1. asq changed occupant       (the attacker moved / was captured / promoted), or
//  2. vsq changed occupant       (the victim appeared / vanished / changed type), or
//  3. a changed square lies on the slider ray asq->vsq (blocked / discovered).
//
// Let D = the squares whose occupant changed (found by diffing the old and child
// boards — robust to castle/en-passant/promotion without decoding move flags).
// Every affected edge is attributed to its ATTACKER's square, and that square is
// either in D (cases 1) or attacks some d in D under the old or new occupancy
// (cases 2 and 3 — a discovering slider had d as its blocker in exactly one of the
// two occupancies). So the affected attacker squares are
//
//	S = D  ∪  AttackersTo(d, oldOcc)  ∪  AttackersTo(d, newOcc)   for d in D
//
// For each s in S we subtract the old board's edges of s and add the child's, so
// unchanged edges of an s cancel in the diff. Base-768 placement features change
// only for squares in D. Being generous with S is safe: an unaffected attacker's
// edges are identical old and new and cancel — it costs a little work, never
// correctness.

// appendAttackerEdges appends the threat feature indices for the piece on sq
// acting as ATTACKER, from persp's frame, computed against occupancy occ. It emits
// byte-identical indices to appendEnrichedFeatures' inner loop (enriched.go).
func appendAttackerEdges(dst []uint16, pos *chess.Position, sq chess.Square, occ chess.Bitboard, persp chess.Color) []uint16 {
	pc := pos.PieceOn(sq)
	var aRel uint16
	if pc.Color() != persp {
		aRel = 1
	}
	a := aRel*6 + uint16(pc.Type())
	flip := persp == chess.Black
	targets := chess.PseudoAttacks(pc, sq, occ) & occ
	for targets != 0 {
		tsq := targets.PopLSB()
		victim := pos.PieceOn(tsq)
		var vRel uint16
		if victim.Color() != persp {
			vRel = 1
		}
		v := vRel*6 + uint16(victim.Type())
		rtsq := uint16(tsq)
		if flip {
			rtsq ^= 56
		}
		dst = append(dst, uint16(InputDim)+(a*12+v)*64+rtsq)
	}
	return dst
}

// pushMoveAware is the O(delta) Push used when the net has moveAware set. It leaves
// dst.fw/dst.fb untouched (the move-aware path never reads them; the assert path
// rebuilds from scratch).
//
// The affected attackers are the pieces ON a changed square plus every piece
// attacking a changed square under the old or new occupancy (a discovering slider
// had the square as its blocker in exactly one of the two). Each such attacker's
// FULL edge set is re-enumerated old and new; unchanged edges cancel in the diff.
//
// Two "smarter" variants were built and measured SLOWER on AVX-512 and reverted:
// (1) single-edge shortcut for knight/king attackers, (2) exact changed-edges via
// the XOR of each attacker's old/new PseudoAttacks. Both add per-attacker probing
// (extra AttackersTo / a second PseudoAttacks) to shrink the sub/add lists, but the
// applyDiff they save is already cheap — SIMD column ops over an L1-resident count
// array — so the probing dominates. The flat re-enumerate-and-cancel wins (822 vs
// 888/935 ns/push). The enumeration is the irreducible cost here.
func (st *EnrichedStack) pushMoveAware(pos *chess.Position, m chess.Move) {
	src := &st.data[st.sp]
	dst := &st.data[st.sp+1]
	copy(dst.w, src.w)
	copy(dst.b, src.b)

	child := *pos
	var u chess.Undo
	child.DoMove(m, &u)

	oldOcc := pos.Occupied()
	newOcc := child.Occupied()

	subW := st.dsubW[:0]
	addW := st.daddW[:0]
	subB := st.dsubB[:0]
	addB := st.daddB[:0]

	// Changed squares: base-768 delta + seed the affected-attacker set.
	var affected chess.Bitboard
	for s := chess.Square(0); s < 64; s++ {
		op := pos.PieceOn(s)
		np := child.PieceOn(s)
		if op == np {
			continue
		}
		if op != chess.NoPiece {
			subW = append(subW, FeatureIndex(chess.White, op, s))
			subB = append(subB, FeatureIndex(chess.Black, op, s))
		}
		if np != chess.NoPiece {
			addW = append(addW, FeatureIndex(chess.White, np, s))
			addB = append(addB, FeatureIndex(chess.Black, np, s))
		}
		affected |= s.BB()
		affected |= pos.AttackersTo(s, oldOcc)
		affected |= child.AttackersTo(s, newOcc)
	}

	// Threat edges of every affected attacker: subtract old-board edges, add child's.
	for bb := affected; bb != 0; {
		s := bb.PopLSB()
		if pos.PieceOn(s) != chess.NoPiece {
			subW = appendAttackerEdges(subW, pos, s, oldOcc, chess.White)
			subB = appendAttackerEdges(subB, pos, s, oldOcc, chess.Black)
		}
		if child.PieceOn(s) != chess.NoPiece {
			addW = appendAttackerEdges(addW, &child, s, newOcc, chess.White)
			addB = appendAttackerEdges(addB, &child, s, newOcc, chess.Black)
		}
	}

	st.applyDiff(dst.w, subW, addW)
	st.applyDiff(dst.b, subB, addB)

	st.dsubW, st.daddW, st.dsubB, st.daddB = subW, addW, subB, addB
	st.sp++
}
