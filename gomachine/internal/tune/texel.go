package tune

import (
	"fmt"
	"math"
	"runtime"
	"strings"
	"sync"

	"github.com/timanthonyalexander/gomachine/internal/eval"
)

// ln10over400 is d/dE of sigmoid's exponent (base-10, /400 scaling).
const ln10over400 = math.Ln10 / 400.0

// Options controls the Adam optimiser.
type Options struct {
	Epochs int
	LR     float64 // step size in centipawns/epoch (Adam-normalised)
	Beta1  float64
	Beta2  float64
	Decay  float64 // decoupled weight-decay pull toward θ0 each epoch (regularisation)
	Lambda float64 // WDL+eval blend: 1=pure WDL, <1 mixes in the soft search-eval label
	LogN   int     // log MSE every LogN epochs (0 = only first/last)
}

// DefaultOptions returns sane Adam settings for this model size (~788 params).
// Decay shrinks weights toward the PeSTO starting point so rarely-occupied
// squares (which see little data) stay near their sane defaults instead of
// fitting noise — the regularisation that keeps the tuned PSQT smooth.
func DefaultOptions() Options {
	return Options{Epochs: 400, LR: 1.0, Beta1: 0.9, Beta2: 0.999, Decay: 0.01, Lambda: 1.0, LogN: 25}
}

// frozen marks parameters the tuner must not move, to keep the model faithful to
// Evaluate: tempo (a fixed constant, both phases) and the king-shield endgame
// weight (the term is middlegame-only). Everything else — all PSQT/material and
// the remaining knowledge weights — is tuned jointly.
func frozen() map[int]bool {
	return map[int]bool{
		2 * eval.FeatTempo:        true,
		2*eval.FeatTempo + 1:      true,
		2*eval.FeatKingShield + 1: true,
	}
}

// Optimize fits θ (starting from θ0) by Adam gradient descent on the MSE against
// the WDL labels, with K frozen. It returns the tuned vector and the final
// training MSE. log receives progress lines.
func Optimize(samples []Sample, θ0 []float64, k float64, opt Options, log func(string)) ([]float64, float64) {
	n := len(θ0)
	θ := append([]float64(nil), θ0...)
	m := make([]float64, n)
	v := make([]float64, n)
	froz := frozen()

	b1, b2, eps := opt.Beta1, opt.Beta2, 1e-8
	var mse float64
	for epoch := 1; epoch <= opt.Epochs; epoch++ {
		grad := gradient(samples, θ, k, opt.Lambda)
		b1t := 1 - math.Pow(b1, float64(epoch))
		b2t := 1 - math.Pow(b2, float64(epoch))
		for j := 0; j < n; j++ {
			if froz[j] {
				continue
			}
			g := grad[j]
			m[j] = b1*m[j] + (1-b1)*g
			v[j] = b2*v[j] + (1-b2)*g*g
			θ[j] -= opt.LR * (m[j] / b1t) / (math.Sqrt(v[j]/b2t) + eps)
			θ[j] -= opt.LR * opt.Decay * (θ[j] - θ0[j]) // decoupled decay toward θ0
		}
		if log != nil && (epoch == 1 || epoch == opt.Epochs || (opt.LogN > 0 && epoch%opt.LogN == 0)) {
			mse = MSE(samples, θ, k, opt.Lambda)
			log(fmt.Sprintf("epoch %4d  MSE %.6f", epoch, mse))
		}
	}
	return θ, MSE(samples, θ, k, opt.Lambda)
}

// gradient returns dMSE/dθ over all samples, computed in parallel. The model is
// E = Σ coeff·taper(θ); with p = sigmoid(K·E) and loss (p−r)², the per-sample
// dLoss/dE = 2(p−r)·p(1−p)·ln10·K/400, and dE/dθ_mg = coeff·phase/24,
// dE/dθ_eg = coeff·(24−phase)/24.
func gradient(samples []Sample, θ []float64, k, lambda float64) []float64 {
	workers := runtime.NumCPU()
	chunk := (len(samples) + workers - 1) / workers
	partials := make([][]float64, workers)
	var wg sync.WaitGroup
	for wkr := 0; wkr < workers; wkr++ {
		lo, hi := wkr*chunk, min(wkr*chunk+chunk, len(samples))
		if lo >= hi {
			break
		}
		wg.Add(1)
		go func(wkr, lo, hi int) {
			defer wg.Done()
			g := make([]float64, len(θ))
			for i := lo; i < hi; i++ {
				tr := samples[i].Trace
				ph := float64(tr.Phase)
				e := scoreTrace(tr, θ)
				p := sigmoid(k, e)
				dLde := 2 * (p - target(samples[i], k, lambda)) * p * (1 - p) * ln10over400 * k
				for _, en := range tr.Entries {
					f := int(en.Feat)
					c := float64(en.Coeff)
					g[2*f] += dLde * c * ph / 24
					g[2*f+1] += dLde * c * (24 - ph) / 24
				}
			}
			partials[wkr] = g
		}(wkr, lo, hi)
	}
	wg.Wait()

	grad := make([]float64, len(θ))
	inv := 1.0 / float64(len(samples))
	for _, g := range partials {
		for j := range g {
			grad[j] += g[j] * inv
		}
	}
	return grad
}

// EmitGo renders a tuned θ as paste-ready Go literals for pesto_tables.go
// (mgPesto/egPesto) and eval.DefaultWeights (Weights).
func EmitGo(θ []float64) string {
	mgP, egP, w := eval.ParamsToTables(θ)
	var b strings.Builder
	b.WriteString("// --- paste into internal/eval/pesto_tables.go (mgValue/egValue unchanged) ---\n\n")
	b.WriteString(table("mgPesto", mgP))
	b.WriteString("\n")
	b.WriteString(table("egPesto", egP))
	b.WriteString("\n// --- paste into internal/eval/terms.go DefaultWeights() ---\n")
	b.WriteString(weightsLiteral(w))
	b.WriteString("\n")
	return b.String()
}

// EmitGoFile renders a tuned θ as a complete, compilable internal/eval source
// file (the tuned PSQT + weights), to overwrite tuned_tables.go via `--out`.
// `go build` then makes it live behind Config.UseTuned for SPRT.
func EmitGoFile(θ []float64) string {
	mgP, egP, w := eval.ParamsToTables(θ)
	var b strings.Builder
	b.WriteString("package eval\n\n")
	b.WriteString("// Code generated by `gomachine tune --out`; DO NOT EDIT.\n")
	b.WriteString("// Texel-tuned PSQT (positional; material added at init) + knowledge weights,\n")
	b.WriteString("// selected by Config.UseTuned. SPRT before relying on it (eval-fit ≠ Elo).\n\n")
	b.WriteString(table("tunedMgPesto", mgP))
	b.WriteString("\n")
	b.WriteString(table("tunedEgPesto", egP))
	b.WriteString("\nfunc tunedWeightsLiteral() *Weights {\n\t")
	b.WriteString(weightsLiteral(w))
	b.WriteString("\n}\n")
	return b.String()
}

// weightsLiteral formats a Weights as a compilable Go composite literal. Arrays
// must be rendered as [4]int{…} (not %v, which prints "[6 6 6 2]" — not valid Go).
func weightsLiteral(w *eval.Weights) string {
	return fmt.Sprintf(`return &Weights{
		MobMG:      %s,
		MobEG:      %s,
		IsolatedMG: %d, IsolatedEG: %d,
		DoubledMG: %d, DoubledEG: %d,
		PassedMG: %d, PassedEG: %d,
		BishopPairMG: %d, BishopPairEG: %d,
		KingShield: %d,
		KingProxEG: %d,
	}`, arr4(w.MobMG), arr4(w.MobEG), w.IsolatedMG, w.IsolatedEG, w.DoubledMG, w.DoubledEG,
		w.PassedMG, w.PassedEG, w.BishopPairMG, w.BishopPairEG, w.KingShield, w.KingProxEG)
}

func arr4(a [4]int) string {
	return fmt.Sprintf("[4]int{%d, %d, %d, %d}", a[0], a[1], a[2], a[3])
}

var pieceNames = [6]string{"Pawn", "Knight", "Bishop", "Rook", "Queen", "King"}

func table(name string, t [6][64]int) string {
	var b strings.Builder
	fmt.Fprintf(&b, "var %s = [6][64]int{\n", name)
	for pt := 0; pt < 6; pt++ {
		fmt.Fprintf(&b, "\t{ // %s\n", pieceNames[pt])
		for r := 0; r < 8; r++ {
			b.WriteString("\t\t")
			for f := 0; f < 8; f++ {
				fmt.Fprintf(&b, "%d, ", t[pt][r*8+f])
			}
			b.WriteString("\n")
		}
		b.WriteString("\t},\n")
	}
	b.WriteString("}\n")
	return b.String()
}
