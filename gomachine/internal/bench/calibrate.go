package bench

import (
	"context"
	"fmt"
	"time"

	"github.com/timanthonyalexander/gomachine/internal/search"
)

// LevelElo is a calibrated absolute Elo for one difficulty level.
type LevelElo struct {
	Level int
	Elo   float64 // absolute, anchored to full-strength @ anchor movetime
	Delta float64 // Elo gained over the level below (0 for level 0)
	Err   float64 // 95% error on this rung's delta measurement
}

// Calibrate measures the absolute Elo of difficulty levels 0..maxLevel.
//
// Method (self-play ladder, anchored once): adjacent levels k and k+1 play a
// fixed-length match. Neighbours are close in strength, so each match scores near
// 50% → low-variance, reliable Elo deltas. The deltas accumulate into a RELATIVE
// ladder; then one ANCHOR match — full strength @ anchorMoveTime (whose absolute
// Elo `anchorElo` we know from the Stockfish anchor) versus the top level — pins
// the whole ladder to absolute Elo. This needs Stockfish only once, not per rung.
func Calibrate(ctx context.Context, book []Opening, maxLevel, pairs, conc, ttMB int,
	anchorElo float64, anchorMoveTime time.Duration, log func(string)) []LevelElo {

	run := func(label string, newLevel, oldLevel int, anchorSide bool) (float64, float64) {
		cfg := Config{
			NewParams: search.DefaultParams(), OldParams: search.DefaultParams(),
			NewName: label, OldName: "",
			TTMB: ttMB, Concurrency: conc, MaxPairs: pairs, Book: book,
			Elo0: -10000, Elo1: 10000, Alpha: 0.05, Beta: 0.05, // never trips → plays all pairs
			NewThreads: 1, OldThreads: 1,
			NewLevel: newLevel, OldLevel: oldLevel,
		}
		if anchorSide {
			cfg.NewLevel = -1                // new side = full strength
			cfg.NewMoveTime = anchorMoveTime // at the anchor's time control
		}
		last := time.Now()
		s := RunSPRT(ctx, cfg, func(p Progress) {
			if log != nil && time.Since(last) > 5*time.Second {
				last = time.Now()
				log(fmt.Sprintf("  %s: %d pairs  Elo %+.0f ± %.0f", label, p.Pairs, p.Elo, p.Err95))
			}
		})
		return s.Elo, s.Err95
	}

	// 1. Relative ladder from adjacent matches: delta[k] = Elo(k+1) − Elo(k).
	rel := make([]float64, maxLevel+1) // rel[0] = 0
	deltas := make([]float64, maxLevel+1)
	errs := make([]float64, maxLevel+1)
	for k := 0; k < maxLevel; k++ {
		if log != nil {
			log(fmt.Sprintf("ladder: level %d vs %d…", k+1, k))
		}
		d, e := run(fmt.Sprintf("L%d>L%d", k+1, k), k+1, k, false)
		deltas[k+1], errs[k+1] = d, e
		rel[k+1] = rel[k] + d
	}

	// 2. Anchor: full strength @ anchorMoveTime vs the top level. The advantage
	//    a = anchorElo − Elo(maxLevel) pins the top rung's absolute Elo.
	if log != nil {
		log(fmt.Sprintf("anchor: full-strength @ %s vs level %d…", anchorMoveTime, maxLevel))
	}
	a, _ := run("anchor", -1, maxLevel, true)
	topElo := anchorElo - a

	// 3. Absolute Elo: shift the relative ladder so the top rung sits at topElo.
	out := make([]LevelElo, maxLevel+1)
	for k := 0; k <= maxLevel; k++ {
		out[k] = LevelElo{
			Level: k,
			Elo:   topElo + (rel[k] - rel[maxLevel]),
			Delta: deltas[k],
			Err:   errs[k],
		}
	}
	return out
}
