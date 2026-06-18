// Package eval implements a tapered PeSTO evaluation: material + phase-
// interpolated piece-square tables + a small tempo bonus (SPEC §4.8). Scores are
// centipawns from the side-to-move's perspective (for negamax).
package eval

import "github.com/timanthonyalexander/gomachine/internal/chess"

// Tempo bonus for the side to move (centipawns).
const Tempo = 10

// Combined tables, signed (White positive, Black negative) and indexed by the
// engine's square numbering (a1=0). Built at init from the PeSTO source tables.
var (
	mgTable [12][64]int
	egTable [12][64]int
)

// gamePhaseInc is the phase weight contributed by each piece type
// (P=0,N=1,B=1,R=2,Q=4,K=0); the total caps at 24.
var gamePhaseInc = [6]int{0, 1, 1, 2, 4, 0}

func init() {
	for pt := 0; pt < 6; pt++ {
		wPc := chess.MakePiece(chess.White, chess.PieceType(pt))
		bPc := chess.MakePiece(chess.Black, chess.PieceType(pt))
		for sq := 0; sq < 64; sq++ {
			// White reads the table flipped (sq^56); Black reads it directly.
			mgTable[wPc][sq] = mgValue[pt] + mgPesto[pt][sq^56]
			egTable[wPc][sq] = egValue[pt] + egPesto[pt][sq^56]
			mgTable[bPc][sq] = -(mgValue[pt] + mgPesto[pt][sq])
			egTable[bPc][sq] = -(egValue[pt] + egPesto[pt][sq])
		}
	}
}

// Evaluate returns the static evaluation in centipawns from the perspective of
// the side to move. The base score (material + tapered PSQT + tempo) is always
// computed; cfg enables the optional knowledge terms and supplies their weights.
func Evaluate(pos *chess.Position, cfg Config) int {
	w := cfg.W
	if w == nil {
		w = defaultW
	}
	var mg, eg, phase int
	for pc := chess.WhitePawn; pc <= chess.BlackKing; pc++ {
		bb := pos.PieceBB(pc)
		for bb != 0 {
			sq := bb.PopLSB()
			mg += mgTable[pc][sq]
			eg += egTable[pc][sq]
			phase += gamePhaseInc[pc.Type()]
		}
	}
	if cfg.Mobility {
		m, e := mobility(pos, w)
		mg += m
		eg += e
	}
	if cfg.Pawns {
		m, e := pawnStructure(pos, w)
		mg += m
		eg += e
	}
	if cfg.BishopPair {
		m, e := bishopPair(pos, w)
		mg += m
		eg += e
	}
	if cfg.KingSafety {
		mg += kingSafety(pos, w) // middlegame term
	}
	if phase > 24 {
		phase = 24
	}
	score := (mg*phase + eg*(24-phase)) / 24 // White's perspective
	if pos.SideToMove() == chess.Black {
		score = -score
	}
	return score + Tempo
}
