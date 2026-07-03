package search

import (
	"testing"
	"time"
)

func TestTMFromLimitsLegacy(t *testing.T) {
	tm := tmFromLimits(Limits{MoveTime: 500 * time.Millisecond})
	if !tm.hasTime() {
		t.Fatal("expected hasTime=true for MoveTime limits")
	}
	if tm.softDuration != 500*time.Millisecond {
		t.Fatalf("soft=%v, want 500ms", tm.softDuration)
	}
	if tm.hardDuration != 500*time.Millisecond {
		t.Fatalf("hard=%v, want 500ms", tm.hardDuration)
	}
}

func TestTMFromLimitsClock(t *testing.T) {
	tm := tmFromLimits(Limits{TimeLeft: 60 * time.Second, Increment: 1 * time.Second})
	if !tm.hasTime() {
		t.Fatal("expected hasTime=true for clock limits")
	}
	// Base = 60s/25 + 0.75*1s = 2.4s + 0.75s = 3.15s
	// Soft = 3.15s, Hard = min(3*3.15s, 30s) = 9.45s
	if tm.softDuration < 3*time.Second || tm.softDuration > 4*time.Second {
		t.Fatalf("soft=%v, want ~3.15s", tm.softDuration)
	}
	if tm.hardDuration < 9*time.Second || tm.hardDuration > 10*time.Second {
		t.Fatalf("hard=%v, want ~9.45s", tm.hardDuration)
	}
}

func TestTMFromLimitsClockLowTime(t *testing.T) {
	tm := tmFromLimits(Limits{TimeLeft: 500 * time.Millisecond, Increment: 100 * time.Millisecond})
	if !tm.hasTime() {
		t.Fatal("expected hasTime=true")
	}
	// Base = 500ms/25 + 75ms = 20ms + 75ms = 95ms
	// Hard = min(3*95ms, 250ms) = 250ms
	if tm.hardDuration > 260*time.Millisecond {
		t.Fatalf("hard=%v, want ≤250ms (50%% remaining)", tm.hardDuration)
	}
}

func TestTMFromLimitsMovesToGo(t *testing.T) {
	tm := tmFromLimits(Limits{TimeLeft: 120 * time.Second, MovesToGo: 10})
	// Base = 120s/10 = 12s, hard = min(36s, 60s) = 36s
	if tm.softDuration < 11*time.Second || tm.softDuration > 13*time.Second {
		t.Fatalf("soft=%v, want ~12s", tm.softDuration)
	}
}

func TestTMStability(t *testing.T) {
	tm := tmFromLimits(Limits{TimeLeft: 60 * time.Second, Increment: 1 * time.Second})
	originalSoft := tm.softDuration

	// Unstable: new best move → extends
	tm.updateBestMove(100)
	// stability=0 → scale 1.5
	if tm.softLimit.Before(tm.start.Add(originalSoft)) {
		t.Fatal("unstable move should not shrink soft limit")
	}

	// Same move → stability grows
	tm.updateBestMove(100) // stability=1
	tm.updateBestMove(100) // stability=2 → scale 0.75
	afterStable := tm.softLimit
	if !afterStable.Before(tm.start.Add(originalSoft)) {
		t.Fatal("3× stable should shrink soft limit below base")
	}

	// Very stable → even shorter
	tm.updateBestMove(100) // stability=3 → scale 0.5
	if !tm.softLimit.Before(afterStable) {
		t.Fatal("4× stable should shrink further")
	}
}

func TestTMScoreDropExtend(t *testing.T) {
	tm := tmFromLimits(Limits{TimeLeft: 60 * time.Second, Increment: 1 * time.Second})
	before := tm.softLimit

	// Small drop: no effect
	tm.scoreDropExtend(10)
	if !tm.softLimit.Equal(before) {
		t.Fatal("small drop should not extend")
	}

	// Large drop: extends
	tm.scoreDropExtend(60)
	if !tm.softLimit.After(before) {
		t.Fatal("large drop should extend soft limit")
	}
}

func TestTMNoTimeNoLimits(t *testing.T) {
	tm := tmFromLimits(Limits{Nodes: 10000})
	if tm.hasTime() {
		t.Fatal("node-only limits should have hasTime=false")
	}
}

func TestTMLegacyNoStabilityAdjust(t *testing.T) {
	tm := tmFromLimits(Limits{MoveTime: 500 * time.Millisecond})
	before := tm.softLimit
	tm.updateBestMove(42)
	tm.updateBestMove(42)
	tm.updateBestMove(42)
	// Legacy (softDuration == hardDuration) → no adjustment
	if !tm.softLimit.Equal(before) {
		t.Fatal("legacy MoveTime should not adjust soft limit on stability")
	}
}
