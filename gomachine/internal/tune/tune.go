// Package tune implements Texel tuning of the evaluation's knowledge-term
// weights (internal/eval Weights). It generates labeled positions by self-play
// and optimizes the weights to minimize the mean-squared error between the
// engine's sigmoided eval and a target — either the game RESULT (classic Texel)
// or STOCKFISH's eval of the position (knowledge distillation). The result is a
// tuned Weights printed as a Go literal to paste into DefaultWeights.
package tune

import (
	"fmt"
	"math"
	"math/rand"
	"runtime"
	"sync"

	"github.com/timanthonyalexander/gomachine/internal/bench"
	"github.com/timanthonyalexander/gomachine/internal/chess"
	"github.com/timanthonyalexander/gomachine/internal/engine"
	"github.com/timanthonyalexander/gomachine/internal/eval"
	"github.com/timanthonyalexander/gomachine/internal/search"
)

// Sample is one labeled position. Result is the game outcome and SFcp the
// Stockfish eval, both from the position's SIDE-TO-MOVE perspective.
type Sample struct {
	Pos    *chess.Position
	Result float64 // {0, 0.5, 1}
	SFcp   int     // stockfish centipawns (only set when distilling)
}

// allTerms is the eval config with every knowledge term enabled, used for tuning
// (we tune the weights of the full eval).
func allTerms(w *eval.Weights) eval.Config {
	return eval.Config{Mobility: true, Pawns: true, KingSafety: true, BishopPair: true, W: w}
}

// GenerateSelfPlay plays nGames self-play games (our engine, fixed nodes, with
// 10% random moves for diversity) and returns quiet labeled positions.
func GenerateSelfPlay(openings []bench.Opening, nGames, nodes int, seed int64) []Sample {
	rng := rand.New(rand.NewSource(seed))
	eng := engine.New(64)
	var out []Sample

	for g := 0; g < nGames; g++ {
		eng.NewGame()
		open := openings[rng.Intn(len(openings))]
		pos, err := chess.ParseFEN(open.FEN)
		if err != nil {
			continue
		}
		var history []uint64
		var snaps []*chess.Position
		result := 0.5
		decided := false

		for ply := 0; ply < 400; ply++ {
			st := engine.Adjudicate(pos, history)
			if st.State != "ongoing" {
				result = whiteScore(st.Result)
				decided = true
				break
			}
			if has(st.ClaimableDraws, "threefold") || has(st.ClaimableDraws, "fifty") {
				result, decided = 0.5, true
				break
			}
			if ply >= 4 && !pos.InCheck() { // record quiet, non-opening positions
				snap := *pos
				snaps = append(snaps, &snap)
			}
			var m chess.Move
			if rng.Float64() < 0.10 {
				m = randomLegal(pos, rng)
			} else {
				m = eng.Play(pos, search.Limits{Nodes: uint64(nodes)}, history).Move
			}
			if m == chess.NullMove {
				break
			}
			history = append(history, pos.Key())
			var u chess.Undo
			pos.DoMove(m, &u)
		}
		if !decided {
			continue // unfinished game → don't trust the label
		}
		for _, p := range snaps {
			label := result
			if p.SideToMove() == chess.Black {
				label = 1 - result
			}
			out = append(out, Sample{Pos: p, Result: label})
		}
	}
	return out
}

// LabelStockfish fills each sample's SFcp with Stockfish's eval (side-to-move cp)
// at the given depth, using `workers` parallel Stockfish processes.
func LabelStockfish(samples []Sample, sfPath string, depth, workers int) error {
	if workers < 1 {
		workers = 1
	}
	budget := bench.UCIBudget{Depth: depth}
	var wg sync.WaitGroup
	errCh := make(chan error, workers)
	chunk := (len(samples) + workers - 1) / workers
	for w := 0; w < workers; w++ {
		lo := w * chunk
		hi := lo + chunk
		if hi > len(samples) {
			hi = len(samples)
		}
		if lo >= hi {
			break
		}
		wg.Add(1)
		go func(lo, hi int) {
			defer wg.Done()
			sf, err := bench.StartUCI(sfPath, map[string]string{})
			if err != nil {
				errCh <- err
				return
			}
			defer sf.Close()
			for i := lo; i < hi; i++ {
				cp, err := sf.Evaluate(samples[i].Pos.FEN(), nil, budget)
				if err != nil {
					errCh <- err
					return
				}
				samples[i].SFcp = cp
			}
		}(lo, hi)
	}
	wg.Wait()
	select {
	case err := <-errCh:
		return err
	default:
		return nil
	}
}

func sigmoid(k, cp float64) float64 {
	return 1.0 / (1.0 + math.Pow(10, -k*cp/400))
}

// mse returns the mean-squared error of the eval (with weights w, scale k)
// against the chosen target over all samples, computed in parallel.
func mse(samples []Sample, w *eval.Weights, k float64, distill bool) float64 {
	cfg := allTerms(w)
	workers := runtime.NumCPU()
	chunk := (len(samples) + workers - 1) / workers
	sums := make([]float64, workers)
	var wg sync.WaitGroup
	for wkr := 0; wkr < workers; wkr++ {
		lo := wkr * chunk
		hi := lo + chunk
		if hi > len(samples) {
			hi = len(samples)
		}
		if lo >= hi {
			break
		}
		wg.Add(1)
		go func(wkr, lo, hi int) {
			defer wg.Done()
			var s float64
			for i := lo; i < hi; i++ {
				e := float64(eval.Evaluate(samples[i].Pos, cfg))
				p := sigmoid(k, e)
				t := samples[i].Result
				if distill {
					t = sigmoid(k, float64(samples[i].SFcp))
				}
				d := p - t
				s += d * d
			}
			sums[wkr] = s
		}(wkr, lo, hi)
	}
	wg.Wait()
	total := 0.0
	for _, s := range sums {
		total += s
	}
	return total / float64(len(samples))
}

// MSE is the exported mean-squared error (for reporting the starting error).
func MSE(samples []Sample, w *eval.Weights, k float64, distill bool) float64 {
	return mse(samples, w, k, distill)
}

// FitK scans for the sigmoid scale k that minimizes the result-MSE with the given
// weights (the standard pre-step before tuning the weights).
func FitK(samples []Sample, w *eval.Weights) float64 {
	bestK, bestE := 1.0, math.Inf(1)
	for k := 0.20; k <= 2.0; k += 0.05 {
		if e := mse(samples, w, k, false); e < bestE {
			bestE, bestK = e, k
		}
	}
	return bestK
}

// Optimize runs coordinate-descent (±1 per weight) until no single step lowers
// the MSE, or maxPasses is reached. Returns the final MSE.
func Optimize(samples []Sample, w *eval.Weights, k float64, distill bool, maxPasses int, log func(string)) float64 {
	best := mse(samples, w, k, distill)
	params := w.Tunables()
	for pass := 0; pass < maxPasses; pass++ {
		improved := false
		for _, p := range params {
			for _, d := range []int{1, -1} {
				*p += d
				if e := mse(samples, w, k, distill); e < best-1e-12 {
					best = e
					improved = true
				} else {
					*p -= d // revert
				}
			}
		}
		if log != nil {
			log(fmt.Sprintf("pass %d: MSE %.6f", pass+1, best))
		}
		if !improved {
			break
		}
	}
	return best
}

// GoLiteral formats w as a DefaultWeights()-style Go literal.
func GoLiteral(w *eval.Weights) string {
	return fmt.Sprintf(`&Weights{
	MobMG:      %v,
	MobEG:      %v,
	IsolatedMG: %d, IsolatedEG: %d,
	DoubledMG: %d, DoubledEG: %d,
	PassedMG: %d, PassedEG: %d,
	BishopPairMG: %d, BishopPairEG: %d,
	KingShield: %d,
}`, w.MobMG, w.MobEG, w.IsolatedMG, w.IsolatedEG, w.DoubledMG, w.DoubledEG,
		w.PassedMG, w.PassedEG, w.BishopPairMG, w.BishopPairEG, w.KingShield)
}

func randomLegal(pos *chess.Position, rng *rand.Rand) chess.Move {
	var ml chess.MoveList
	pos.GenerateLegal(&ml)
	if ml.Len() == 0 {
		return chess.NullMove
	}
	return ml.Get(rng.Intn(ml.Len()))
}

func whiteScore(result string) float64 {
	switch result {
	case "1-0":
		return 1
	case "0-1":
		return 0
	default:
		return 0.5
	}
}

func has(s []string, v string) bool {
	for _, x := range s {
		if x == v {
			return true
		}
	}
	return false
}
