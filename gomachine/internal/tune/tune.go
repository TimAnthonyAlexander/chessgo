// Package tune implements Texel tuning of the evaluation as a single linear
// model. It generates QUIET, WDL-labelled positions by self-play, traces each
// into eval coefficients (eval.EvalTrace), and fits the FULL weight vector —
// PSQT/material AND the knowledge terms, jointly — by gradient descent (Adam) to
// minimise the MSE between sigmoid(K·E) and the game result.
//
// This replaces the previous coordinate-descent-over-bolt-on-scalars tuner,
// which left the PSQT frozen and accepted on MSE alone — the configuration that
// SPRT-rejected at −148 Elo (docs/ENGINE_STRENGTH.md §6). The new tuner follows
// the community-consensus recipe (Österlund / Grant): joint gradient descent,
// WDL target, frozen K, quiet positions only. Every candidate it produces is
// still SPRT-gated before shipping — MSE only proposes.
package tune

import (
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

// Sample is one quiet position, stored as its weight-independent coefficient
// trace. Result is the GAME outcome in White's perspective ({0, 0.5, 1}); the
// trace is also White-perspective, so no per-sample flip. SoftCp is an optional
// strong-eval label (our own search score here, White cp) used by the WDL+eval
// blend target (--lambda) to counter the label-smearing that flips small-term
// signs under pure WDL (docs/ENGINE_STRENGTH.md §6); HasSoft gates it.
type Sample struct {
	Trace   eval.Trace
	Result  float64
	SoftCp  float64
	HasSoft bool
}

// GenerateSelfPlay plays nGames self-play games (our engine, fixed nodes, with
// ~10% random moves for diversity) and returns quiet, non-opening positions
// traced into eval coefficients and labelled with the game result.
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
		var softs []float64
		var hasSoft []bool
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
			// Pick the move; a searched move yields the position's eval for free
			// (the soft label), a random move (for diversity) does not.
			var m chess.Move
			softCp, searched := 0.0, false
			if rng.Float64() < 0.10 {
				m = randomLegal(pos, rng)
			} else {
				res := eng.Play(pos, search.Limits{Nodes: uint64(nodes)}, history)
				m, softCp, searched = res.Move, float64(res.Score), true
				if pos.SideToMove() == chess.Black {
					softCp = -softCp // store White-perspective cp
				}
			}
			if m == chess.NullMove {
				break
			}
			// Record past the opening, only genuinely quiet positions.
			if ply >= 8 && isQuiet(pos) {
				snap := *pos
				snaps = append(snaps, &snap)
				softs = append(softs, softCp)
				hasSoft = append(hasSoft, searched)
			}
			history = append(history, pos.Key())
			var u chess.Undo
			pos.DoMove(m, &u)
		}
		if !decided {
			continue // unfinished game → don't trust the label
		}
		for i, p := range snaps {
			out = append(out, Sample{
				Trace: eval.EvalTrace(p), Result: result,
				SoftCp: softs[i], HasSoft: hasSoft[i],
			})
		}
	}
	return out
}

// isQuiet reports whether pos is tactically calm enough to label: the side to
// move is not in check and has no capture that wins material by SEE. This keeps
// the regression off positions whose static eval the engine would never trust
// (the most common cause of a tuned eval underperforming).
func isQuiet(pos *chess.Position) bool {
	if pos.InCheck() {
		return false
	}
	var ml chess.MoveList
	pos.GenerateLegal(&ml)
	occ := pos.Occupied()
	for i := 0; i < ml.Len(); i++ {
		m := ml.Get(i)
		capture := m.Type() == chess.EnPassant || occ&m.To().BB() != 0
		if capture && pos.SEE(m) > 0 {
			return false
		}
	}
	return true
}

func sigmoid(k, cp float64) float64 {
	return 1.0 / (1.0 + math.Pow(10, -k*cp/400))
}

// target returns the regression target for a sample under the WDL+eval blend:
// lambda·result + (1−lambda)·sigmoid(K·softEval). lambda=1 (or no soft label) is
// pure WDL; lambda=0 is pure self-distillation onto our own search eval.
func target(s Sample, k, lambda float64) float64 {
	if lambda >= 1 || !s.HasSoft {
		return s.Result
	}
	return lambda*s.Result + (1-lambda)*sigmoid(k, s.SoftCp)
}

// scoreTrace evaluates a trace against θ in White centipawns (the linear model).
func scoreTrace(tr eval.Trace, θ []float64) float64 {
	ph := float64(tr.Phase)
	var e float64
	for _, en := range tr.Entries {
		f := int(en.Feat)
		e += float64(en.Coeff) * (ph*θ[2*f] + (24-ph)*θ[2*f+1]) / 24
	}
	return e
}

// MSE returns the mean-squared error of sigmoid(K·E) against the (blended)
// target, computed in parallel across samples.
func MSE(samples []Sample, θ []float64, k, lambda float64) float64 {
	workers := runtime.NumCPU()
	chunk := (len(samples) + workers - 1) / workers
	sums := make([]float64, workers)
	var wg sync.WaitGroup
	for wkr := 0; wkr < workers; wkr++ {
		lo, hi := wkr*chunk, min(wkr*chunk+chunk, len(samples))
		if lo >= hi {
			break
		}
		wg.Add(1)
		go func(wkr, lo, hi int) {
			defer wg.Done()
			var s float64
			for i := lo; i < hi; i++ {
				d := sigmoid(k, scoreTrace(samples[i].Trace, θ)) - target(samples[i], k, lambda)
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

// FitK scans for the sigmoid scale k that minimises the pure-WDL MSE at the given
// weights — computed once on the starting weights and then frozen, per Texel's
// method. K is fit to the game result (lambda=1) so the cp↔win-prob calibration
// is anchored to outcomes, independent of the blend.
func FitK(samples []Sample, θ []float64) float64 {
	bestK, bestE := 1.0, math.Inf(1)
	for k := 0.20; k <= 2.0; k += 0.02 {
		if e := MSE(samples, θ, k, 1.0); e < bestE {
			bestE, bestK = e, k
		}
	}
	return bestK
}

// PieceMeans returns the mean (mg, eg) value across the 64 PSQT squares of each
// piece type — a proxy for that piece's material value, for watching drift while
// material floats during tuning (anchored only by frozen K + decay).
func PieceMeans(θ []float64) [6][2]float64 {
	var out [6][2]float64
	for pt := 0; pt < 6; pt++ {
		var mg, eg float64
		for pidx := 0; pidx < 64; pidx++ {
			f := pt*64 + pidx
			mg += θ[2*f]
			eg += θ[2*f+1]
		}
		out[pt] = [2]float64{mg / 64, eg / 64}
	}
	return out
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
