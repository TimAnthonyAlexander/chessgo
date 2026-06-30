package nnue

import "math"

// int8 quantization of the EnrichedNet tail's L1 layer (H→D2), the dominant tail
// cost. Mirrors MultiNet's int8 path (multilayer_int8.go) but for the enriched
// arch: the activation feeding L1 is the PAIRWISE product (not SCReLU), and the
// tail layers use SCReLU (not CReLU). int8 is the lever that changes the
// enriched-÷-v6 cost ratio — plain SIMD speeds both nets equally (docs/NNUE/
// INT8_HANDOFF.md). The maddubs win is realized on AVX2/AVX-512 (lairner); on NEON
// dotU8I8 stays scalar, so measure the movetime payoff on the prod arch.
//
// The QAT net trained the u8 activation grid exactly (faux_quantise(QACT=127) on
// the pairwise product), so this PTQ is near-lossless on the activation; only the
// L1 weights are PTQ'd here (per-output-row scale), which the closeness gate
// checks.

// pairwiseU8 is the int8-path analogue of pairwiseHalf: CReLU each half-pair,
// multiply, and quantize the [0,1] product to u8 ∈ [0,int8QA=127]. Writes H/2
// activations. (Scalar; the cost is dominated by the int8 L1 dot, not this.)
func pairwiseU8(out []uint8, half []int16) {
	hh := len(half) / 2
	const scale = float64(int8QA) / (float64(ftQA) * float64(ftQA)) // 127/255²
	for i := 0; i < hh; i++ {
		a := half[i]
		if a < 0 {
			a = 0
		} else if a > ftQA {
			a = ftQA
		}
		b := half[i+hh]
		if b < 0 {
			b = 0
		} else if b > ftQA {
			b = ftQA
		}
		q := float64(a) * float64(b) * scale // ∈ [0, int8QA]
		out[i] = uint8(q + 0.5)
	}
}

// enrichedL1QB is the FIXED int8 scale for L1 weights (the QB convention). It MUST
// match the QW the bullet config fake-quantises the L1 weights to (examples/
// chessgo_enriched.rs, QW=64): the QAT then trains the int8-grid weights, so this
// PTQ is near-lossless. A per-row scale would NOT match the QAT and re-introduces
// the ~150-Elo PTQ leak. AdamW's ±1.98 weight clip keeps 64·|w| ≤ ~127 (no
// saturation); the clamp below is a safety net.
const enrichedL1QB = 64

// QuantizeForInt8 fills L1W8 + L1Inv from the float L1W/L1B at the FIXED scale
// enrichedL1QB (matching the weight QAT) and switches Eval onto the int8 L1 path.
// Idempotent; call once after the float net is loaded (e.g. ImportBulletEnrichedNet).
func (n *EnrichedNet) QuantizeForInt8() {
	h := n.H
	n.L1W8 = make([]int8, n.NB*n.D2*h)
	n.L1Inv = make([]float32, n.NB*n.D2)
	const sw = float32(enrichedL1QB)
	d2, nb := n.D2, n.NB
	for bk := 0; bk < nb; bk++ {
		for o := 0; o < d2; o++ {
			// L1W is INPUT-MAJOR [H × NB*D2]; gather output o's column (scattered at
			// stride NB*D2) into the contiguous per-output int8 row dotU8I8 wants.
			dst := n.L1W8[(bk*d2+o)*h : (bk*d2+o)*h+h]
			for i := 0; i < h; i++ {
				q := math.Round(float64(n.L1W[i*(nb*d2)+bk*d2+o] * sw))
				if q > 127 {
					q = 127
				} else if q < -127 {
					q = -127
				}
				dst[i] = int8(q)
			}
			n.L1Inv[bk*d2+o] = 1 / (int8QA * sw)
		}
	}
	n.int8L1 = true
}

// IsInt8 reports whether the int8 L1 path is active.
func (n *EnrichedNet) IsInt8() bool { return n.int8L1 }

// QuantizeFTInt8 stores the FT THREAT columns (features 768..InputDim) as int8 at
// the SAME scale ftQA the int16 W0i uses, so they widen-add into the same int16
// accumulator — halving the per-move threat-column memory traffic. Base (piece-
// square) columns stay int16. Lossless only when the threat weights were QAT'd into
// the int8 range (|round(W·ftQA)| ≤ 127); out-of-range weights clamp (lossy), which
// the closeness test surfaces on a net not trained int8-FT-aware. Derives from W0i
// (already = round(W0·ftQA)). Idempotent.
func (n *EnrichedNet) QuantizeFTInt8() int {
	h := n.H
	n.W0t8 = make([]int8, ThreatBlock*h)
	clamped := 0
	for j := 0; j < ThreatBlock*h; j++ {
		v := n.W0i[InputDim*h+j] // threat columns start at feature InputDim (768)
		if v > 127 {
			v = 127
			clamped++
		} else if v < -127 {
			v = -127
			clamped++
		}
		n.W0t8[j] = int8(v)
	}
	n.int8FT = true
	return clamped
}

// IsInt8FT reports whether the int8 threat-column FT path is active.
func (n *EnrichedNet) IsInt8FT() bool { return n.int8FT }

// evalFromHalvesInt8 is evalFromHalves with the L1 matmul in int8: pairwise u8
// activation × int8 weights via dotU8I8, descaled, SCReLU; the float L2→output
// tail runs unchanged.
func (n *EnrichedNet) evalFromHalvesInt8(stm, opp []int16, bk int, sc *enrichedScratch) int {
	h := n.H
	half := h / 2
	aq := sc.aq // [stm_pair | opp_pair] u8, total H
	pairwiseU8(aq[:half], stm)
	pairwiseU8(aq[half:], opp)

	d2, d3, nb := n.D2, n.D3, n.NB

	// Tail layer 1: u8 activations × int8 weights → int32 dot → descale → SCReLU.
	// L1W8 is the gathered per-output contiguous int8 row (output-major); the dot
	// here is the one place the int8 path keeps the per-output dotU8I8 (its win is
	// MAC density, distinct from the float GEMV's reduction-avoidance).
	l1 := sc.l1
	w8 := n.L1W8[bk*d2*h : (bk+1)*d2*h]
	b1 := n.L1B[bk*d2 : bk*d2+d2]
	inv := n.L1Inv[bk*d2 : bk*d2+d2]
	for o := 0; o < d2; o++ {
		l1[o] = screluF(float32(dotU8I8(aq, w8[o*h:o*h+h]))*inv[o] + b1[o])
	}

	// Tail layer 2 + output: float output-stationary GEMV (input-major), same as
	// the float path.
	l2 := sc.l2
	gemvF32(l2, l1, n.L2W, nb*d3, bk*d3)
	b2 := n.L2B[bk*d3 : bk*d3+d3]
	for o := range l2 {
		l2[o] = screluF(l2[o] + b2[o])
	}
	var y1 [1]float32
	gemvF32(y1[:], l2, n.OW, nb, bk)
	y := n.OB[bk] + y1[0]
	return int(math.Round(float64(y * n.CpScale)))
}
