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
	pc chess.Piece
	to chess.Square
	ok bool
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
// the table self-ages and stays in int16 range. Mirrors updateHistory.
func contGravity(e *int16, bonus int) {
	if bonus > maxHistory {
		bonus = maxHistory
	} else if bonus < -maxHistory {
		bonus = -maxHistory
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
			contGravity(&s.cont.one[p.pc][p.to][curPc][to], bonus)
		}
	}
	if ply >= 2 {
		if p := s.contMove[ply-2]; p.ok {
			contGravity(&s.cont.two[p.pc][p.to][curPc][to], bonus)
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
	bonus := statBonus(depth)
	s.contUpdate(ply, pos.PieceOn(best.From()), best.To(), bonus)
	for _, q := range tried {
		if q != best {
			s.contUpdate(ply, pos.PieceOn(q.From()), q.To(), -bonus)
		}
	}
}
