package chess

import "testing"

// TestRandomChess960FEN generates many random Fischer-random start positions and
// asserts each one: parses, has the king strictly between the rooks, has bishops
// on opposite-colored squares, and FEN()-round-trips (parse → serialize → parse
// denotes the same position).
func TestRandomChess960FEN(t *testing.T) {
	for i := 0; i < 2000; i++ {
		fen := RandomChess960FEN()
		pos, err := ParseFEN(fen)
		if err != nil {
			t.Fatalf("ParseFEN(%q): %v", fen, err)
		}
		if !pos.Legal() {
			t.Fatalf("generated FEN is illegal: %q", fen)
		}

		// Locate the white back-rank pieces (rank 1).
		var rooks []File
		var bishops []File
		king := File(255)
		for f := FileA; f <= FileH; f++ {
			switch pos.board[MakeSquare(f, Rank1)] {
			case WhiteRook:
				rooks = append(rooks, f)
			case WhiteBishop:
				bishops = append(bishops, f)
			case WhiteKing:
				king = f
			}
		}
		if len(rooks) != 2 {
			t.Fatalf("%q: expected 2 white rooks, got %d", fen, len(rooks))
		}
		if len(bishops) != 2 {
			t.Fatalf("%q: expected 2 white bishops, got %d", fen, len(bishops))
		}
		if king == 255 {
			t.Fatalf("%q: no white king on rank 1", fen)
		}

		// King strictly between the rooks.
		lo, hi := rooks[0], rooks[1]
		if lo > hi {
			lo, hi = hi, lo
		}
		if !(lo < king && king < hi) {
			t.Errorf("%q: king (file %d) not strictly between rooks (%d, %d)", fen, king, lo, hi)
		}

		// Bishops on opposite-colored squares (opposite file parity on one rank).
		if bishops[0]%2 == bishops[1]%2 {
			t.Errorf("%q: bishops on same color (files %d, %d)", fen, bishops[0], bishops[1])
		}

		// Mirror check: Black's back rank matches White's arrangement.
		for f := FileA; f <= FileH; f++ {
			w := pos.board[MakeSquare(f, Rank1)]
			b := pos.board[MakeSquare(f, Rank8)]
			if w.Type() != b.Type() || w.Color() != White || b.Color() != Black {
				t.Fatalf("%q: back ranks not mirrored at file %d (white=%v black=%v)", fen, f, w, b)
			}
		}

		// FEN round-trip.
		rt, err := ParseFEN(pos.FEN())
		if err != nil {
			t.Fatalf("reparse %q: %v", pos.FEN(), err)
		}
		if rt.FEN() != pos.FEN() {
			t.Errorf("round-trip changed FEN: %q -> %q", pos.FEN(), rt.FEN())
		}
	}
}
