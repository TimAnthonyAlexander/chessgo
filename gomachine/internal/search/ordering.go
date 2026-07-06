package search

import "github.com/timanthonyalexander/gomachine/internal/chess"

// Move-ordering scores (SPEC §4.7): TT move first, then captures by MVV-LVA,
// then killer moves, then quiet moves by history heuristic.
const (
	scoreTT      = 2_000_000
	scorePromo   = 1_500_000
	scoreCapture = 1_000_000
	scoreKiller0 = 900_000
	scoreKiller1 = 800_000
	// scoreLosingCapture sits below killers and quiet (history) moves so that
	// SEE-losing captures are tried last (SEE ordering, enabled by Params.SEE).
	scoreLosingCapture = -2_000_000
	// seeLosingScoreThreshold splits captureScore's two SEE tiers. A capture with
	// SEE<0 gets base=scoreLosingCapture (−2,000,000); an equal/winning one gets
	// base=scoreCapture (+1,000,000). The within-tier adjustments (mvvlva up to
	// ~14,300 for a queen victim, ±maxHistory=8,192 capthist) are ≪ the 3,000,000
	// tier gap, so a losing capture's score is always ≤ −1,977,508 and a
	// winning/equal one always ≥ +973,408. Any score ≤ this mid-gap value therefore
	// encodes SEE<0 exactly — the qsearch SEE prune (threshold 0) reads it back via
	// SEEReuseQS instead of recomputing pos.SEE.
	seeLosingScoreThreshold = -1_000_000
)

// isCapture reports whether m captures on the (pre-move) position.
func isCapture(pos *chess.Position, m chess.Move) bool {
	return pos.PieceOn(m.To()) != chess.NoPiece || m.Type() == chess.EnPassant
}

// captureGain returns the centipawn value of m's victim (for delta pruning).
func captureGain(pos *chess.Position, m chess.Move) int {
	if m.Type() == chess.EnPassant {
		return chess.SEEValues[chess.Pawn]
	}
	if v := pos.PieceOn(m.To()); v != chess.NoPiece {
		return chess.SEEValues[v.Type()]
	}
	return 0
}

// scoreMoves fills scores[i] with the ordering score of ml[i].
func (s *Searcher) scoreMoves(pos *chess.Position, ml *chess.MoveList, ttMove chess.Move, ply int, scores *[256]int) {
	for i := 0; i < ml.Len(); i++ {
		scores[i] = s.moveScore(pos, ml.Get(i), ttMove, ply)
	}
}

func (s *Searcher) moveScore(pos *chess.Position, m, ttMove chess.Move, ply int) int {
	if m == ttMove {
		return scoreTT
	}
	if m.Type() == chess.Promotion {
		return scorePromo + pieceOrderVal[m.Promo()]
	}
	if m.Type() == chess.EnPassant {
		mvvlva := pieceOrderVal[chess.Pawn]*16 - pieceOrderVal[chess.Pawn]
		return s.captureScore(pos, m, mvvlva)
	}
	if victim := pos.PieceOn(m.To()); victim != chess.NoPiece {
		attacker := pos.PieceOn(m.From()).Type()
		mvvlva := pieceOrderVal[victim.Type()]*16 - pieceOrderVal[attacker]
		return s.captureScore(pos, m, mvvlva)
	}
	// Quiet move.
	if m == s.killers[ply][0] {
		return scoreKiller0
	}
	if m == s.killers[ply][1] {
		return scoreKiller1
	}
	mover := pos.PieceOn(m.From())
	h := s.history[mover][m.To()]
	// Continuation history: a quiet that refuted the parent/grandparent move scores
	// higher. Added to the butterfly term; both stay well below the killer tier.
	if s.params.ContHist && s.cont != nil {
		h += s.contScore(ply, mover, m.To())
	}
	// Stormphrax-style continuation history (independent path; both stay well below
	// the killer tier). ContHist and ContHist2 are never on together in practice.
	if s.params.ContHist2 && s.cont2 != nil {
		h += s.contScore2(ply, mover, m.To())
	}
	return h
}

// captureScore ranks a capture: winning/equal captures (or all captures when SEE
// is off) sort by MVV-LVA above killers; SEE-losing captures sort last. With
// CaptHist on, the (piece,to,victim) capture-history score is added WITHIN the
// chosen tier — bounded by ±maxHistory (≪ the ~1M tier gap), so it only reorders
// captures relative to each other, never crosses the good/bad SEE split.
func (s *Searcher) captureScore(pos *chess.Position, m chess.Move, mvvlva int) int {
	base := scoreCapture
	if s.params.SEE && pos.SEE(m) < 0 {
		base = scoreLosingCapture
	}
	if s.params.CaptHist {
		return base + mvvlva + s.captureHist[pos.PieceOn(m.From())][m.To()][captureVictim(pos, m)]
	}
	return base + mvvlva
}

// selectLegacy=true (default) uses the branchy selection sort; false uses the packed
// branchless path. Measured NEUTRAL (+0.2%, noise) on coalla v4 and a slight drag in
// combo, so the proven branchy path stays the default; packed kept behind the toggle.
var selectLegacy = true

// SetSelectLegacy switches selectMove between the packed-branchless path (false,
// default) and the old branchy path (true). For NPS A/B; both select identically.
func SetSelectLegacy(on bool) { selectLegacy = on }

// selectMove performs one step of a selection sort: it finds the highest-scored
// move in [i, len) and swaps it (and its score) into slot i. This lazily orders
// moves so a beta-cutoff avoids sorting the rest.
//
// The default path is branchless: pack (score, index) into one uint64 —
// (score-INT32_MIN)<<32 | (256-index) — and take the running max. Ties keep the
// lowest index (higher 256-index wins), byte-identical to the old strict-`>`
// scan, but the hot loop is a single max with no data-dependent branch to
// mispredict (the old `if scores[j] > scores[best]` was ~40% of selectMove).
func selectMove(ml *chess.MoveList, scores *[256]int, i int) {
	if selectLegacy {
		selectMoveLegacy(ml, scores, i)
		return
	}
	const off = int64(1) << 31 // -math.MinInt32: shift signed score into unsigned order
	n := ml.Len()
	best := uint64(int64(scores[i])+off)<<32 | uint64(256-i)
	for j := i + 1; j < n; j++ {
		cur := uint64(int64(scores[j])+off)<<32 | uint64(256-j)
		if cur > best { // simple form the compiler lowers to CMOV (no index bookkeeping)
			best = cur
		}
	}
	bi := 256 - int(best&0xFFFFFFFF)
	if bi != i {
		ml.Swap(i, bi)
		scores[i], scores[bi] = scores[bi], scores[i]
	}
}

func selectMoveLegacy(ml *chess.MoveList, scores *[256]int, i int) {
	best := i
	for j := i + 1; j < ml.Len(); j++ {
		if scores[j] > scores[best] {
			best = j
		}
	}
	if best != i {
		ml.Swap(i, best)
		scores[i], scores[best] = scores[best], scores[i]
	}
}

func (s *Searcher) recordKiller(ply int, m chess.Move) {
	if s.killers[ply][0] != m {
		s.killers[ply][1] = s.killers[ply][0]
		s.killers[ply][0] = m
	}
}
