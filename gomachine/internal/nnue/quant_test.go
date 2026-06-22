package nnue

import (
	"bytes"
	"testing"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// TestGNN2RoundTrip checks the integer net format serializes and reloads with
// the int weights bit-identical (and arrives as quantized=true).
func TestGNN2RoundTrip(t *testing.T) {
	net := RandomNet(3)
	net.quantized = true // force the GNN2 path
	var buf bytes.Buffer
	if err := net.Write(&buf); err != nil {
		t.Fatalf("write: %v", err)
	}
	got, err := ReadNet(&buf)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if !got.quantized {
		t.Fatal("reloaded net not marked quantized")
	}
	if got.QA != net.QA || got.QB != net.QB || got.Scale != net.Scale || got.B1i != net.B1i {
		t.Fatalf("scales drifted: QA %d/%d QB %d/%d Scale %d/%d B1i %d/%d",
			got.QA, net.QA, got.QB, net.QB, got.Scale, net.Scale, got.B1i, net.B1i)
	}
	for i := range net.W0i {
		if got.W0i[i] != net.W0i[i] {
			t.Fatalf("W0i[%d] drift: %d vs %d", i, got.W0i[i], net.W0i[i])
		}
	}
	for i := range net.W1i {
		if got.W1i[i] != net.W1i[i] {
			t.Fatalf("W1i[%d] drift: %d vs %d", i, got.W1i[i], net.W1i[i])
		}
	}
}

// TestGNN2IntMatchesFloat (G2) loads the real shipped net and confirms the
// integer forward reproduces the float reference forward within float rounding
// (≤1cp). Both views come from the SAME GNN2 net (ints verbatim, floats
// dequantized), so the only difference is int-vs-float arithmetic — which is the
// same ≤1cp the Phase-A loader gate established against bullet. Skips if no net.
func TestGNN2IntMatchesFloat(t *testing.T) {
	net, err := LoadNet("../../data/nnue/net.nnue")
	if err != nil {
		t.Skipf("no shipped net (%v) — skipping G2", err)
	}
	if !net.quantized {
		t.Fatal("shipped net is not GNN2 (integer) — Phase B expects the re-imported net")
	}
	fens := append([]string{
		chess.StartFEN,
		"8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1",
		"r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1",
		"r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R b KQkq - 0 1",
		"rnbqkbnr/pp1ppppp/8/2p5/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2",
		"8/8/8/4k3/8/4K3/4P3/8 w - - 0 1",
	}, moveTypeFENs...)

	maxDiff := 0
	for _, fen := range fens {
		pos, err := chess.ParseFEN(fen)
		if err != nil {
			t.Fatalf("bad fen %q: %v", fen, err)
		}
		acc := net.newAccumulator()
		net.build(&acc, pos)
		gotInt := net.evalFrom(&acc, pos.SideToMove())
		gotFloat := net.Eval(pos)
		d := gotInt - gotFloat
		if d < 0 {
			d = -d
		}
		if d > maxDiff {
			maxDiff = d
		}
		if d > 1 {
			t.Errorf("int %d vs float %d (diff %d > 1cp) for %q", gotInt, gotFloat, d, fen)
		}
	}
	t.Logf("G2: int-vs-float max diff = %dcp over %d FENs (≤1cp = bit-exact-quantized-eval, float drift only)", maxDiff, len(fens))
}
