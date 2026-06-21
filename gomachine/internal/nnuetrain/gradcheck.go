package nnuetrain

import (
	"fmt"
	"math"
	"math/rand"

	"github.com/timanthonyalexander/gomachine/internal/nnue"
)

// paramRef names one scalar parameter of a Model so the gradient check can read
// the analytic gradient and perturb the same scalar for the finite difference.
type paramRef struct {
	name string
	get  func(m *Model) *float64
	grad func(g *Grad) float64
}

// pickParams selects nPerLayer random scalars from each of W0, b0, W1, b1 (b1 is
// the single scalar) — ~50 total spanning all four layers, as the gate requires.
func pickParams(rng *rand.Rand, nPerLayer int) []paramRef {
	var refs []paramRef
	for k := 0; k < nPerLayer; k++ {
		i := rng.Intn(nnue.InputDim * nnue.L1)
		refs = append(refs, paramRef{
			name: fmt.Sprintf("W0[%d]", i),
			get:  func(m *Model) *float64 { return &m.W0[i] },
			grad: func(g *Grad) float64 { return g.W0[i] },
		})
		j := rng.Intn(nnue.L1)
		refs = append(refs, paramRef{
			name: fmt.Sprintf("B0[%d]", j),
			get:  func(m *Model) *float64 { return &m.B0[j] },
			grad: func(g *Grad) float64 { return g.B0[j] },
		})
		l := rng.Intn(nnue.ConcatDim)
		refs = append(refs, paramRef{
			name: fmt.Sprintf("W1[%d]", l),
			get:  func(m *Model) *float64 { return &m.W1[l] },
			grad: func(g *Grad) float64 { return g.W1[l] },
		})
	}
	refs = append(refs, paramRef{
		name: "B1",
		get:  func(m *Model) *float64 { return &m.B1 },
		grad: func(g *Grad) float64 { return g.B1 },
	})
	return refs
}

// batchMeanLoss is the exact objective the analytic gradient differentiates: the
// MEAN λ-schedule CE loss over the fixed batch. The finite difference must use
// this same definition (same lp) or the check is meaningless.
func batchMeanLoss(m *Model, batch []sample, sc *scratch, lp lossParams) float64 {
	var s float64
	for i := range batch {
		s += m.loss(batch[i], sc, lp)
	}
	return s / float64(len(batch))
}

// gradCheckLossParams is the loss configuration the gradient check uses. λ is
// strictly between 0 and 1 so BOTH the eval and result terms (and thus both
// (q−p) gradient halves and the SCReLU path) are exercised.
var gradCheckLossParams = lossParams{lambda: 0.6, sf: DefaultScalingFactor}

// GradCheck compares analytic gradients to central finite differences on a small
// fixed batch, in float64. It returns the worst relative error observed across
// the sampled parameters. The objective is the MEAN batch loss (matching Train's
// per-minibatch scaling), so the analytic gradient is the summed Grad divided by
// the batch size.
//
// relErr = |num − ana| / max(1, |ana|); the gate requires worst < 1e-6.
func GradCheck(batch []sample, seed int64, nPerLayer int, eps float64) (worst float64, details []string) {
	m := NewModel()
	m.InitRandom(seed)

	lp := gradCheckLossParams

	// Analytic gradient: summed over the batch, then divided by the batch size to
	// match the mean-loss objective.
	g := NewGrad()
	sc := newScratch()
	for i := range batch {
		m.accumulate(batch[i], g, sc, lp)
	}
	g.Scale(1.0 / float64(len(batch)))

	rng := rand.New(rand.NewSource(seed + 7))
	refs := pickParams(rng, nPerLayer)

	for _, r := range refs {
		ana := r.grad(g)
		p := r.get(m)
		orig := *p

		*p = orig + eps
		lpls := batchMeanLoss(m, batch, sc, lp)
		*p = orig - eps
		lmin := batchMeanLoss(m, batch, sc, lp)
		*p = orig

		num := (lpls - lmin) / (2 * eps)
		rel := math.Abs(num-ana) / math.Max(1, math.Abs(ana))
		if rel > worst {
			worst = rel
		}
		details = append(details, fmt.Sprintf("%-12s ana=%+.8e num=%+.8e rel=%.3e", r.name, ana, num, rel))
	}
	return worst, details
}
