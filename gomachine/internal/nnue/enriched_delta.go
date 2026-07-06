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
		dst = append(dst, uint16(PsqSize)+(a*12+v)*64+rtsq)
	}
	return dst
}

// pushMoveAware is the O(delta) Push used when the net has moveAware set. It leaves
// dst.fw/dst.fb untouched (the move-aware path never reads them; the assert path
// rebuilds from scratch). It dispatches on the net's changedEdges toggle (default
// on): the O(changed-edges) fast delta (pushMoveAwareChanged) vs the correct-by-
// construction full re-enumeration (pushMoveAwareEnumerate). Both are bit-exact and
// share the applyDiff back end; the fast path is gated by TestEnrichedMoveAwareBitExact
// (int16-exact perft walk) + the NNUE_ASSERT Eval check. The enumerate path stays
// available so the two can be A/B'd at movetime (SetChangedEdges).
func (st *EnrichedStack) pushMoveAware(pos *chess.Position, m chess.Move) {
	if st.net.changedEdges {
		st.pushMoveAwareChanged(pos, m)
		return
	}
	st.pushMoveAwareEnumerate(pos, m)
}

// pushMoveAwareChanged is the fast delta path: it emits only the threat edges that
// actually CHANGE, instead of re-enumerating every affected attacker's full edge
// set and cancelling the unchanged ones in the count array.
//
// Let D = the squares whose occupant changed (found by a per-piece bitboard XOR of
// the old and child boards — robust to castle/en-passant/promotion). The affected
// attacker set is D ∪ AttackersTo(d, oldOcc) ∪ AttackersTo(d, newOcc) for d in D
// (a discovering slider had d as its blocker in exactly one of the two occupancies).
// It is partitioned:
//
//   - Group 1 — attackers ON a changed square (s ∈ D): the piece there changed
//     identity, so its ENTIRE edge set flips. Subtract the old piece's full edges,
//     add the new piece's. Base-768 placement features change only here.
//   - Group 2 — attackers NOT in D (s ∈ affected\D): the attacker is the SAME piece
//     old and new, so only the edges incident to D shift. Emit exact deltas
//     (appendChangedEdges): for a non-slider, the victim swap at each attacked square
//     in D; for a slider, the full masked-line diff — which handles a discovered
//     threat (a blocker leaves → the ray EXTENDS, emit add) or a retracted one (a
//     piece appears → the ray shortens, emit sub) automatically.
//
// Being generous with the affected set is safe: an unaffected attacker's masked
// edges are identical old and new and cancel in applyDiff — it costs a little work,
// never correctness.
func (st *EnrichedStack) pushMoveAwareChanged(pos *chess.Position, m chess.Move) {
	st.buildSlotFrom(st.sp+1, st.sp, pos, m)
	st.sp++
}

// buildSlotFrom computes slot dstIdx's accumulator from slot srcIdx (the parent)
// plus the move m applied to the pre-move position pos, via the O(changed-edges)
// delta. Index-explicit (does NOT touch st.sp) so both the eager push and the lazy
// walk-back can drive it. Requires srcIdx to already hold the parent accumulator.
func (st *EnrichedStack) buildSlotFrom(dstIdx, srcIdx int, pos *chess.Position, m chess.Move) {
	if kingMoveNeedsRefresh(pos, m) {
		// King move that CHANGES bucket → the MOVING side's base features shift to a new
		// bucket copy → its incremental delta is invalid. splitRefresh rebuilds only that
		// half from scratch and deltas the opponent half (whose king didn't move, so its
		// bucket offset is unchanged); the default full-rebuild does both halves.
		if st.net.splitRefresh {
			st.buildSlotRefreshSplit(dstIdx, srcIdx, pos, m)
			return
		}
		child := *pos
		var u chess.Undo
		child.DoMove(m, &u)
		dst := &st.data[dstIdx]
		st.net.buildAcc(dst.w, dst.b, &child)
		return
	}
	subW, addW, subB, addB := st.computeDelta(pos, m)
	st.applyDelta(dstIdx, srcIdx, subW, addW, subB, addB)
}

// buildSlotRefreshSplit handles a bucket-crossing king move by rebuilding ONLY the
// moving side's accumulator half from scratch (its base features shifted to a new
// king-bucket copy) and deltaing the OPPONENT half from the parent. computeDelta's
// offsets come from the parent: the opponent's king didn't move, so its off<opp> is
// unchanged and its (sub,add) lists are the exact child opponent delta (the moved
// king appears there as an ordinary relocating piece; threat edges start at PsqSize,
// bucket-independent). The moving side's lists use a now-stale offset, so we discard
// them and full-rebuild that half. pos.SideToMove() is the side making m (whose king
// moves), matching kingBucketOffset's per-perspective base-offset convention.
func (st *EnrichedStack) buildSlotRefreshSplit(dstIdx, srcIdx int, pos *chess.Position, m chess.Move) {
	child := *pos
	var u chess.Undo
	child.DoMove(m, &u)
	src := &st.data[srcIdx]
	dst := &st.data[dstIdx]
	mover := pos.SideToMove()
	subW, addW, subB, addB := st.computeDelta(pos, m)
	if mover == chess.White {
		st.refreshHalf(dst.w, &child, chess.White) // moving side: rebuild (Finny or scratch)
		copy(dst.b, src.b)                         // opponent: delta from parent
		st.applyDiff(dst.b, subB, addB)
		_ = subW
		_ = addW
	} else {
		st.refreshHalf(dst.b, &child, chess.Black)
		copy(dst.w, src.w)
		st.applyDiff(dst.w, subW, addW)
		_ = subB
		_ = addB
	}
}

// refreshHalf rebuilds the moving side's accumulator half for the child position.
// With the Finny table off it is a from-scratch buildAccHalf; with it on, the cheaper
// cache-diff path (finnyRefreshHalf). Both are int16-identical.
func (st *EnrichedStack) refreshHalf(dstHalf []int16, pos *chess.Position, persp chess.Color) {
	if st.net.finny {
		st.finnyRefreshHalf(dstHalf, pos, persp)
		return
	}
	st.net.buildAccHalf(dstHalf, pos, persp)
}

// finnyRefreshHalf produces persp's accumulator half for pos into dstHalf using the
// Finny-table cache keyed by (persp, kingBucket). On a cache HIT it starts from a copy
// of the cached half and applies the multiset feature DIFF (cached features → current
// features) via applyDiff; because the cached half satisfies half == B0i + Σ ftAdd(cached
// features) and both feature lists index the SAME king bucket (cache key), the result is
// B0i + Σ ftAdd(current features) == buildAccHalf(pos, persp), int16-for-int16. On a MISS
// it falls back to a from-scratch buildAccHalf. Either way it refreshes the cache entry
// (half + feature list) so the invariant holds for the next cross into this bucket.
func (st *EnrichedStack) finnyRefreshHalf(dstHalf []int16, pos *chess.Position, persp chess.Color) {
	bucket := kingBucket(pos, persp)
	e := &st.finny[persp][bucket]

	var buf [maxEnrichedActive]uint16
	cur := appendEnrichedFeatures(buf[:0], pos, persp)

	if e.valid {
		st.finnyHit++
		if !sliceEqU16(e.features, cur) {
			st.finnyHitChanged++ // the diff is non-trivial: a hit on a CHANGED board
		}
		copy(dstHalf, e.half)                  // start from the cached half
		st.applyDiff(dstHalf, e.features, cur) // subtract cached features, add current
	} else {
		st.finnyMiss++
		st.net.buildAccHalf(dstHalf, pos, persp) // cold: full rebuild
		e.valid = true
	}

	// Refresh the cache so half == B0i + Σ ftAdd(features) stays true for the next hit.
	copy(e.half, dstHalf)
	e.features = append(e.features[:0], cur...)
}

// sliceEqU16 reports whether two uint16 slices are element-wise equal. appendEnriched-
// Features emits features in a fixed order for a given board, so equal sequences mean the
// accumulator target is unchanged (the diff is a no-op) — a differing sequence flags the
// "cache hit with a changed board" case.
func sliceEqU16(a, b []uint16) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// computeDelta enumerates the changed-edge sub/add feature lists (both perspectives)
// for move m on the pre-move position pos. It reads only pos (the caller's live
// board — no persisted copy) plus a cheap value-copy child, so it can run EAGERLY at
// push time while the accumulator apply is deferred (lazy path). The returned slices
// are backed by st's reusable scratch — copy them out (lazy) or apply them
// immediately (eager) before the next call overwrites the scratch.
func (st *EnrichedStack) computeDelta(pos *chess.Position, m chess.Move) (subW, addW, subB, addB []uint16) {
	child := *pos
	var u chess.Undo
	child.DoMove(m, &u)

	oldOcc := pos.Occupied()
	newOcc := child.Occupied()

	subW = st.dsubW[:0]
	addW = st.daddW[:0]
	subB = st.dsubB[:0]
	addB = st.daddB[:0]

	// King-bucket base offsets. computeDelta only runs for NON-king moves (king moves
	// take the refresh path in Push), so neither king moved: the parent's king bucket
	// equals the child's, and offW/offB are constant across the whole base delta.
	offW := kingBucketOffset(pos, chess.White)
	offB := kingBucketOffset(pos, chess.Black)

	// A1: changed squares via per-piece bitboard XOR (occupant differs old vs new).
	// Cheaper than the 64-square PieceOn scan, and D is needed for the geometry.
	var D chess.Bitboard
	for p := chess.WhitePawn; p <= chess.BlackKing; p++ {
		D |= pos.PieceBB(p) ^ child.PieceBB(p)
	}

	// Group 1: base-768 delta + the FULL threat edges of the piece that left/arrived.
	// Also seed the affected-attacker set.
	var affected chess.Bitboard
	for bb := D; bb != 0; {
		s := bb.PopLSB()
		op := pos.PieceOn(s)
		np := child.PieceOn(s)
		if op != chess.NoPiece {
			subW = append(subW, offW+FeatureIndex(chess.White, op, s))
			subB = append(subB, offB+FeatureIndex(chess.Black, op, s))
			subW = appendAttackerEdges(subW, pos, s, oldOcc, chess.White)
			subB = appendAttackerEdges(subB, pos, s, oldOcc, chess.Black)
		}
		if np != chess.NoPiece {
			addW = append(addW, offW+FeatureIndex(chess.White, np, s))
			addB = append(addB, offB+FeatureIndex(chess.Black, np, s))
			addW = appendAttackerEdges(addW, &child, s, newOcc, chess.White)
			addB = appendAttackerEdges(addB, &child, s, newOcc, chess.Black)
		}
		affected |= pos.AttackersTo(s, oldOcc)
		affected |= child.AttackersTo(s, newOcc)
	}

	// Group 2: attackers not in D whose edges toward a changed square shifted. These
	// squares are occupied by the SAME piece in both boards (∉ D), so PieceOn is safe.
	for bb := affected &^ D; bb != 0; {
		s := bb.PopLSB()
		subW, addW, subB, addB = appendChangedEdges(subW, addW, subB, addB, pos, &child, s, oldOcc, newOcc, D)
	}

	st.dsubW, st.daddW, st.dsubB, st.daddB = subW, addW, subB, addB
	return subW, addW, subB, addB
}

// applyDelta materializes slot dstIdx from the parent slot srcIdx: copy the parent
// accumulator, then apply the sub/add feature deltas. This is the deferrable half
// (2 KB copy + scattered column adds) — skipped entirely for lazy subtrees that
// never evaluate. Requires srcIdx already materialized.
func (st *EnrichedStack) applyDelta(dstIdx, srcIdx int, subW, addW, subB, addB []uint16) {
	src := &st.data[srcIdx]
	dst := &st.data[dstIdx]
	copy(dst.w, src.w)
	copy(dst.b, src.b)
	st.applyDiff(dst.w, subW, addW)
	st.applyDiff(dst.b, subB, addB)
}

// appendChangedEdges emits, for the piece on square s (which is the SAME in the old
// and child boards — s ∉ D), ONLY the threat edges that differ between old and new
// occupancy, for BOTH perspectives at once (White: tsq as-is; Black: tsq^56). Old
// edges that vanish/change go to subW/subB, new ones to addW/addB; unchanged edges
// are omitted (they cancel in applyDiff regardless). Byte-identical index encoding
// to appendEnrichedFeaturesBoth.
//
// Non-slider (knight/king/pawn): the attack set is occupancy-independent, so an edge
// changes only where the attacked square's occupant changed — the targets in D. New
// occupancy of D squares can only differ from old at D, and the attacker is fixed.
//
// Slider (bishop/rook/queen): an edge can only shift along a ray crossing a changed
// square, so restrict the old and new attack∩occupancy sets to mask = the union of
// full lines through s and each changed square, then diff. This captures blocked,
// discovered (ray extends past a departed blocker) and retracted (ray shortens at a
// newly-appeared piece) edges uniformly; targets on masked lines that did not change
// appear in both the old and new sets with the same victim and cancel.
func appendChangedEdges(
	subW, addW, subB, addB []uint16,
	oldPos, child *chess.Position, s chess.Square,
	oldOcc, newOcc, D chess.Bitboard,
) ([]uint16, []uint16, []uint16, []uint16) {
	pc := oldPos.PieceOn(s) // == child.PieceOn(s) since s ∉ D
	pt := pc.Type()

	var aRelW, aRelB uint16
	if pc.Color() != chess.White {
		aRelW = 1
	}
	if pc.Color() != chess.Black {
		aRelB = 1
	}
	aW := aRelW*6 + uint16(pt)
	aB := aRelB*6 + uint16(pt)

	var oldT, newT chess.Bitboard
	if pt == chess.Bishop || pt == chess.Rook || pt == chess.Queen {
		var mask chess.Bitboard
		for dd := D; dd != 0; {
			mask |= chess.LineBB(s, dd.PopLSB())
		}
		oldT = chess.PseudoAttacks(pc, s, oldOcc) & oldOcc & mask
		newT = chess.PseudoAttacks(pc, s, newOcc) & newOcc & mask
	} else {
		// Leaper: attack set is occupancy-independent; edges shift only at D.
		a := chess.PseudoAttacks(pc, s, oldOcc) & D
		oldT = a & oldOcc
		newT = a & newOcc
	}

	for oldT != 0 {
		t := oldT.PopLSB()
		victim := oldPos.PieceOn(t)
		var vRelW, vRelB uint16
		if victim.Color() != chess.White {
			vRelW = 1
		}
		if victim.Color() != chess.Black {
			vRelB = 1
		}
		vW := vRelW*6 + uint16(victim.Type())
		vB := vRelB*6 + uint16(victim.Type())
		tw := uint16(t)
		subW = append(subW, uint16(PsqSize)+(aW*12+vW)*64+tw)
		subB = append(subB, uint16(PsqSize)+(aB*12+vB)*64+(tw^56))
	}
	for newT != 0 {
		t := newT.PopLSB()
		victim := child.PieceOn(t)
		var vRelW, vRelB uint16
		if victim.Color() != chess.White {
			vRelW = 1
		}
		if victim.Color() != chess.Black {
			vRelB = 1
		}
		vW := vRelW*6 + uint16(victim.Type())
		vB := vRelB*6 + uint16(victim.Type())
		tw := uint16(t)
		addW = append(addW, uint16(PsqSize)+(aW*12+vW)*64+tw)
		addB = append(addB, uint16(PsqSize)+(aB*12+vB)*64+(tw^56))
	}
	return subW, addW, subB, addB
}

// pushMoveAwareEnumerate is the correct-by-construction reference delta path: it
// re-enumerates EVERY affected attacker's full edge set under both occupancies and
// lets the applyDiff count array cancel the unchanged edges. Retained as the
// fallback / A-B baseline for pushMoveAwareChanged; byte-identical result.
func (st *EnrichedStack) pushMoveAwareEnumerate(pos *chess.Position, m chess.Move) {
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
