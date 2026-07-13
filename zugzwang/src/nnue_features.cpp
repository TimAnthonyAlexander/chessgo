#include "nnue_features.h"
#include "nnue_arch.h"
#include "bitboard.h"
#include "types.h"

#include <cstdint>
#include <array>

// NNUE feature extraction — a bit-exact C++ port of gomachine's
// internal/nnue/{kingbucket.go, threats_sf.go, enriched.go}. See the porting spec
// in nnue_features.h. Every table and index formula is derived directly from the Go
// reference; the M0 harness pins the output against gomachine's authoritative dump.
//
// Index space:  base  ∈ [0, PsqSize)          king-bucketed + horizontally-mirrored PSQ
//               threat∈ [PsqSize, InputTotal)  SF full-threats (sfThreatIndex + PsqSize)
//
// Piece-type convention: internally we use gomachine's 0-indexed types (Pawn=0..King=5)
// so the port mirrors the Go line-for-line; chesshce's 1-indexed PieceType (PAWN=1) is
// converted at the board boundary (subtract 1).

namespace {

using NNUE::InputDim;   // 768
using NNUE::PsqSize;    // 12288
using NNUE::ThreatBlock;// 79856

// attacks0 returns the empty/occ-blocked attack set of a piece given a 0-indexed type
// (0=Pawn..5=King). Mirrors gomachine chess.attacksFrom: sliders honour occ, leapers
// and pawns ignore it. `c` selects the pawn direction (White up / Black down); it is
// irrelevant for the color-independent non-pawn geometry.
inline U64 attacks0(int t0, Color c, Square s, U64 occ) {
    switch (t0) {
        case 0: return BB::pawn_attacks(c, s);      // Pawn
        case 1: return BB::KnightAttacks[s];        // Knight
        case 2: return BB::bishop_attacks(s, occ);  // Bishop
        case 3: return BB::rook_attacks(s, occ);    // Rook
        case 4: return BB::queen_attacks(s, occ);   // Queen
        case 5: return BB::KingAttacks[s];          // King
    }
    return 0;
}

// SFTables holds the SF18 full-threats index tables, built once. It is a direct port
// of threats_sf.go's package-level vars + init(): buildSFVictimMap / buildSFAttackTables
// / buildSFOffsetsAndBase. All arrays are value-initialized (zero) so the sparse tables
// (victimAllowed, edgeRank) are correct without explicit clears.
struct SFTables {
    static constexpr int NPT = 6;  // Pawn..King (0-indexed)
    static constexpr int NRP = 12; // relColor(2) x type(6)

    bool    victimAllowed[NPT][NPT]{};
    int     victimSlotHalf[NPT][NPT]{};
    int     nvtHalf[NPT]{};
    U64     relAttack[NRP][64]{};
    int     attackTableSize[NRP]{};
    int     offsets[NRP][64]{};
    int16_t edgeRank[NRP][64][64]{};
    int     attackerBase[NRP]{};
    int     totalDim = 0;

    SFTables() {
        buildVictimMap();
        buildAttackTables();
        buildOffsetsAndBase();
    }

    // buildVictimMap: exclusion table + per-color-half victim slots (SF `map`).
    // Piece-type order 0=Pawn 1=Knight 2=Bishop 3=Rook 4=Queen 5=King.
    void buildVictimMap() {
        // excl[atk] = victim types an attacker of atk does NOT record.
        // pawn: no B/Q/K ; knight: all ; bishop: no Q ; rook: no Q ; queen: all ; king: no Q/K.
        static const std::array<std::array<int, 3>, NPT> excl = {{
            {{2, 4, 5}},   // pawn  -> 3 exclusions
            {{-1, -1, -1}},// knight-> none
            {{4, -1, -1}}, // bishop-> Q
            {{4, -1, -1}}, // rook  -> Q
            {{-1, -1, -1}},// queen -> none
            {{4, 5, -1}},  // king  -> Q,K
        }};
        for (int atk = 0; atk < NPT; ++atk) {
            bool isExcl[NPT] = {};
            for (int v : excl[atk])
                if (v >= 0) isExcl[v] = true;
            int slot = 0;
            for (int vic = 0; vic < NPT; ++vic) {
                if (isExcl[vic]) {
                    victimSlotHalf[atk][vic] = -1;
                    continue;
                }
                victimAllowed[atk][vic] = true;
                victimSlotHalf[atk][vic] = slot++;
            }
            nvtHalf[atk] = slot;
        }
    }

    // buildAttackTables: oriented-frame empty-board attack patterns + per-square
    // popcount sums. Own pawns attack "up" (White), enemy pawns "down" (Black); pawns
    // on ranks 1/8 (rank index 0/7) have no pattern. Non-pawns are color-independent.
    void buildAttackTables() {
        for (int rel = 0; rel < NRP; ++rel) {
            int relColor = rel / NPT; // 0 = own, 1 = enemy
            int pt = rel % NPT;
            int total = 0;
            for (int sq = 0; sq < 64; ++sq) {
                U64 bb = 0;
                if (pt == 0) { // pawn
                    int rank = sq / 8;
                    if (rank != 0 && rank != 7) {
                        Color pc = (relColor == 0) ? WHITE : BLACK;
                        bb = BB::pawn_attacks(pc, Square(sq));
                    }
                } else {
                    bb = attacks0(pt, WHITE, Square(sq), 0);
                }
                relAttack[rel][sq] = bb;
                total += BB::popcount(bb);
            }
            attackTableSize[rel] = total;
        }
    }

    // buildOffsetsAndBase: per-from cumulative offsets, edge-ranks, and the cumulative
    // rel-attacker bases (enumeration order own P..K then enemy P..K).
    void buildOffsetsAndBase() {
        int base = 0;
        for (int rel = 0; rel < NRP; ++rel) {
            int acc = 0;
            for (int from = 0; from < 64; ++from) {
                offsets[rel][from] = acc;
                U64 bb = relAttack[rel][from];
                U64 below = 0;
                for (int to = 0; to < 64; ++to) {
                    U64 mask = U64(1) << to;
                    if (bb & mask)
                        edgeRank[rel][from][to] = int16_t(BB::popcount(bb & below));
                    below |= mask;
                }
                acc += BB::popcount(bb);
            }
            int pt = rel % NPT;
            attackerBase[rel] = base;
            base += 2 * nvtHalf[pt] * attackTableSize[rel]; // nvt = 2 color halves
        }
        totalDim = base;
    }

    // threatIndex ports sfThreatIndex: returns the threat feature index for the ordered
    // edge (attacker rel-piece at oriented `from`) -> (victim rel-piece at oriented `to`),
    // or false if the edge is excluded (victim-type exclusion or the same-type dedup that
    // drops the from<to direction). Squares MUST already be oriented (^56 for black) and
    // mirrored (^mir). atkRel/vicRel: 0 = perspective's own color, 1 = enemy. Types are
    // 0-indexed (Pawn=0).
    bool threatIndex(int atkRel, int atkType, int vicRel, int vicType,
                     int from, int to, int& outIdx) const {
        const int at = atkType, vt = vicType;
        if (!victimAllowed[at][vt])
            return false;
        // Same-type dedup: for atkType==vicType and (opposite color || non-pawn), keep
        // only the from>=to direction (SF semi_excluded). Opposite color <=> atkRel!=vicRel.
        if (at == vt && (atkRel != vicRel || atkType != 0 /*Pawn*/) && from < to)
            return false;
        const int rel = atkRel * NPT + at;
        const int victimSlot = vicRel * nvtHalf[at] + victimSlotHalf[at][vt];
        outIdx = attackerBase[rel]
               + victimSlot * attackTableSize[rel]
               + offsets[rel][from]
               + int(edgeRank[rel][from][to]);
        return true;
    }
};

// Meyers singleton — thread-safe one-time init on first use. Requires BB::init() to
// have run (the empty-board slider patterns use the magic tables), which the engine
// does at startup before any eval, exactly as gomachine builds its tables in init().
const SFTables& tables() {
    static const SFTables t;
    return t;
}

} // namespace

namespace NNUE {

// active_features fills `out` with the active base + threat features for `persp`,
// computed from scratch off the current board. Port of appendBucketedBase +
// appendEnrichedFeatures (enriched.go), with the perspective mirror + king bucket from
// kingbucket.go. The base and threat blocks are order-independent (the FT sums columns),
// so we emit them piece-by-piece in a single sweep that computes each piece's attacks once.
void active_features(const Position& pos, Color persp, Features& out) {
    const SFTables& T = tables();
    out.base.clear();
    out.threat.clear();

    // Perspective canonicalization (kingbucket.go): orient by ^56 for Black, then the
    // horizontal mirror (^7) when the oriented king sits on the e-h half. off selects
    // this perspective's copy of the 768-wide PSQ block.
    const int ksq = int(pos.king_square(persp));
    const int ko  = (persp == BLACK) ? (ksq ^ 56) : ksq;
    const int mir = ((ko & 7) >= 4) ? 7 : 0;
    const int bucket = ((ko ^ mir) >> 3) * 2 + (((ko ^ mir) & 7) >> 1);
    const int off = bucket * InputDim;

    // orient maps a real square into the perspective's oriented+mirrored frame — the
    // SAME transform for base piece squares and threat endpoints.
    auto orient = [persp, mir](int s) -> int {
        int r = s;
        if (persp == BLACK) r ^= 56;
        r ^= mir;
        return r;
    };

    const U64 occ = pos.pieces();

    // Sweep every piece. gomachine iterates WhitePawn..BlackKing; we iterate
    // (color, type) — identical set, and both blocks are order-independent.
    for (int c = WHITE; c <= BLACK; ++c) {
        for (int pt = PAWN; pt <= KING; ++pt) {
            U64 bb = pos.pieces(Color(c), PieceType(pt));
            if (!bb) continue;

            const int t0 = pt - 1;                              // 0-indexed type
            const int aRel = (Color(c) != persp) ? 1 : 0;       // 0 = own, 1 = enemy
            const int baseIdx = (aRel * 6 + t0) * 64;           // PSQ sub-block

            U64 b = bb;
            while (b) {
                const Square sq = BB::pop_lsb(b);
                const int rsq = orient(int(sq));

                // base (king-bucketed + mirrored)
                out.base.push_back(off + baseIdx + rsq);

                // threats: every attacker -> occupied-square edge that survives the
                // victim-exclusion / same-type-dedup filter (real-board geometry,
                // oriented endpoints).
                U64 targets = attacks0(t0, Color(c), sq, occ) & occ;
                while (targets) {
                    const Square tsq = BB::pop_lsb(targets);
                    const Piece victim = pos.piece_on(tsq);
                    const int vt0 = int(type_of(victim)) - 1;
                    const int vRel = (color_of(victim) != persp) ? 1 : 0;
                    int idx;
                    if (T.threatIndex(aRel, t0, vRel, vt0, rsq, orient(int(tsq)), idx))
                        out.threat.push_back(PsqSize + idx);
                }
            }
        }
    }
}

} // namespace NNUE
