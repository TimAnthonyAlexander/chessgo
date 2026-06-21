package nnuetrain

import (
	"fmt"
	"math"
	"math/rand"
	"runtime"
	"sync"

	"github.com/timanthonyalexander/gomachine/internal/nnue"
)

// Options controls the Adam minibatch trainer.
type Options struct {
	Epochs        int
	Batch         int
	LR            float64
	Gamma         float64 // per-epoch lr decay (lr *= Gamma after each epoch)
	Beta1         float64
	Beta2         float64
	Eps           float64
	Holdout       float64 // fraction of samples held out for validation
	Seed          int64
	ScalingFactor float64 // cp "50%-win" constant (sigmoid(out/sf))
	StartLambda   float64 // λ at epoch 1 (eval-weight)
	EndLambda     float64 // λ at the final epoch
}

// DefaultOptions returns the trainer's default Adam + net-v2 loss settings.
func DefaultOptions() Options {
	return Options{
		Epochs: 40, Batch: 16384, LR: 8.75e-4, Gamma: 0.992,
		Beta1: 0.9, Beta2: 0.999, Eps: 1e-8,
		Holdout: 0.02, Seed: 1,
		ScalingFactor: DefaultScalingFactor,
		StartLambda:   1.0, EndLambda: 0.75,
	}
}

// lambdaAt returns the linearly-scheduled λ for epoch (1-based) across opt.Epochs:
// StartLambda at epoch 1, EndLambda at the final epoch.
func lambdaAt(opt Options, epoch int) float64 {
	if opt.Epochs <= 1 {
		return opt.EndLambda
	}
	frac := float64(epoch-1) / float64(opt.Epochs-1)
	return opt.StartLambda + (opt.EndLambda-opt.StartLambda)*frac
}

// adamState carries the first/second-moment estimates, laid out like Grad so the
// update iterates parameters and moments in lockstep.
type adamState struct {
	mW0, vW0 []float64
	mB0, vB0 []float64
	mW1, vW1 []float64
	mB1, vB1 float64
	step     int
}

func newAdamState() *adamState {
	return &adamState{
		mW0: make([]float64, nnue.InputDim*nnue.L1),
		vW0: make([]float64, nnue.InputDim*nnue.L1),
		mB0: make([]float64, nnue.L1),
		vB0: make([]float64, nnue.L1),
		mW1: make([]float64, nnue.ConcatDim),
		vW1: make([]float64, nnue.ConcatDim),
	}
}

// Train fits a fresh random model on samples with minibatch Adam, holding out
// Holdout for validation and keeping the best-val model. log receives progress
// lines. It returns the best-val model.
func Train(samples []sample, opt Options, log func(string)) *Model {
	rng := rand.New(rand.NewSource(opt.Seed))

	// Holdout split (shuffle once so val isn't a correlated tail).
	rng.Shuffle(len(samples), func(i, j int) { samples[i], samples[j] = samples[j], samples[i] })
	nVal := int(float64(len(samples)) * opt.Holdout)
	if nVal < 1 && len(samples) > 50 {
		nVal = 1
	}
	val := samples[:nVal]
	train := samples[nVal:]
	if log != nil {
		log(fmt.Sprintf("split: %d train, %d val", len(train), len(val)))
	}

	m := NewModel()
	m.InitRandom(opt.Seed)
	adam := newAdamState()

	best := cloneModel(m)
	bestVal := math.Inf(1)

	order := make([]int, len(train))
	for i := range order {
		order[i] = i
	}

	lr := opt.LR
	for epoch := 1; epoch <= opt.Epochs; epoch++ {
		rng.Shuffle(len(order), func(i, j int) { order[i], order[j] = order[j], order[i] })

		lp := lossParams{lambda: lambdaAt(opt, epoch), sf: opt.ScalingFactor}
		epochOpt := opt
		epochOpt.LR = lr // current decayed learning rate

		for start := 0; start < len(order); start += opt.Batch {
			end := start + opt.Batch
			if end > len(order) {
				end = len(order)
			}
			grad := batchGradient(m, train, order[start:end], lp)
			grad.Scale(1.0 / float64(end-start)) // mean over the minibatch
			adamStep(m, grad, adam, epochOpt)
		}

		trainLoss := meanLoss(m, train, lp)
		valLoss := meanLoss(m, val, lp)
		if valLoss < bestVal {
			bestVal = valLoss
			best = cloneModel(m)
		}
		if log != nil {
			log(fmt.Sprintf("epoch %3d  λ %.4f  lr %.3e  train %.6f  val %.6f%s",
				epoch, lp.lambda, lr, trainLoss, valLoss, bestMarker(valLoss, bestVal)))
		}
		lr *= opt.Gamma
	}
	return best
}

func bestMarker(valLoss, bestVal float64) string {
	if valLoss == bestVal {
		return "  *"
	}
	return ""
}

// batchGradient computes the summed (unaveraged) gradient over the given sample
// indices, parallelised across NumCPU workers each with a local Grad+scratch.
func batchGradient(m *Model, train []sample, idx []int, lp lossParams) *Grad {
	workers := runtime.NumCPU()
	if workers > len(idx) {
		workers = len(idx)
	}
	if workers < 1 {
		workers = 1
	}
	chunk := (len(idx) + workers - 1) / workers

	partials := make([]*Grad, workers)
	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		lo := w * chunk
		hi := lo + chunk
		if hi > len(idx) {
			hi = len(idx)
		}
		if lo >= hi {
			break
		}
		wg.Add(1)
		go func(w, lo, hi int) {
			defer wg.Done()
			g := NewGrad()
			sc := newScratch()
			for _, i := range idx[lo:hi] {
				m.accumulate(train[i], g, sc, lp)
			}
			partials[w] = g
		}(w, lo, hi)
	}
	wg.Wait()

	total := NewGrad()
	for _, g := range partials {
		if g != nil {
			total.Add(g)
		}
	}
	return total
}

// adamStep applies one Adam update of g to m (g is already the mean gradient).
func adamStep(m *Model, g *Grad, a *adamState, opt Options) {
	a.step++
	b1t := 1 - math.Pow(opt.Beta1, float64(a.step))
	b2t := 1 - math.Pow(opt.Beta2, float64(a.step))

	upd := func(theta, grad, mm, vv []float64) {
		for i := range theta {
			gi := grad[i]
			mm[i] = opt.Beta1*mm[i] + (1-opt.Beta1)*gi
			vv[i] = opt.Beta2*vv[i] + (1-opt.Beta2)*gi*gi
			mhat := mm[i] / b1t
			vhat := vv[i] / b2t
			theta[i] -= opt.LR * mhat / (math.Sqrt(vhat) + opt.Eps)
		}
	}
	upd(m.W0, g.W0, a.mW0, a.vW0)
	upd(m.B0, g.B0, a.mB0, a.vB0)
	upd(m.W1, g.W1, a.mW1, a.vW1)

	// Scalar B1.
	a.mB1 = opt.Beta1*a.mB1 + (1-opt.Beta1)*g.B1
	a.vB1 = opt.Beta2*a.vB1 + (1-opt.Beta2)*g.B1*g.B1
	m.B1 -= opt.LR * (a.mB1 / b1t) / (math.Sqrt(a.vB1/b2t) + opt.Eps)
}

// meanLoss returns the mean λ-schedule CE loss over a sample set, parallelised.
func meanLoss(m *Model, set []sample, lp lossParams) float64 {
	if len(set) == 0 {
		return 0
	}
	workers := runtime.NumCPU()
	if workers > len(set) {
		workers = len(set)
	}
	if workers < 1 {
		workers = 1
	}
	chunk := (len(set) + workers - 1) / workers
	sums := make([]float64, workers)
	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		lo := w * chunk
		hi := lo + chunk
		if hi > len(set) {
			hi = len(set)
		}
		if lo >= hi {
			break
		}
		wg.Add(1)
		go func(w, lo, hi int) {
			defer wg.Done()
			sc := newScratch()
			var s float64
			for i := lo; i < hi; i++ {
				s += m.loss(set[i], sc, lp)
			}
			sums[w] = s
		}(w, lo, hi)
	}
	wg.Wait()
	var total float64
	for _, s := range sums {
		total += s
	}
	return total / float64(len(set))
}

func cloneModel(m *Model) *Model {
	c := NewModel()
	copy(c.W0, m.W0)
	copy(c.B0, m.B0)
	copy(c.W1, m.W1)
	c.B1 = m.B1
	return c
}

// ToNet casts the float64 model into an nnue.Net (float32) ready to Save. The
// trained out is already in centipawns (it is sigmoid(out/sf)-calibrated against
// label cp under the same sf), so CpScale = 1 — we only ever rescale post-hoc.
func (m *Model) ToNet() *nnue.Net {
	n := nnue.NewNet()
	for i, v := range m.W0 {
		n.W0[i] = float32(v)
	}
	for i, v := range m.B0 {
		n.B0[i] = float32(v)
	}
	for i, v := range m.W1 {
		n.W1[i] = float32(v)
	}
	n.B1 = float32(m.B1)
	n.CpScale = 1.0
	return n
}
