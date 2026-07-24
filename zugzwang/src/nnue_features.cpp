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
using NNUE::BoardSnapshot;

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

// emit_changed_edges — appends ONLY the threat edges that differ old vs new occupancy
// for attacker square `s`, whose OCCUPANT IS UNCHANGED between the old and new board
// (s ∉ D — same piece, so old/new attacker identity is identical). Port of gomachine's
// appendChangedEdges (enriched_delta.go): the THREATDELTA_FAST candidate for the
// enumerate variant's per-affected-attacker full old/new edge emission.
//
// Leaper (knight/king/pawn): the attack set is occupancy-independent, so an edge can
// only change where the TARGET square's occupant changed — i.e. targets in D. Diff
// `PseudoAttacks(pc,s) & D` under old vs new occ.
// Slider (bishop/rook/queen): an edge can only shift along a ray crossing a changed
// square, so restrict to `mask = ⋃ LineBB(s,d)` over d ∈ D, then diff
// `attacks(s,oldOcc)&oldOcc&mask` vs `attacks(s,newOcc)&newOcc&mask` — this captures
// blocked, discovered (ray extends past a departed blocker) and retracted (ray shortens
// at a newly-appeared piece) edges uniformly; unshifted targets on the masked lines
// appear in both sets with the same victim and cancel (well, are simply omitted here —
// unlike the enumerate variant's count-array cancellation, this path never emits them).
template <class OldPieceAt, class NewPieceAt>
inline void emit_changed_edges(const SFTables& T, const PerspXform& x, int aRel,
                               int pt0, Color c, Square s, U64 oldOcc, U64 newOcc, U64 D,
                               OldPieceAt&& oldPieceAt, NewPieceAt&& newPieceAt,
                               std::vector<int>& sub, std::vector<int>& add) {
    const int rfrom = x.orient(int(s));
    U64 oldT, newT;
    if (pt0 == 2 || pt0 == 3 || pt0 == 4) { // Bishop, Rook, Queen
        U64 mask = 0;
        for (U64 d = D; d;) {
            const Square dsq = BB::pop_lsb(d);
            mask |= BB::line_bb(s, dsq);
        }
        oldT = attacks0(pt0, c, s, oldOcc) & oldOcc & mask;
        newT = attacks0(pt0, c, s, newOcc) & newOcc & mask;
    } else { // Pawn, Knight, King
        const U64 a = attacks0(pt0, c, s, oldOcc) & D; // occ-independent; shifts only at D
        oldT = a & oldOcc;
        newT = a & newOcc;
    }
    while (oldT) {
        const Square tsq   = BB::pop_lsb(oldT);
        const Piece victim = oldPieceAt(tsq);
        const int   vt0    = int(type_of(victim)) - 1;
        const int   vRel   = (color_of(victim) != x.persp) ? 1 : 0;
        int idx;
        if (T.threatIndex(aRel, pt0, vRel, vt0, rfrom, x.orient(int(tsq)), idx))
            sub.push_back(int(PsqSize) + idx);
    }
    while (newT) {
        const Square tsq   = BB::pop_lsb(newT);
        const Piece victim = newPieceAt(tsq);
        const int   vt0    = int(type_of(victim)) - 1;
        const int   vRel   = (color_of(victim) != x.persp) ? 1 : 0;
        int idx;
        if (T.threatIndex(aRel, pt0, vRel, vt0, rfrom, x.orient(int(tsq)), idx))
            add.push_back(int(PsqSize) + idx);
    }
}

// ============================================================================
// THREATDELTA_SF — SF18 "touch-only-D" threat delta (default OFF).
//
// Port of Stockfish 18's Position::update_piece_threats: touches ONLY the ≤4
// squares in D (never builds an `affected` set, never calls attackers_to as a
// seed for re-enumerating a full attacker's edge set). At each touched square
// it emits the touched piece's own outgoing edges, the touched square's
// incoming edges (one `threatIndex` call per attacker, no re-walk of the
// attacker's other edges), and — for every SLIDER found while computing
// incoming edges — exactly one discovered/blocked edge at the square beyond.
// See the porting spec (nnue_features.h's doc comment references it) for the
// full derivation/proof; this is a byte-identical-multiset alternate
// implementation of the same threat delta the enumerate path computes.
// ============================================================================

// LiveBoard — a small mutable piece-placement snapshot (byType/byColor
// bitboards + mailbox), seeded from `oldb` and progressively mutated, in the
// exact order and discipline SF's remove_piece/put_piece/swap_piece use, as
// each touch in a move's ordered touch-list is processed. This is what lets a
// touch at square `s` see the CORRECT intermediate occupancy/identity of the
// other ≤3 D squares already processed earlier in the same move's sequence
// (load-bearing for castling — see the spec's worked counterexample).
struct LiveBoard {
    U64   byType[PIECE_TYPE_NB];
    U64   byColor[COLOR_NB];
    Piece board[SQUARE_NB];

    void init(const BoardSnapshot& snap) {
        for (int i = 0; i < PIECE_TYPE_NB; ++i) byType[i] = snap.byType[i];
        for (int i = 0; i < COLOR_NB; ++i)      byColor[i] = snap.byColor[i];
        for (int i = 0; i < SQUARE_NB; ++i)     board[i] = snap.board[i];
    }
    U64   occ()               const { return byType[0]; }
    Piece piece_on(Square s)  const { return board[s]; }
    U64   attackers_to(Square s) const { return Position::attackers_to(byType, byColor, s, byType[0]); }

    // VACATE-shaped mutation: mirrors Position::remove_piece exactly (reads
    // board[s] for the piece identity being removed).
    void remove_piece(Square s) {
        const Piece pc = board[s];
        const U64   b  = BB::square_bb(s);
        byType[0] ^= b;
        byType[type_of(pc)] ^= b;
        byColor[color_of(pc)] ^= b;
        board[s] = NO_PIECE;
    }
    // PLACE-shaped mutation: mirrors Position::put_piece exactly.
    void put_piece(Piece pc, Square s) {
        const U64 b = BB::square_bb(s);
        byType[0] |= b;
        byType[type_of(pc)] |= b;
        byColor[color_of(pc)] |= b;
        board[s] = pc;
    }
};

// ray_pass_minus_between — literal transcription of SF's `RayPassBB[s1][s2] &
// ~BetweenBB[s1][s2]` (spec §2.1/§1.4): the squares strictly beyond s2, away
// from s1, out to the board edge. Squares-only (no occupancy filtering) —
// used only for the noRaysMask suppression test, mirroring SF's
// `(RayPassBB[sliderSq][s] & noRaysContaining) != noRaysContaining`.
inline U64 ray_pass_minus_between(Square s1, Square s2, bool rookLine) {
    const U64 fullLineFromS1 = rookLine ? BB::rook_attacks(s1, 0) : BB::bishop_attacks(s1, 0);
    const U64 fromS2StoppedAtS1 =
        (rookLine ? BB::rook_attacks(s2, BB::square_bb(s1))
                  : BB::bishop_attacks(s2, BB::square_bb(s1)))
        | BB::square_bb(s2);
    return fullLineFromS1 & fromS2StoppedAtS1 & ~BB::between_bb(s1, s2);
}

// touch_sf — the per-square SF touch primitive (spec §2.2). Appends the
// touched piece `pc`'s own outgoing edges + the touched square's incoming
// edges into `out` (sub for a VACATE, add for a PLACE/SWAP-add), and, when
// `computeRay`, at most one discovered edge PER SLIDER found in the incoming
// step into `oppositeOut` (the opposite-sign list — VACATE's discovered edge
// is an add, PLACE's is a sub). `live` is read at exactly the point in the
// move's touch sequence this call represents (already mutated for every
// earlier touch, not yet mutated for this one or any later touch).
inline void touch_sf(const SFTables& T, const PerspXform& x, Color persp,
                     Square s, Piece pc, const LiveBoard& live,
                     bool computeRay, U64 noRaysMask,
                     std::vector<int>& out, std::vector<int>& oppositeOut) {
    const int   pt0  = int(type_of(pc)) - 1;
    const Color c    = color_of(pc);
    const int   aRel = (c != persp) ? 1 : 0;
    const U64   occ  = live.occ();
    const int   rfrom = x.orient(int(s));
    auto pieceAt = [&live](Square t) { return live.piece_on(t); };

    // (1) OUTGOING — identical machinery to today's per-D-square emission.
    emit_piece_threats(T, x, aRel, pt0, c, s, occ, pieceAt, out);

    // (2) INCOMING — one edge per attacker of `s`, no re-walk of the
    // attacker's other edges. Also collect the slider subset for (3).
    const U64 attackers = live.attackers_to(s);
    const U64 sliders    = attackers & (live.byType[ROOK] | live.byType[BISHOP] | live.byType[QUEEN]);
    U64 att = attackers;
    while (att) {
        const Square y    = BB::pop_lsb(att);
        const Piece  apc  = live.piece_on(y);
        const int    ypt0 = int(type_of(apc)) - 1;
        const int    yRel = (color_of(apc) != persp) ? 1 : 0;
        int idx;
        if (T.threatIndex(yRel, ypt0, aRel, pt0, x.orient(int(y)), rfrom, idx))
            out.push_back(int(PsqSize) + idx);
    }

    // (3) DISCOVERED — only sliders found in (2), only if computeRay (never
    // for a SWAP touch — a continuously-occupied square can't discover or
    // block a ray through itself).
    if (computeRay) {
        U64 sl = sliders;
        while (sl) {
            const Square y = BB::pop_lsb(sl);
            const bool rookLine = (rank_of(y) == rank_of(s)) || (file_of(y) == file_of(s));
            const U64 farSet = (rookLine ? BB::rook_attacks(s, occ) : BB::bishop_attacks(s, occ))
                              & occ & BB::line_bb(y, s) & ~BB::square_bb(y);
            if (!farSet) continue; // no far-side occupant on this ray -> nothing discovered
            if ((ray_pass_minus_between(y, s, rookLine) & noRaysMask) == noRaysMask)
                continue; // suppressed: this ray is the moving piece's own line
            const Square f    = BB::lsb(farSet);
            const Piece  ypc  = live.piece_on(y);
            const Piece  fpc  = live.piece_on(f);
            const int    ypt0 = int(type_of(ypc)) - 1;
            const int    yRel = (color_of(ypc) != persp) ? 1 : 0;
            const int    fpt0 = int(type_of(fpc)) - 1;
            const int    fRel = (color_of(fpc) != persp) ? 1 : 0;
            int idx;
            if (T.threatIndex(yRel, ypt0, fRel, fpt0, x.orient(int(y)), x.orient(int(f)), idx))
                oppositeOut.push_back(int(PsqSize) + idx);
        }
    }
}

// TouchOp — one entry of a move's ordered touch-list (spec §2.3). `swap` (SWAP,
// continuously-occupied square: captures/promotions) always runs with
// computeRay=false; otherwise `place` selects VACATE (false) vs PLACE (true).
struct TouchOp {
    Square sq;
    Piece  oldPc;      // meaningful for VACATE and SWAP
    Piece  newPc;      // meaningful for PLACE and SWAP
    bool   swap;
    bool   place;      // ignored when swap
    bool   computeRay; // ignored when swap (always false there)
    U64    noRaysMask;
};

// build_touch_plan_sf — classifies the move PURELY from oldb/child piece
// identity at the D squares (no move-flag decoding, spec §2.3) into an
// ordered touch-list. Returns the touch count (2, 3, or 4; `plan` must have
// capacity >= 4).
template <class Board>
inline int build_touch_plan_sf(const BoardSnapshot& oldb, const Board& child, U64 D,
                               TouchOp* plan) {
    // Castling, tried first. Geometry match (king/rook sit at the fixed FRC
    // destination squares) PLUS a same-move-diff proof: the historical
    // castling-rook origin square (`child.castling_rook_square(flag)` — set
    // once at game start, valid even after the right is later lost) must
    // itself be a member of D, i.e. it actually changed on THIS move. That
    // combination can only be produced by an actual castling move: a
    // non-castling do_move touches exactly one piece's own from/to (plus, for
    // EN_PASSANT, one pure removal) — it can never simultaneously land a king
    // on the fixed castling square AND change the specific historical
    // castling-rook square to a same-color rook at the fixed rook-destination
    // square, unless that piece-pair move WAS the castling move.
    static const int kFlags[4] = { WHITE_OO, WHITE_OOO, BLACK_OO, BLACK_OOO };
    for (int flag : kFlags) {
        const Color  c        = (flag == WHITE_OO || flag == WHITE_OOO) ? WHITE : BLACK;
        const bool   kingside = (flag == WHITE_OO || flag == BLACK_OO);
        const int    rank     = (c == WHITE) ? 0 : 7;
        const Square kto      = make_square(kingside ? 6 : 2, rank);
        const Square rto      = make_square(kingside ? 5 : 3, rank);
        const Square rfrom    = child.castling_rook_square(flag);
        if (rfrom == SQ_NONE) continue;
        if (oldb.piece_on(rfrom) != make_piece(c, ROOK)) continue;
        if (!(D & BB::square_bb(rfrom))) continue;
        if (child.king_square(c) != kto) continue;
        if (child.piece_on(rto) != make_piece(c, ROOK)) continue;
        const Square kfrom = BB::lsb(oldb.pieces(c, KING));
        // D-subset closure — REQUIRED, not redundant: without it, any ordinary quiet
        // move played AFTER this side has already castled can false-positive here,
        // because castling_rook_square/kto/rto are immutable game history that stays
        // "true" long after the right is spent (e.g. king permanently sits at kto, the
        // castled rook still sits at rto) — an unrelated later move that merely walks
        // some OTHER piece off the historical rfrom square (kfrom==kto already, so D
        // wouldn't include any king-square change at all) would otherwise pass every
        // check above. A genuine castling move can only ever touch these <=4 squares —
        // D must not contain anything outside {kfrom,rfrom,kto,rto}.
        if (D & ~(BB::square_bb(kfrom) | BB::square_bb(rfrom) | BB::square_bb(kto) | BB::square_bb(rto)))
            continue;
        const Piece king = make_piece(c, KING);
        const Piece rook = make_piece(c, ROOK);
        // Both removes before either place (Chess960 square-aliasing safety —
        // exactly do_castling's own discipline), all 4 unsuppressed (noRaysMask
        // = ~0ULL), all computeRay=true (remove_piece/put_piece-shaped, never
        // swap_piece-shaped) — still 4 touches even when kto==rfrom or
        // rto==kfrom collapse them to <=3 distinct squares.
        plan[0] = TouchOp{ kfrom, king,     NO_PIECE, false, false, true, ~0ULL };
        plan[1] = TouchOp{ rfrom, rook,     NO_PIECE, false, false, true, ~0ULL };
        plan[2] = TouchOp{ kto,   NO_PIECE, king,     false, true,  true, ~0ULL };
        plan[3] = TouchOp{ rto,   NO_PIECE, rook,     false, true,  true, ~0ULL };
        return 4;
    }

    Square dsq[4]; int nd = 0;
    for (U64 d = D; d; ) dsq[nd++] = BB::pop_lsb(d);

    if (nd == 2) {
        const Square a = dsq[0], b = dsq[1];
        const bool aVacates = (oldb.piece_on(a) != NO_PIECE && child.piece_on(a) == NO_PIECE);
        const Square vac   = aVacates ? a : b;
        const Square other = aVacates ? b : a;
        const U64   fromTo = BB::square_bb(vac) | BB::square_bb(other);
        const Piece op = oldb.piece_on(vac);
        const Piece ov = oldb.piece_on(other);
        const Piece nv = child.piece_on(other);
        if (ov == NO_PIECE) {
            // Quiet move or non-capture promotion (child.piece_on(other) is
            // already the promoted piece directly — no pawn intermediate, §3.3).
            plan[0] = TouchOp{ vac,   op,       NO_PIECE, false, false, true, fromTo };
            plan[1] = TouchOp{ other, NO_PIECE, nv,       false, true,  true, fromTo };
        } else {
            // Capture, possibly + promotion: `from` VACATE (unsuppressed —
            // do_move's plain remove_piece, not move_piece), `to` SWAP
            // (continuously occupied, no ray).
            plan[0] = TouchOp{ vac,   op, NO_PIECE, false, false, true,  ~0ULL };
            plan[1] = TouchOp{ other, ov, nv,       true,  false, false, ~0ULL };
        }
        return 2;
    }

    if (nd == 3) {
        // En passant: exactly one PLACE square (`to`); of the other two
        // VACATE squares, `from` is the one whose old piece equals the mover
        // that landed at `to` (same piece — a pawn); the other is `capsq`,
        // processed FIRST and unsuppressed (do_move removes it before
        // move_piece(from,to) runs).
        int placeIdx = 0;
        for (int i = 0; i < 3; ++i)
            if (oldb.piece_on(dsq[i]) == NO_PIECE) { placeIdx = i; break; }
        const Square to = dsq[placeIdx];
        const Square v0 = dsq[(placeIdx + 1) % 3];
        const Square v1 = dsq[(placeIdx + 2) % 3];
        const Piece  moved    = child.piece_on(to);
        const bool   v0IsFrom = (oldb.piece_on(v0) == moved);
        const Square from  = v0IsFrom ? v0 : v1;
        const Square capsq = v0IsFrom ? v1 : v0;
        const U64 fromTo = BB::square_bb(from) | BB::square_bb(to);
        plan[0] = TouchOp{ capsq, oldb.piece_on(capsq), NO_PIECE, false, false, true, ~0ULL };
        plan[1] = TouchOp{ from,  oldb.piece_on(from),  NO_PIECE, false, false, true, fromTo };
        plan[2] = TouchOp{ to,    NO_PIECE, moved,       false, true,  true, fromTo };
        return 3;
    }

    return 0; // no actual board diff (e.g. a fully-aliased no-op castle) -> nothing to touch
}

// apply_touch_plan_sf — replays an already-built touch plan against a fresh
// LiveBoard for ONE perspective, mutating `live` in the general rule stated
// once in the spec: VACATE touches read-then-clear their own square, PLACE
// touches set-then-read theirs, in exactly the plan's listed order. A SWAP
// runs its sub-touch (old identity), transitions the square (remove+put), then
// its add-touch (new identity) — both with computeRay=false.
inline void apply_touch_plan_sf(const TouchOp* plan, int n, const SFTables& T,
                                const PerspXform& x, Color persp, LiveBoard& live,
                                std::vector<int>& sub, std::vector<int>& add) {
    for (int i = 0; i < n; ++i) {
        const TouchOp& op = plan[i];
        if (op.swap) {
            touch_sf(T, x, persp, op.sq, op.oldPc, live, false, op.noRaysMask, sub, add);
            live.remove_piece(op.sq);
            live.put_piece(op.newPc, op.sq);
            touch_sf(T, x, persp, op.sq, op.newPc, live, false, op.noRaysMask, add, sub);
        } else if (op.place) {
            live.put_piece(op.newPc, op.sq);
            touch_sf(T, x, persp, op.sq, op.newPc, live, op.computeRay, op.noRaysMask, add, sub);
        } else {
            touch_sf(T, x, persp, op.sq, op.oldPc, live, op.computeRay, op.noRaysMask, sub, add);
            live.remove_piece(op.sq);
        }
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
//
// Templatized on the CHILD board type (LAZYACC2): `child` is a live Position at push
// time, or a stored BoardSnapshot when materialize() recomputes a deferred delta from
// two saved boards. `oldb` is always a BoardSnapshot (the pre-move snapshot do_move
// captures, or a slot's stored childBoard playing the "parent" role). The body below
// is verbatim from the pre-LAZYACC2 Position-only version — Position and BoardSnapshot
// now share the exact interface it needs (pieces()/pieces(c,pt)/piece_on/king_square/
// attackers_to/castling_rook_square).
template <class Board>
void changed_edges_delta_impl(const BoardSnapshot& oldb, const Board& child,
                              bool doW, std::vector<int>& subW, std::vector<int>& addW,
                              bool doB, std::vector<int>& subB, std::vector<int>& addB,
                              bool baseSkipW, bool baseSkipB) {
    const SFTables& T = tables();
    const U64 oldOcc = oldb.occ();
    const U64 newOcc = child.pieces();
    const bool fast = threat_delta_fast_enabled();
    const bool sf = threat_delta_sf_enabled();

    // D = squares whose occupant changed (per-piece bitboard XOR) — robust to castling /
    // en passant / promotion without decoding move flags (a promotion shows as pawn-left
    // at `from` + promo-piece-arrived at `to`; en passant as three changed squares).
    U64 D = 0;
    for (int c = WHITE; c <= BLACK; ++c)
        for (int pt = PAWN; pt <= KING; ++pt)
            D |= oldb.pieces(Color(c), PieceType(pt)) ^ child.pieces(Color(c), PieceType(pt));

    // THREATDELTA_SF: build the ordered touch-list ONCE (perspective-independent —
    // it depends only on oldb/child/D, not on which perspective's threat indices are
    // being emitted). Replayed per-perspective below against a fresh LiveBoard.
    TouchOp sfPlan[4];
    int sfPlanN = sf ? build_touch_plan_sf(oldb, child, D, sfPlan) : 0;

    // affected — the both-occupancy seeding is what catches discovered AND retracted
    // slider threats (case 3 above). Only needed by the enumerate/fast branches below —
    // skipped entirely under THREATDELTA_SF, which is the whole point of that path (it
    // never builds an affected set, touching only the O(1) D squares instead).
    U64 affected = D;
    if (!sf) {
        for (U64 d = D; d;) {
            const Square s = BB::pop_lsb(d);
            affected |= oldb.attackers_to(s, oldOcc);
            affected |= child.attackers_to(s, newOcc);
        }
    }

    auto oldPieceAt = [&oldb](Square t)  { return oldb.piece_on(t); };
    auto newPieceAt = [&child](Square t) { return child.piece_on(t); };

    struct PerspReq { bool on; Color color; std::vector<int>* sub; std::vector<int>* add; bool baseSkip; };
    const PerspReq reqs[2] = {
        { doW, WHITE, &subW, &addW, baseSkipW },
        { doB, BLACK, &subB, &addB, baseSkipB },
    };
    for (const PerspReq& p : reqs) {
        if (!p.on) continue;
        // A requested perspective's king did NOT cross a bucket/mirror boundary (else the
        // caller refreshes that half), so parent and child share this transform — take it
        // from the child.
        const PerspXform x = make_xform(child.king_square(p.color), p.color);

        // Base-768: changes only on D squares (piece left / arrived / changed identity).
        // Skipped when baseSkip is set (THREATGATE bucket-cross-same-mirror case): base
        // there shifts by the bucket offset for EVERY piece, not just D, so the caller
        // does a full base swap via emit_base_swap instead. The threat loops below are
        // UNCHANGED and still run in that case — they remain correct because the
        // caller guarantees baseSkip is only set when this perspective's MIRROR (the
        // only thing threat indices depend on) did not flip.
        if (!p.baseSkip) {
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
        }

        if (sf) {
            // THREATDELTA_SF: SF18 touch-only-D path (see the block comment above
            // build_touch_plan_sf). Replay the precomputed plan against a fresh
            // LiveBoard for this perspective — the plan itself is perspective-
            // independent, only the emitted indices (x.orient/threatIndex reads)
            // differ per perspective.
            LiveBoard live;
            live.init(oldb);
            apply_touch_plan_sf(sfPlan, sfPlanN, T, x, p.color, live, *p.sub, *p.add);
        } else if (!fast) {
            // Enumerate variant (shipped cut-1, default): subtract each affected
            // attacker's FULL old edge set, add its FULL new set. Unchanged edges
            // cancel in apply_diff's count array.
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
        } else {
            // THREATDELTA_FAST candidate: Group 1 (s ∈ D, attacker identity changed)
            // still needs its FULL old/new edge set — same as the enumerate variant.
            for (U64 d = D; d;) {
                const Square s = BB::pop_lsb(d);
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
            // Group 2 (s ∈ affected \ D, attacker identity UNCHANGED): masked-line
            // diff — emit ONLY the edges that actually differ, instead of the full
            // old/new edge set.
            for (U64 a = affected & ~D; a;) {
                const Square s = BB::pop_lsb(a);
                const Piece pc = child.piece_on(s); // == oldb.piece_on(s), s ∉ D
                if (pc == NO_PIECE) continue; // defensive; attackers_to never yields an empty square
                emit_changed_edges(T, x, (color_of(pc) != p.color) ? 1 : 0,
                                   int(type_of(pc)) - 1, color_of(pc), s,
                                   oldOcc, newOcc, D, oldPieceAt, newPieceAt,
                                   *p.sub, *p.add);
            }
        }
    }
}

void changed_edges_delta(const BoardSnapshot& oldb, const Position& child,
                         bool doW, std::vector<int>& subW, std::vector<int>& addW,
                         bool doB, std::vector<int>& subB, std::vector<int>& addB,
                         bool baseSkipW, bool baseSkipB) {
    changed_edges_delta_impl(oldb, child, doW, subW, addW, doB, subB, addB, baseSkipW, baseSkipB);
}

void changed_edges_delta(const BoardSnapshot& oldb, const BoardSnapshot& child,
                         bool doW, std::vector<int>& subW, std::vector<int>& addW,
                         bool doB, std::vector<int>& subB, std::vector<int>& addB,
                         bool baseSkipW, bool baseSkipB) {
    changed_edges_delta_impl(oldb, child, doW, subW, addW, doB, subB, addB, baseSkipW, baseSkipB);
}

int perspective_bucket_key(Square ksq, Color persp) {
    const PerspXform x = make_xform(ksq, persp);
    return x.off | x.mir; // off is a multiple of InputDim (768, div by 8); mir ∈ {0,7}
}

int perspective_mirror(Square ksq, Color persp) {
    return make_xform(ksq, persp).mir;
}

bool threat_gate_enabled() {
    // SHIPPED default-ON (2026-07-24): keep threats on the delta path across a bucket
    // cross that keeps the same mirror, refreshing only the base columns. Byte-identical
    // (ASSERT-clean + 5-position full-search node/score/bestmove match) and NPS-positive
    // (~+1.9% interleaved, mechanistic ceiling +2.64%: 87.4% of king-crosses are
    // same-mirror). Kill-switch THREATGATE=0. Mirrors threat_delta_enabled's env style.
    static const bool on = [] { const char* e = getenv("THREATGATE"); return !(e && e[0] == '0'); }();
    return on;
}

// emit_base_swap — the THREATGATE base-column swap for a king move that crosses a
// bucket but keeps the same mirror. Correctness: base_index = x.off + (aRel*6+pt0)*64 +
// x.orient(sq); x.off is the ONLY term that changes when the bucket crosses (mirror and
// hence x.orient are unchanged for every square), and x.off is added identically to
// EVERY piece's index — so swapping the bucket means every single piece's base column
// moves, not just the D squares touched by the king move itself. We therefore subtract
// every piece's base index under the OLD transform (built from the pre-move snapshot,
// so it reflects the parent's actual active columns) and add every piece's base index
// under the NEW transform (built from the child) — a full from-scratch base swap.
// apply_diff's count-array cancellation makes this exact even though every piece is
// touched: a piece whose old and new base index coincide (impossible here since x.off
// differs, but the mechanism is general) would simply net to zero.
void emit_base_swap(const BoardSnapshot& oldb, const Position& child,
                    bool doW, std::vector<int>& subW, std::vector<int>& addW,
                    bool doB, std::vector<int>& subB, std::vector<int>& addB) {
    struct Req { bool on; Color color; std::vector<int>* sub; std::vector<int>* add; };
    const Req reqs[2] = { { doW, WHITE, &subW, &addW }, { doB, BLACK, &subB, &addB } };
    for (const Req& p : reqs) {
        if (!p.on) continue;
        const Square oldK = BB::lsb(oldb.pieces(p.color, KING));
        const PerspXform xo = make_xform(oldK, p.color);
        const PerspXform xn = make_xform(child.king_square(p.color), p.color);
        for (int c = WHITE; c <= BLACK; ++c) {
            const int aRel = (Color(c) != p.color) ? 1 : 0;
            for (int pt = PAWN; pt <= KING; ++pt) {
                const int t0 = pt - 1;
                U64 bo = oldb.pieces(Color(c), PieceType(pt));
                while (bo) { const Square sq = BB::pop_lsb(bo); p.sub->push_back(base_index(xo, aRel, t0, sq)); }
                U64 bn = child.pieces(Color(c), PieceType(pt));
                while (bn) { const Square sq = BB::pop_lsb(bn); p.add->push_back(base_index(xn, aRel, t0, sq)); }
            }
        }
    }
}

bool threat_delta_enabled() {
    // Default ON (banked +43 Elo movetime, coalla 966g LLR 2.95, 2026-07-15). THREATDELTA=0
    // is the parity/debug kill-switch back to the full-enumerate push().
    static const bool on = [] { const char* e = getenv("THREATDELTA"); return !(e && e[0] == '0'); }();
    return on;
}

bool threat_delta_fast_enabled() {
    // Default ON (shipped: +16.7 Elo movetime, LB +7.8, coalla 1600g LLR 1.93 trend-accept,
    // 2026-07-16). The masked-line diff inside changed_edges_delta emits only the edges that
    // actually change; eval is ASSERT-proven byte-identical to the enumerate variant (pure NPS).
    // THREATDELTA_FAST=0 is the parity/debug kill-switch back to the full-enumerate diff.
    // Only consulted when threat_delta_enabled() is already true (push_delta's caller).
    static const bool on = [] { const char* e = getenv("THREATDELTA_FAST"); return !(e && e[0] == '0'); }();
    return on;
}

bool threat_delta_sf_enabled() {
    // Default OFF (design-only, cut-1 port of SF18's touch-only-D update_piece_threats —
    // see build_touch_plan_sf/touch_sf above): THREATDELTA_SF=1 switches
    // changed_edges_delta's per-perspective threat loop to the SF-shaped path, which never
    // builds an `affected` set and touches only the <=4 D squares directly. The enumerate
    // path (threat_delta_fast_enabled()==false) remains the correctness oracle/default;
    // THREATDELTA_FAST is unaffected by (and independent of) this flag — only one of the
    // three branches runs per call. Only consulted when threat_delta_enabled() is true.
    static const bool on = [] { const char* e = getenv("THREATDELTA_SF"); return e && e[0] == '1'; }();
    return on;
}

} // namespace NNUE
