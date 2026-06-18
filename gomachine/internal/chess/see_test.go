package chess

import "testing"

// seeMove parses a UCI move in the given position (helper for tests).
func seeMove(t *testing.T, pos *Position, uci string) Move {
	t.Helper()
	m, ok := pos.ParseUCIMove(uci)
	if !ok {
		t.Fatalf("illegal/unparseable move %q in %s", uci, pos.FEN())
	}
	return m
}

func TestSEE(t *testing.T) {
	cases := []struct {
		name string
		fen  string
		uci  string
		want int
	}{
		{
			// White pawn captures an undefended pawn → win a pawn.
			name: "undefended pawn",
			fen:  "4k3/8/8/3p4/4P3/8/8/4K3 w - - 0 1",
			uci:  "e4d5",
			want: 100,
		},
		{
			// Pawn takes pawn, recaptured by a pawn → even.
			name: "pawn defended by pawn",
			fen:  "4k3/8/1p6/2p5/3P4/8/8/4K3 w - - 0 1",
			uci:  "d4c5",
			want: 0,
		},
		{
			// Queen grabs a pawn defended by a pawn → lose queen for pawn.
			name: "queen takes defended pawn",
			fen:  "4k3/8/2p5/3p4/8/3Q4/8/4K3 w - - 0 1",
			uci:  "d3d5",
			want: 100 - 900,
		},
		{
			// Capturing an undefended queen with a rook → win a queen.
			name: "rook takes undefended queen",
			fen:  "4k3/8/8/8/8/3q4/8/3RK3 w - - 0 1",
			uci:  "d1d3",
			want: 900,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			pos, err := ParseFEN(c.fen)
			if err != nil {
				t.Fatalf("ParseFEN: %v", err)
			}
			m := seeMove(t, pos, c.uci)
			if got := pos.SEE(m); got != c.want {
				t.Fatalf("SEE(%s) = %d, want %d", c.uci, got, c.want)
			}
		})
	}
}

// A quiet (non-capture) move to a square defended by a lesser piece has negative
// SEE; SEEGE gates on a threshold.
func TestSEEGE(t *testing.T) {
	pos, err := ParseFEN("4k3/8/2p5/3p4/8/3Q4/8/4K3 w - - 0 1")
	if err != nil {
		t.Fatal(err)
	}
	m := seeMove(t, pos, "d3d5")
	if pos.SEEGE(m, 0) {
		t.Fatalf("expected losing capture to fail SEEGE(0)")
	}
	if !pos.SEEGE(m, -900) {
		t.Fatalf("expected SEE >= -900")
	}
}
