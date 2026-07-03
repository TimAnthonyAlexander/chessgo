package search

import "time"

// timeManager computes adaptive soft/hard time limits from a game clock and
// tracks best-move stability across iterations to decide whether to extend or
// shorten the allocated time. The soft limit gates "should I start the next
// iteration?"; the hard limit is the absolute cutoff checked mid-search.
//
// When Limits carries only MoveTime (no clock), soft==hard==MoveTime (legacy).
type timeManager struct {
	softLimit time.Time
	hardLimit time.Time

	// Best-move stability: how many consecutive completed iterations kept the
	// same best move. A stable move lets the engine stop early (before the soft
	// limit); an unstable move extends the soft limit toward the hard limit.
	bestMove     uint32 // encoded best move from the last completed iteration
	stability    int    // consecutive iterations with the same best move
	softDuration time.Duration
	hardDuration time.Duration
	start        time.Time
}

// tmFromLimits builds a timeManager for a search. If clock info is present
// (TimeLeft>0), it computes adaptive soft/hard limits; otherwise it falls back
// to the legacy flat-MoveTime behaviour.
func tmFromLimits(limits Limits) timeManager {
	now := time.Now()
	tm := timeManager{start: now}

	if limits.TimeLeft > 0 {
		remaining := limits.TimeLeft
		inc := limits.Increment

		// Moves-to-go: if given (e.g. X/40 time controls), plan for that many
		// moves; otherwise assume ~25 moves remaining (typical mid-game).
		mtg := limits.MovesToGo
		if mtg <= 0 {
			mtg = 25
		}
		if mtg > 50 {
			mtg = 50
		}

		// Base time = remaining / mtg + 75% of increment. The 75% (not 100%)
		// leaves a buffer so we don't flag on increment alone.
		base := remaining / time.Duration(mtg)
		base += inc * 3 / 4

		// Soft limit: the base allocation. The engine will stop after finishing
		// an iteration if soft has elapsed (unless the best move is unstable).
		// Hard limit: 3× base, capped at 50% of remaining time. This is the
		// absolute cutoff — the engine will abort mid-search if hard is hit.
		soft := base
		hard := base * 3
		maxHard := remaining / 2
		if hard > maxHard {
			hard = maxHard
		}
		// Never let soft exceed hard.
		if soft > hard {
			soft = hard
		}

		// Floor: at least 10ms soft, 20ms hard (avoid zero-time searches).
		if soft < 10*time.Millisecond {
			soft = 10 * time.Millisecond
		}
		if hard < 20*time.Millisecond {
			hard = 20 * time.Millisecond
		}

		tm.softDuration = soft
		tm.hardDuration = hard
		tm.softLimit = now.Add(soft)
		tm.hardLimit = now.Add(hard)
	} else if limits.MoveTime > 0 {
		// Legacy: flat movetime, no stability scaling.
		tm.softDuration = limits.MoveTime
		tm.hardDuration = limits.MoveTime
		tm.softLimit = now.Add(limits.MoveTime)
		tm.hardLimit = now.Add(limits.MoveTime)
	}
	return tm
}

// softExpired reports whether the soft limit has been reached.
func (tm *timeManager) softExpired() bool {
	return !tm.softLimit.IsZero() && time.Now().After(tm.softLimit)
}

// hardExpired reports whether the hard limit has been reached.
func (tm *timeManager) hardExpired() bool {
	return !tm.hardLimit.IsZero() && time.Now().After(tm.hardLimit)
}

// hasTime reports whether this search has any time constraint.
func (tm *timeManager) hasTime() bool {
	return !tm.hardLimit.IsZero()
}

// updateBestMove records the best move from a completed iteration and adjusts
// the soft limit based on stability: a stable best move (same for several
// iterations) pulls the soft limit IN (stop earlier); an unstable best move
// (changed this iteration) pushes it OUT (search longer, up to the hard limit).
func (tm *timeManager) updateBestMove(move uint32) {
	if move == tm.bestMove {
		tm.stability++
	} else {
		tm.bestMove = move
		tm.stability = 0
	}

	// Only adjust when we have adaptive time (clock-based, not flat MoveTime).
	if tm.softDuration == tm.hardDuration {
		return
	}

	// Scale factor based on stability:
	//   0 iterations stable → 1.5× base (extend: the move just changed)
	//   1 iteration stable  → 1.0× base (neutral)
	//   2 iterations stable → 0.75× base
	//   3+ iterations stable → 0.5× base (stop early: very stable)
	var scale float64
	switch {
	case tm.stability == 0:
		scale = 1.5
	case tm.stability == 1:
		scale = 1.0
	case tm.stability == 2:
		scale = 0.75
	default:
		scale = 0.5
	}

	adjusted := time.Duration(float64(tm.softDuration) * scale)
	// Clamp: never exceed the hard limit, never go below 10ms.
	if adjusted > tm.hardDuration {
		adjusted = tm.hardDuration
	}
	if adjusted < 10*time.Millisecond {
		adjusted = 10 * time.Millisecond
	}
	tm.softLimit = tm.start.Add(adjusted)
}

// scoreDropExtend extends the soft limit when the score drops significantly
// between iterations (the position may be losing and needs more search to
// find the best defense). Called after a completed iteration if the score
// dropped ≥ threshold cp from the previous iteration.
func (tm *timeManager) scoreDropExtend(scoreDrop int) {
	if tm.softDuration == tm.hardDuration {
		return // flat MoveTime, no adaptive extension
	}
	if scoreDrop < 30 {
		return // small drop, don't extend
	}

	// Extend proportionally: 30cp → 1.2×, 60cp → 1.4×, 100+cp → 1.8× (capped).
	scale := 1.0 + float64(scoreDrop)/150.0
	if scale > 1.8 {
		scale = 1.8
	}
	extended := time.Duration(float64(tm.softDuration) * scale)
	if extended > tm.hardDuration {
		extended = tm.hardDuration
	}
	tm.softLimit = tm.start.Add(extended)
}
