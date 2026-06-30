package nnue

import "math"

// int8 quantization of MultiNet's L1 layer (the tail's dominant cost). Float-tail
// SIMD was proven a movetime wash vs v6 (it speeds v6's int dot equally, leaving
// the eval-cost RATIO unchanged at ~16×; docs/NNUE/INT8_HANDOFF.md). int8 is the
// lever that changes the ratio: VPMADDUBSW packs 4× the MACs per SIMD op of
// float32, and v6's int16 dot can't get denser — so the multilayer L1 goes from
// ~16× to ~4× v6's per-node eval cost.
//
// Scope: ONLY L1 is int8 (16×1024 = 16384 MACs ≈ 96% of the tail FLOPs). L2
// (32×16) and L3 (32) stay float — quantizing them buys ~nothing and adds
// surface. This is post-training quantization (PTQ) of the existing float PoC
// net: no retrain, validated by closeness-to-float + fixed-depth SPRT.
//
// Quantization (per output ROW o of each bucket, so each row gets its own scale):
//   - activation aq[i] = round(SCReLU(acc[i]) · int8QA) ∈ [0,127]  (quantU8)
//   - weight     w8[o][i] = round(W[o][i] · Sw[o]) ∈ [-127,127], Sw[o]=127/max_i|W[o][i]|
//   - int32 dot  = Σ aq[i]·w8[o][i]  (dotU8I8, maddubs+madd; ≤127·127·2 ⇒ no saturation)
//   - descale    preact[o] = dot · L1Inv[o] + B[o],  L1Inv[o] = 1/(int8QA·Sw[o])
//   - CReLU      l2[o] = clamp(preact[o], 0, 1)
// then the float L2→L3→out tail runs unchanged.

// QuantizeForInt8 fills L1W8 + L1Inv from the float L2W/L2B (per-output-row int8
// scale) and switches Eval onto the int8 L1 path. Idempotent; safe to call once
// after the float net is loaded (e.g. ImportBulletMultiNet). A row of all-zero
// weights gets a unit scale (its dot is 0 anyway).
func (n *MultiNet) QuantizeForInt8() {
	in1 := 2 * n.H
	n.L1W8 = make([]int8, n.NB*n.D2*in1)
	n.L1Inv = make([]float32, n.NB*n.D2)
	for bk := 0; bk < n.NB; bk++ {
		w2 := n.L2W[bk*n.D2*in1 : (bk+1)*n.D2*in1]
		for o := 0; o < n.D2; o++ {
			row := w2[o*in1 : o*in1+in1]
			var m float32
			for _, v := range row {
				if a := absF(v); a > m {
					m = a
				}
			}
			sw := float32(1)
			if m > 0 {
				sw = 127 / m
			}
			dst := n.L1W8[(bk*n.D2+o)*in1 : (bk*n.D2+o)*in1+in1]
			for i, v := range row {
				q := math.Round(float64(v * sw))
				if q > 127 {
					q = 127
				} else if q < -127 { // symmetric range; -128 is unused (matches typical int8 NNUE)
					q = -127
				}
				dst[i] = int8(q)
			}
			n.L1Inv[bk*n.D2+o] = 1 / (int8QA * sw)
		}
	}
	n.int8L1 = true
}

// IsInt8 reports whether the int8 L1 path is active.
func (n *MultiNet) IsInt8() bool { return n.int8L1 }

func absF(x float32) float32 {
	if x < 0 {
		return -x
	}
	return x
}

// tailEvalInt8 is tailEval with the L1 matmul done in int8: aq is the u8-quantized
// [stm|opp] activation (length 2*H, produced by quantU8), the int8 L1 weights are
// dotted via dotU8I8 and descaled, then the float L2→L3→output tail runs exactly
// as the float path (so the two share their numerically-dominant-but-cheap tail).
func (n *MultiNet) tailEvalInt8(aq []uint8, bk int, l2, l3 []float32) int {
	in1 := 2 * n.H

	// L1: u8 activations × int8 weights → int32 dot → descale → CReLU.
	w8 := n.L1W8[bk*n.D2*in1 : (bk+1)*n.D2*in1]
	b2 := n.L2B[bk*n.D2 : (bk+1)*n.D2]
	inv := n.L1Inv[bk*n.D2 : (bk+1)*n.D2]
	for o := 0; o < n.D2; o++ {
		row := w8[o*in1 : o*in1+in1]
		dot := dotU8I8(aq, row)
		l2[o] = creluF(float32(dot)*inv[o] + b2[o])
	}

	// L2: l2[D2] → l3[D3], CReLU (float). (dotF32 SIMD seam handles the small
	// widths fine on AVX-512 — an inline scalar variant measured slower.)
	w3 := n.L3W[bk*n.D3*n.D2 : (bk+1)*n.D3*n.D2]
	b3 := n.L3B[bk*n.D3 : (bk+1)*n.D3]
	for o := 0; o < n.D3; o++ {
		row := w3[o*n.D2 : o*n.D2+n.D2]
		l3[o] = creluF(b3[o] + dotF32(l2, row))
	}

	// Output: l3[D3] → 1.
	ow := n.OW[bk*n.D3 : (bk+1)*n.D3]
	y := n.OB[bk] + dotF32(l3, ow)
	return int(math.Round(float64(y * n.CpScale)))
}
