package search

import "github.com/timanthonyalexander/gomachine/internal/chess"

// Continuation history, Stormphrax-style (Params.ContHist2). A stronger VARIANT of
// the (SPRT-rejected) ContHist, kept fully SEPARATE from it (own tables, own flag).
// Two things distinguish it from ContHist:
//
//  1. FOUR ancestor offsets — 1, 2, 4 and 6 plies back — instead of ContHist's
//     1+2. The deeper reach (matching Stormphrax history.h getConthist) lets a
//     quiet that historically refuted a move several plies up still be trusted.
//
//  2. A COUPLED gravity update ("updateWithBase"): the decay pull is NOT each
//     entry's own value (plain self-gravity, as in ContHist) but a weighted BLEND
//     of the main butterfly history and all four continuation entries for that
//     move. So the tables age together — a move with strong evidence anywhere
//     decays slowly everywhere — instead of drifting independently. Mirrors
//     Stormphrax's HistoryEntry::updateWithBase + updateConthist base blend.
//
// Like ContHist it feeds quiet move ordering, the LMR reduction term and the
// history-pruning margin, all guarded on Params.ContHist2. With the flag OFF no
// read/update/order/reduction here executes, so the search is byte-identical.
//
// Ownership: cont2 is a per-Searcher pointer (like cont / the butterfly history).
// Each Lazy-SMP worker is its own *Searcher (newWithSharedTT shares only the TT),
// so cont2 is never touched by another goroutine — race-safe by construction. The
// contMove path stack is shared with ContHist/CorrHistCont and is maintained
// unconditionally (see search.go), so the offset lookups work regardless of flag.

// contOffsets are the ancestor plies the continuation tables key off, matching
// Stormphrax's 1/2/4/6-back continuations. Table i keys off contOffsets[i].
var contOffsets = [4]int{1, 2, 4, 6}

const (
	// cont2Max bounds a single ContHist2 entry (also the gravity denominator). Set
	// to the butterfly-history bound so the blended base stays on the same scale as
	// an individual entry and the whole ordering hierarchy is preserved.
	cont2Max = 8192

	// Coupled-gravity base-blend weights (sum to 1024, applied then /1024): the
	// decay pull is a weighted average of the move's main (butterfly) history and
	// its four continuation entries. Heavier weight on the near offsets (1/2) than
	// the far ones (4/6), mirroring Stormphrax's contBase*Weight ordering.
	cont2BaseMainWeight = 256
)

// cont2BaseContWeight[i] weights table i (offset contOffsets[i]) in the base blend.
var cont2BaseContWeight = [4]int{256, 256, 128, 128}

// contHist2 holds the four continuation tables (offsets 1/2/4/6), each keyed by
// [prevPiece][prevTo][curPiece][curTo]. ~4.7 MB total, behind a pointer on the
// Searcher so a ContHist2-off searcher pays no memory. Per-search, per-worker.
type contHist2 struct {
	tbl [4][12][64][12][64]int16
}

// cont2Begin (re)allocates and clears the ContHist2 tables for a fresh search.
// Called from reset() AFTER contBegin() (which resets the shared contMove path).
// A no-op when ContHist2 is off. Allocation is gated on the flag so an off search
// pays nothing; the flag also guards every read/update, so allocation alone can
// never change behavior.
func (s *Searcher) cont2Begin() {
	if !s.params.ContHist2 {
		return
	}
	if s.cont2 == nil {
		s.cont2 = &contHist2{}
		return
	}
	*s.cont2 = contHist2{} // zero in place (no pointers → memclr); per-search, like butterfly
}

// contScore2 returns the summed 1/2/4/6-ply continuation score for a quiet move
// (curPc → to) at the given ply. Caller has verified ContHist2 is on (cont2 != nil).
func (s *Searcher) contScore2(ply int, curPc chess.Piece, to chess.Square) int {
	sum := 0
	for i, off := range contOffsets {
		if off <= ply {
			if p := s.contMove[ply-off]; p.ok {
				sum += int(s.cont2.tbl[i][p.pc][p.to][curPc][to])
			}
		}
	}
	return sum
}

// cont2Base computes the coupled-gravity base for a quiet move: a weighted blend
// (/1024) of its main (butterfly) history and its four continuation entries. This
// is the shared decay term of updateWithBase — using it in place of each entry's
// own value couples the tables so they age together.
func (s *Searcher) cont2Base(ply int, curPc chess.Piece, to chess.Square) int {
	base := s.history[curPc][to] * cont2BaseMainWeight
	for i, off := range contOffsets {
		if off <= ply {
			if p := s.contMove[ply-off]; p.ok {
				base += int(s.cont2.tbl[i][p.pc][p.to][curPc][to]) * cont2BaseContWeight[i]
			}
		}
	}
	return base / 1024
}

// cont2Gravity applies one coupled ("updateWithBase") gravity step: nudge toward
// ±cont2Max by bonus with a pull proportional to the shared base (not the entry's
// own value), then clamp to int16 range. Mirrors Stormphrax HistoryEntry::updateWithBase.
func cont2Gravity(e *int16, bonus, base int) {
	if bonus > maxHistory {
		bonus = maxHistory
	} else if bonus < -maxHistory {
		bonus = -maxHistory
	}
	v := int(*e)
	v += bonus - base*absInt(bonus)/cont2Max
	if v > cont2Max {
		v = cont2Max
	} else if v < -cont2Max {
		v = -cont2Max
	}
	*e = int16(v)
}

// cont2Update credits (or penalizes) one quiet move in all four continuation
// tables, keyed by the 1/2/4/6-ply ancestor moves on the current path, using the
// single shared base blend for the coupled decay.
func (s *Searcher) cont2Update(ply int, curPc chess.Piece, to chess.Square, bonus int) {
	base := s.cont2Base(ply, curPc, to)
	for i, off := range contOffsets {
		if off <= ply {
			if p := s.contMove[ply-off]; p.ok {
				cont2Gravity(&s.cont2.tbl[i][p.pc][p.to][curPc][to], bonus, base)
			}
		}
	}
}

// updateContHist2 rewards the quiet move that caused a beta cutoff (+bonus) and
// penalizes the quiets tried before it that failed to cut off (−bonus), in all
// four continuation tables. Mirrors updateContHist. No-op when ContHist2 is off.
func (s *Searcher) updateContHist2(pos *chess.Position, best chess.Move, tried []chess.Move, depth, ply int) {
	if !s.params.ContHist2 || s.cont2 == nil {
		return
	}
	bonus := statBonus(depth)
	s.cont2Update(ply, pos.PieceOn(best.From()), best.To(), bonus)
	for _, q := range tried {
		if q != best {
			s.cont2Update(ply, pos.PieceOn(q.From()), q.To(), -bonus)
		}
	}
}
