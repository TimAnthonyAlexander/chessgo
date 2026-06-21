package eval

import "github.com/timanthonyalexander/gomachine/internal/chess"

// Endgame scale factor (Stockfish-classical, SF11/SF12 `winnable()` port).
//
// A scale factor sf in [0..scaleNormal] expresses how *convertible* the endgame
// advantage is: the eg term is worth only sf/64 of its nominal value. It scales
// ONLY the endgame half of the taper, so it is naturally inert in the middlegame
// (eg*(24-phase) → 0 as phase → 24). The point is drawishness: a PeSTO+linear eval
// statically believes KBvK, KNvK, opposite-bishop, and single-flank rook endings
// are won by the material it counts — they are dead/near-dead draws. Scaling the
// eg term toward 0 in those material configs stops the engine trading into "won on
// paper, drawn in reality" endings (and lets a worse side steer for the known
// draw).
//
// Faithful to Stockfish's classical scale-factor block (constants verbatim):
//   - opposite bishops: pure → 18 + 4·passers(strong); with pieces → 22 + 3·pieces(strong)
//   - lone queen on board → 37 + 3·(minors of the side without the queen)
//   - otherwise → min(sf, 36 + 7·pawns(strong))
//
// plus the material.cpp no-pawn rules (sf = 0/4/14 when the strong side has no
// pawns and at most a bishop's worth of extra non-pawn material). Those no-pawn
// rules require lead ≤ a minor, so they can NEVER fire on a real material win
// (KRvK keeps a +rook lead → sf stays 64).
const scaleNormal = 64

// Endgame material thresholds (centipawns), using the engine's own egValue row so
// the cut points track the rest of the eval. "Bishop" is the ≤one-minor cut; a
// rook is the next step up.
var (
	bishopScaleVal = egValue[chess.Bishop] // 297
	rookScaleVal   = egValue[chess.Rook]   // 512
)

// scaleFactor returns the endgame scale factor in [0..64] for the given position,
// where eg is the endgame score from White's perspective (its sign picks the
// strong side). 64 means "no scaling" (the common case). Cheap: a handful of
// popcounts, only meaningful once material is low.
func scaleFactor(pos *chess.Position, eg int) int {
	strong := chess.White
	if eg < 0 {
		strong = chess.Black
	}
	weak := strong.Opposite()

	npmStrong := nonPawnMaterial(pos, strong)
	npmWeak := nonPawnMaterial(pos, weak)
	pawnsStrong := pos.PieceBB(chess.MakePiece(strong, chess.Pawn)).Count()

	// No-pawn insufficient-material rules (material.cpp). Only entered when the
	// strong side has no pawns AND is at most a bishop ahead in non-pawn material,
	// so it cannot scale a genuine material win.
	if pawnsStrong == 0 && npmStrong-npmWeak <= bishopScaleVal {
		switch {
		case npmStrong < rookScaleVal:
			return 0 // KK, KNK, KBK, KNNvK-lite — no mating material
		case npmWeak <= bishopScaleVal:
			return 4 // e.g. KR vs K+minor (fortress draw)
		default:
			return 14 // e.g. KRB vs KR
		}
	}

	if oppositeBishops(pos) {
		if npmStrong == bishopScaleVal && npmWeak == bishopScaleVal {
			return 18 + 4*passedCount(pos, strong) // pure OCB: famously drawish
		}
		return clampScale(22 + 3*pos.ColorBB(strong).Count()) // OCB + other pieces
	}

	if queenCount(pos) == 1 {
		// A lone queen ending is hard to convert vs minors; scale toward draw by
		// the count of the (queen-less) defender's minors.
		var minors int
		if pos.PieceBB(chess.WhiteQueen).Count() == 1 {
			minors = minorCount(pos, chess.Black)
		} else {
			minors = minorCount(pos, chess.White)
		}
		return clampScale(37 + 3*minors)
	}

	// Generic pawn-count cap: fewer strong-side pawns → more drawish. Guard: a
	// clear piece-up lead (≥ a rook ahead in non-pawn material) is a material win,
	// not a drawish pawn ending, so it must NOT be scaled down. Stockfish never hits
	// this because its specialized KXK/KRK/… endgames return early; we have no such
	// functions (we lean on the tablebase ≤5 men), so we add the guard explicitly to
	// avoid scaling a won KRRvK-type ending above the TB boundary toward a draw.
	if npmStrong-npmWeak >= rookScaleVal {
		return scaleNormal
	}
	sf := 36 + 7*pawnsStrong
	if sf > scaleNormal {
		sf = scaleNormal
	}
	return sf
}

func clampScale(sf int) int {
	if sf > scaleNormal {
		return scaleNormal
	}
	if sf < 0 {
		return 0
	}
	return sf
}

// nonPawnMaterial sums the egValue of c's knights, bishops, rooks and queens.
func nonPawnMaterial(pos *chess.Position, c chess.Color) int {
	v := 0
	for pt := chess.Knight; pt <= chess.Queen; pt++ {
		v += pos.PieceBB(chess.MakePiece(c, pt)).Count() * egValue[pt]
	}
	return v
}

func minorCount(pos *chess.Position, c chess.Color) int {
	return pos.PieceBB(chess.MakePiece(c, chess.Knight)).Count() +
		pos.PieceBB(chess.MakePiece(c, chess.Bishop)).Count()
}

func queenCount(pos *chess.Position) int {
	return pos.PieceBB(chess.WhiteQueen).Count() + pos.PieceBB(chess.BlackQueen).Count()
}

// oppositeBishops reports whether each side has exactly one bishop and the two
// bishops sit on opposite-colored squares.
func oppositeBishops(pos *chess.Position) bool {
	wb := pos.PieceBB(chess.WhiteBishop)
	bb := pos.PieceBB(chess.BlackBishop)
	if wb.Count() != 1 || bb.Count() != 1 {
		return false
	}
	return squareColor(wb.LSB()) != squareColor(bb.LSB())
}

// squareColor returns 0 for one square color and 1 for the other (a1 dark).
func squareColor(sq chess.Square) int {
	return (int(sq.File()) + int(sq.Rank())) & 1
}

// passedCount returns how many of c's pawns are passed.
func passedCount(pos *chess.Position, c chess.Color) int {
	own := pos.PieceBB(chess.MakePiece(c, chess.Pawn))
	enemy := pos.PieceBB(chess.MakePiece(c.Opposite(), chess.Pawn))
	n := 0
	bb := own
	for bb != 0 {
		sq := bb.PopLSB()
		if enemy&passedMask[c][sq] == 0 {
			n++
		}
	}
	return n
}
