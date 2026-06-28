package search

import "github.com/timanthonyalexander/gomachine/internal/chess"

// Correction history (Params.CorrHist). A set of small tables that learn, per
// board pattern, the systematic error between the static eval and the eventual
// search result, then correct the static eval by that learned bias. It makes
// evaluate() more accurate, which in turn sharpens every eval-gated decision the
// search already makes (reverse-futility, null-move, the "improving" heuristic,
// quiescence stand-pat). This is the SF18-standard "eval multiplier".
//
// We key THREE tables, all indexed [sideToMove][key % corrSize]:
//   - pawn structure (both pawn bitboards + both king squares),
//   - white's non-pawn pieces, black's non-pawn pieces (separately).
// Each entry is a fixed-point EMA (scaled by corrScale) of (search − static) in
// centipawns from the side-to-move's perspective; the apply step adds a clamped
// blend of the three back onto the raw static eval.
//
// The tables live on the Searcher and persist ACROSS moves within a game (their
// value is the accumulated bias), so they are cleared in ClearTT() — which the
// match driver calls between games — and NOT in reset(). Lazy-SMP workers start
// with zero tables, which is correct (a cold table contributes 0 correction).

const (
	corrSize  = 16384 // entries per side per table (power of two → mask, not modulo)
	corrMask  = corrSize - 1
	corrScale = 256 // fixed-point scale: an entry of corrScale ≈ 1cp of learned bias
	// corrMaxEntry bounds a stored entry to ±150cp (scaled), so a single table can
	// never dominate; the blended, re-clamped correction is bounded again on apply.
	corrMaxEntry = 150 * corrScale
	// corrMaxApply bounds the TOTAL correction applied to a static eval (centipawns).
	corrMaxApply = 150
	// corrWeightDen / corrMaxWeight drive the EMA update: new = (old*(den−w)+target*w)/den
	// with w = min(depth+1, corrMaxWeight). Deeper results move the entry more.
	corrWeightDen = 256
	corrMaxWeight = 16
	// blend weights for the three tables (pawn weighted a touch heavier).
	corrWPawn = 2
	corrWNP   = 1 // each non-pawn table
	corrWDen  = corrWPawn + corrWNP + corrWNP
)

// corrTables holds the correction-history tables. Kept in one struct so the whole
// set clears with a single assignment. The pawn + per-color non-pawn tables are
// always active (Params.CorrHist); minor and continuation are extra keys behind
// their own flags (Params.CorrHistMinor / Params.CorrHistCont).
type corrTables struct {
	pawn  [2][corrSize]int32 // [stm][pawnKey]
	wnp   [2][corrSize]int32 // [stm][white non-pawn key]
	bnp   [2][corrSize]int32 // [stm][black non-pawn key]
	minor [2][corrSize]int32 // [stm][minor-piece (N+B, both colors) key] — CorrHistMinor
	contn [12][64]int32      // [movedPiece][toSquare] continuation correction — CorrHistCont
}

// mix is a splitmix64 finalizer — cheap, good avalanche for folding bitboards.
func mix(x uint64) uint64 {
	x ^= x >> 30
	x *= 0xbf58476d1ce4e5b9
	x ^= x >> 27
	x *= 0x94d049bb133111eb
	x ^= x >> 31
	return x
}

// pawnKey hashes the pawn skeleton plus both king squares (king placement is part
// of what makes a pawn structure good or bad in the endgame).
func pawnKey(pos *chess.Position) uint64 {
	wp := uint64(pos.PieceBB(chess.WhitePawn))
	bp := uint64(pos.PieceBB(chess.BlackPawn))
	wk := uint64(pos.KingSquare(chess.White))
	bk := uint64(pos.KingSquare(chess.Black))
	return mix(mix(wp) ^ mix(bp*0x9e3779b97f4a7c15) ^ (wk << 6) ^ (bk << 12))
}

// nonPawnKey hashes one color's non-pawn, non-king pieces (N/B/R/Q occupancy).
func nonPawnKey(pos *chess.Position, c chess.Color) uint64 {
	n := uint64(pos.PieceBB(chess.MakePiece(c, chess.Knight)))
	b := uint64(pos.PieceBB(chess.MakePiece(c, chess.Bishop)))
	r := uint64(pos.PieceBB(chess.MakePiece(c, chess.Rook)))
	q := uint64(pos.PieceBB(chess.MakePiece(c, chess.Queen)))
	return mix(mix(n) ^ mix(b*0x9e3779b97f4a7c15) ^ mix(r*0xc2b2ae3d27d4eb4f) ^ mix(q*0x165667b19e3779f9))
}

// minorKey hashes the minor-piece skeleton (knights + bishops, both colors) — a
// separate pattern from the per-color non-pawn keys (Stockfish keeps a dedicated
// minor-piece corrhist; major-piece corrhist was tried and removed there).
func minorKey(pos *chess.Position) uint64 {
	wn := uint64(pos.PieceBB(chess.MakePiece(chess.White, chess.Knight)))
	wb := uint64(pos.PieceBB(chess.MakePiece(chess.White, chess.Bishop)))
	bn := uint64(pos.PieceBB(chess.MakePiece(chess.Black, chess.Knight)))
	bb := uint64(pos.PieceBB(chess.MakePiece(chess.Black, chess.Bishop)))
	return mix(mix(wn) ^ mix(wb*0x9e3779b97f4a7c15) ^ mix(bn*0xc2b2ae3d27d4eb4f) ^ mix(bb*0x165667b19e3779f9))
}

// correction returns the blended, clamped correction (centipawns, side-to-move
// perspective) to add to the raw static eval. Callers must already hold CorrHist.
func (s *Searcher) correction(pos *chess.Position) int {
	stm := pos.SideToMove()
	p := s.corr.pawn[stm][pawnKey(pos)&corrMask]
	w := s.corr.wnp[stm][nonPawnKey(pos, chess.White)&corrMask]
	b := s.corr.bnp[stm][nonPawnKey(pos, chess.Black)&corrMask]
	c := (int(p)*corrWPawn + int(w)*corrWNP + int(b)*corrWNP) / (corrScale * corrWDen)
	// Minor-piece key (extra, behind CorrHistMinor). Added on top with a non-pawn
	// table's weight; gated so the off-path is byte-identical.
	if s.params.CorrHistMinor {
		m := s.corr.minor[stm][minorKey(pos)&corrMask]
		c += int(m) * corrWNP / (corrScale * corrWDen)
	}
	if c > corrMaxApply {
		c = corrMaxApply
	} else if c < -corrMaxApply {
		c = -corrMaxApply
	}
	return c
}

// contCorrection returns the continuation correction (centipawns, side-to-move
// perspective) from the side-to-move's own prior moves at ply-2 and ply-4, behind
// CorrHistCont. Applied ONLY at the negamax static-eval site (where contMove is
// reliably maintained by ancestors); not in qsearch, whose ply slots may hold
// stale move records. Caller has already checked CorrHistCont.
func (s *Searcher) contCorrection(ply int) int {
	c := 0
	if ply >= 2 && s.contMove[ply-2].ok {
		e := s.corr.contn[s.contMove[ply-2].pc][s.contMove[ply-2].to]
		c += int(e) / (corrScale * corrWDen * 2)
	}
	if ply >= 4 && s.contMove[ply-4].ok {
		e := s.corr.contn[s.contMove[ply-4].pc][s.contMove[ply-4].to]
		c += int(e) / (corrScale * corrWDen * 2)
	}
	lim := corrMaxApply / 2
	if c > lim {
		c = lim
	} else if c < -lim {
		c = -lim
	}
	return c
}

// updateCorrEntry applies one EMA step of an entry toward target (already in
// scaled units), with EMA weight w, and re-clamps to ±corrMaxEntry.
func updateCorrEntry(e *int32, target, w int) {
	v := (int(*e)*(corrWeightDen-w) + target*w) / corrWeightDen
	if v > corrMaxEntry {
		v = corrMaxEntry
	} else if v < -corrMaxEntry {
		v = -corrMaxEntry
	}
	*e = int32(v)
}

// updateCorrHist nudges the three side-to-move tables toward (bestScore −
// staticEval). Caller has already verified the signal is trustworthy (out of
// check, defined static eval, non-noisy best move, bound agrees with direction,
// non-mate/TB score).
func (s *Searcher) updateCorrHist(pos *chess.Position, staticEval, bestScore, depth, ply int) {
	diff := bestScore - staticEval
	if diff > corrMaxApply {
		diff = corrMaxApply
	} else if diff < -corrMaxApply {
		diff = -corrMaxApply
	}
	target := diff * corrScale
	w := depth + 1
	if w > corrMaxWeight {
		w = corrMaxWeight
	}
	stm := pos.SideToMove()
	updateCorrEntry(&s.corr.pawn[stm][pawnKey(pos)&corrMask], target, w)
	updateCorrEntry(&s.corr.wnp[stm][nonPawnKey(pos, chess.White)&corrMask], target, w)
	updateCorrEntry(&s.corr.bnp[stm][nonPawnKey(pos, chess.Black)&corrMask], target, w)
	if s.params.CorrHistMinor {
		updateCorrEntry(&s.corr.minor[stm][minorKey(pos)&corrMask], target, w)
	}
	if s.params.CorrHistCont {
		if ply >= 2 && s.contMove[ply-2].ok {
			updateCorrEntry(&s.corr.contn[s.contMove[ply-2].pc][s.contMove[ply-2].to], target, w)
		}
		if ply >= 4 && s.contMove[ply-4].ok {
			updateCorrEntry(&s.corr.contn[s.contMove[ply-4].pc][s.contMove[ply-4].to], target, w)
		}
	}
}
