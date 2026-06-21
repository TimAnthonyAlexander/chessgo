package eval

import "github.com/timanthonyalexander/gomachine/internal/chess"

// Config selects which knowledge terms are layered onto the always-on base
// (material + tapered PSQT + tempo), and supplies the tunable Weights. Each term
// is gated so the harness can A/B it; the Texel tuner optimizes W jointly. eval
// only reads W, so a *Weights may be shared across SMP search threads.
type Config struct {
	Mobility    bool
	Pawns       bool
	KingSafety  bool
	BishopPair  bool
	KingProx    bool // EG-only king proximity to advanced passers (escort/blockade)
	PawnRace    bool // EG-only knight-aware unstoppable-passer / race detection
	ScaleFactor bool // EG drawishness scale factor (Stockfish-classical, scales the eg term)
	UseTuned    bool // select the Texel-tuned PSQT (tuned_tables.go) over PeSTO
	NNUE        bool // route static eval through the NNUE net instead of HCE; READ BY THE SEARCHER (eval.Evaluate ignores it), so eval keeps no dependency on internal/nnue
	W           *Weights
}

// TunedWeights returns the Texel-tuned knowledge weights (tuned_tables.go),
// paired with the tuned PSQT via Config.UseTuned. Until a tune is generated it
// equals DefaultWeights().
func TunedWeights() *Weights { return tunedWeightsLiteral() }

// Weights holds every tunable knowledge-term weight (centipawns). The PSQT and
// material values live in the fixed base tables (pesto_tables.go) and are not
// tuned in this version. Penalties are negative.
type Weights struct {
	MobMG                      [4]int // mobility per reachable square, by piece (0=N,1=B,2=R,3=Q)
	MobEG                      [4]int
	IsolatedMG, IsolatedEG     int // isolated pawn penalty
	DoubledMG, DoubledEG       int // doubled pawn penalty (per extra pawn on a file)
	PassedMG, PassedEG         int // passed pawn base bonus, scaled by advancement (0..5)
	BishopPairMG, BishopPairEG int // bonus for holding both bishops
	KingShield                 int // MG penalty per missing pawn in the king's shield
	KingProxEG                 int // EG: per-rank weight for king proximity to (≥4th-rank) passers
	PawnRaceEG                 int // EG: base bonus for an unstoppable passer (knight-aware), decayed by plies-to-queen
}

// DefaultWeights is the hand-picked fallback weight set (positive mobility,
// negative penalties), used only when no tuned weights are available. The engine
// default is now the SPRT-accepted tuned set (TunedWeights, selected by
// search.DefaultParams' TunedEval=true), which gained +101 Elo @ movetime with
// the knowledge terms ON. An earlier MSE tune (game-result + Stockfish-distill
// targets, coordinate descent over bolt-on scalars on a frozen PSQT) lost −148
// Elo — but that was a broken *method*, not a verdict on these terms: joint Adam
// on WDL with the PSQT tuned in flips the sign. See docs/ENGINE_STRENGTH.md §5–§6.
func DefaultWeights() *Weights {
	return &Weights{
		MobMG:      [4]int{4, 3, 2, 1},
		MobEG:      [4]int{4, 3, 4, 2},
		IsolatedMG: -12, IsolatedEG: -8,
		DoubledMG: -10, DoubledEG: -16,
		PassedMG: 10, PassedEG: 20,
		BishopPairMG: 25, BishopPairEG: 40,
		KingShield: -12,
		KingProxEG: 4,
		PawnRaceEG: 700,
	}
}

// Clone returns a deep copy (the tuner mutates copies).
func (w *Weights) Clone() *Weights {
	c := *w
	return &c
}

// Tunables returns pointers to every scalar weight so the Texel tuner can perturb
// them in place. Order is stable.
func (w *Weights) Tunables() []*int {
	ps := make([]*int, 0, 17)
	for i := range w.MobMG {
		ps = append(ps, &w.MobMG[i])
	}
	for i := range w.MobEG {
		ps = append(ps, &w.MobEG[i])
	}
	return append(ps, &w.IsolatedMG, &w.IsolatedEG, &w.DoubledMG, &w.DoubledEG,
		&w.PassedMG, &w.PassedEG, &w.BishopPairMG, &w.BishopPairEG, &w.KingShield)
}

var defaultW = DefaultWeights()

// --- precomputed masks ---

var (
	fileMask         [8]chess.Bitboard
	adjacentFileMask [8]chess.Bitboard
	passedMask       [2][64]chess.Bitboard // enemy-pawn-free zone ahead → passed
	shieldMask       [2][64]chess.Bitboard // 3 squares in front of the king
)

func sqBB(f, r int) chess.Bitboard { return chess.MakeSquare(chess.File(f), chess.Rank(r)).BB() }

func init() {
	for f := 0; f < 8; f++ {
		for r := 0; r < 8; r++ {
			fileMask[f] |= sqBB(f, r)
		}
	}
	for f := 0; f < 8; f++ {
		if f > 0 {
			adjacentFileMask[f] |= fileMask[f-1]
		}
		if f < 7 {
			adjacentFileMask[f] |= fileMask[f+1]
		}
	}
	for sq := 0; sq < 64; sq++ {
		f, r := sq%8, sq/8
		for ff := f - 1; ff <= f+1; ff++ {
			if ff < 0 || ff > 7 {
				continue
			}
			for rr := r + 1; rr < 8; rr++ {
				passedMask[chess.White][sq] |= sqBB(ff, rr)
			}
			for rr := 0; rr < r; rr++ {
				passedMask[chess.Black][sq] |= sqBB(ff, rr)
			}
			if r+1 < 8 {
				shieldMask[chess.White][sq] |= sqBB(ff, r+1)
			}
			if r-1 >= 0 {
				shieldMask[chess.Black][sq] |= sqBB(ff, r-1)
			}
		}
	}
}

// --- terms (all return White-minus-Black contributions) ---

func mobility(pos *chess.Position, w *Weights) (mg, eg int) {
	wmg, weg := sideMobility(pos, chess.White, w)
	bmg, beg := sideMobility(pos, chess.Black, w)
	return wmg - bmg, weg - beg
}

func sideMobility(pos *chess.Position, us chess.Color, w *Weights) (mg, eg int) {
	area := ^pos.ColorBB(us) &^ pos.PawnAttacksBB(us.Opposite())
	for pt := chess.Knight; pt <= chess.Queen; pt++ {
		idx := int(pt - chess.Knight)
		bb := pos.PieceBB(chess.MakePiece(us, pt))
		for bb != 0 {
			sq := bb.PopLSB()
			n := (pos.AttacksFrom(sq) & area).Count()
			mg += n * w.MobMG[idx]
			eg += n * w.MobEG[idx]
		}
	}
	return mg, eg
}

func pawnStructure(pos *chess.Position, w *Weights) (mg, eg int) {
	wmg, weg := sidePawns(pos, chess.White, w)
	bmg, beg := sidePawns(pos, chess.Black, w)
	return wmg - bmg, weg - beg
}

func sidePawns(pos *chess.Position, us chess.Color, w *Weights) (mg, eg int) {
	own := pos.PieceBB(chess.MakePiece(us, chess.Pawn))
	enemy := pos.PieceBB(chess.MakePiece(us.Opposite(), chess.Pawn))

	bb := own
	for bb != 0 {
		sq := bb.PopLSB()
		f := int(sq.File())
		if own&adjacentFileMask[f] == 0 { // isolated
			mg += w.IsolatedMG
			eg += w.IsolatedEG
		}
		if enemy&passedMask[us][sq] == 0 { // passed
			adv := advancement(us, int(sq.Rank())) / 2
			mg += w.PassedMG * adv
			eg += w.PassedEG * adv
		}
	}
	for f := 0; f < 8; f++ { // doubled
		if c := (own & fileMask[f]).Count(); c > 1 {
			mg += w.DoubledMG * (c - 1)
			eg += w.DoubledEG * (c - 1)
		}
	}
	return mg, eg
}

// advancement returns how many ranks a pawn of color us on rank r (0-indexed)
// has advanced from its home rank (0..5).
func advancement(us chess.Color, r int) int {
	if us == chess.White {
		return r - 1
	}
	return 6 - r
}

// passedKingProximity is the endgame-only king-proximity term: it rewards
// keeping your own king near your advanced passed pawns and the enemy king far
// from them. This is the single biggest endgame-knowledge gap in a PeSTO+linear
// eval — the engine never escorts its own passers nor chases the opponent's, so
// in a connected-passer race it walks into a lost promotion it can't see at
// search depth. Returns the White-minus-Black contribution; the caller adds it
// to the EG score only, so the taper makes it inert in the middlegame.
//
// Design (intentionally minimal for the first SPRT, your §6 "don't double-count"
// rule): the per-passer core is the *centered* race differential
// (enemyKingDist − ownKingDist) to the pawn's stop square, so two equidistant
// kings contribute exactly 0 and the term overlaps PassedEG as little as
// possible. It is rank-weighted (rw = advancement−1) so escorting an almost-queen
// dominates nudging a home pawn, and only fires for passers on the 4th rank or
// beyond (where king placement actually decides the race).
func passedKingProximity(pos *chess.Position, w *Weights) int {
	if w.KingProxEG == 0 {
		return 0
	}
	return sideKingProx(pos, chess.White, w) - sideKingProx(pos, chess.Black, w)
}

func sideKingProx(pos *chess.Position, us chess.Color, w *Weights) int {
	own := pos.PieceBB(chess.MakePiece(us, chess.Pawn))
	enemy := pos.PieceBB(chess.MakePiece(us.Opposite(), chess.Pawn))
	ourK := pos.KingSquare(us)
	enemyK := pos.KingSquare(us.Opposite())

	total := 0
	bb := own
	for bb != 0 {
		sq := bb.PopLSB()
		if enemy&passedMask[us][sq] != 0 {
			continue // not passed
		}
		adv := advancement(us, int(sq.Rank())) // 0..5
		if adv < 2 {
			continue // only 4th-rank-and-beyond passers — king placement decides those
		}
		stop := stopSquare(us, sq)
		ourD := kingDist(ourK, stop)
		enemyD := kingDist(enemyK, stop)
		rw := adv - 1 // 1..4: an almost-queen dominates a home-rank passer
		total += w.KingProxEG * rw * (enemyD - ourD)
	}
	return total
}

// stopSquare is the square directly in front of a pawn (toward promotion) — the
// blockade/escort square the kings race for. A passer is never on the last rank,
// so this is always on the board.
func stopSquare(us chess.Color, sq chess.Square) chess.Square {
	f, r := int(sq.File()), int(sq.Rank())
	if us == chess.White {
		r++
	} else {
		r--
	}
	return chess.MakeSquare(chess.File(f), chess.Rank(r))
}

// kingDist is Chebyshev (king-move) distance, capped at 5 to bound far-king noise
// (mirrors the standard Stockfish king-proximity cap).
func kingDist(a, b chess.Square) int {
	df := int(a.File()) - int(b.File())
	if df < 0 {
		df = -df
	}
	dr := int(a.Rank()) - int(b.Rank())
	if dr < 0 {
		dr = -dr
	}
	d := df
	if dr > d {
		d = dr
	}
	if d > 5 {
		d = 5
	}
	return d
}

func bishopPair(pos *chess.Position, w *Weights) (mg, eg int) {
	if pos.PieceBB(chess.MakePiece(chess.White, chess.Bishop)).Count() >= 2 {
		mg += w.BishopPairMG
		eg += w.BishopPairEG
	}
	if pos.PieceBB(chess.MakePiece(chess.Black, chess.Bishop)).Count() >= 2 {
		mg -= w.BishopPairMG
		eg -= w.BishopPairEG
	}
	return mg, eg
}

// kingSafety returns the White-minus-Black pawn-shield term (middlegame only).
func kingSafety(pos *chess.Position, w *Weights) int {
	return sideShield(pos, chess.White, w) - sideShield(pos, chess.Black, w)
}

func sideShield(pos *chess.Position, us chess.Color, w *Weights) int {
	ksq := pos.KingSquare(us)
	own := pos.PieceBB(chess.MakePiece(us, chess.Pawn))
	present := (shieldMask[us][ksq] & own).Count()
	missing := 3 - present
	if missing < 0 {
		missing = 0
	}
	return w.KingShield * missing
}
