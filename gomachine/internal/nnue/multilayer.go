package nnue

import (
	"math"
	"math/rand"
	"sync/atomic"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// MultiNet is the multilayer perspective network — the GNN4 architecture that
// closes the gap to the open-source NNUE frontier (docs/NNUE/NEXT_ARCH.md,
// docs/NNUE/INT8_PORT_SPEC.md). Shape:
//
//	768 --FT--> [stm | opp] (2*H)  --SCReLU-->  L2(D2) --CReLU-->  L3(D3) --CReLU-->  1
//
// with NB output buckets: the feature transformer (W0/B0) is shared across
// buckets; the tail layers (L2/L3/output) are per-bucket. The single-layer Net
// (GNN1/2/3, the shipped v6) is left completely untouched — this is an additive
// second eval architecture, selected by net file format.
//
// This is the FLOAT REFERENCE forward (correct-but-slow, from-scratch every
// call). The int8 + sparse fast path (Phase 2) is built later and gated
// bit-exact against this. "Minimal-first": no threats / pairwise / dual /
// skip-connection / king-buckets yet — each of those is a later enrichment with
// its own retrain + movetime gate.
//
// Activation choice (must match the bullet training config): SCReLU on the FT
// (clamp [0,1] then square — the big capacity layer, same as Net), CReLU
// (clamp [0,1]) on the two tail layers. Tunable later; the float path here is
// the source of truth the int path must reproduce.
type MultiNet struct {
	H  int // FT hidden width per perspective (the spec's "L1")
	D2 int // tail layer-1 width (the spec's "L2")
	D3 int // tail layer-2 width (the spec's "L3")
	NB int // output buckets (piece-count heads, like Net)

	// Feature transformer (shared across buckets), feature-major like Net.W0 so an
	// accumulator add is a contiguous slice add (the incremental-update shape).
	// W0/B0 are the float source; W0i/B0i are the int16 quantization the
	// accumulator actually uses (QA=ftQA), so the per-move Push is the same fast
	// int16 SIMD addCol/subCol as v6 (the float accumulator's copy+scalar-delta was
	// the single biggest per-node cost). quantizeFT derives W0i/B0i from W0/B0.
	W0  []float32 // InputDim * H (float source)
	B0  []float32 // H
	W0i []int16   // InputDim * H (int16, the accumulator weights)
	B0i []int16   // H

	// Tail layers, per bucket, row-major: a layer mapping `in`→`out` stores
	// weight[(bucket*outDim + o)*inDim + i].
	L2W []float32 // NB * D2 * (2*H)
	L2B []float32 // NB * D2
	L3W []float32 // NB * D3 * D2
	L3B []float32 // NB * D3
	OW  []float32 // NB * D3   (output weights)
	OB  []float32 // NB        (output bias)

	CpScale float32 // raw output → centipawns

	// int8 L1 (PTQ, multilayer_int8.go). When int8L1 is true, evalFromAcc runs the
	// dominant L1 matmul in int8 (u8 activations × int8 weights, the maddubs path)
	// instead of float — the only lever that makes the multilayer tail movetime-
	// viable vs v6 (float SIMD speeds v6 equally; int8 changes the cost ratio).
	// L2/L3 stay float (negligible cost). Filled by QuantizeForInt8 from L2W.
	int8L1 bool
	L1W8   []int8    // NB * D2 * (2*H), per-output-row int8 quantized L1 weights
	L1Inv  []float32 // NB * D2, per-output descale 1/(255·Sw[o]) applied to the int32 dot
}

// ftQA is the feature-transformer quantization scale: the int16 accumulator holds
// round(float_activation · ftQA), so clamp(acc,0,ftQA) maps the SCReLU [0,1] input
// range onto [0,ftQA]. 255 matches the single-layer Net (bulletQA), giving 8-bit
// resolution on the pre-square activation.
const ftQA = 255

// NewMultiNet allocates a zeroed multilayer net of the given dimensions.
func NewMultiNet(h, d2, d3, nb int) *MultiNet {
	if nb < 1 {
		nb = 1
	}
	n := &MultiNet{
		H: h, D2: d2, D3: d3, NB: nb,
		W0:      make([]float32, InputDim*h),
		B0:      make([]float32, h),
		W0i:     make([]int16, InputDim*h),
		B0i:     make([]int16, h),
		L2W:     make([]float32, nb*d2*2*h),
		L2B:     make([]float32, nb*d2),
		L3W:     make([]float32, nb*d3*d2),
		L3B:     make([]float32, nb*d3),
		OW:      make([]float32, nb*d3),
		OB:      make([]float32, nb),
		CpScale: 1,
	}
	return n
}

// quantizeFT (re)derives the int16 accumulator weights W0i/B0i from the float
// W0/B0 at scale ftQA. Call after any change to W0/B0 (import, randomize). The
// accumulator math is then pure int16 (exact, associative) like v6.
func (n *MultiNet) quantizeFT() {
	for i, v := range n.W0 {
		n.W0i[i] = int16(math.Round(float64(v * ftQA)))
	}
	for i, v := range n.B0 {
		n.B0i[i] = int16(math.Round(float64(v * ftQA)))
	}
}

// RandomMultiNet returns a small-random-weight multilayer net for tests.
func RandomMultiNet(seed int64, h, d2, d3, nb int) *MultiNet {
	rng := rand.New(rand.NewSource(seed))
	n := NewMultiNet(h, d2, d3, nb)
	fill := func(s []float32, scale float32) {
		for i := range s {
			s[i] = float32(rng.NormFloat64()) * scale
		}
	}
	fill(n.W0, 0.1)
	fill(n.B0, 0.1)
	fill(n.L2W, 0.2)
	fill(n.L2B, 0.1)
	fill(n.L3W, 0.2)
	fill(n.L3B, 0.1)
	fill(n.OW, 0.2)
	fill(n.OB, 0.1)
	n.CpScale = 100
	n.quantizeFT()
	return n
}

// materialBucket selects pos's piece-count output bucket, matching bullet's
// MaterialCount<NB> (divisor = ceil(32/NB), bucket = (popcount-2)/divisor,
// clamped). Shared by MultiNet; Net keeps its own identical method so the v6
// path stays byte-for-byte unchanged.
func materialBucket(pos *chess.Position, nb int) int {
	if nb <= 1 {
		return 0
	}
	divisor := (32 + nb - 1) / nb
	b := (pos.Occupied().Count() - 2) / divisor
	if b < 0 {
		return 0
	}
	if b >= nb {
		return nb - 1
	}
	return b
}

// screluF clamps x to [0,1] then squares it (SCReLU), matching Net's float path.
func screluF(x float32) float32 {
	if x < 0 {
		return 0
	}
	if x > 1 {
		x = 1
	}
	return x * x
}

// creluF clamps x to [0,1] (CReLU).
func creluF(x float32) float32 {
	if x < 0 {
		return 0
	}
	if x > 1 {
		return 1
	}
	return x
}

// Eval returns the multilayer net's static evaluation of pos in centipawns from
// the side-to-move's perspective. From-scratch reference path: build the feature
// transformer accumulator, then run the activation + tail. The incremental path
// (multilayer_acc.go) reuses evalFromAcc with an incrementally-maintained
// accumulator instead of rebuilding it.
func (n *MultiNet) Eval(pos *chess.Position) int {
	acc := n.newAcc()
	n.buildAcc(&acc, pos)
	return n.evalFromAcc(&acc, pos)
}

// tailEval runs SCReLU-on-FT's output through the multilayer tail (L2 → L3 →
// output) for the given bucket. ft is the concatenated [stm|opp] SCReLU
// activation (length 2*H); the caller has already oriented and activated it.
func (n *MultiNet) tailEval(ft []float32, bk int, l2, l3 []float32) int {
	in1 := 2 * n.H

	// Tail layer 1: ft[2H] → l2[D2], CReLU. The dominant cost (D2 dots over the
	// 2*H feature vector) routes through the dotF32 kernel seam so a SIMD backend
	// accelerates it; bias is added after the dot (float non-associativity makes
	// this bit-close, not bit-exact, vs the old fused loop — see dotF32Scalar).
	w2 := n.L2W[bk*n.D2*in1 : (bk+1)*n.D2*in1]
	b2 := n.L2B[bk*n.D2 : (bk+1)*n.D2]
	for o := 0; o < n.D2; o++ {
		row := w2[o*in1 : o*in1+in1]
		l2[o] = creluF(b2[o] + dotF32(ft, row))
	}

	// Tail layer 2: l2[D2] → l3[D3], CReLU.
	w3 := n.L3W[bk*n.D3*n.D2 : (bk+1)*n.D3*n.D2]
	b3 := n.L3B[bk*n.D3 : (bk+1)*n.D3]
	for o := 0; o < n.D3; o++ {
		row := w3[o*n.D2 : o*n.D2+n.D2]
		l3[o] = creluF(b3[o] + dotF32(l2, row))
	}

	// Output layer: l3[D3] → 1.
	ow := n.OW[bk*n.D3 : (bk+1)*n.D3]
	y := n.OB[bk] + dotF32(l3, ow)
	return int(math.Round(float64(y * n.CpScale)))
}

// --- Default (process-wide) multilayer net, atomically swappable ---

var defaultMultiNet atomic.Pointer[MultiNet]

// SetMultiNet installs m as the process-wide default multilayer net (nil clears
// it). When set, the searcher routes its static eval through it via the
// from-scratch forward — for fixed-depth / fixed-nodes eval-quality measurement
// of the GNN4 architecture (NEXT_ARCH Phase 1; no incremental accumulator yet).
func SetMultiNet(m *MultiNet) { defaultMultiNet.Store(m) }

// DefaultMulti returns the installed default multilayer net, or nil if none.
func DefaultMulti() *MultiNet { return defaultMultiNet.Load() }
