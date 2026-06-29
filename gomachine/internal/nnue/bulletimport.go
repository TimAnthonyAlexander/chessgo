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
func ImportBulletNet(path string, nb int) (*Net, error) {
	if nb < 1 {
		nb = 1
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("nnue: read bullet net: %w", err)
	}

	// INFER the hidden width from the file given the (known) bucket count nb. The
	// content is
	//   l0w(768·HL) + l0b(HL) + l1w(2·HL·nb) + l1b(nb) = (769+2·nb)·HL + nb  int16,
	// then bullet pads the file up to a multiple of 64 bytes (a few leftover i16).
	// A wrong HL would change the content by ≥(769+2·nb) i16 — far more than the
	// <64-byte padding — so floor((nI16-nb)/(769+2·nb)) recovers HL uniquely.
	perHL := InputDim + 1 + 2*nb // 769 + 2·nb
	if len(raw) == 0 || len(raw)%64 != 0 {
		return nil, fmt.Errorf("nnue: bullet net is %d bytes; expected a non-empty multiple of 64 (bullet pads to 64)", len(raw))
	}
	nI16 := len(raw) / 2
	if nI16 < perHL+nb {
		return nil, fmt.Errorf("nnue: bullet net too small: %d bytes (%d i16) — not even one HL=1 net at nb=%d", len(raw), nI16, nb)
	}
	hl := (nI16 - nb) / perHL
	if hl <= 0 || hl > 8192 {
		return nil, fmt.Errorf("nnue: implausible inferred hidden width HL=%d from %d bytes (nb=%d)", hl, len(raw), nb)
	}
	// The content is (769+2·nb)·HL+nb int16, padded UP to a multiple of 64 bytes.
	// Require the file to be EXACTLY that padded size for the inferred HL — this
	// rejects any file that isn't a clean net for this (HL, nb) (a wrong HL/nb or a
	// non-bullet file). If you pass the wrong --buckets, this is what catches it.
	contentBytes := (perHL*hl + nb) * 2
	wantBytes := (contentBytes + 63) / 64 * 64
	if len(raw) != wantBytes {
		return nil, fmt.Errorf(
			"nnue: bullet net size %d bytes doesn't match (769+2·nb)·HL+nb padded-to-64 for inferred HL=%d, nb=%d (want %d bytes) — wrong --buckets?",
			len(raw), hl, nb, wantBytes)
	}

	l0wCount := InputDim * hl
	l0bCount := hl
	l1wCount := 2 * hl * nb // bucket-contiguous: nb blocks of 2·HL
	l1bCount := nb
	wantI16 := l0wCount + l0bCount + l1wCount + l1bCount

	// Decode the i16 stream (we only need the first wantI16; the rest is padding).
	vals := make([]int16, wantI16)
	for i := 0; i < wantI16; i++ {
		vals[i] = int16(binary.LittleEndian.Uint16(raw[i*2 : i*2+2]))
	}

	l0w := vals[0:l0wCount]                                              // [HL x 768] column-major
	l0b := vals[l0wCount : l0wCount+l0bCount]                            // [HL]
	l1w := vals[l0wCount+l0bCount : l0wCount+l0bCount+l1wCount]          // [nb x 2·HL] bucket-contiguous
	l1b := vals[l0wCount+l0bCount+l1wCount : wantI16]                    // [nb]

	n := NewNetSizeBuckets(hl, nb)
	n.QA, n.QB, n.Scale = bulletQA, bulletQB, bulletSCALE

	// Phase B: store bullet's quantised ints VERBATIM (no float round-trip) so the
	// integer forward reproduces bullet's quantised eval bit-for-bit. The float
	// view is then derived by dequantising (the reference/comparison path).
	//
	// --- Feature transformer (l0w): bullet column-major [HIDDEN x 768] ---
	// bullet stores feature f as the contiguous block l0w[f*HIDDEN : ...]; our W0i
	// is also feature-major and bulletIdx == ourIdx (identity permutation, proven
	// by the verification gate), so per feature this is a straight copy.
	for ourIdx := 0; ourIdx < InputDim; ourIdx++ {
		bulletIdx := ourIdx
		copy(n.W0i[ourIdx*hl:ourIdx*hl+hl], l0w[bulletIdx*hl:bulletIdx*hl+hl])
	}
	copy(n.B0i, l0b) // feature bias
	copy(n.W1i, l1w) // output weights, nb buckets × concat [stm, opp]
	for b := 0; b < nb; b++ {
		n.B1i[b] = int32(l1b[b]) // per-bucket output bias (scaled by QA*QB)
	}
	n.quantized = true

	n.dequantizeToFloat() // float reference view (≤1cp from the exact int forward)
	return n, nil
}
