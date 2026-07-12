package search

import "github.com/timanthonyalexander/gomachine/internal/chess"

// Continuation history (Params.ContHist). Move-ordering history keyed by the
// PRECEDING move(s): a quiet move that refuted a particular previous move is
// likely good again the next time that same previous move is on the board. This
// complements (does not replace) the butterfly history [12][64] and killers, and
// it feeds BOTH quiet-move ordering and the LMR reduction decision — so it
// multiplies the value of every reduction / late-move prune already in the search.
//
// Two tables are kept, keyed by the parent (1-ply, the "countermove") and the
// grandparent (2-ply) move:
//
//	cont.one[prevPiece][prevTo][curPiece][curTo]   // parent  (ply-1)
//	cont.two[prevPiece][prevTo][curPiece][curTo]   // grandparent (ply-2)
//
// Each entry is a bounded gravity counter (same scheme as butterfly history),
// stored as int16 to keep the two tables ~1.2 MB each. The tables mirror the
// butterfly-history lifecycle exactly: cleared in reset() every search, never
// persisted. Lazy-SMP workers each own their own tables.

const (
	// contMax bounds a single continuation-history entry (also the gravity
	// denominator). Two entries (1-ply + 2-ply) plus butterfly stay far below the
	// killer/capture ordering tiers, so the move-ordering hierarchy is preserved.
	contMax = 8192
)

// contHist holds the two continuation tables. Stored behind a pointer on the
// Searcher so an HCE/ContHist-off searcher pays no memory for it (~2.4 MB total).
type contHist struct {
	one [12][64][12][64]int16 // parent (1-ply / countermove) keyed
	two [12][64][12][64]int16 // grandparent (2-ply) keyed
}

// contEntry records the moving piece + target of a move played on the current
// search path, so a child node can key its continuation tables off its ancestors.
// ok is false for the root sentinel and for a null move (no continuation).
type contEntry struct {
	pc        chess.Piece
	to        chess.Square
	ok        bool
	quiet     bool  // move was a quiet (not capture/promotion); read by the PCM bonus/malus.
	moveCount int16 // 0-based rank of this move among searched moves at its node (TT/best = 0);
	// read only by the PCM MALUS gate (penalize a refuted parent only if it was an early move).
	// Both fields are set at the real-move push site (the default unified loop). Staged/ProbCut
	// push sites leave them zero → PCM is simply inert on those default-off paths, never wrong.
}

// contBegin (re)allocates and clears the continuation tables for a fresh search.
// Called from reset(); a no-op (beyond the path reset) when ContHist is off.
func (s *Searcher) contBegin() {
	s.contMove = [maxPly]contEntry{}
	if !s.params.ContHist {
		return
	}
	if s.cont == nil {
		s.cont = &contHist{}
		return
	}
	*s.cont = contHist{} // zero in place (no pointers → memclr); per-search, like butterfly
}

// contScore returns the blended 1-ply + 2-ply continuation score for a quiet move
// (curPc → to) at the given ply. Caller has verified ContHist is on.
func (s *Searcher) contScore(ply int, curPc chess.Piece, to chess.Square) int {
	sum := 0
	if ply >= 1 {
		if p := s.contMove[ply-1]; p.ok {
			sum += int(s.cont.one[p.pc][p.to][curPc][to])
		}
	}
	if ply >= 2 {
		if p := s.contMove[ply-2]; p.ok {
			sum += int(s.cont.two[p.pc][p.to][curPc][to])
		}
	}
	return sum
}

// contGravity applies one bounded gravity step to a continuation entry: nudge
// toward ±contMax by bonus with a pull proportional to the current magnitude, so
// the table self-ages and stays in int16 range. Mirrors updateHistory. maxHist is
// only the BONUS CLAMP (Params.MaxHistory) — contMax (the self-age divisor/cap)
// is a separate constant and is left untouched.
func contGravity(e *int16, bonus, maxHist int) {
	if bonus > maxHist {
		bonus = maxHist
	} else if bonus < -maxHist {
		bonus = -maxHist
	}
	v := int(*e)
	v += bonus - v*absInt(bonus)/contMax
	if v > contMax {
		v = contMax
	} else if v < -contMax {
		v = -contMax
	}
	*e = int16(v)
}

// contUpdate credits (or penalizes) one quiet move in both continuation tables,
// keyed by the parent and grandparent moves on the current path.
func (s *Searcher) contUpdate(ply int, curPc chess.Piece, to chess.Square, bonus int) {
	if ply >= 1 {
		if p := s.contMove[ply-1]; p.ok {
			contGravity(&s.cont.one[p.pc][p.to][curPc][to], bonus, s.params.MaxHistory)
		}
	}
	if ply >= 2 {
		if p := s.contMove[ply-2]; p.ok {
			contGravity(&s.cont.two[p.pc][p.to][curPc][to], bonus, s.params.MaxHistory)
		}
	}
}

// updateContHist rewards the quiet move that caused a beta cutoff (+bonus) and
// penalizes the quiets tried before it that failed to cut off (−bonus), in both
// continuation tables. Mirrors updateQuietStats' gravity bonus. tried includes
// best as its last element. No-op when ContHist is off.
func (s *Searcher) updateContHist(pos *chess.Position, best chess.Move, tried []chess.Move, depth, ply int) {
	if !s.params.ContHist || s.cont == nil {
		return
	}
	bonus := s.statBonus(depth)
	malus := s.statMalus(depth)
	s.contUpdate(ply, pos.PieceOn(best.From()), best.To(), bonus)
	for _, q := range tried {
		if q != best {
			s.contUpdate(ply, pos.PieceOn(q.From()), q.To(), -malus)
		}
	}
}

// pcmCreditParent gives the quiet parent move (contMove[ply-1]) a positive
// continuation + butterfly bonus on a PURE FAIL-LOW node: no move raised alpha, so
// the parent move "caused the fail low" — it was a good move for the side that
// played it. Stockfish 18 search.cpp:1423 (the !priorCapture fail-low branch) and
// Stormphrax search.cpp:1398 (the parent-counter-move bonus), collapsed to our two
// continuation tables + butterfly and to 3 SPSA knobs.
//
// Crediting the PARENT move keys cont.one by contMove[ply-2] and cont.two by
// contMove[ply-3] — reproduced exactly by contUpdate(ply-1, parentPc, parentTo, …).
// Caller has verified: ParentContHistBonus on, flag==ttUpper (pure fail-low),
// ply>=1, contMove[ply-1].ok && .quiet.
func (s *Searcher) pcmCreditParent(ply, depth, bestScore, staticEval int, inCheck bool) {
	p := s.contMove[ply-1]

	// SF gates parent credit behind a NEGATIVE base offset (bonusScale starts at −215,
	// then max(0,…)): only DEEP or SEVERE fail-lows credit the parent; shallow/mild ones
	// get nothing. A positive floor (crediting every fail-low) over-pollutes history and
	// washes — that was the v1 slip. weight = depth·PCMDepthScale − PCMBaseOffset (+ a
	// severity bonus), clamped to (0,1024].
	weight := depth*s.params.PCMDepthScale - s.params.PCMBaseOffset
	if !inCheck && s.params.PCMEvalMargin > 0 && bestScore <= staticEval-s.params.PCMEvalMargin {
		weight += s.params.PCMMarginBonus // severe fail-low relative to our own static eval
	}
	if weight <= 0 {
		return // shallow/mild fail-low → no credit (SF's bonusScale clamped to 0)
	}
	if weight > 1024 {
		weight = 1024 // bounded credit (≤ one full cutoff bonus)
	}

	scaled := s.statBonus(depth) * weight / 1024 // 0 … one cutoff-sized bonus, gated by depth+severity
	if scaled <= 0 {
		return
	}
	if s.cont != nil { // both continuation tables (only when ContHist is on)
		s.contUpdate(ply-1, p.pc, p.to, scaled)
	}
	s.updateHistory(p.pc, p.to, scaled) // + butterfly (pc encodes color, == SF mainHistory[~us])
}

// pcmPenalizeParent penalizes the quiet parent move (contMove[ply-1]) when the CHILD
// fails HIGH: the parent's move got refuted, so it was worse than its ordering rank
// suggested. Stockfish 18 search.cpp:1859 (update_all_stats) / :774 (TT-cutoff path).
// Two SF-specific details, both grounded in source:
//   - CONTINUATION HISTORY ONLY — SF's fail-high parent penalty hits only
//     update_continuation_histories, NOT main/pawn history (asymmetric with the bonus,
//     which also credits butterfly). So no updateHistory call here.
//   - Gated by the parent being an EARLY move (caller checks moveCount < PCMMalusMaxMoves):
//     fail-highs are the norm at interior cut-nodes, so penalizing every parent is noise;
//     restricting to top-ordered parent moves that still got refuted is the real signal.
//
// Stormphrax has NO analog (it penalizes fail-low SIBLINGS, not the parent) — this is
// SF-specific taste, hence SPRT-gated and lower-prior.
func (s *Searcher) pcmPenalizeParent(ply, depth int) {
	if s.cont == nil { // conthist-only: nothing to penalize when ContHist is off
		return
	}
	p := s.contMove[ply-1]
	mag := s.statMalus(depth) * s.params.PCMMalusScale / 1024
	if mag <= 0 {
		return
	}
	s.contUpdate(ply-1, p.pc, p.to, -mag) // keys cont.one←contMove[ply-2], cont.two←contMove[ply-3]
}
