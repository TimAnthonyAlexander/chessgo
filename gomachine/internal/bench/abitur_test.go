package bench

import (
	"math"
	"testing"
)

func TestScheduleMatches(t *testing.T) {
	ps := []Participant{{Name: "a"}, {Name: "b"}, {Name: "c"}}
	// Full round-robin: 3 unordered pairs.
	got := scheduleMatches(ps, "")
	if len(got) != 3 {
		t.Fatalf("round-robin: want 3 pairs, got %d (%v)", len(got), got)
	}
	// Gauntlet vs "a": only pairs touching a → (a,b),(a,c) = 2.
	g := scheduleMatches(ps, "a")
	if len(g) != 2 {
		t.Fatalf("gauntlet: want 2 pairs, got %d (%v)", len(g), g)
	}
	for _, m := range g {
		if ps[m[0]].Name != "a" && ps[m[1]].Name != "a" {
			t.Fatalf("gauntlet pair %v does not involve a", m)
		}
	}
}

func TestStandingsAnchor(t *testing.T) {
	// A (unknown Elo) beats B (Elo 3000) by +50 head-to-head → A anchors to 3050,
	// and B (already known) anchors off A's unknown Elo → no anchor contribution.
	ps := []Participant{{Name: "A", Elo: 0}, {Name: "B", Elo: 3000}}
	results := []PairResult{{
		A: "A", B: "B", WinsA: 6, Draws: 4, WinsB: 0, Games: 10, ScoreA: 0.8, EloDiff: 50,
	}}
	rows := standings(ps, results)
	if len(rows) != 2 {
		t.Fatalf("want 2 rows, got %d", len(rows))
	}
	// Sorted by score desc → A first.
	if rows[0].Name != "A" {
		t.Fatalf("want A on top by score, got %s", rows[0].Name)
	}
	var a StandingRow
	for _, r := range rows {
		if r.Name == "A" {
			a = r
		}
	}
	if !a.HasAnchor || math.Abs(a.AnchorElo-3050) > 1e-6 {
		t.Fatalf("A anchor: want 3050, got %.2f (hasAnchor=%v)", a.AnchorElo, a.HasAnchor)
	}
	// A's aggregated W/D/L reflects the single match from A's perspective.
	if a.Wins != 6 || a.Draws != 4 || a.Losses != 0 {
		t.Fatalf("A W/D/L: want 6/4/0, got %d/%d/%d", a.Wins, a.Draws, a.Losses)
	}
}

func TestStandingsAnchorAveragesKnownOpponents(t *testing.T) {
	// A (unknown) vs two known opponents: B=3000 (A +40 → 3040), C=3200 (A −60 → 3140).
	// Anchor should be the mean = 3090.
	ps := []Participant{{Name: "A"}, {Name: "B", Elo: 3000}, {Name: "C", Elo: 3200}}
	results := []PairResult{
		{A: "A", B: "B", Games: 10, EloDiff: 40},
		{A: "A", B: "C", Games: 10, EloDiff: -60},
	}
	rows := standings(ps, results)
	var a StandingRow
	for _, r := range rows {
		if r.Name == "A" {
			a = r
		}
	}
	if !a.HasAnchor || math.Abs(a.AnchorElo-3090) > 1e-6 {
		t.Fatalf("A anchor: want mean 3090, got %.2f", a.AnchorElo)
	}
}
