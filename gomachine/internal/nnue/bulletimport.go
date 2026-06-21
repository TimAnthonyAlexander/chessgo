package nnue

import (
	"encoding/binary"
	"fmt"
	"os"
)

// Bullet quantisation constants (must match the bullet example examples/chessgo.rs:
// QA scales the feature transformer (l0w, l0b), QB scales the output weights (l1w),
// and l1b is scaled by QA*QB. SCALE is bullet's eval_scale — the centipawn scale
// of the float forward pass (Network::evaluate multiplies the int forward by
// SCALE/(QA*QB) at the end).
const (
	bulletQA    = 255
	bulletQB    = 64
	bulletSCALE = 400
)

// ImportBulletNet reads a bullet `quantised.bin` checkpoint (SavedFormat order
// l0w, l0b, l1w, l1b; little-endian i16; column-major; padded to a multiple of
// 64 bytes) and converts it into our float32 Net.
//
// Feature indexing: bullet's Chess768.map_features and our FeatureIndex use the
// SAME convention (own pieces in [0,384), enemy in [384,768); pieceType*64+sq;
// the side-to-move is folded to "me at the bottom" — bullet pre-flips the board
// for black-to-move in bulletformat, we flip sq^56 for the Black perspective).
// So the feature permutation is the identity: bullet feature index == our
// FeatureIndex. We still rebuild W0 explicitly via FeatureIndex so the mapping is
// auditable and would self-correct if a convention ever diverged.
//
// Concat order: bullet does stm_hidden.concat(ntm_hidden) (stm first), matching
// our Eval's acc[:L1]=stm, acc[L1:]=opp. So output weights map 1:1 (no half-swap).
//
// Scale: bullet's float eval == SCALE * (B1 + sum h_i*W1_i) where h_i is our
// SCReLU output, B1 = l1b/(QA*QB), W1_i = l1w_i/QB and the accumulator is
// dequantised by /QA. Our Eval returns round(y*CpScale) with the same y, so
// CpScale = SCALE = 400 reproduces bullet's centipawns exactly.
func ImportBulletNet(path string) (*Net, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("nnue: read bullet net: %w", err)
	}

	const (
		l0wCount = InputDim * L1 // 768*256, column-major (HIDDEN x 768)
		l0bCount = L1            // 256
		l1wCount = ConcatDim     // 512
		l1bCount = 1
	)
	wantI16 := l0wCount + l0bCount + l1wCount + l1bCount // 197377
	if len(raw) < wantI16*2 {
		return nil, fmt.Errorf("nnue: bullet net too small: have %d bytes, need >= %d (%d i16)",
			len(raw), wantI16*2, wantI16)
	}

	// Decode the i16 stream (we only need the first wantI16; the rest is padding).
	vals := make([]int16, wantI16)
	for i := 0; i < wantI16; i++ {
		vals[i] = int16(binary.LittleEndian.Uint16(raw[i*2 : i*2+2]))
	}

	l0w := vals[0:l0wCount]                                  // [HIDDEN x 768] column-major
	l0b := vals[l0wCount : l0wCount+l0bCount]                // [256]
	l1w := vals[l0wCount+l0bCount : l0wCount+l0bCount+l1wCount] // [512]
	l1b := vals[l0wCount+l0bCount+l1wCount]                  // scalar

	n := NewNet()

	// --- Feature transformer (l0w): bullet column-major [HIDDEN x 768] ---
	//
	// bullet's l0w is the affine "l0" weight, shape (out=HIDDEN, in=768), stored
	// column-major. For an input affine the saved layout is feature-as-column:
	// the weights for feature f occupy l0w[f*HIDDEN : f*HIDDEN + HIDDEN] (the same
	// `[Accumulator; 768]` view the Rust Network uses — feature_weights[f].vals is
	// a contiguous HIDDEN block). Our W0 is also feature-major
	// (W0[f*L1 : f*L1+L1]), so per feature this is a straight contiguous copy.
	//
	// We rebuild it via the identity permutation: bulletIdx == ourIdx for every
	// physical (perspective, pieceType, square). Walk our index space; copy the
	// matching bullet column.
	for ourIdx := 0; ourIdx < InputDim; ourIdx++ {
		bulletIdx := ourIdx // identity permutation (proven by the verification gate)
		src := l0w[bulletIdx*L1 : bulletIdx*L1+L1]
		dst := n.W0[ourIdx*L1 : ourIdx*L1+L1]
		for j := 0; j < L1; j++ {
			dst[j] = float32(src[j]) / bulletQA
		}
	}

	// --- Feature bias (l0b): /QA ---
	for j := 0; j < L1; j++ {
		n.B0[j] = float32(l0b[j]) / bulletQA
	}

	// --- Output weights (l1w): concat [stm, opp], /QB. Same order as ours. ---
	for i := 0; i < ConcatDim; i++ {
		n.W1[i] = float32(l1w[i]) / bulletQB
	}

	// --- Output bias (l1b): /(QA*QB) ---
	n.B1 = float32(l1b) / float32(bulletQA*bulletQB)

	// --- Output scale: reproduces bullet's centipawns. ---
	n.CpScale = bulletSCALE

	return n, nil
}
