#include "nnue_features.h"
#include "nnue_arch.h"
#include "bitboard.h"
#include "types.h"

#include <cstdint>
#include <array>
#include <cstdlib>

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

// PerspXform — the per-perspective canonicalization (king bucket + horizontal mirror)
// shared by active_features and the move-aware delta so both orient IDENTICALLY.
struct PerspXform {
    int   off;    // bucket * InputDim — this perspective's base-block offset
    int   mir;    // 0 or 7 — horizontal mirror mask
    Color persp;
    int orient(int s) const {
        int r = s;
        if (persp == BLACK) r ^= 56;
        r ^= mir;
        return r;
    }
};

inline PerspXform make_xform(Square ksq, Color persp) {
    const int k      = int(ksq);
    const int ko     = (persp == BLACK) ? (k ^ 56) : k;
    const int mir    = ((ko & 7) >= 4) ? 7 : 0;
    const int bucket = ((ko ^ mir) >> 3) * 2 + (((ko ^ mir) & 7) >> 1);
    return PerspXform{ bucket * int(InputDim), mir, persp };
}

// base_index — the king-bucketed + mirrored PSQ feature index for a piece of 0-indexed
// type `pt0` and relative color `aRel` (0 = perspective's own, 1 = enemy) on `sq`.
inline int base_index(const PerspXform& x, int aRel, int pt0, Square sq) {
    return x.off + (aRel * 6 + pt0) * 64 + x.orient(int(sq));
}

// emit_piece_threats — append the threat feature indices for ONE attacker piece
// (0-indexed type `pt0`, color `c`, relative color `aRel`) on `sq` against occupancy
// `occ`, reading victims via `pieceAt`. Shared by active_features and the delta so both
// produce byte-identical threat indices (PsqSize + threatIndex per surviving edge).
template <class PieceAt>
inline void emit_piece_threats(const SFTables& T, const PerspXform& x, int aRel,
                               int pt0, Color c, Square sq, U64 occ,
                               PieceAt&& pieceAt, std::vector<int>& out) {
    const int rfrom = x.orient(int(sq));
    U64 targets = attacks0(pt0, c, sq, occ) & occ;
    while (targets) {
        const Square tsq   = BB::pop_lsb(targets);
        const Piece victim = pieceAt(tsq);
        const int   vt0    = int(type_of(victim)) - 1;
        const int   vRel   = (color_of(victim) != x.persp) ? 1 : 0;
        int idx;
        if (T.threatIndex(aRel, pt0, vRel, vt0, rfrom, x.orient(int(tsq)), idx))
            out.push_back(int(PsqSize) + idx);
    }
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
    // horizontal mirror (^7) when the oriented king sits on the e-h half; the bucket
    // selects this perspective's copy of the 768-wide PSQ block.
    const PerspXform x = make_xform(pos.king_square(persp), persp);
    const U64 occ = pos.pieces();
    auto pieceAt = [&pos](Square t) { return pos.piece_on(t); };

    // Sweep every piece. gomachine iterates WhitePawn..BlackKing; we iterate
    // (color, type) — identical set, and both blocks are order-independent.
    for (int c = WHITE; c <= BLACK; ++c) {
        for (int pt = PAWN; pt <= KING; ++pt) {
            U64 bb = pos.pieces(Color(c), PieceType(pt));
            if (!bb) continue;

            const int t0 = pt - 1;                        // 0-indexed type
            const int aRel = (Color(c) != persp) ? 1 : 0; // 0 = own, 1 = enemy

            U64 b = bb;
            while (b) {
                const Square sq = BB::pop_lsb(b);
                out.base.push_back(base_index(x, aRel, t0, sq));
                emit_piece_threats(T, x, aRel, t0, Color(c), sq, occ, pieceAt, out.threat);
            }
        }
    }
}

// changed_edges_delta — cut-1 "correct-by-construction enumerate" move-aware delta.
// Correctness proof (why the from-scratch ASSERT rebuild must match int16-exact):
//   A threat edge (attacker@a -> victim@v) can only differ old vs child if
//     (1) a's occupant changed (a ∈ D), or
//     (2) v's occupant changed (v ∈ D  =>  a attacks a D-square under old or new occ), or
//     (3) a slider a's ray to v gained/lost a blocker b ∈ D (a attacks b under EXACTLY
//         one occupancy  =>  a ∈ attackers_to(b, oldOcc) ∪ attackers_to(b, newOcc)).
//   So every attacker whose edges change lies in
//     affected = D ∪ ⋃_{d∈D} (attackers_to(d,oldOcc) ∪ attackers_to(d,newOcc)).
//   Base-768 features change only on D. For every s ∈ affected we subtract s's FULL old
//   edge set and add its FULL new set; an attacker whose edges did NOT change is either
//   outside affected (untouched) or emits identical old/new edges that cancel in
//   apply_diff. Hence (parent half) + delta == (child half) as int16-column multisets.
void changed_edges_delta(const BoardSnapshot& oldb, const Position& child,
                         bool doW, std::vector<int>& subW, std::vector<int>& addW,
                         bool doB, std::vector<int>& subB, std::vector<int>& addB) {
    const SFTables& T = tables();
    const U64 oldOcc = oldb.occ();
    const U64 newOcc = child.pieces();

    // D = squares whose occupant changed (per-piece bitboard XOR) — robust to castling /
    // en passant / promotion without decoding move flags (a promotion shows as pawn-left
    // at `from` + promo-piece-arrived at `to`; en passant as three changed squares).
    U64 D = 0;
    for (int c = WHITE; c <= BLACK; ++c)
        for (int pt = PAWN; pt <= KING; ++pt)
            D |= oldb.pieces(Color(c), PieceType(pt)) ^ child.pieces(Color(c), PieceType(pt));

    // affected — the both-occupancy seeding is what catches discovered AND retracted
    // slider threats (case 3 above).
    U64 affected = D;
    for (U64 d = D; d;) {
        const Square s = BB::pop_lsb(d);
        affected |= oldb.attackers_to(s, oldOcc);
        affected |= child.attackers_to(s, newOcc);
    }

    auto oldPieceAt = [&oldb](Square t)  { return oldb.piece_on(t); };
    auto newPieceAt = [&child](Square t) { return child.piece_on(t); };

    struct PerspReq { bool on; Color color; std::vector<int>* sub; std::vector<int>* add; };
    const PerspReq reqs[2] = {
        { doW, WHITE, &subW, &addW },
        { doB, BLACK, &subB, &addB },
    };
    for (const PerspReq& p : reqs) {
        if (!p.on) continue;
        // A requested perspective's king did NOT cross a bucket/mirror boundary (else the
        // caller refreshes that half), so parent and child share this transform — take it
        // from the child.
        const PerspXform x = make_xform(child.king_square(p.color), p.color);

        // Base-768: changes only on D squares (piece left / arrived / changed identity).
        for (U64 d = D; d;) {
            const Square s = BB::pop_lsb(d);
            const Piece op = oldb.piece_on(s);
            const Piece np = child.piece_on(s);
            if (op != NO_PIECE)
                p.sub->push_back(base_index(x, (color_of(op) != p.color) ? 1 : 0,
                                            int(type_of(op)) - 1, s));
            if (np != NO_PIECE)
                p.add->push_back(base_index(x, (color_of(np) != p.color) ? 1 : 0,
                                            int(type_of(np)) - 1, s));
        }

        // Threat edges: subtract each affected attacker's FULL old edge set, add its FULL
        // new set. Unchanged edges cancel in apply_diff.
        for (U64 a = affected; a;) {
            const Square s = BB::pop_lsb(a);
            const Piece op = oldb.piece_on(s);
            if (op != NO_PIECE)
                emit_piece_threats(T, x, (color_of(op) != p.color) ? 1 : 0,
                                   int(type_of(op)) - 1, color_of(op), s, oldOcc,
                                   oldPieceAt, *p.sub);
            const Piece np = child.piece_on(s);
            if (np != NO_PIECE)
                emit_piece_threats(T, x, (color_of(np) != p.color) ? 1 : 0,
                                   int(type_of(np)) - 1, color_of(np), s, newOcc,
                                   newPieceAt, *p.add);
        }
    }
}

int perspective_bucket_key(Square ksq, Color persp) {
    const PerspXform x = make_xform(ksq, persp);
    return x.off | x.mir; // off is a multiple of InputDim (768, div by 8); mir ∈ {0,7}
}

bool threat_delta_enabled() {
    // Default ON (banked +43 Elo movetime, coalla 966g LLR 2.95, 2026-07-15). THREATDELTA=0
    // is the parity/debug kill-switch back to the full-enumerate push().
    static const bool on = [] { const char* e = getenv("THREATDELTA"); return !(e && e[0] == '0'); }();
    return on;
}

} // namespace NNUE
