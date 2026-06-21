package nnue

import (
	"bytes"
	"strings"
	"testing"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

func mustFEN(t *testing.T, fen string) *chess.Position {
	t.Helper()
	pos, err := chess.ParseFEN(fen)
	if err != nil {
		t.Fatalf("ParseFEN(%q): %v", fen, err)
	}
	return pos
}

func featureSet(pos *chess.Position, persp chess.Color) map[uint16]bool {
	m := map[uint16]bool{}
	for _, f := range AppendFeatures(nil, pos, persp) {
		m[f] = true
	}
	return m
}

// Two kings only: White Ke1 (sq 4), Black Ke8 (sq 60). Indices hand-computed
// from (relColor*6+type)*64 + relSq, type King=5.
func TestFeatureIndexKings(t *testing.T) {
	pos := mustFEN(t, "4k3/8/8/8/8/8/8/4K3 w - - 0 1")

	// White perspective: own WK e1 → (0*6+5)*64+4 = 324; enemy BK e8 → (1*6+5)*64+60 = 764.
	white := featureSet(pos, chess.White)
	wantWhite := map[uint16]bool{324: true, 764: true}
	if len(white) != 2 || !white[324] || !white[764] {
		t.Errorf("white-perspective features = %v, want %v", white, wantWhite)
	}

	// Black perspective (flip sq^56): enemy WK e1 → (1*6+5)*64 + (4^56=60) = 764;
	// own BK e8 → (0*6+5)*64 + (60^56=4) = 324.
	black := featureSet(pos, chess.Black)
	if len(black) != 2 || !black[324] || !black[764] {
		t.Errorf("black-perspective features = %v, want {324,764}", black)
	}

	// Direct FeatureIndex spot-checks.
	if got := FeatureIndex(chess.White, chess.WhiteKing, chess.E1); got != 324 {
		t.Errorf("FeatureIndex(White, WK, e1) = %d, want 324", got)
	}
	if got := FeatureIndex(chess.Black, chess.WhiteKing, chess.E1); got != 764 {
		t.Errorf("FeatureIndex(Black, WK, e1) = %d, want 764", got)
	}
}

// Hand-computed forward pass. Net: biases 0, CpScale 1, all W1=1, W0 zero except
// two cells. Position = two kings, White to move.
//   active(stm=White)  = {324, 764};  active(opp=Black) = {764, 324}
//   set W0[324][0]=0.5, W0[764][0]=0.3
//   acc[stm][0]  = 0.5+0.3 = 0.8 ; acc[opp][0] = 0.3+0.5 = 0.8 ; all else 0
//   clamp → 0.8 at indices {0, 256}; y = 1*0.8 + 1*0.8 = 1.6 ; eval = round(1.6) = 2
func TestForwardHandComputed(t *testing.T) {
	n := NewNet()
	n.CpScale = 1
	for i := range n.W1 {
		n.W1[i] = 1
	}
	n.W0[324*L1+0] = 0.5
	n.W0[764*L1+0] = 0.3

	pos := mustFEN(t, "4k3/8/8/8/8/8/8/4K3 w - - 0 1")
	if got := n.Eval(pos); got != 2 {
		t.Fatalf("Eval = %d, want 2", got)
	}

	// ClippedReLU upper clamp: bump the cell so acc[0] = 2.3 → clamps to 1.
	// Now y = 1(index0) + 0.8(index256) = 1.8 → eval = round(1.8) = 2 as well;
	// raise the opp side too to make the clamp observable.
	n.W0[324*L1+0] = 2.0 // acc[stm][0] = 2.3 → clamp 1 ; acc[opp][0] = 2.3 → clamp 1
	if got := n.Eval(pos); got != 2 { // y = 1 + 1 = 2
		t.Fatalf("clamped Eval = %d, want 2", got)
	}
}

// mirrorColorSwap returns the FEN of the position with colors swapped and the
// board vertically mirrored (and side-to-move flipped, castling/ep cleared).
// This maps a position onto "the same position seen from the other side", which
// a shared-weight perspective net MUST evaluate identically — a strong check on
// the flip + own/enemy labeling + stm-first concat.
func mirrorColorSwap(fen string) string {
	parts := strings.Fields(fen)
	rows := strings.Split(parts[0], "/")
	for i, j := 0, len(rows)-1; i < j; i, j = i+1, j-1 {
		rows[i], rows[j] = rows[j], rows[i]
	}
	var b strings.Builder
	for i, row := range rows {
		if i > 0 {
			b.WriteByte('/')
		}
		for _, c := range row {
			switch {
			case c >= 'a' && c <= 'z':
				b.WriteRune(c - 32)
			case c >= 'A' && c <= 'Z':
				b.WriteRune(c + 32)
			default:
				b.WriteRune(c)
			}
		}
	}
	stm := "w"
	if parts[1] == "w" {
		stm = "b"
	}
	return b.String() + " " + stm + " - - 0 1"
}

func TestColorSwapSymmetry(t *testing.T) {
	n := RandomNet(42)
	// FENs without castling/ep rights so the transform is exact.
	fens := []string{
		"4k3/8/8/8/8/8/8/4K3 w - - 0 1",
		"r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w - - 0 1",
		"8/2k5/3p4/p2P1p2/P2P1P2/8/8/4K3 w - - 0 1",
		"2kr3r/pp1q1ppp/2n1pn2/8/3P4/2N1PN2/PP1Q1PPP/2KR3R b - - 0 1",
		"8/5k2/8/8/3N4/8/2K5/8 w - - 0 1",
	}
	for _, fen := range fens {
		a := n.Eval(mustFEN(t, fen))
		b := n.Eval(mustFEN(t, mirrorColorSwap(fen)))
		if a != b {
			t.Errorf("symmetry broken for %q: %d vs mirror %d", fen, a, b)
		}
	}
}

func TestSaveLoadRoundTrip(t *testing.T) {
	n := RandomNet(7)
	var buf bytes.Buffer
	if err := n.Write(&buf); err != nil {
		t.Fatalf("Write: %v", err)
	}
	m, err := ReadNet(&buf)
	if err != nil {
		t.Fatalf("ReadNet: %v", err)
	}
	fens := []string{
		"rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
		"r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1",
		"8/2k5/3p4/p2P1p2/P2P1P2/8/8/4K3 w - - 0 1",
	}
	for _, fen := range fens {
		pos := mustFEN(t, fen)
		if a, b := n.Eval(pos), m.Eval(pos); a != b {
			t.Errorf("round-trip eval mismatch for %q: %d vs %d", fen, a, b)
		}
	}
}

func TestEvalNoPanicAndDeterministic(t *testing.T) {
	n := RandomNet(1)
	fens := []string{
		"rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
		"r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1",
		"8/8/8/8/8/8/8/K6k w - - 0 1",
	}
	for _, fen := range fens {
		pos := mustFEN(t, fen)
		a, b := n.Eval(pos), n.Eval(pos)
		if a != b {
			t.Errorf("non-deterministic eval for %q: %d vs %d", fen, a, b)
		}
	}
}

func TestDefaultNetFallback(t *testing.T) {
	SetNet(nil)
	if _, ok := Eval(mustFEN(t, "8/8/8/8/8/8/8/K6k w - - 0 1")); ok {
		t.Fatal("Eval reported ok with no net loaded")
	}
	n := RandomNet(3)
	SetNet(n)
	defer SetNet(nil)
	if _, ok := Eval(mustFEN(t, "8/8/8/8/8/8/8/K6k w - - 0 1")); !ok {
		t.Fatal("Eval reported not-ok with a net loaded")
	}
}
