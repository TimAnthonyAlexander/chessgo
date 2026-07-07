package nnue

import "github.com/timanthonyalexander/gomachine/internal/chess"

// King buckets (EnrichedNet / lean-threats arch only). The 768 piece-square block is
// REPLICATED per king bucket: a piece's base feature is bucket(kingSq)·768 + psqIndex,
// where the bucket is chosen by the PERSPECTIVE's own king square. This lets the net
// learn king-relative piece values (castled vs central king) — the biggest structural
// eval lever the frontier (SF/Reckless/Stormphrax) has.
//
// v2 (2026-07-07): HORIZONTAL FILE-MIRROR. Every strong king-bucket net mirrors
// (SF18 HalfKAv2_hm, Viridithas 16+hm, Renegade 768x14hm, Stormphrax
// KingBucketsMergedMirrored) — nobody runs a large non-mirrored KB net. The mirror
// halves the king-square parameter space: when the perspective's king is on the e–h
// half we reflect the board horizontally (file ^ 7) so the king always sits on files
// a–d. That gives ~2× effective training data per bucket for ~0 extra params — the
// exact density lever at our measured ~4 epochs (docs/open_tasks/king-bucket-mirror-v2.md).
//
// The canonicalization per perspective P (orient = P==Black ? 56 : 0, applied first):
//	ksqO = kingSq(P) ^ orient                 // king in P's view
//	mir  = file(ksqO) >= 4 ? 7 : 0            // reflect if king on e–h half
//	s_final = s ^ orient ^ mir                // EVERY feature sq: base + threat target
//	bucket  = mirBucket(ksqO ^ mir)          // ksqO^mir has file 0–3 (32 half-squares → 16)
// orient (^56, rank bits) and mir (^7, file bits) are DISJOINT masks, so they compose
// and commute — s^orient^mir is order-independent.
//
// The v6 Net / MultiNet feature sets are untouched — they keep InputDim(768). King
// buckets live only in the enriched feature emission + EnrichedNet sizing.
//
// CONTRACT: this indexing MUST match the bullet trainer (chessgo_lean_threats.rs
// map_features) byte-for-byte, or the trained net sees a scrambled input. The
// kb_verify_test.go independent Rust replica pins it.
const (
	// NumKingBuckets is the number of king-square buckets (16, mirrored 8×2 layout).
	NumKingBuckets = 16
	// NumKingRefreshKeys is the Finny refresh-cache key count. Mirrored buckets share
	// weights, but the accumulator feature coordinates differ by mirror half; keeping
	// separate cache entries avoids d/e crossings diffing against the opposite mirror.
	NumKingRefreshKeys = NumKingBuckets * 2
	// PsqSize is the king-bucketed base-psq input size: NumKingBuckets copies of the
	// 768 psq block. Replaces InputDim(768) as the enriched threat-feature offset.
	PsqSize = NumKingBuckets * InputDim // 16 * 768 = 12288
)

// kingMirror returns the horizontal-mirror mask (7 or 0) for a perspective-ORIENTED
// king square: 7 (reflect file) when the king is on the e–h half (file >= 4), else 0.
func kingMirror(ksqOriented uint16) uint16 {
	if ksqOriented&7 >= 4 {
		return 7
	}
	return 0
}

// mirBucket maps a mirrored+oriented king square (file 0–3, so 32 half-board squares)
// to a bucket 0..15: rank·2 + (file>>1) — 8 rank levels × 2 file bands, keeping king-
// safety rank resolution. Identical to the bullet trainer's kbucket(). Tunable later.
func mirBucket(ksqMirrored uint16) uint16 {
	return (ksqMirrored>>3)*2 + (ksqMirrored&7)>>1
}

// kingBucketOffset returns the base-feature offset (bucket·InputDim) that persp's own
// king selects in pos — which of the NumKingBuckets copies of the 768 psq block this
// perspective's base features index into.
func kingBucketOffset(pos *chess.Position, persp chess.Color) uint16 {
	ksq := uint16(pos.KingSquare(persp))
	if persp == chess.Black {
		ksq ^= 56
	}
	mir := kingMirror(ksq)
	return mirBucket(ksq^mir) * uint16(InputDim)
}

// kingBucket returns the king-bucket INDEX (0..NumKingBuckets-1) that persp's own king
// selects in pos — kingBucketOffset without the ·InputDim scale. Used to key the Finny
// refresh cache per (perspective, bucket).
func kingBucket(pos *chess.Position, persp chess.Color) int {
	ksq := uint16(pos.KingSquare(persp))
	if persp == chess.Black {
		ksq ^= 56
	}
	mir := kingMirror(ksq)
	return int(mirBucket(ksq ^ mir))
}

// kingRefreshKey returns the Finny refresh-cache key for persp's own king. It keeps
// the two horizontal mirror halves separate even when they map to the same bucket.
func kingRefreshKey(pos *chess.Position, persp chess.Color) int {
	ksq := uint16(pos.KingSquare(persp))
	if persp == chess.Black {
		ksq ^= 56
	}
	mir := kingMirror(ksq)
	mirHalf := int(mir >> 2) // 0 for a-d, 1 for e-h (mir is 0 or 7)
	return int(mirBucket(ksq^mir))*2 + mirHalf
}

// perspMirror returns the horizontal-mirror mask (7 or 0) for persp's own king in pos.
// The mask is XORed into EVERY feature square (base piece squares AND threat target
// squares) for that perspective, AFTER the ^56 orient. Constant across any move that
// does not cross the d/e file boundary — a boundary-crossing king move flips every
// square, so kingMoveNeedsRefresh forces a full from-scratch refresh instead of a delta.
func perspMirror(pos *chess.Position, persp chess.Color) uint16 {
	ksq := uint16(pos.KingSquare(persp))
	if persp == chess.Black {
		ksq ^= 56
	}
	return kingMirror(ksq)
}

// kingMoveNeedsRefresh reports whether m is a king move that INVALIDATES the moving
// side's incremental accumulator delta — i.e. it changes the king bucket OR flips the
// mirror half (king crosses the d/e file). Either changes the feature encoding for the
// whole perspective (a new bucket copy, or every square reflected), so a from-scratch
// refresh is required. A king move that stays in the same bucket AND the same mirror
// half is handled correctly by the normal delta (bucket offset + mir are constant, so
// computeDelta's single per-perspective transform applies to both parent and child).
func kingMoveNeedsRefresh(pos *chess.Position, m chess.Move) bool {
	if pos.PieceOn(m.From()).Type() != chess.King {
		return false
	}
	from, to := uint16(m.From()), uint16(m.To())
	if pos.SideToMove() == chess.Black {
		from ^= 56 // orient to the moving side's perspective (matches kingBucketOffset)
		to ^= 56
	}
	mirFrom, mirTo := kingMirror(from), kingMirror(to)
	return mirBucket(from^mirFrom) != mirBucket(to^mirTo) || mirFrom != mirTo
}

// appendBucketedBase emits persp's active base (piece-square) features with the king-
// bucket offset and horizontal mirror applied: off + (relColor·6+type)·64 + (relSq^mir).
// Same as AppendFeatures but shifted into this perspective's king-bucket copy of the
// 768 block and reflected when the king is on the e–h half. Used by the enriched
// feature set only (v6/MultiNet keep the plain AppendFeatures).
func appendBucketedBase(dst []uint16, pos *chess.Position, persp chess.Color) []uint16 {
	ksq := uint16(pos.KingSquare(persp))
	if persp == chess.Black {
		ksq ^= 56
	}
	mir := kingMirror(ksq)
	off := mirBucket(ksq^mir) * uint16(InputDim)
	flip := persp == chess.Black
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
		for bb != 0 {
			sq := bb.PopLSB()
			rsq := uint16(sq)
			if flip {
				rsq ^= 56
			}
			rsq ^= mir
			dst = append(dst, off+base+rsq)
		}
	}
	return dst
}
