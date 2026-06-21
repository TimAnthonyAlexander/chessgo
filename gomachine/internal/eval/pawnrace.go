package eval

import "github.com/timanthonyalexander/gomachine/internal/chess"

// Passed-pawn race / knight-aware unstoppable-passer detection (EG-only).
//
// This is the "do I queen first?" term — the over-optimism killer for pawn-race
// endings. A PeSTO+linear eval counts a connected passer as good and walks into a
// race it is actually losing (the engine's diagnosed K+N+P loss). This term gives
// a large bonus to a side whose passer the defender genuinely cannot stop, and —
// because it is emitted as White-minus-Black — a large *penalty* to a side whose
// opponent has the unstoppable passer. That negative is the real fix: it tells the
// over-optimistic side NOT to race when it is the one getting queened on.
//
// Correctness over breadth (the research's K+N+P trap): a king-only square rule
// hands out wrong +700s for passers the enemy KNIGHT catches. So detection is
// conservative on every axis and only runs when the defender's non-pawn material
// is KNIGHTS ONLY (the targeted case) — any bishop/rook/queen and we bail to 0:
//   - the pawn's path to promotion must be empty (a clean runner),
//   - the enemy KING must be outside the square (cannot reach the promo square in
//     time, counting the defender's tempo), and
//   - no enemy KNIGHT can reach the promotion square or any path square in time
//     (knight-distance BFS, counting the defender's tempo).
// Every tempo/inequality is rounded in the DEFENDER's favor, so the term
// under-claims unstoppability rather than over-claiming it.
//
// On the symmetric diagnosed position every passer is caught by the nearby enemy
// king, so the term is 0 (no false optimism added) — exactly right for a draw.

// knightDist[from][to] is the minimum number of knight moves between two squares
// (BFS, computed once at init). Unreachable pairs cannot occur on an 8x8 board, so
// every entry is finite; kept as int for cheap comparison.
var knightDist [64][64]int

func init() {
	var offs = [8][2]int{{1, 2}, {2, 1}, {2, -1}, {1, -2}, {-1, -2}, {-2, -1}, {-2, 1}, {-1, 2}}
	for from := 0; from < 64; from++ {
		for i := range knightDist[from] {
			knightDist[from][i] = 99
		}
		knightDist[from][from] = 0
		queue := []int{from}
		for len(queue) > 0 {
			cur := queue[0]
			queue = queue[1:]
			cf, cr := cur%8, cur/8
			for _, o := range offs {
				nf, nr := cf+o[0], cr+o[1]
				if nf < 0 || nf > 7 || nr < 0 || nr > 7 {
					continue
				}
				ns := nr*8 + nf
				if knightDist[from][ns] > knightDist[from][cur]+1 {
					knightDist[from][ns] = knightDist[from][cur] + 1
					queue = append(queue, ns)
				}
			}
		}
	}
}

// raceDecay is the per-ply falloff of the unstoppable bonus (a passer that queens
// sooner is worth more); raceFloor keeps a far-but-still-unstoppable passer
// meaningful. Both fixed; the magnitude lives in the seeded weight PawnRaceEG.
const (
	raceDecay = 24
	raceFloor = 80
)

// passedPawnRace returns the White-minus-Black unstoppable-passer contribution,
// added to the EG score only by the caller (taper makes it inert in the midgame).
func passedPawnRace(pos *chess.Position, w *Weights) int {
	if w.PawnRaceEG == 0 {
		return 0
	}
	return sideRace(pos, chess.White, w) - sideRace(pos, chess.Black, w)
}

// sideRace returns us's best unstoppable-passer bonus (0 if none). Only fires when
// the defender's non-pawn material is knights only.
func sideRace(pos *chess.Position, us chess.Color, w *Weights) int {
	them := us.Opposite()
	if pos.PieceBB(chess.MakePiece(them, chess.Bishop)) != 0 ||
		pos.PieceBB(chess.MakePiece(them, chess.Rook)) != 0 ||
		pos.PieceBB(chess.MakePiece(them, chess.Queen)) != 0 {
		return 0 // not a clean K(+N)+P defence — out of scope, stay safe
	}

	own := pos.PieceBB(chess.MakePiece(us, chess.Pawn))
	enemyPawns := pos.PieceBB(chess.MakePiece(them, chess.Pawn))
	occ := pos.Occupied()
	defKing := pos.KingSquare(them)
	defToMove := pos.SideToMove() == them
	defKnights := pos.PieceBB(chess.MakePiece(them, chess.Knight))

	bestPlies := -1 // pliesToQueen of the fastest unstoppable passer; -1 = none
	bb := own
	for bb != 0 {
		sq := bb.PopLSB()
		if enemyPawns&passedMask[us][sq] != 0 {
			continue // not passed
		}
		plies, ok := unstoppablePlies(us, sq, occ, defKing, defKnights, defToMove)
		if !ok {
			continue
		}
		if bestPlies < 0 || plies < bestPlies {
			bestPlies = plies
		}
	}
	if bestPlies < 0 {
		return 0
	}
	bonus := w.PawnRaceEG - raceDecay*bestPlies
	if bonus < raceFloor {
		bonus = raceFloor
	}
	return bonus
}

// unstoppablePlies reports whether the pawn of color us on sq is an unstoppable
// passer against a defender of king defKing + knights defKnights, and if so its
// plies-to-queen. occ is the full occupancy (for path-blocked detection).
func unstoppablePlies(us chess.Color, sq chess.Square, occ chess.Bitboard,
	defKing chess.Square, defKnights chess.Bitboard, defToMove bool) (int, bool) {

	f := int(sq.File())
	r := int(sq.Rank())
	promoRank := 7
	homeRank := 1
	if us == chess.Black {
		promoRank = 0
		homeRank = 6
	}
	promoSq := chess.MakeSquare(chess.File(f), chess.Rank(promoRank))

	// Moves (single pushes) to promote, minus one for the home-rank double-step.
	moves := promoRank - r
	if moves < 0 {
		moves = -moves
	}
	if r == homeRank {
		moves--
	}
	if moves <= 0 {
		return 0, false
	}

	// Path must be a clean runner: every square strictly ahead on the file empty.
	step := 1
	if us == chess.Black {
		step = -1
	}
	pathSquares := make([]chess.Square, 0, 7)
	for rr := r + step; rr != promoRank+step; rr += step {
		s := chess.MakeSquare(chess.File(f), chess.Rank(rr))
		if occ&s.BB() != 0 {
			return 0, false // blocked → not a clean runner
		}
		pathSquares = append(pathSquares, s)
	}

	defTempo := 0
	if defToMove {
		defTempo = 1
	}

	// Enemy king: catches iff it can reach the promotion square within the pawn's
	// moves (+ the defender's tempo). Chebyshev (king-move) distance.
	if chebyshev(defKing, promoSq) <= moves+defTempo {
		return 0, false
	}

	// Enemy knight: catches iff any knight can reach the promo square or a path
	// square within the pawn's moves (+ the defender's tempo).
	if defKnights != 0 {
		stops := append(pathSquares, promoSq) // promoSq is in pathSquares already, harmless dup
		kb := defKnights
		for kb != 0 {
			n := kb.PopLSB()
			for _, s := range stops {
				if knightDist[n][s] <= moves+defTempo {
					return 0, false
				}
			}
		}
	}

	plies := 2*moves - defTempo // defender to move costs the racer a tempo
	if plies < 1 {
		plies = 1
	}
	return plies, true
}

// chebyshev is the king-move (max-coordinate) distance between two squares.
func chebyshev(a, b chess.Square) int {
	df := int(a.File()) - int(b.File())
	if df < 0 {
		df = -df
	}
	dr := int(a.Rank()) - int(b.Rank())
	if dr < 0 {
		dr = -dr
	}
	if dr > df {
		return dr
	}
	return df
}
