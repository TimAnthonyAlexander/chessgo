package bench

import (
	"context"
	"fmt"
	"math"
	"math/rand"
	"os"
	"sync"
	"time"

	"github.com/timanthonyalexander/gomachine/internal/book"
	"github.com/timanthonyalexander/gomachine/internal/engine"
	"github.com/timanthonyalexander/gomachine/internal/search"
	"github.com/timanthonyalexander/gomachine/internal/syzygy"
)

// SPSA — Simultaneous Perturbation Stochastic Approximation tuning of the
// engine's INTEGER search-margin parameters by self-play. It reuses this package's
// game-playing machinery (player + playGame, the same reversed-color pair the SPRT
// harness uses) so there is exactly one game loop in the codebase.
//
// Each iteration draws a single Rademacher perturbation vector δ (±1 per param),
// forms two engines θ⁺ = clamp(round(θ + cₖ·δ)) and θ⁻ = clamp(round(θ − cₖ·δ)),
// plays a BATCH of game pairs θ⁺ vs θ⁻, and uses the match score to estimate the
// gradient of playing strength w.r.t. every param AT ONCE (that's the "simultaneous
// perturbation" trick — one match, N gradient components). θ is then nudged toward
// whichever perturbation played better. Over many noisy iterations θ random-walks
// uphill toward stronger margins.
//
// SCALE-CORRECT PER-PARAM VARIANT (deliberate, documented deviation from a naive
// single-global-cₖ SPSA): the tuned params live on wildly different scales
// (SingularMargin ∈ [1,6] vs SEEQuietMargin ∈ [50,300]). A single global step would
// barely move the wide-range params and thrash the narrow ones. So every param i
// carries its own perturbation scale CEnd (its "natural step", the SPSA c_end /
// perturbation floor) and BOTH its perturbation and its learning step are scaled by
// it — perturbation ∝ CEndᵢ, update step ∝ CEndᵢ (via the CEndᵢ² factor over the
// CEndᵢ in the gradient denominator). a and c stay GLOBAL knobs: a is the overall
// learning rate, c the exploration multiplier. This is the same relation Fishtest's
// SPSA uses (a ∝ c_end²). See RunSPSA for the exact recurrence.
//
// OBJECTIVE = MAXIMIZE θ⁺'s win score. (Note: the classic SPSA recurrence is written
// for MINIMIZING a loss with θ −= aₖ·ĝ; here we ascend a strength score, so the sign
// is flipped — θ moves TOWARD the better-scoring perturbation. Implemented directly
// as an ascent so the direction is unambiguous.)

// SPSAParam is one integer search.Params field under tuning.
type SPSAParam struct {
	Name    string  // canonical lowercase field name (see spsaFields)
	Min     int     // hard lower clamp
	Max     int     // hard upper clamp
	Initial int     // starting value (default = current DefaultParams value)
	CEnd    float64 // per-param perturbation scale / floor (the SPSA c_end, in param units; ≥1 so the int rounding always flips)
}

// SPSAConfig fully specifies an SPSA tuning run.
type SPSAConfig struct {
	Params []SPSAParam   // params to tune (≥1)
	Base   search.Params // engine config the tuned fields are written into (rest held fixed)

	Nodes    uint64        // fixed nodes per move (primary, reproducible objective)
	MoveTime time.Duration // per-move budget used only if Nodes == 0
	TTMB     int           // transposition table size per engine

	Concurrency  int // parallel game-pair workers per batch
	PairsPerIter int // game pairs played each iteration (the batch size)
	Iterations   int // number of SPSA steps

	A     float64 // SPSA learning-rate numerator (a)
	C     float64 // SPSA perturbation multiplier (c); per-param perturbation = max(c/k^γ, 1)·CEnd
	ABig  float64 // SPSA stability constant (A); 0 → 0.1·Iterations
	Alpha float64 // learning-rate decay exponent (0 → 0.602)
	Gamma float64 // perturbation decay exponent (0 → 0.101)

	Seed int64     // RNG seed (Rademacher draws + per-batch book shuffles); reproducible
	Book []Opening // opening positions; reshuffled per batch for variety

	EngineBook *book.Book        // shared opening book (inert unless a side has UseBook)
	Tablebase  *syzygy.Tablebase // shared Syzygy tablebase (inert unless a side has UseTablebase)

	Checkpoint string // if set, append per-iteration θ here (resumable/inspectable)
}

// SPSAIter is a per-iteration snapshot pushed to the reporter.
type SPSAIter struct {
	K          int       // iteration number (1-based)
	Theta      []float64 // continuous θ after this step
	ThetaInt   []int     // rounded, clamped θ (the engine-applied values)
	BatchScore float64   // θ⁺'s normalized score this batch, [0,1] (0.5 = even)
	AK, CK     float64   // the iteration's gains
	Elapsed    time.Duration
}

// SPSAResult is the converged outcome.
type SPSAResult struct {
	Params   []SPSAParam
	Theta    []float64
	ThetaInt []int
	Iters    int
	Final    search.Params // Base with the converged ints written in
}

// RunSPSA runs the tuning loop, invoking onIter after each iteration (and after the
// checkpoint append, so a kill never loses a recorded step). It returns the final θ.
func RunSPSA(ctx context.Context, cfg SPSAConfig, onIter func(SPSAIter)) SPSAResult {
	if cfg.Alpha == 0 {
		cfg.Alpha = 0.602
	}
	if cfg.Gamma == 0 {
		cfg.Gamma = 0.101
	}
	if cfg.ABig == 0 {
		cfg.ABig = 0.1 * float64(cfg.Iterations)
	}
	if cfg.Concurrency < 1 {
		cfg.Concurrency = 1
	}
	if cfg.PairsPerIter < 1 {
		cfg.PairsPerIter = 1
	}

	rng := rand.New(rand.NewSource(cfg.Seed))
	n := len(cfg.Params)

	theta := make([]float64, n)
	for i, p := range cfg.Params {
		theta[i] = float64(p.Initial)
	}

	cp := openCheckpoint(cfg)
	if cp != nil {
		defer cp.Close()
	}

	delta := make([]float64, n)
	pert := make([]float64, n)
	plusTheta := make([]float64, n)
	minusTheta := make([]float64, n)
	start := time.Now()

	res := SPSAResult{Params: cfg.Params, Theta: theta}

iterate:
	for k := 1; k <= cfg.Iterations; k++ {
		select {
		case <-ctx.Done():
			break iterate
		default:
		}

		ak := cfg.A / math.Pow(float64(k)+cfg.ABig, cfg.Alpha)
		ck := cfg.C / math.Pow(float64(k), cfg.Gamma)

		for i, p := range cfg.Params {
			if rng.Intn(2) == 0 {
				delta[i] = -1
			} else {
				delta[i] = 1
			}
			// Perturbation in param-i units, floored at CEnd so the int rounding
			// always flips the value (else the gradient component would be 0/undef).
			pert[i] = math.Max(ck, 1.0) * p.CEnd
			plusTheta[i] = clampF(math.Round(theta[i]+pert[i]*delta[i]), p.Min, p.Max)
			minusTheta[i] = clampF(math.Round(theta[i]-pert[i]*delta[i]), p.Min, p.Max)
		}

		plusP := applyTheta(cfg.Base, cfg.Params, plusTheta)
		minusP := applyTheta(cfg.Base, cfg.Params, minusTheta)

		// Distinct book shuffle per batch for variety (deterministic from Seed).
		b := append([]Opening(nil), cfg.Book...)
		rng.Shuffle(len(b), func(i, j int) { b[i], b[j] = b[j], b[i] })

		s := playMatch(ctx, cfg, plusP, minusP, b) // θ⁺'s normalized score, [0,1]
		g := 2*s - 1                               // θ⁺'s advantage, [-1,1]

		for i, p := range cfg.Params {
			// Ascent: ∂score/∂θ_i ≈ g·δ_i/(2·pertᵢ) (δ_i=±1 ⇒ 1/δ_i=δ_i). The CEndᵢ²
			// factor rescales the step into param-i units (Fishtest's a ∝ c_end²), so a
			// single global a moves every param a CEndᵢ-proportional amount.
			grad := g * delta[i] / (2 * pert[i])
			theta[i] += ak * p.CEnd * p.CEnd * grad
			theta[i] = clampF(theta[i], p.Min, p.Max)
		}

		thetaInt := roundClampAll(theta, cfg.Params)
		it := SPSAIter{
			K: k, Theta: append([]float64(nil), theta...), ThetaInt: thetaInt,
			BatchScore: s, AK: ak, CK: ck, Elapsed: time.Since(start),
		}
		appendCheckpoint(cp, cfg, it)
		if onIter != nil {
			onIter(it)
		}
		res.Iters = k
	}

	res.Theta = theta
	res.ThetaInt = roundClampAll(theta, cfg.Params)
	res.Final = applyTheta(cfg.Base, cfg.Params, theta)
	return res
}

// playMatch plays PairsPerIter reversed-color game pairs of plus vs minus and
// returns plus's normalized score in [0,1] (0.5 = dead even). It reuses player +
// playGame, the SPRT harness's exact game loop. Engines are built fresh here because
// the params are baked in at construction (cheap vs the games themselves).
func playMatch(ctx context.Context, cfg SPSAConfig, plus, minus search.Params, b []Opening) float64 {
	lim := spsaLimits(cfg)
	jobs := make(chan Opening)
	type pairOut struct{ score float64 } // plus's pair score, [0,2]
	results := make(chan pairOut, cfg.Concurrency)

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	var wg sync.WaitGroup
	for w := 0; w < cfg.Concurrency; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			plusP := player{eng: engine.NewWithParams(cfg.TTMB, plus), threads: 1, lim: lim, level: -1}
			minusP := player{eng: engine.NewWithParams(cfg.TTMB, minus), threads: 1, lim: lim, level: -1}
			plusP.eng.SetBook(cfg.EngineBook)
			minusP.eng.SetBook(cfg.EngineBook)
			plusP.eng.SetTablebase(cfg.Tablebase)
			minusP.eng.SetTablebase(cfg.Tablebase)
			for open := range jobs {
				r1 := playGame(ctx, plusP, minusP, open.FEN)
				r2 := playGame(ctx, minusP, plusP, open.FEN)
				score := float64(r1) + (1 - float64(r2)) // plus's score across the pair
				select {
				case results <- pairOut{score: score}:
				case <-ctx.Done():
					return
				}
			}
		}()
	}

	go func() {
		defer close(jobs)
		nb := len(b)
		if nb == 0 {
			return
		}
		for i := 0; i < cfg.PairsPerIter; i++ {
			select {
			case jobs <- b[i%nb]:
			case <-ctx.Done():
				return
			}
		}
	}()

	var total float64
	got := 0
	for i := 0; i < cfg.PairsPerIter; i++ {
		select {
		case out := <-results:
			total += out.score
			got++
		case <-ctx.Done():
			i = cfg.PairsPerIter // stop waiting; workers drain on cancel
		}
	}
	cancel()
	wg.Wait()

	if got == 0 {
		return 0.5
	}
	return total / float64(got) / 2.0
}

func spsaLimits(cfg SPSAConfig) search.Limits {
	if cfg.Nodes > 0 {
		return search.Limits{Nodes: cfg.Nodes}
	}
	return search.Limits{MoveTime: cfg.MoveTime}
}

// applyTheta writes the (rounded, clamped) θ into a copy of base, leaving every
// other field untouched.
func applyTheta(base search.Params, params []SPSAParam, theta []float64) search.Params {
	p := base
	for i, sp := range params {
		v := int(clampF(math.Round(theta[i]), sp.Min, sp.Max))
		if f, ok := spsaFields[sp.Name]; ok {
			f.apply(&p, v)
		}
	}
	return p
}

func roundClampAll(theta []float64, params []SPSAParam) []int {
	out := make([]int, len(theta))
	for i, sp := range params {
		out[i] = int(clampF(math.Round(theta[i]), sp.Min, sp.Max))
	}
	return out
}

func clampF(v float64, lo, hi int) float64 {
	if v < float64(lo) {
		return float64(lo)
	}
	if v > float64(hi) {
		return float64(hi)
	}
	return v
}

func openCheckpoint(cfg SPSAConfig) *os.File {
	if cfg.Checkpoint == "" {
		return nil
	}
	f, err := os.OpenFile(cfg.Checkpoint, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		fmt.Fprintf(os.Stderr, "spsa: cannot open checkpoint %q: %v (continuing without)\n", cfg.Checkpoint, err)
		return nil
	}
	fmt.Fprintf(f, "# SPSA start %s  iters=%d pairs/iter=%d a=%g c=%g A=%g alpha=%g gamma=%g\n",
		time.Now().Format(time.RFC3339), cfg.Iterations, cfg.PairsPerIter,
		cfg.A, cfg.C, cfg.ABig, cfg.Alpha, cfg.Gamma)
	line := "# k\tscore\tak\tck"
	for _, p := range cfg.Params {
		line += "\t" + p.Name
	}
	fmt.Fprintln(f, line)
	return f
}

func appendCheckpoint(cp *os.File, cfg SPSAConfig, it SPSAIter) {
	if cp == nil {
		return
	}
	line := fmt.Sprintf("%d\t%.4f\t%.5f\t%.4f", it.K, it.BatchScore, it.AK, it.CK)
	for _, v := range it.ThetaInt {
		line += fmt.Sprintf("\t%d", v)
	}
	fmt.Fprintln(cp, line)
	_ = cp.Sync() // flush so a kill keeps every recorded step
}
