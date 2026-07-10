package nnue

import (
	"testing"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// TestSFThreatDimension asserts the ported SF18 Full-Threats index space is exactly
// 79,856 and the per-type attack-table sizes match SF's — the proof the scheme matches.
func TestSFThreatDimension(t *testing.T) {
	if sfTotalDim != SFThreatDim {
		t.Fatalf("total threat dim = %d, want %d", sfTotalDim, SFThreatDim)
	}
	// SF attackTableSize per type: pawn 84, knight 336, bishop 560, rook 896, queen 1456, king 420.
	want := map[chess.PieceType]int{
		chess.Pawn: 84, chess.Knight: 336, chess.Bishop: 560,
		chess.Rook: 896, chess.Queen: 1456, chess.King: 420,
	}
	for pt, w := range want {
		// own (rel 0) attacker
		if got := sfAttackTableSize[int(pt)]; got != w {
			t.Errorf("attackTableSize[own %v] = %d, want %d", pt, got, w)
		}
		// enemy (rel 1) attacker — pawns differ in direction but same count
		if got := sfAttackTableSize[sfNumPieceTypes+int(pt)]; got != w {
			t.Errorf("attackTableSize[enemy %v] = %d, want %d", pt, got, w)
		}
	}
	// Per-color valid victim counts (nvt/2): P 3, N 6, B 5, R 5, Q 6, K 4.
	wantNvt := map[chess.PieceType]int{
		chess.Pawn: 3, chess.Knight: 6, chess.Bishop: 5,
		chess.Rook: 5, chess.Queen: 6, chess.King: 4,
	}
	for pt, w := range wantNvt {
		if got := sfNvtHalf[int(pt)]; got != w {
			t.Errorf("nvtHalf[%v] = %d, want %d", pt, got, w)
		}
	}
}

// TestSFThreatIndexInjective enumerates every valid (attacker, victim, from→to) edge
// and asserts the indices are in-range and collision-free (injective) — no two distinct
// edges share an index, so the trained weights are unambiguous.
func TestSFThreatIndexInjective(t *testing.T) {
	seen := make(map[int][6]int) // idx -> the edge that claimed it
	maxIdx := -1
	count := 0
	for atkRel := 0; atkRel < 2; atkRel++ {
		for atkT := 0; atkT < sfNumPieceTypes; atkT++ {
			rel := atkRel*sfNumPieceTypes + atkT
			for from := 0; from < 64; from++ {
				bb := sfRelAttack[rel][from]
				for to := 0; to < 64; to++ {
					if bb&(chess.Bitboard(1)<<uint(to)) == 0 {
						continue // `to` not attacked from `from`
					}
					for vicRel := 0; vicRel < 2; vicRel++ {
						for vicT := 0; vicT < sfNumPieceTypes; vicT++ {
							idx, ok := sfThreatIndex(atkRel, chess.PieceType(atkT), vicRel, chess.PieceType(vicT), from, to)
							if !ok {
								continue
							}
							count++
							if idx < 0 || idx >= SFThreatDim {
								t.Fatalf("edge atk=%d/%d vic=%d/%d %d->%d: idx %d out of [0,%d)", atkRel, atkT, vicRel, vicT, from, to, idx, SFThreatDim)
							}
							if idx > maxIdx {
								maxIdx = idx
							}
							edge := [6]int{atkRel, atkT, vicRel, vicT, from, to}
							if prev, dup := seen[idx]; dup {
								t.Fatalf("index collision at %d: %v vs %v", idx, prev, edge)
							}
							seen[idx] = edge
						}
					}
				}
			}
		}
	}
	t.Logf("valid edges=%d distinct indices=%d maxIdx=%d (space=%d)", count, len(seen), maxIdx, SFThreatDim)
	if len(seen) == 0 {
		t.Fatal("no valid edges enumerated")
	}
}
