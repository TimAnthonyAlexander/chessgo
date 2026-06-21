package eval

import "github.com/timanthonyalexander/gomachine/internal/chess"

// Coefficient tracing turns the (otherwise opaque) Evaluate into an explicit
// LINEAR model so the Texel tuner can do joint gradient descent over every
// weight at once — including the PSQT/material tables, which the old
// coordinate-descent tuner left frozen (the root cause of its double-counting:
// bolt-on terms fighting an untunable PSQT). See docs/ENGINE_STRENGTH.md.
//
// The model is  E_white = Σ_f coeff_f · taper(θ_f.mg, θ_f.eg)  where
//
//	taper(mg, eg) = (phase·mg + (24−phase)·eg) / 24
//
// and coeff_f is the position's White-minus-Black count for feature f (a plain
// integer that does NOT depend on the weights). EvalTrace emits {phase, coeffs};
// the tuner re-scores millions of positions as cheap dot products against θ
// without ever re-running eval. This is the standard "evaluation wrapping" trick.
//
// Feature layout (parameter vector θ has an (mg, eg) pair per feature):
//
//	[0 .. 384)  PSQT+material, indexed pieceType*64 + pestoIndex (P,N,B,R,Q,K)
//	384..387    mobility per reachable square (N, B, R, Q)
//	388         isolated pawn
//	389         doubled pawn (per extra pawn on a file)
//	390         passed pawn (scaled by advancement/2, matching Evaluate)
//	391         bishop pair
//	392         king shield (mg-only; eg pinned to 0 by the tuner)
//	393         king proximity to advanced passers (EG-only; mg pinned to 0)
//	394         tempo (frozen by the tuner; kept here so E is exact)
const (
	NumPSQT        = 6 * 64
	FeatMob0       = NumPSQT // +0..+3 = N,B,R,Q
	FeatIsolated   = NumPSQT + 4
	FeatDoubled    = NumPSQT + 5
	FeatPassed     = NumPSQT + 6
	FeatBishopPair = NumPSQT + 7
	FeatKingShield = NumPSQT + 8
	FeatKingProx   = NumPSQT + 9 // EG-only; the model taper (24−ph)/24 reproduces the live eg term
	FeatTempo      = NumPSQT + 10
	NumFeatures    = NumPSQT + 11
)

// TraceEntry is one non-zero feature coefficient for a position. Coeff is the
// White-minus-Black raw count; it applies identically to the feature's mg and eg
// weights (only the taper differs), which is what lets us store a single int.
type TraceEntry struct {
	Feat  uint16
	Coeff int16
}

// Trace is the sparse, weight-independent footprint of one position.
type Trace struct {
	Phase   uint8
	Entries []TraceEntry
}

// EvalTrace computes the coefficient trace of pos in WHITE's perspective. It
// mirrors Evaluate with every knowledge term enabled, but accumulates counts
// instead of weighted sums. Scoring a trace against DefaultParams() reproduces
// Evaluate(pos, allTermsConfig) up to integer-rounding noise.
func EvalTrace(pos *chess.Position) Trace {
	var acc [NumFeatures]int32
	phase := 0

	// PSQT + material + phase.
	for pc := chess.WhitePawn; pc <= chess.BlackKing; pc++ {
		bb := pos.PieceBB(pc)
		pt := int(pc.Type())
		white := pc.Color() == chess.White
		for bb != 0 {
			sq := int(bb.PopLSB())
			phase += gamePhaseInc[pt]
			if white {
				acc[pt*64+(sq^56)]++
			} else {
				acc[pt*64+sq]--
			}
		}
	}
	if phase > 24 {
		phase = 24
	}

	// Mobility (pawn-safe area), per piece type, White minus Black.
	traceMobility(pos, &acc)
	// Pawn structure: isolated, passed (adv/2), doubled.
	tracePawns(pos, &acc)
	// Bishop pair.
	if pos.PieceBB(chess.WhiteBishop).Count() >= 2 {
		acc[FeatBishopPair]++
	}
	if pos.PieceBB(chess.BlackBishop).Count() >= 2 {
		acc[FeatBishopPair]--
	}
	// King shield (mg-only): net missing shield pawns.
	acc[FeatKingShield] += int32(missingShield(pos, chess.White) - missingShield(pos, chess.Black))
	// King proximity to advanced passers (EG-only): raw Σ rw·(enemyD−ownD), White
	// minus Black. The weight (KingProxEG) and the EG taper both live in the model
	// (θ eg slot · (24−ph)/24), so the coefficient here carries NEITHER — exactly
	// mirroring how Evaluate adds the un-weighted, un-tapered sum into eg.
	traceKingProx(pos, &acc)
	// Tempo: +1 if White to move, else −1 (White perspective of the stm bonus).
	if pos.SideToMove() == chess.White {
		acc[FeatTempo]++
	} else {
		acc[FeatTempo]--
	}

	entries := make([]TraceEntry, 0, 40)
	for f := 0; f < NumFeatures; f++ {
		if acc[f] != 0 {
			entries = append(entries, TraceEntry{Feat: uint16(f), Coeff: int16(acc[f])})
		}
	}
	return Trace{Phase: uint8(phase), Entries: entries}
}

func traceMobility(pos *chess.Position, acc *[NumFeatures]int32) {
	for _, c := range []chess.Color{chess.White, chess.Black} {
		sign := int32(1)
		if c == chess.Black {
			sign = -1
		}
		area := ^pos.ColorBB(c) &^ pos.PawnAttacksBB(c.Opposite())
		for pt := chess.Knight; pt <= chess.Queen; pt++ {
			idx := int(pt - chess.Knight)
			bb := pos.PieceBB(chess.MakePiece(c, pt))
			for bb != 0 {
				sq := bb.PopLSB()
				n := int32((pos.AttacksFrom(sq) & area).Count())
				acc[FeatMob0+idx] += sign * n
			}
		}
	}
}

func tracePawns(pos *chess.Position, acc *[NumFeatures]int32) {
	for _, c := range []chess.Color{chess.White, chess.Black} {
		sign := int32(1)
		if c == chess.Black {
			sign = -1
		}
		own := pos.PieceBB(chess.MakePiece(c, chess.Pawn))
		enemy := pos.PieceBB(chess.MakePiece(c.Opposite(), chess.Pawn))
		bb := own
		for bb != 0 {
			sq := bb.PopLSB()
			f := int(sq.File())
			if own&adjacentFileMask[f] == 0 {
				acc[FeatIsolated] += sign
			}
			if enemy&passedMask[c][sq] == 0 {
				acc[FeatPassed] += sign * int32(advancement(c, int(sq.Rank()))/2)
			}
		}
		for f := 0; f < 8; f++ {
			if cnt := (own & fileMask[f]).Count(); cnt > 1 {
				acc[FeatDoubled] += sign * int32(cnt-1)
			}
		}
	}
}

// traceKingProx accumulates the EG-only king-proximity coefficient, mirroring
// sideKingProx (in terms.go) term-for-term: same passed/advancement≥2 gate, same
// rw=adv−1 rank weight, same capped-Chebyshev distances to the stop square, same
// (enemyD−ownD) differential. It records the RAW per-side sum (no KingProxEG, no
// taper); the model supplies both.
func traceKingProx(pos *chess.Position, acc *[NumFeatures]int32) {
	for _, c := range []chess.Color{chess.White, chess.Black} {
		sign := int32(1)
		if c == chess.Black {
			sign = -1
		}
		own := pos.PieceBB(chess.MakePiece(c, chess.Pawn))
		enemy := pos.PieceBB(chess.MakePiece(c.Opposite(), chess.Pawn))
		ourK := pos.KingSquare(c)
		enemyK := pos.KingSquare(c.Opposite())
		bb := own
		for bb != 0 {
			sq := bb.PopLSB()
			if enemy&passedMask[c][sq] != 0 {
				continue // not passed
			}
			adv := advancement(c, int(sq.Rank()))
			if adv < 2 {
				continue
			}
			stop := stopSquare(c, sq)
			rw := adv - 1
			acc[FeatKingProx] += sign * int32(rw*(kingDist(enemyK, stop)-kingDist(ourK, stop)))
		}
	}
}

func missingShield(pos *chess.Position, c chess.Color) int {
	ksq := pos.KingSquare(c)
	own := pos.PieceBB(chess.MakePiece(c, chess.Pawn))
	missing := 3 - (shieldMask[c][ksq] & own).Count()
	if missing < 0 {
		missing = 0
	}
	return missing
}

// DefaultParams returns the starting parameter vector θ (length 2*NumFeatures,
// mg at 2f and eg at 2f+1) built from the current PeSTO tables + DefaultWeights,
// so that scoring it reproduces today's eval. The tuner descends from here.
func DefaultParams() []float64 {
	θ := make([]float64, 2*NumFeatures)
	for pt := 0; pt < 6; pt++ {
		for pidx := 0; pidx < 64; pidx++ {
			f := pt*64 + pidx
			θ[2*f] = float64(mgValue[pt] + mgPesto[pt][pidx])
			θ[2*f+1] = float64(egValue[pt] + egPesto[pt][pidx])
		}
	}
	w := DefaultWeights()
	for i := 0; i < 4; i++ {
		f := FeatMob0 + i
		θ[2*f] = float64(w.MobMG[i])
		θ[2*f+1] = float64(w.MobEG[i])
	}
	set := func(f, mg, eg int) { θ[2*f] = float64(mg); θ[2*f+1] = float64(eg) }
	set(FeatIsolated, w.IsolatedMG, w.IsolatedEG)
	set(FeatDoubled, w.DoubledMG, w.DoubledEG)
	set(FeatPassed, w.PassedMG, w.PassedEG)
	set(FeatBishopPair, w.BishopPairMG, w.BishopPairEG)
	set(FeatKingShield, w.KingShield, 0) // mg-only
	set(FeatKingProx, 0, w.KingProxEG)   // eg-only (mg pinned to 0)
	set(FeatTempo, Tempo, Tempo)
	return θ
}

// ParamsToTables converts a tuned θ back into PeSTO tables (material kept in the
// existing mgValue/egValue rows, the remainder folded into the positional tables)
// and a Weights set, for emitting Go literals to paste into the eval source.
func ParamsToTables(θ []float64) (mgP, egP [6][64]int, w *Weights) {
	for pt := 0; pt < 6; pt++ {
		for pidx := 0; pidx < 64; pidx++ {
			f := pt*64 + pidx
			mgP[pt][pidx] = round(θ[2*f]) - mgValue[pt]
			egP[pt][pidx] = round(θ[2*f+1]) - egValue[pt]
		}
	}
	// PawnRaceEG is a seeded, non-linear term (not a trace feature — it can't be
	// expressed as a single linear coefficient), so it is preserved as the seed
	// through the round-trip rather than reconstructed from θ.
	w = &Weights{KingShield: round(θ[2*FeatKingShield]), PawnRaceEG: defaultW.PawnRaceEG}
	for i := 0; i < 4; i++ {
		f := FeatMob0 + i
		w.MobMG[i] = round(θ[2*f])
		w.MobEG[i] = round(θ[2*f+1])
	}
	w.IsolatedMG, w.IsolatedEG = round(θ[2*FeatIsolated]), round(θ[2*FeatIsolated+1])
	w.DoubledMG, w.DoubledEG = round(θ[2*FeatDoubled]), round(θ[2*FeatDoubled+1])
	w.PassedMG, w.PassedEG = round(θ[2*FeatPassed]), round(θ[2*FeatPassed+1])
	w.BishopPairMG, w.BishopPairEG = round(θ[2*FeatBishopPair]), round(θ[2*FeatBishopPair+1])
	w.KingProxEG = round(θ[2*FeatKingProx+1]) // eg-only (mg slot unused)
	return mgP, egP, w
}

func round(x float64) int {
	if x < 0 {
		return int(x - 0.5)
	}
	return int(x + 0.5)
}
