package chess

// Precomputed ray geometry for pin-aware legal move generation.
//
//   betweenBB[a][b] — squares STRICTLY between a and b when they share a rank,
//                     file, or diagonal; 0 otherwise. Used for the check mask
//                     (squares that block a sliding check) and pin detection.
//   lineBB[a][b]    — every square on the full line through a and b (the entire
//                     rank/file/diagonal, including a and b); 0 if not aligned.
//                     Used to restrict a pinned piece to its pin ray.
var (
	betweenBB [64][64]Bitboard
	lineBB    [64][64]Bitboard
)

func init() { initRays() }

func initRays() {
	// betweenBB: walk each of the 8 ray directions from a, recording the squares
	// seen SO FAR as the "between" set for the square currently reached.
	dirs := [8][2]int{
		{1, 0}, {-1, 0}, {0, 1}, {0, -1},
		{1, 1}, {-1, -1}, {1, -1}, {-1, 1},
	}
	for a := Square(0); a < 64; a++ {
		af, ar := int(a.File()), int(a.Rank())
		for _, d := range dirs {
			var between Bitboard
			f, r := af+d[0], ar+d[1]
			for f >= 0 && f <= 7 && r >= 0 && r <= 7 {
				b := MakeSquare(File(f), Rank(r))
				betweenBB[a][b] = between
				between |= b.BB()
				f += d[0]
				r += d[1]
			}
		}
	}

	// lineBB: for each of the 4 axes (E-W, N-S, the two diagonals), collect the
	// full line through a, then assign it to every other square on that line.
	axes := [4][2]int{{1, 0}, {0, 1}, {1, 1}, {1, -1}}
	for a := Square(0); a < 64; a++ {
		af, ar := int(a.File()), int(a.Rank())
		for _, d := range axes {
			full := a.BB()
			for sign := -1; sign <= 1; sign += 2 {
				f, r := af+sign*d[0], ar+sign*d[1]
				for f >= 0 && f <= 7 && r >= 0 && r <= 7 {
					full |= MakeSquare(File(f), Rank(r)).BB()
					f += sign * d[0]
					r += sign * d[1]
				}
			}
			tmp := full
			for tmp != 0 {
				b := tmp.PopLSB()
				if b != a {
					lineBB[a][b] = full
				}
			}
		}
	}
}
