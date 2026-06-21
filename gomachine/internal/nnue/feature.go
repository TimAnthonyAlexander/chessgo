// Package nnue implements the engine's NNUE (efficiently-updatable neural
// network) evaluation: a 768-input, dual-perspective, piece-square feature set
// feeding a (768→256)×2→1 network that returns a side-to-move-relative
// centipawn score — the same contract as the hand-crafted eval it replaces.
//
// Phase 1 is a correct-but-slow FLOAT forward pass that recomputes the whole
// network on every call (no incremental accumulator, no quantization). It
// imports only internal/chess so the dependency graph stays acyclic
// (search → nnue → chess; eval is untouched). See docs/NNUE/PLAN.md.
package nnue

import "github.com/timanthonyalexander/gomachine/internal/chess"

// Feature-set dimensions. The input is the classic 768 = 2 colors × 6 piece
// types × 64 squares, built once per perspective (own pieces vs enemy pieces).
const (
	// InputDim is the number of features per perspective.
	InputDim = 2 * 6 * 64 // 768
	// L1 is the feature-transformer (accumulator) width per perspective.
	L1 = 256
	// ConcatDim is the width of the concatenated [stm, opp] accumulator.
	ConcatDim = 2 * L1 // 512
	// maxActive bounds the active features per perspective (≤32 pieces).
	maxActive = 32
)

// FeatureIndex returns the 768-feature index of a piece for a given perspective.
//
//	relColor = (piece is enemy of persp) ? 1 : 0   // own pieces first
//	relSq    = (persp == White) ? sq : sq^56        // vertical mirror for Black
//	index    = (relColor*6 + type)*64 + relSq
//
// The vertical flip (sq^56) folds Black's view onto the same "me on rank 1"
// frame White uses, so the shared first-layer weights see a consistent
// orientation regardless of whose perspective is being built.
func FeatureIndex(persp chess.Color, pc chess.Piece, sq chess.Square) uint16 {
	var relColor uint16
	if pc.Color() != persp {
		relColor = 1
	}
	rsq := uint16(sq)
	if persp == chess.Black {
		rsq ^= 56
	}
	return (relColor*6+uint16(pc.Type()))*64 + rsq
}

// AppendFeatures appends the active feature indices of pos, from persp's point
// of view, to dst and returns the extended slice. One index per piece on the
// board. Pass a dst with cap ≥ maxActive (e.g. buf[:0]) to avoid allocation.
func AppendFeatures(dst []uint16, pos *chess.Position, persp chess.Color) []uint16 {
	for pc := chess.WhitePawn; pc <= chess.BlackKing; pc++ {
		bb := pos.PieceBB(pc)
		if bb == 0 {
			continue
		}
		var relColor uint16
		if pc.Color() != persp {
			relColor = 1
		}
		base := (relColor*6 + uint16(pc.Type())) * 64
		flip := persp == chess.Black
		for bb != 0 {
			rsq := uint16(bb.PopLSB())
			if flip {
				rsq ^= 56
			}
			dst = append(dst, base+rsq)
		}
	}
	return dst
}
