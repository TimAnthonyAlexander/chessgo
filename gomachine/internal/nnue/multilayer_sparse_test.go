package nnue

import (
	"math/rand"
	"testing"
)

// randMultiNet builds a random float MultiNet and int8-quantizes it, for testing
// the int8 L1 kernels in isolation (no real weights / no FT needed).
func randMultiNet(r *rand.Rand, h, d2, d3, nb int) *MultiNet {
	n := &MultiNet{H: h, D2: d2, D3: d3, NB: nb, CpScale: 400}
	in1 := 2 * h
	n.L2W = make([]float32, nb*d2*in1)
	n.L2B = make([]float32, nb*d2)
	n.L3W = make([]float32, nb*d3*d2)
	n.L3B = make([]float32, nb*d3)
	n.OW = make([]float32, nb*d3)
	n.OB = make([]float32, nb)
	fill := func(s []float32, scale float32) {
		for i := range s {
			s[i] = (r.Float32()*2 - 1) * scale
		}
	}
	fill(n.L2W, 1.5) // ~±1.98 range so int8 quant exercises the full grid
	fill(n.L2B, 0.5)
	fill(n.L3W, 1.0)
	fill(n.L3B, 0.5)
	fill(n.OW, 1.0)
	fill(n.OB, 0.5)
	n.QuantizeForInt8()
	return n
}

// TestSparseMatchesDense gates the sparse int8 L1 as a pure speed lever: for random
// u8 activations across a range of densities, the sparse path must return the EXACT
// same eval as the dense int8 path (a skipped all-zero dword contributes 0).
func TestSparseMatchesDense(t *testing.T) {
	r := rand.New(rand.NewSource(1))
	n := randMultiNet(r, 512, 16, 32, 8)
	in1 := 2 * n.H
	l2a := make([]float32, n.D2)
	l3a := make([]float32, n.D3)
	l2b := make([]float32, n.D2)
	l3b := make([]float32, n.D3)
	nnz := make([]uint16, n.H/2)
	densities := []int{128, 64, 20, 4, 1, 0} // full → all-zero
	for iter := 0; iter < 600; iter++ {
		aq := make([]uint8, in1)
		density := densities[iter%len(densities)]
		for i := range aq {
			if r.Intn(128) < density {
				aq[i] = uint8(r.Intn(128)) // u8 FT activations are ≤ int8QA=127
			}
		}
		bk := r.Intn(n.NB)
		dense := n.tailEvalInt8(aq, bk, l2a, l3a)
		sparse := n.tailEvalInt8Sparse(aq, bk, l2b, l3b, nnz)
		if dense != sparse {
			t.Fatalf("iter %d bk %d density %d: dense=%d sparse=%d", iter, bk, density, dense, sparse)
		}
	}
}

// TestNnzDwords sanity-checks the nonzero-dword extractor.
func TestNnzDwords(t *testing.T) {
	aq := make([]uint8, 32) // 8 dwords
	aq[0] = 1               // dword 0
	aq[7] = 9               // dword 1 (byte 3)
	aq[20] = 5              // dword 5
	idx := make([]uint16, 8)
	cnt := nnzDwords(aq, idx)
	if cnt != 3 || idx[0] != 0 || idx[1] != 1 || idx[2] != 5 {
		t.Fatalf("got cnt=%d idx=%v; want 3 [0 1 5]", cnt, idx[:cnt])
	}
}
