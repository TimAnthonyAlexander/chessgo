package nnue

import "github.com/timanthonyalexander/gomachine/internal/chess"

// SF18-style "Full Threat Inputs" — a threat feature encodes the ORDERED (from→to)
// attack edge within the attacker's real attack geometry, so the attacker's SQUARE
// is captured compactly (the edge-rank collapses the 64×64 from×to space down to the
// piece's reachable-square count). Ported from ~/sf18-arm/src/nnue/features/
// full_threats.{cpp,h} (see docs/open_tasks/threats-richness-build.md).
//
// A feature is: (attacker rel-piece, victim type+color slot, (from→to) edge). Index:
//
//	idx = attackerBase[atk]                            // per rel-attacker offset
//	    + victimSlot · attackTableSize[atk]            // allowed-victim type+color slot
//	    + offsets[atk][from]                           // Σ popcount(attacks) over from' < from
//	    + edgeRank[atk][from][to]                      // rank of `to` in from's oriented attack set
//
// Rel-piece = relColor·6 + type (relColor 0 = perspective's own, 1 = enemy), matching
// the base-768 convention. from/to are perspective-oriented (^56 for black) AND
// horizontally mirrored (^mir) — the SAME transform the base block uses, so we keep a
// single mirror convention (the Rust trainer must replicate exactly; kb_verify pins it).
//
// Total index space is exactly 79,856 (asserted in TestSFThreatDimension) — the proof
// this matches SF18's Dimensions.

const (
	sfNumPieceTypes = 6 // Pawn..King
	sfNumRelPieces  = 12 // relColor(2) × type(6)
	// SFThreatDim is the total threat index space; MUST equal SF18 full_threats Dimensions.
	SFThreatDim = 79856
)

// sfVictimAllowed[atkType][vicType] reports whether an attacker of atkType records a
// victim of vicType (SF `map` exclusions): Pawn→{B,Q,K}, {B,R,K}→Q, K→K all dropped.
var sfVictimAllowed [sfNumPieceTypes][sfNumPieceTypes]bool

// sfVictimSlotHalf[atkType][vicType] is the 0-based slot of an allowed victim type
// within ONE color half (−1 if excluded). Enemy victims sit in the high half at
// +sfNvtHalf[atkType]. Slots are assigned in ascending victim-type order.
var sfVictimSlotHalf [sfNumPieceTypes][sfNumPieceTypes]int

// sfNvtHalf[atkType] = number of allowed victim types per color (nvt/2).
var sfNvtHalf [sfNumPieceTypes]int

// sfRelAttack[relPiece][sq] = empty-board attack pattern of the rel-piece at sq in the
// ORIENTED frame (own pawns attack "up" = WhitePawn, enemy pawns "down" = BlackPawn;
// all other types are color-independent). Pawns on ranks 1/8 have no pattern.
var sfRelAttack [sfNumRelPieces][64]chess.Bitboard

// sfAttackTableSize[relPiece] = Σ_sq popcount(sfRelAttack[relPiece][sq]).
var sfAttackTableSize [sfNumRelPieces]int

// sfOffsets[relPiece][from] = Σ_{f<from} popcount(sfRelAttack[relPiece][f]).
var sfOffsets [sfNumRelPieces][64]int

// sfEdgeRank[relPiece][from][to] = popcount(attacks(from) & squares<to); valid only
// when `to` ∈ attacks(from). Packed sparsely via a per-(relPiece,from) map is overkill;
// a dense [12][64][64] int16 table is 98KB — fine, built once.
var sfEdgeRank [sfNumRelPieces][64][64]int16

// sfAttackerBase[relPiece] = cumulative Σ over rel-pieces r<relPiece of
// (nvt[type(r)] × sfAttackTableSize[r]). Enumeration order: own P..K then enemy P..K.
var sfAttackerBase [sfNumRelPieces]int

// sfTotalDim is the built total index space; must equal SFThreatDim (79856).
var sfTotalDim int

func init() {
	buildSFVictimMap()
	buildSFAttackTables()
	buildSFOffsetsAndBase()
}

// buildSFVictimMap fills the exclusion table + per-half victim slots (SF `map`).
func buildSFVictimMap() {
	// Piece-type order: 0=Pawn 1=Knight 2=Bishop 3=Rook 4=Queen 5=King.
	excl := [sfNumPieceTypes][]int{
		0: {2, 4, 5}, // pawn attacker: no bishop/queen/king victims
		1: {},        // knight: all
		2: {4},       // bishop: no queen
		3: {4},       // rook: no queen
		4: {},        // queen: all
		5: {4, 5},    // king: no queen/king
	}
	for atk := 0; atk < sfNumPieceTypes; atk++ {
		isExcl := [sfNumPieceTypes]bool{}
		for _, v := range excl[atk] {
			isExcl[v] = true
		}
		slot := 0
		for vic := 0; vic < sfNumPieceTypes; vic++ {
			if isExcl[vic] {
				sfVictimSlotHalf[atk][vic] = -1
				continue
			}
			sfVictimAllowed[atk][vic] = true
			sfVictimSlotHalf[atk][vic] = slot
			slot++
		}
		sfNvtHalf[atk] = slot
	}
}

// buildSFAttackTables fills the oriented-frame empty-board attack patterns and their
// per-square popcount sums.
func buildSFAttackTables() {
	for rel := 0; rel < sfNumRelPieces; rel++ {
		relColor := rel / sfNumPieceTypes // 0 = own, 1 = enemy
		pt := chess.PieceType(rel % sfNumPieceTypes)
		total := 0
		for sq := 0; sq < 64; sq++ {
			var bb chess.Bitboard
			if pt == chess.Pawn {
				// Own pawn attacks "up" (WhitePawn); enemy pawn "down" (BlackPawn). No
				// pawns on ranks 1/8 (rank 0 and 7), matching SF's ranks-2..7 table.
				rank := sq / 8
				if rank != 0 && rank != 7 {
					pc := chess.WhitePawn
					if relColor == 1 {
						pc = chess.BlackPawn
					}
					bb = chess.PseudoAttacks(pc, chess.Square(sq), 0)
				}
			} else {
				// Non-pawn attack geometry is color-independent; use the White piece.
				pc := chess.Piece(int(pt)) // WhitePawn=0.. so WhiteKnight=1.. == type index
				bb = chess.PseudoAttacks(pc, chess.Square(sq), 0)
			}
			sfRelAttack[rel][sq] = bb
			total += bb.Count()
		}
		sfAttackTableSize[rel] = total
	}
}

// buildSFOffsetsAndBase fills offsets, edge-ranks, and the cumulative attacker bases.
func buildSFOffsetsAndBase() {
	base := 0
	for rel := 0; rel < sfNumRelPieces; rel++ {
		acc := 0
		for from := 0; from < 64; from++ {
			sfOffsets[rel][from] = acc
			bb := sfRelAttack[rel][from]
			// edge-rank: for each `to` in attacks(from), rank = popcount(attacks & below(to)).
			below := chess.Bitboard(0)
			for to := 0; to < 64; to++ {
				mask := chess.Bitboard(1) << uint(to)
				if bb&mask != 0 {
					sfEdgeRank[rel][from][to] = int16((bb & below).Count())
				}
				below |= mask
			}
			acc += bb.Count()
		}
		pt := rel % sfNumPieceTypes
		sfAttackerBase[rel] = base
		base += 2 * sfNvtHalf[pt] * sfAttackTableSize[rel] // nvt = 2 halves
	}
	sfTotalDim = base
}

// sfThreatIndex returns the threat feature index for the edge (attacker rel-piece at
// oriented square from) → (victim rel-piece at oriented square to), and ok=false if
// the edge is excluded (victim-type exclusion or the same-type dedup drops the from<to
// direction). Squares MUST already be oriented (^56 for black perspective) and mirrored
// (^mir). atkRel/vicRel are 0 for the perspective's own color, 1 for the enemy.
func sfThreatIndex(atkRel int, atkType chess.PieceType, vicRel int, vicType chess.PieceType, from, to int) (int, bool) {
	at := int(atkType)
	vt := int(vicType)
	if !sfVictimAllowed[at][vt] {
		return 0, false
	}
	// Same-type dedup: for atkType==vicType and (opposite color || non-pawn), keep only
	// the from>=to direction (SF semi_excluded). Opposite color ⇔ atkRel != vicRel.
	if at == vt && (atkRel != vicRel || atkType != chess.Pawn) && from < to {
		return 0, false
	}
	rel := atkRel*sfNumPieceTypes + at
	victimSlot := vicRel*sfNvtHalf[at] + sfVictimSlotHalf[at][vt]
	idx := sfAttackerBase[rel] +
		victimSlot*sfAttackTableSize[rel] +
		sfOffsets[rel][from] +
		int(sfEdgeRank[rel][from][to])
	return idx, true
}
