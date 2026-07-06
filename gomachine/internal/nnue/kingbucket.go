package nnue

import "github.com/timanthonyalexander/gomachine/internal/chess"

// King buckets (EnrichedNet / lean-threats arch only). The 768 piece-square block is
// REPLICATED per king bucket: a piece's base feature is bucket(kingSq)·768 + psqIndex,
// where the bucket is chosen by the PERSPECTIVE's own king square. This lets the net
// learn king-relative piece values (castled vs central king) — the biggest structural
// eval lever the frontier (SF/Reckless/Stormphrax) has and we lacked.
//
// v1 is NO-mirror, NO king-merge: the minimal, low-risk form. The base block grows
// 768 → NumKingBuckets·768 (= PsqSize) and the threat block simply shifts to start at
// PsqSize instead of 768. Threat feature internals are UNCHANGED. A future v2 adds the
// file-mirror (halves psq params) once v1 validates.
//
// The v6 Net / MultiNet feature sets are untouched — they keep InputDim(768). King
// buckets live only in the enriched feature emission + EnrichedNet sizing.
//
// CONTRACT: this indexing MUST match the bullet trainer (chessgo_lean_threats.rs
// map_features) byte-for-byte, or the trained net sees a scrambled input. The bucket
// table below is duplicated there verbatim.
const (
	// NumKingBuckets is the number of king-square buckets (v1 = 16, a 4×4 grid).
	NumKingBuckets = 16
	// PsqSize is the king-bucketed base-psq input size: NumKingBuckets copies of the
	// 768 psq block. Replaces InputDim(768) as the enriched threat-feature offset.
	PsqSize = NumKingBuckets * InputDim // 16 * 768 = 12288
)

// kingBucketTable maps a perspective-ORIENTED king square (White: sq; Black: sq^56,
// matching FeatureIndex's relSq so both colors share the same weights) to a bucket.
// v1: a 4×4 grid — bucket = (rank>>1)·4 + (file>>1). Identical table in the bullet
// trainer. Tunable later (a king-safety-aware map likely beats the uniform grid).
var kingBucketTable = func() [64]uint16 {
	var t [64]uint16
	for sq := 0; sq < 64; sq++ {
		r, f := sq>>3, sq&7
		t[sq] = uint16((r>>1)*4 + (f >> 1))
	}
	return t
}()

// kingBucketOffset returns the base-feature offset (bucket·InputDim) that persp's own
// king selects in pos — which of the NumKingBuckets copies of the 768 psq block this
// perspective's base features index into.
func kingBucketOffset(pos *chess.Position, persp chess.Color) uint16 {
	ksq := uint16(pos.KingSquare(persp))
	if persp == chess.Black {
		ksq ^= 56
	}
	return kingBucketTable[ksq] * uint16(InputDim)
}

// kingBucket returns the king-bucket INDEX (0..NumKingBuckets-1) that persp's own king
// selects in pos — kingBucketOffset without the ·InputDim scale. Used to key the Finny
// refresh cache per (perspective, bucket).
func kingBucket(pos *chess.Position, persp chess.Color) int {
	ksq := uint16(pos.KingSquare(persp))
	if persp == chess.Black {
		ksq ^= 56
	}
	return int(kingBucketTable[ksq])
}

// kingMoveNeedsRefresh reports whether m is a king move that CHANGES the moving
// side's king bucket — the only case where the incremental accumulator delta is
// invalid (every base feature for that perspective shifts to a new bucket copy, so a
// from-scratch refresh is required). A king move that stays within the same bucket is
// handled correctly by the normal delta: the bucket offset is constant across the
// move, so computeDelta's single per-perspective offset applies to both the removed
// (parent) and added (child) base features. Skipping the refresh on same-bucket king
// moves recovers most of the king-bucket NPS cost (kings often shuffle within a
// bucket, e.g. a castled king on the back two ranks).
func kingMoveNeedsRefresh(pos *chess.Position, m chess.Move) bool {
	if pos.PieceOn(m.From()).Type() != chess.King {
		return false
	}
	from, to := uint16(m.From()), uint16(m.To())
	if pos.SideToMove() == chess.Black {
		from ^= 56 // orient to the moving side's perspective (matches kingBucketOffset)
		to ^= 56
	}
	return kingBucketTable[from] != kingBucketTable[to]
}

// appendBucketedBase emits persp's active base (piece-square) features with the king-
// bucket offset applied: off + (relColor·6+type)·64 + relSq. Same as AppendFeatures
// but shifted into this perspective's king-bucket copy of the 768 block. Used by the
// enriched feature set only (v6/MultiNet keep the plain AppendFeatures).
func appendBucketedBase(dst []uint16, pos *chess.Position, persp chess.Color) []uint16 {
	off := kingBucketOffset(pos, persp)
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
			dst = append(dst, off+base+rsq)
		}
	}
	return dst
}
