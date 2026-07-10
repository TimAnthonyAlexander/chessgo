package nnue

import (
	"sort"
	"testing"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// sfCrossCheckWant pins the exact THREAT feature indices (>= PsqSize, i.e.
// PsqSize + sfIndex) the Go engine must emit for the two cross-check FENs, per
// perspective. These are the GROUND TRUTH captured from the bullet trainer's
// `cargo test --example chessgo_ml_threats_sf` on 2026-07-10 and verified
// byte-for-byte against Go — so this is the persistent Go<->Rust pin (the
// full-threats replacement for the old kb_verify pins). If either side's index
// scheme drifts, this fails: retrain data would then index garbage weights.
var sfCrossCheckWant = map[string][]int{
	"startpos/White": {12794, 12813, 16838, 16839, 16859, 16860, 22431, 22529, 23320, 23424, 31475, 31476, 31477, 34384, 38751, 48871, 48872, 48873, 49709, 55050, 55069, 60075, 60076, 60096, 60097, 67622, 67720, 68519, 68623, 81431, 81432, 81433, 84350, 88717, 90861, 90862, 90863, 91704},
	"startpos/Black": {12794, 12813, 16838, 16839, 16859, 16860, 22431, 22529, 23320, 23424, 31475, 31476, 31477, 34384, 38751, 48871, 48872, 48873, 49709, 55050, 55069, 60075, 60076, 60096, 60097, 67622, 67720, 68519, 68623, 81431, 81432, 81433, 84350, 88717, 90861, 90862, 90863, 91704},
	"midgame/White":  {12292, 12308, 12374, 12383, 12868, 12871, 12893, 14234, 14546, 14912, 16989, 17041, 17044, 18666, 19796, 22459, 22529, 26037, 31477, 32934, 34391, 35838, 35842, 48861, 48862, 48863, 50120, 52267, 52530, 52542, 52624, 52633, 52974, 54969, 54970, 54995, 55666, 56340, 56652, 60017, 60094, 60097, 60578, 61700, 67650, 67720, 69518, 71236, 81426, 84343, 84350, 85804, 90851, 90852, 90853, 92115},
	"midgame/Black":  {12292, 12308, 12374, 12383, 12868, 12871, 12893, 13564, 14234, 14546, 14912, 16860, 16861, 16910, 17467, 18585, 22459, 22529, 24319, 26037, 31482, 34384, 34387, 35838, 48861, 48862, 48863, 50120, 52266, 52530, 52542, 52624, 52633, 52974, 54969, 54970, 54995, 56340, 56652, 57150, 59855, 59856, 59958, 61639, 67650, 67720, 71236, 81433, 82884, 84341, 85804, 85808, 90851, 90852, 90853, 92115},
}

// TestSFThreatCrossCheck pins the Go threat-feature emission byte-for-byte against
// the values the Rust trainer emits for the same positions — the Go<->Rust
// contract that makes trained full-threats weights index correctly at inference.
func TestSFThreatCrossCheck(t *testing.T) {
	fens := map[string]string{
		"startpos": chess.StartFEN,
		"midgame":  "r1bq1rk1/pp2bppp/2n1pn2/2pp4/3P1B2/2NBPN2/PPP2PPP/R2Q1RK1 w - - 0 8",
	}
	for name, fen := range fens {
		pos, err := chess.ParseFEN(fen)
		if err != nil {
			t.Fatalf("%s: parse: %v", name, err)
		}
		for _, persp := range []chess.Color{chess.White, chess.Black} {
			side := "White"
			if persp == chess.Black {
				side = "Black"
			}
			key := name + "/" + side
			feats := appendEnrichedFeatures(nil, pos, persp)
			var got []int
			for _, f := range feats {
				if f >= uint32(PsqSize) {
					got = append(got, int(f))
				}
			}
			sort.Ints(got)
			want := sfCrossCheckWant[key]
			if len(got) != len(want) {
				t.Fatalf("%s: got %d threats, want %d\n got=%v\nwant=%v", key, len(got), len(want), got, want)
			}
			for i := range got {
				if got[i] != want[i] {
					t.Fatalf("%s: threat[%d]=%d, want %d (Go<->Rust index drift)\n got=%v\nwant=%v", key, i, got[i], want[i], got, want)
				}
			}
		}
	}
}
