package nnue

import (
	"encoding/binary"
	"fmt"
	"math"
	"os"
)

// ImportBulletMultiNet reads a bullet float32 export of the multilayer arch
// (768 -> H)x2 -> D2 -> D3 -> 1 (trained by examples/chessgo_ml_smoke.rs) and
// builds a MultiNet. Use raw.bin (exact, unpadded) or quantised.bin (padded to
// 64 bytes — the extra trailing floats are ignored). Single-bucket (nb=1) for
// now; the bucketed import comes with the GNN4 format.
//
// bullet save order: l0w, l0b, l1w, l1b, l2w, l2b, l3w, l3b (little-endian f32).
// Affine weights are stored INPUT-major [in x out] (each input's `out` weights
// contiguous — verified against the single-layer importer's l0w layout). So:
//   - the FT (l0w) copies straight: bullet [in x out] == MultiNet W0 feature-major.
//   - the tail layers (l1w, l2w) are TRANSPOSED into MultiNet's output-major
//     [out x in] forward layout. l3w (out=1) is a straight copy.
//
// CpScale = bullet's eval_scale (400), matching the single-layer importer: the
// raw network output times 400 is the centipawn eval.
func ImportBulletMultiNet(path string, h, d2, d3 int) (*MultiNet, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("nnue: read bullet multilayer net: %w", err)
	}

	nL0w := InputDim * h
	nL0b := h
	in1 := 2 * h
	nL1w := in1 * d2
	nL1b := d2
	nL2w := d2 * d3
	nL2b := d3
	nL3w := d3 // out=1
	nL3b := 1
	want := nL0w + nL0b + nL1w + nL1b + nL2w + nL2b + nL3w + nL3b

	if len(raw) < want*4 {
		return nil, fmt.Errorf(
			"nnue: bullet multilayer net is %d bytes (%d f32) < %d f32 needed for H=%d D2=%d D3=%d",
			len(raw), len(raw)/4, want, h, d2, d3)
	}

	f := make([]float32, want)
	for i := 0; i < want; i++ {
		f[i] = math.Float32frombits(binary.LittleEndian.Uint32(raw[i*4 : i*4+4]))
	}

	off := 0
	take := func(n int) []float32 { s := f[off : off+n]; off += n; return s }
	l0w := take(nL0w)
	l0b := take(nL0b)
	l1w := take(nL1w)
	l1b := take(nL1b)
	l2w := take(nL2w)
	l2b := take(nL2b)
	l3w := take(nL3w)
	l3b := take(nL3b)

	n := NewMultiNet(h, d2, d3, 1)
	copy(n.W0, l0w) // FT: bullet feature-major == MultiNet W0
	copy(n.B0, l0b)

	// Tail layer 1: bullet l1w [in1 x d2] (input-major) → MultiNet L2W [d2 x in1].
	for i := 0; i < in1; i++ {
		for o := 0; o < d2; o++ {
			n.L2W[o*in1+i] = l1w[i*d2+o]
		}
	}
	copy(n.L2B, l1b)

	// Tail layer 2: bullet l2w [d2 x d3] → MultiNet L3W [d3 x d2].
	for i := 0; i < d2; i++ {
		for o := 0; o < d3; o++ {
			n.L3W[o*d2+i] = l2w[i*d3+o]
		}
	}
	copy(n.L3B, l2b)

	// Output: bullet l3w [d3 x 1] → MultiNet OW [d3] (straight; out==1).
	copy(n.OW, l3w)
	copy(n.OB, l3b)

	n.CpScale = bulletSCALE // 400
	n.quantizeFT()          // derive the int16 accumulator weights
	return n, nil
}
