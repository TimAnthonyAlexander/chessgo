package engine

import "time"

// LevelConfig defines how a difficulty level 0..10 searches and how it is
// weakened (SPEC §6). Strength rises monotonically: level 10 is full strength
// with the longest think time and no weakening; level 0 thinks briefly, adds
// large eval noise, and blunders outright a third of the time. Weakening is
// always done by noise/sub-optimal selection — the engine never makes an illegal
// or rules-incorrect move.
type LevelConfig struct {
	Depth    int           // max search depth
	MoveTime time.Duration // soft time budget
	NoiseCp  int           // uniform eval jitter in [-NoiseCp, +NoiseCp] centipawns
	Blunder  float64       // probability of deliberately picking a weaker move
}

const ms = time.Millisecond

// levelConfigs is indexed by level (0..10).
var levelConfigs = [11]LevelConfig{
	0:  {Depth: 2, MoveTime: 60 * ms, NoiseCp: 160, Blunder: 0.33},
	1:  {Depth: 3, MoveTime: 90 * ms, NoiseCp: 120, Blunder: 0.24},
	2:  {Depth: 3, MoveTime: 120 * ms, NoiseCp: 95, Blunder: 0.17},
	3:  {Depth: 4, MoveTime: 160 * ms, NoiseCp: 70, Blunder: 0.12},
	4:  {Depth: 5, MoveTime: 220 * ms, NoiseCp: 50, Blunder: 0.08},
	5:  {Depth: 6, MoveTime: 320 * ms, NoiseCp: 35, Blunder: 0.05},
	6:  {Depth: 7, MoveTime: 480 * ms, NoiseCp: 22, Blunder: 0.03},
	7:  {Depth: 8, MoveTime: 700 * ms, NoiseCp: 12, Blunder: 0.015},
	8:  {Depth: 10, MoveTime: 1000 * ms, NoiseCp: 6, Blunder: 0.006},
	9:  {Depth: 12, MoveTime: 1400 * ms, NoiseCp: 0, Blunder: 0},
	// Depth 18 (not 14): measured time-to-depth on current hardware shows the old
	// 14 cap clipped quiet middlegames ~1 ply short of what 1900ms reaches (~d15),
	// while sharp middlegames are time-bound at ~d13 (cap never binds there). 18
	// frees that ply yet still early-outs trivial endgames (which blow past d14 in
	// <0.5s) instead of grinding to ~d30 — keeping moves snappy and CPU bounded.
	10: {Depth: 18, MoveTime: 1900 * ms, NoiseCp: 0, Blunder: 0},
}

// configForLevel clamps level to 0..10 and returns its config.
func configForLevel(level int) LevelConfig {
	if level < 0 {
		level = 0
	}
	if level > 10 {
		level = 10
	}
	return levelConfigs[level]
}
