// Package bench is the engine strength feedback loop: native, in-process
// self-play SPRT (sequential probability ratio test). Two configurations of the
// SAME engine binary play game pairs (reversed colors from a shared opening)
// against each other; the perft-verified rules core (internal/chess +
// engine.Adjudicate) is the in-process arbiter — no UCI, no subprocesses. Games
// run at fixed nodes so results are reproducible and hardware-independent.
//
// This file is the statistics: the pentanomial GSPRT. Getting it wrong gives
// false confidence in patches, so it is small, documented, and unit-tested.
package bench

import "math"

// Pentanomial outcome buckets. Each *pair* of games (A-white then A-black from
// the same opening) yields a score for the patch ("A") in {0, ½, 1, 1½, 2},
// normalized to {0, .25, .5, .75, 1}. The five buckets, in order:
//
//	LL  (0)   loss+loss
//	LDg (.25) one loss, one draw
//	DD  (.5)  draw+draw, or win+loss  (the "central" bucket)
//	WD  (.75) one win, one draw
//	WW  (1)   win+win
//
// Pairing reversed colors over a shared opening makes the two games in a pair
// negatively correlated in the draw-heavy regime, so the pentanomial model has
// lower variance than win/draw/loss trinomial on the same number of games — it
// converges faster. (Van den Bergh; the pentanomial/GSPRT standard.)
type Pentanomial [5]int

// pairValues are the normalized pair scores for each bucket.
var pairValues = [5]float64{0, 0.25, 0.5, 0.75, 1}

// Add records one finished pair given the patch's total score over the two games
// (0, 0.5, 1.0, 1.5, or 2.0).
func (p *Pentanomial) Add(pairScore float64) {
	idx := int(math.Round(pairScore * 2)) // 0,0.5,1,1.5,2 → 0..4 (×2 then round)
	if idx < 0 {
		idx = 0
	}
	if idx > 4 {
		idx = 4
	}
	p[idx]++
}

// Pairs returns the number of recorded pairs.
func (p Pentanomial) Pairs() int {
	n := 0
	for _, c := range p {
		n += c
	}
	return n
}

// EloToScore maps a logistic Elo difference to an expected score in (0,1).
func EloToScore(elo float64) float64 { return 1 / (1 + math.Pow(10, -elo/400)) }

// ScoreToElo is the inverse: an expected score in (0,1) to a logistic Elo diff.
func ScoreToElo(score float64) float64 {
	if score <= 0 {
		return math.Inf(-1)
	}
	if score >= 1 {
		return math.Inf(1)
	}
	return -400 * math.Log10(1/score-1)
}

// priorPairs is the strength (in pseudo-pairs) of the regularizing prior, and
// priorPDF its shape over the five buckets. Without it, a tiny or single-bucket
// sample has zero empirical variance, which makes the LLR explode and the SPRT
// "decide" after one pair. The prior is a slightly draw-weighted, symmetric
// distribution (mean ½, so it favors neither hypothesis); it keeps the variance
// estimate positive and washes out after ~100 real pairs. (This is the standard
// regularization of the pentanomial GSPRT.)
const priorPairs = 2.0

var priorPDF = [5]float64{0.1, 0.2, 0.4, 0.2, 0.1}

// meanVar returns the per-pair mean and variance of the normalized pair score
// (regularized by the prior), plus the EFFECTIVE pair count used as the evidence
// weight. Real pair count is Pairs(); this includes the prior pseudo-pairs.
func (p Pentanomial) meanVar() (mu, variance, nEff float64) {
	var eff [5]float64
	for i := range eff {
		eff[i] = float64(p[i]) + priorPairs*priorPDF[i]
		nEff += eff[i]
	}
	if nEff == 0 {
		return 0, 0, 0
	}
	for i := range eff {
		mu += eff[i] * pairValues[i]
	}
	mu /= nEff
	for i := range eff {
		d := pairValues[i] - mu
		variance += eff[i] * d * d
	}
	variance /= nEff
	if variance < 1e-9 {
		variance = 1e-9
	}
	return mu, variance, nEff
}

// LLR returns the log-likelihood ratio of H1 (true Elo ≥ elo1) over H0 (true Elo
// ≤ elo0), using the quadratic / normal-approximation GSPRT — the same estimator
// cutechess-cli used for years, here on the pentanomial pair distribution.
//
// The normalized pair score has expectation equal to the per-game expected
// score, so the per-game logistic targets s0,s1 apply directly to the per-pair
// mean. A positive LLR favors the patch; the caller compares it to the Wald
// bounds (see Bounds) to accept H1, accept H0, or keep playing.
//
// (The "exact" empirical-likelihood GSPRT of Van den Bergh tilts the MLE
// distribution per hypothesis; the quadratic form here is its 2nd-order Taylor
// expansion and matches it closely in the relevant regime. Documented so a future
// upgrade is a known, isolated change.)
func (p Pentanomial) LLR(elo0, elo1 float64) float64 {
	mu, variance, nEff := p.meanVar()
	if nEff == 0 {
		return 0
	}
	s0 := EloToScore(elo0)
	s1 := EloToScore(elo1)
	return nEff * (s1 - s0) * (2*mu - s0 - s1) / (2 * variance)
}

// Elo returns the point estimate and 95% half-width of the patch's Elo, via the
// delta method on the per-pair mean. Half-width is NaN until there is signal.
func (p Pentanomial) Elo() (elo, err95 float64) {
	mu, variance, nEff := p.meanVar()
	if nEff == 0 || mu <= 0 || mu >= 1 {
		return ScoreToElo(mu), math.NaN()
	}
	elo = ScoreToElo(mu)
	seMu := math.Sqrt(variance / nEff)
	// d(elo)/d(mu) for elo = -400·log10(1/mu - 1).
	dEloDMu := 400 / (math.Ln10 * mu * (1 - mu))
	err95 = 1.959963985 * dEloDMu * seMu
	return elo, err95
}

// Decision is the verdict of an SPRT at a given LLR against the Wald bounds.
type Decision int

const (
	Continue Decision = iota // LLR is between the bounds: keep playing
	AcceptH1                 // LLR ≥ upper bound: the patch is an improvement
	AcceptH0                 // LLR ≤ lower bound: the patch is not an improvement
)

func (d Decision) String() string {
	switch d {
	case AcceptH1:
		return "H1 accepted — patch is an improvement"
	case AcceptH0:
		return "H0 accepted — patch is not an improvement"
	default:
		return "inconclusive"
	}
}

// Bounds returns the Wald decision boundaries (lower, upper) for error rates
// alpha (false accept of H1) and beta (false accept of H0). With α=β=0.05 these
// are ≈ ±2.944.
func Bounds(alpha, beta float64) (lower, upper float64) {
	upper = math.Log((1 - beta) / alpha)
	lower = math.Log(beta / (1 - alpha))
	return lower, upper
}

// MinPairs is the smallest sample on which the SPRT is allowed to decide. The
// prior already tames small-sample variance, but a hard floor guarantees we never
// stop on a handful of games regardless.
const MinPairs = 16

// Decide returns the SPRT verdict for the current pentanomial sample.
func (p Pentanomial) Decide(elo0, elo1, alpha, beta float64) Decision {
	if p.Pairs() < MinPairs {
		return Continue
	}
	llr := p.LLR(elo0, elo1)
	lower, upper := Bounds(alpha, beta)
	switch {
	case llr >= upper:
		return AcceptH1
	case llr <= lower:
		return AcceptH0
	default:
		return Continue
	}
}
