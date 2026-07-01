package nnue

import (
	"encoding/binary"
	"fmt"
	"math"
	"os"
)

// LEAN-PAIRWISE eval path (chessgo_lean_pairwise.rs). Same FT/accumulator as the
// lean single-layer net — byte-identical threat inputs, int16 accumulator, int8-FT
// threat columns, move-aware push — but a PAIRWISE head on the tail: CReLU each of
// the two FT half-pairs and multiply, giving H/2 activations per perspective; concat
// both perspectives → H; one output dot per bucket. The pairwise product is a
// multiplicative nonlinearity (Stormphrax "dual activation") and HALVES the tail
// input (2H→H) vs the lean concat tail.
//
// Arithmetic (bit-CLOSE to the bullet float forward, like the lean tail):
//   FT accumulator holds acc_i = round(act_i · ftQA), ftQA=255 (exact int16, the
//   same W0i the lean/enriched path uses). CReLU on a half = clamp(acc,0,ftQA); its
//   float value is that /ftQA ∈ [0,1]. The pairwise product ca·cb (kept as a full
//   int32, NOT re-quantised to a u8 grid) equals (ca/ftQA)·(cb/ftQA)·ftQA² — the
//   training forward multiplies the two CReLU floats with no intermediate grid, so
//   ca·cb is that product exact. The tail weight is PTQ'd to int16 at leanTailQB
//   (near-lossless for O(1) weights). Final: y = TB + Σ(ca·cb)·TWi / (ftQA²·QB);
//   cp = round(y · CpScale). The int64 accumulator can't overflow (ca·cb ≤ 65025,
//   |TWi| ≤ ~2·QB, H terms).

// quantizeLeanPairwiseTail builds the bucket-contiguous int16 tail weights TWi
// [NB × H] from the input-major float TW [H × NB] (TW[i*NB+b]), at scale leanTailQB.
// Layout within a bucket: TWi[b*H + i] where i<H/2 weights the stm-pairwise output
// and i≥H/2 the opp-pairwise output (matching bullet's concat(stm_hidden,
// ntm_hidden)). Returns the number of weights clamped (expected 0).
func (n *EnrichedNet) quantizeLeanPairwiseTail() int {
	h := n.H
	n.TWi = make([]int16, n.NB*h)
	clamped := 0
	for b := 0; b < n.NB; b++ {
		for i := 0; i < h; i++ {
			q := math.Round(float64(n.TW[i*n.NB+b]) * leanTailQB)
			if q > 32767 {
				q = 32767
				clamped++
			} else if q < -32767 {
				q = -32767
				clamped++
			}
			n.TWi[b*h+i] = int16(q)
		}
	}
	return clamped
}

// evalFromHalvesLeanPairwise runs the pairwise head + single-output tail dot for the
// given bucket, fully in integer (no scratch, no float until the final descale).
// stm/opp are the two oriented int16 accumulator halves (length H).
func (n *EnrichedNet) evalFromHalvesLeanPairwise(stm, opp []int16, bk int, sc *enrichedScratch) int {
	_ = sc // integer path needs no scratch
	h := n.H
	half := h / 2
	w := n.TWi[bk*h : bk*h+h] // [H]: [0,half) stm-pairwise weights, [half,H) opp

	var acc int64
	for i := 0; i < half; i++ {
		a := stm[i]
		if a < 0 {
			a = 0
		} else if a > ftQA {
			a = ftQA
		}
		b := stm[i+half]
		if b < 0 {
			b = 0
		} else if b > ftQA {
			b = ftQA
		}
		acc += int64(int32(a)*int32(b)) * int64(w[i])
	}
	wo := w[half:]
	for i := 0; i < half; i++ {
		a := opp[i]
		if a < 0 {
			a = 0
		} else if a > ftQA {
			a = ftQA
		}
		b := opp[i+half]
		if b < 0 {
			b = 0
		} else if b > ftQA {
			b = ftQA
		}
		acc += int64(int32(a)*int32(b)) * int64(wo[i])
	}

	y := float64(n.TB[bk]) + float64(acc)/(float64(ftQA)*float64(ftQA)*leanTailQB)
	return int(math.Round(y * float64(n.CpScale)))
}

// ImportBulletLeanPairwiseNet reads a bullet float32 export of the LEAN-PAIRWISE arch
// (examples/chessgo_lean_pairwise.rs). Save order: l0w l0b l1w l1b (LE f32). The FT
// (l0w/l0b) is identical to the lean/enriched FT (feature-major). The pairwise tail
// l1w is input-major [H × NB] (l1w[i*NB + b]) — HALF the width of the lean concat
// tail (which is [2H × NB]); l1b is [NB]. CpScale = 400.
func ImportBulletLeanPairwiseNet(path string, h, nb int) (*EnrichedNet, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("nnue: read bullet lean-pairwise net: %w", err)
	}
	in := InputDim + ThreatBlock
	nL0w := in * h
	nL0b := h
	nL1w := h * nb // pairwise tail: [H × NB], not [2H × NB]
	nL1b := nb
	want := nL0w + nL0b + nL1w + nL1b
	if len(raw) < want*4 {
		return nil, fmt.Errorf(
			"nnue: bullet lean-pairwise net is %d bytes (%d f32) < %d f32 needed for H=%d NB=%d",
			len(raw), len(raw)/4, want, h, nb)
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

	n := NewEnrichedNet(h, 0, 0, nb) // D2/D3 unused
	copy(n.W0, l0w)
	copy(n.B0, l0b)
	n.leanPairwise = true
	n.TW = make([]float32, h*nb)
	n.TB = make([]float32, nb)
	copy(n.TW, l1w) // input-major [H × NB], straight
	copy(n.TB, l1b)
	n.CpScale = bulletSCALE // 400
	n.quantizeFT()
	n.quantizeLeanPairwiseTail()
	n.moveAware = true // strictly better + bit-exact incremental (enriched_delta.go)
	return n, nil
}
