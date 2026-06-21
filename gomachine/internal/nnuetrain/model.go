// Package nnuetrain is the Go-native NNUE trainer (PLAN.md Phase 2). It fits the
// (768→256)×2→1 perspective network defined by internal/nnue on WDL-labelled EPD
// data, then serializes to the Phase-1 net file format via nnue.Net.Save.
//
// All training math is float64 (weights, forward, backward) so the gradient
// check lands cleanly under 1e-6 relative error; only at save time do we cast to
// float32 into an nnue.Net. Feature extraction is delegated to nnue.AppendFeatures
// — the single source of truth shared with inference; this package never indexes
// features itself. See docs/NNUE/PLAN.md and the TestGradientCheck gate.
package nnuetrain

import (
	"math"
	"math/rand"

	"github.com/timanthonyalexander/gomachine/internal/nnue"
)

// DefaultScalingFactor is the centipawn "50%-win" constant: the net's win
// probability is sigmoid(out/sf), and the eval target is sigmoid(label_cp/sf),
// so the trained out lands in our cp units by construction (CpScale stays 1.0).
const DefaultScalingFactor = 200.0

// lossParams carries the λ-schedule CE loss configuration for one minibatch.
// lambda blends the eval target (weight λ) and the result target (weight 1−λ);
// sf is the centipawn scaling factor (DefaultScalingFactor by default).
type lossParams struct {
	lambda float64
	sf     float64
}

// Model holds the trainable parameters in float64. Layout mirrors nnue.Net:
//
//	W0  feature transformer, feature-major flat [InputDim*L1] (W0[f*L1+j])
//	B0  accumulator bias [L1] (shared by both perspective halves)
//	W1  output weights over the concatenated [stm, opp] ClippedReLU [ConcatDim]
//	B1  output bias (scalar)
type Model struct {
	W0 []float64 // nnue.InputDim * nnue.L1
	B0 []float64 // nnue.L1
	W1 []float64 // nnue.ConcatDim
	B1 float64
}

// NewModel allocates a zeroed model of the fixed architecture.
func NewModel() *Model {
	return &Model{
		W0: make([]float64, nnue.InputDim*nnue.L1),
		B0: make([]float64, nnue.L1),
		W1: make([]float64, nnue.ConcatDim),
	}
}

// InitRandom fills the model with small Gaussian weights so ClippedReLU units
// aren't all dead (an all-negative accumulator has zero gradient). Biases start
// at 0; W0/W1 ~ N(0, 0.05).
func (m *Model) InitRandom(seed int64) {
	rng := rand.New(rand.NewSource(seed))
	for i := range m.W0 {
		m.W0[i] = rng.NormFloat64() * 0.05
	}
	for i := range m.W1 {
		m.W1[i] = rng.NormFloat64() * 0.05
	}
	// B0, B1 stay 0.
}

// Grad accumulates the gradient of the loss w.r.t. each parameter. It mirrors
// Model's layout so an optimiser can iterate the two in lockstep.
type Grad struct {
	W0 []float64
	B0 []float64
	W1 []float64
	B1 float64
}

// NewGrad allocates a zeroed gradient of the fixed architecture.
func NewGrad() *Grad {
	return &Grad{
		W0: make([]float64, nnue.InputDim*nnue.L1),
		B0: make([]float64, nnue.L1),
		W1: make([]float64, nnue.ConcatDim),
	}
}

// Zero clears the gradient for reuse across minibatches.
func (g *Grad) Zero() {
	for i := range g.W0 {
		g.W0[i] = 0
	}
	for i := range g.B0 {
		g.B0[i] = 0
	}
	for i := range g.W1 {
		g.W1[i] = 0
	}
	g.B1 = 0
}

// Add folds src into g (used to sum per-worker partial gradients).
func (g *Grad) Add(src *Grad) {
	for i := range g.W0 {
		g.W0[i] += src.W0[i]
	}
	for i := range g.B0 {
		g.B0[i] += src.B0[i]
	}
	for i := range g.W1 {
		g.W1[i] += src.W1[i]
	}
	g.B1 += src.B1
}

// Scale multiplies every gradient component by s (e.g. 1/batchSize for a mean).
func (g *Grad) Scale(s float64) {
	for i := range g.W0 {
		g.W0[i] *= s
	}
	for i := range g.B0 {
		g.B0[i] *= s
	}
	for i := range g.W1 {
		g.W1[i] *= s
	}
	g.B1 *= s
}

func sigmoid(x float64) float64 { return 1.0 / (1.0 + math.Exp(-x)) }

// clampUnit clamps x to [0,1].
func clampUnit(x float64) float64 {
	if x < 0 {
		return 0
	}
	if x > 1 {
		return 1
	}
	return x
}

// forward computes the network output y (centipawns) for one sample, plus the
// post-SCReLU activations h (length ConcatDim) and the pre-activation concat z
// (length ConcatDim, STM half first). The caller supplies z and h scratch slices
// to avoid per-sample allocation.
//
// a[j] = B0[j] + Σ_{f∈featsStm} W0[f][j]   (stm half, z[0:L1])
// c[j] = B0[j] + Σ_{f∈featsOpp} W0[f][j]   (opp half, z[L1:])
// h    = clamp(z, 0, 1)²                    (SCReLU)
// y    = B1 + Σ W1[i]·h[i]
func (m *Model) forward(featsStm, featsOpp []uint16, z, h []float64) (y float64) {
	const L1 = nnue.L1
	for j := 0; j < L1; j++ {
		z[j] = m.B0[j]
		z[L1+j] = m.B0[j]
	}
	for _, f := range featsStm {
		col := m.W0[int(f)*L1 : int(f)*L1+L1]
		for j := 0; j < L1; j++ {
			z[j] += col[j]
		}
	}
	for _, f := range featsOpp {
		col := m.W0[int(f)*L1 : int(f)*L1+L1]
		for j := 0; j < L1; j++ {
			z[L1+j] += col[j]
		}
	}
	y = m.B1
	for i := 0; i < nnue.ConcatDim; i++ {
		c := clampUnit(z[i]) // SCReLU: square the clamped activation
		hi := c * c
		h[i] = hi
		y += hi * m.W1[i]
	}
	return y
}

// scratch holds per-worker reusable buffers so accumulate never allocates and
// the global slices stay untouched (concurrency-safe — one scratch per worker).
type scratch struct {
	z  []float64 // pre-clamp concat, length ConcatDim
	h  []float64 // post-ClippedReLU, length ConcatDim
	ga []float64 // gz for the stm half, length L1
	gc []float64 // gz for the opp half, length L1
}

func newScratch() *scratch {
	return &scratch{
		z:  make([]float64, nnue.ConcatDim),
		h:  make([]float64, nnue.ConcatDim),
		ga: make([]float64, nnue.L1),
		gc: make([]float64, nnue.L1),
	}
}

// ceEps stabilizes the log in the cross-entropy loss against q hitting {0,1}.
const ceEps = 1e-12

// crossEntropy is the WDL-space CE between model win-prob q and target p:
//
//	CE(q,p) = −[ p·log(q+ε) + (1−p)·log(1−q+ε) ]
func crossEntropy(q, p float64) float64 {
	return -(p*math.Log(q+ceEps) + (1-p)*math.Log(1-q+ceEps))
}

// accumulate runs forward + backward for one sample under the λ-schedule CE
// loss, adding its (unaveraged) gradient into g and returning the per-sample
// loss. sc holds reusable scratch; lp carries λ and the scaling factor.
//
// With out = net cp output, q = sigmoid(out/sf), p_eval = sigmoid(stmScore/sf),
// p_res = stmResultWP, and loss = λ·CE(q,p_eval) + (1−λ)·CE(q,p_res):
//
//	gy        = dLoss/dout = [λ·(q − p_eval) + (1−λ)·(q − p_res)] / sf
//	dB1      += gy
//	dW1[i]   += gy·h[i]                              // h = SCReLU activation
//	gh[i]     = gy·W1[i]
//	gz[i]     = gh[i]·(0<z[i]<1 ? 2·z[i] : 0)        // SCReLU deriv, boundary→0
//	dB0[j]   += gz[j] + gz[L1+j]                     // B0 feeds both halves
//	dW0[f][j]+= gz[j]      for f∈featsStm             // accumulate, never overwrite
//	dW0[f][j]+= gz[L1+j]   for f∈featsOpp
func (m *Model) accumulate(s sample, g *Grad, sc *scratch, lp lossParams) float64 {
	const L1 = nnue.L1
	out := m.forward(s.featsStm, s.featsOpp, sc.z, sc.h)

	q := sigmoid(out / lp.sf)
	pEval := sigmoid(s.stmScore / lp.sf)
	pRes := s.stmResultWP

	gy := (lp.lambda*(q-pEval) + (1-lp.lambda)*(q-pRes)) / lp.sf
	g.B1 += gy

	// dW1[i] += gy·h[i] over the whole concat.
	for i := 0; i < nnue.ConcatDim; i++ {
		g.W1[i] += gy * sc.h[i]
	}
	// ga = gz[0:L1] (stm half), gc = gz[L1:] (opp half), masked by SCReLU deriv 2·z.
	for j := 0; j < L1; j++ {
		var ga, gc float64
		if z := sc.z[j]; z > 0 && z < 1 {
			ga = gy * m.W1[j] * 2 * z
		}
		if z := sc.z[L1+j]; z > 0 && z < 1 {
			gc = gy * m.W1[L1+j] * 2 * z
		}
		sc.ga[j], sc.gc[j] = ga, gc
		g.B0[j] += ga + gc // B0 feeds both halves
	}
	for _, f := range s.featsStm {
		col := g.W0[int(f)*L1 : int(f)*L1+L1]
		for j := 0; j < L1; j++ {
			col[j] += sc.ga[j]
		}
	}
	for _, f := range s.featsOpp {
		col := g.W0[int(f)*L1 : int(f)*L1+L1]
		for j := 0; j < L1; j++ {
			col[j] += sc.gc[j]
		}
	}
	return lp.lambda*crossEntropy(q, pEval) + (1-lp.lambda)*crossEntropy(q, pRes)
}

// loss returns just the λ-schedule CE loss for one sample (used by the gradient
// check's finite differences and meanLoss — no backward pass).
func (m *Model) loss(s sample, sc *scratch, lp lossParams) float64 {
	out := m.forward(s.featsStm, s.featsOpp, sc.z, sc.h)
	q := sigmoid(out / lp.sf)
	pEval := sigmoid(s.stmScore / lp.sf)
	return lp.lambda*crossEntropy(q, pEval) + (1-lp.lambda)*crossEntropy(q, s.stmResultWP)
}

// Eval returns the model's raw cp output for one sample (used by the train/infer
// consistency test to compare against nnue.Net.Eval). sc holds reusable scratch.
func (m *Model) Eval(s sample, sc *scratch) float64 {
	return m.forward(s.featsStm, s.featsOpp, sc.z, sc.h)
}
