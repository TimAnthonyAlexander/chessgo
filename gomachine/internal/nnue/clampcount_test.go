package nnue

import (
	"math"
	"math/rand"
	"os"
	"testing"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// PRE-COMMITTED sb8 DECISION RULE (write it down before the number exists, per the
// owner's #4): the int8 threat-FT config SHIPS iff BOTH
//   (a) folded-threat-row clamp fraction  <= 0.5%   AND
//   (b) int16-FT vs int8-FT eval RMS       <= 5.0 cp over the sanity positions.
// Either exceeded → STOP the run, split the base/threat affine + clip_pass_through_grad
// on the threat rows, retrain. Do NOT rationalize continuing because the run is 20 min in.
const (
	sb8MaxClampFrac = 0.5 // percent of ThreatBlock*H folded threat weights clamped to ±127
	sb8MaxEvalRMS   = 5.0 // cp RMS between int16-FT and int8-FT eval
)

// TestKBNetClampCount is the sb8 gate. It imports a FOLDED quantised.bin (bullet's
// save_quantised applies merge_factoriser, so l0w threat rows are the deployed
// real+V1+V2+V3 SUM), measures (a) how many of those summed rows QuantizeFTInt8
// clamps to ±127, and (b) the DIRECT deploy loss: int16-FT eval vs int8-FT eval RMS
// over random positions. Applies the pre-committed rule above. Set KB_NET_PATH.
func TestKBNetClampCount(t *testing.T) {
	path := os.Getenv("KB_NET_PATH")
	if path == "" {
		t.Skip("set KB_NET_PATH to a folded quantised.bin to run the sb8 gate")
	}
	n, err := LoadKBNet(path, 512, 16, 32, 8)
	if err != nil {
		t.Fatalf("LoadKBNet(%s): %v", path, err)
	}
	if n.IsLean() {
		t.Fatalf("%s imported as LEAN — expected the multilayer threats net (size dispatch?)", path)
	}

	// Sanity positions: deterministic random-game walk (dedup / mirror / density variety).
	positions := randomPositions(300)

	// (b) DIRECT deploy loss — eval BEFORE int8-FT (int16 threat FT) vs AFTER.
	base := make([]int, len(positions))
	for i, pos := range positions {
		base[i] = n.Eval(pos) // int8FT still off here → int16 threat FT
	}

	total := ThreatBlock * n.H
	clamped := n.QuantizeFTInt8() // now int8FT on; clamps summed threat rows
	clampFrac := float64(clamped) / float64(total) * 100

	var sumSq, maxAbs float64
	for i, pos := range positions {
		d := float64(n.Eval(pos) - base[i]) // int8-FT eval now
		sumSq += d * d
		if a := math.Abs(d); a > maxAbs {
			maxAbs = a
		}
	}
	rms := math.Sqrt(sumSq / float64(len(positions)))

	t.Logf("sb8 gate on %s:", path)
	t.Logf("  (a) CLAMP: %d / %d folded threat-FT weights at ±127 = %.4f%% (limit %.1f%%)", clamped, total, clampFrac, sb8MaxClampFrac)
	t.Logf("  (b) EVAL RMS int16FT->int8FT: %.3f cp (max |Δ| %.1f cp, limit %.1f cp)", rms, maxAbs, sb8MaxEvalRMS)

	// Non-crash eval sanity (per #4: sanity, NOT a strength read).
	for _, pos := range positions[:2] {
		if ev := n.Eval(pos); ev < -3000 || ev > 3000 {
			t.Fatalf("insane eval %d cp", ev)
		}
	}

	if clampFrac > sb8MaxClampFrac || rms > sb8MaxEvalRMS {
		t.Fatalf("sb8 GATE FAILED — int8-FT is lossy (clamp %.4f%% / rms %.3f cp). STOP: split base/threat affine + clip_pass_through_grad on threat rows, retrain.", clampFrac, rms)
	}
	t.Logf("  sb8 GATE PASSED — int8 threat-FT is clamp-clean; roll to 640.")
}

// randomPositions returns n deterministic pseudo-random legal positions.
func randomPositions(n int) []*chess.Position {
	rng := rand.New(rand.NewSource(0x5B8))
	out := make([]*chess.Position, 0, n)
	for len(out) < n {
		pos, err := chess.ParseFEN(chess.StartFEN)
		if err != nil {
			panic(err)
		}
		for ply := 0; ply < 80 && len(out) < n; ply++ {
			var ml chess.MoveList
			pos.GenerateLegal(&ml)
			if ml.Len() == 0 {
				break
			}
			if ply >= 4 {
				cp, _ := chess.ParseFEN(pos.FEN())
				out = append(out, cp)
			}
			m := ml.Get(rng.Intn(ml.Len()))
			var u chess.Undo
			pos.DoMove(m, &u)
		}
	}
	return out
}
