#include "eval.h"
#include "bitboard.h"
#include "nnue.h"
#include "nnue_internal.h"   // SATFIX reads the L1 rail count (g_satdiag.l1live)
#include "nnue_accumulator.h"
#include <cstdlib>
#include <cmath>

using namespace BB;

namespace {

// ---- PeSTO material (mg, eg) indexed by PieceType (PAWN..QUEEN) ----
const int MgValue[7] = {0, 82, 337, 365, 477, 1025, 0};
const int EgValue[7] = {0, 94, 281, 297, 512, 936, 0};

// ---- PeSTO piece-square tables, printed rank8-first (a8 = index 0) ----
const int PawnMG[64] = {
      0,   0,   0,   0,   0,   0,   0,   0,
     98, 134,  61,  95,  68, 126,  34, -11,
     -6,   7,  26,  31,  65,  56,  25, -20,
    -14,  13,   6,  21,  23,  12,  17, -23,
    -27,  -2,  -5,  12,  17,   6,  10, -25,
    -26,  -4,  -4, -10,   3,   3,  33, -12,
    -35,  -1, -20, -23, -15,  24,  38, -22,
      0,   0,   0,   0,   0,   0,   0,   0,
};
const int PawnEG[64] = {
      0,   0,   0,   0,   0,   0,   0,   0,
    178, 173, 158, 134, 147, 132, 165, 187,
     94, 100,  85,  67,  56,  53,  82,  84,
     32,  24,  13,   5,  -2,   4,  17,  17,
     13,   9,  -3,  -7,  -7,  -8,   3,  -1,
      4,   7,  -6,   1,   0,  -5,  -1,  -8,
     13,   8,   8,  10,  13,   0,   2,  -7,
      0,   0,   0,   0,   0,   0,   0,   0,
};
const int KnightMG[64] = {
   -167, -89, -34, -49,  61, -97, -15,-107,
    -73, -41,  72,  36,  23,  62,   7, -17,
    -47,  60,  37,  65,  84, 129,  73,  44,
     -9,  17,  19,  53,  37,  69,  18,  22,
    -13,   4,  16,  13,  28,  19,  21,  -8,
    -23,  -9,  12,  10,  19,  17,  25, -16,
    -29, -53, -12,  -3,  -1,  18, -14, -19,
   -105, -21, -58, -33, -17, -28, -19, -23,
};
const int KnightEG[64] = {
    -58, -38, -13, -28, -31, -27, -63, -99,
    -25,  -8, -25,  -2,  -9, -25, -24, -52,
    -24, -20,  10,   9,  -1,  -9, -19, -41,
    -17,   3,  22,  22,  22,  11,   8, -18,
    -18,  -6,  16,  25,  16,  17,   4, -18,
    -23,  -3,  -1,  15,  10,  -3, -20, -22,
    -42, -20, -10,  -5,  -2, -20, -23, -44,
    -29, -51, -23, -15, -22, -18, -50, -64,
};
const int BishopMG[64] = {
    -29,   4, -82, -37, -25, -42,   7,  -8,
    -26,  16, -18, -13,  30,  59,  18, -47,
    -16,  37,  43,  40,  35,  50,  37,  -2,
     -4,   5,  19,  50,  37,  37,   7,  -2,
     -6,  13,  13,  26,  34,  12,  10,   4,
      0,  15,  15,  15,  14,  27,  18,  10,
      4,  15,  16,   0,   7,  21,  33,   1,
    -33,  -3, -14, -21, -13, -12, -39, -21,
};
const int BishopEG[64] = {
    -14, -21, -11,  -8,  -7,  -9, -17, -24,
     -8,  -4,   7, -12,  -3, -13,  -4, -14,
      2,  -8,   0,  -1,  -2,   6,   0,   4,
     -3,   9,  12,   9,  14,  10,   3,   2,
     -6,   3,  13,  19,   7,  10,  -3,  -9,
    -12,  -3,   8,  10,  13,   3,  -7, -15,
    -14, -18,  -7,  -1,   4,  -9, -15, -27,
    -23,  -9, -23,  -5,  -9, -16,  -5, -17,
};
const int RookMG[64] = {
     32,  42,  32,  51,  63,   9,  31,  43,
     27,  32,  58,  62,  80,  67,  26,  44,
     -5,  19,  26,  36,  17,  45,  61,  16,
    -24, -11,   7,  26,  24,  35,  -8, -20,
    -36, -26, -12,  -1,   9,  -7,   6, -23,
    -45, -25, -16, -17,   3,   0,  -5, -33,
    -44, -16, -20,  -9,  -1,  11,  -6, -71,
    -19, -13,   1,  17,  16,   7, -37, -26,
};
const int RookEG[64] = {
     13,  10,  18,  15,  12,  12,   8,   5,
     11,  13,  13,  11,  -3,   3,   8,   3,
      7,   7,   7,   5,   4,  -3,  -5,  -3,
      4,   3,  13,   1,   2,   1,  -1,   2,
      3,   5,   8,   4,  -5,  -6,  -8, -11,
     -4,   0,  -5,  -1,  -7, -12,  -8, -16,
     -6,  -6,   0,   2,  -9,  -9, -11,  -3,
     -9,   2,   3,  -1,  -5, -13,   4, -20,
};
const int QueenMG[64] = {
    -28,   0,  29,  12,  59,  44,  43,  45,
    -24, -39,  -5,   1, -16,  57,  28,  54,
    -13, -17,   7,   8,  29,  56,  47,  57,
    -27, -27, -16, -16,  -1,  17,  -2,   1,
     -9, -26,  -9, -10,  -2,  -4,   3,  -3,
    -14,   2, -11,  -2,  -5,   2,  14,   5,
    -35,  -8,  11,   2,   8,  15,  -3,   1,
     -1, -18,  -9,  10, -15, -25, -31, -50,
};
const int QueenEG[64] = {
     -9,  22,  22,  27,  27,  19,  10,  20,
    -17,  20,  32,  41,  58,  25,  30,   0,
    -20,   6,   9,  49,  47,  35,  19,   9,
      3,  22,  24,  45,  57,  40,  57,  36,
    -18,  28,  19,  47,  31,  34,  39,  23,
    -16, -27,  15,   6,   9,  17,  10,   5,
    -22, -23, -30, -16, -16, -23, -36, -32,
    -33, -28, -22, -43,  -5, -32, -20, -41,
};
const int KingMG[64] = {
    -65,  23,  16, -15, -56, -34,   2,  13,
     29,  -1, -20,  -7,  -8,  -4, -38, -29,
     -9,  24,   2, -16, -20,   6,  22, -22,
    -17, -20, -12, -27, -30, -25, -14, -36,
    -49,  -1, -27, -39, -46, -44, -33, -51,
    -14, -14, -22, -46, -44, -30, -15, -27,
      1,   7,  -8, -64, -43, -16,   9,   8,
    -15,  36,  12, -54,   8, -28,  24,  14,
};
const int KingEG[64] = {
    -74, -35, -18, -18, -11,  15,   4, -17,
    -12,  17,  14,  17,  17,  38,  23,  11,
     10,  17,  23,  15,  20,  45,  44,  13,
     -8,  22,  24,  27,  26,  33,  26,   3,
    -18,  -4,  21,  24,  27,  23,   9, -11,
    -19,  -3,  11,  21,  23,  16,   7,  -9,
    -27, -11,   4,  13,  14,   4,  -5, -17,
    -53, -34, -21, -11, -28, -14, -24, -43,
};

const int* PstMG[7] = {nullptr, PawnMG, KnightMG, BishopMG, RookMG, QueenMG, KingMG};
const int* PstEG[7] = {nullptr, PawnEG, KnightEG, BishopEG, RookEG, QueenEG, KingEG};

// Combined tables: [piece][square] already including material, from White's view.
int MgTable[PIECE_NB][64];
int EgTable[PIECE_NB][64];
const int PhaseInc[7] = {0, 0, 1, 1, 2, 4, 0};

// Extra HCE knobs (mg, eg)
const int BishopPairMG = 22,  BishopPairEG = 40;
const int RookOpenMG   = 26,  RookOpenEG   = 12;
const int RookSemiMG   = 11,  RookSemiEG   = 8;
const int IsolatedMG   = -14, IsolatedEG   = -12;
const int DoubledMG    = -8,  DoubledEG    = -22;
const int PassedMG[8]  = {0, 5, 12, 20, 38, 68, 120, 0};
const int PassedEG[8]  = {0, 8, 18, 32, 62, 110, 180, 0};
const int TempoMG      = 18,  TempoEG      = 8;
// Mobility bonus per attacked square, by piece type (rough tuned)
const int MobMG[7] = {0, 0, 4, 5, 3, 2, 0};
const int MobEG[7] = {0, 0, 3, 4, 5, 4, 0};
// King-zone attack weights
const int KingAttackWeight[7] = {0, 0, 20, 20, 40, 80, 0};

U64 FileMask[8], AdjacentFiles[8];
U64 PassedPawnMask[COLOR_NB][SQUARE_NB];
U64 ForwardFile[COLOR_NB][SQUARE_NB];

} // namespace

void Eval::init() {
    for (int pt = PAWN; pt <= KING; ++pt) {
        for (int s = 0; s < 64; ++s) {
            int wIdx = s ^ 56; // white reads flipped table
            MgTable[make_piece(WHITE, PieceType(pt))][s] = MgValue[pt] + PstMG[pt][wIdx];
            EgTable[make_piece(WHITE, PieceType(pt))][s] = EgValue[pt] + PstEG[pt][wIdx];
            MgTable[make_piece(BLACK, PieceType(pt))][s] = MgValue[pt] + PstMG[pt][s];
            EgTable[make_piece(BLACK, PieceType(pt))][s] = EgValue[pt] + PstEG[pt][s];
        }
    }
    for (int f = 0; f < 8; ++f) {
        FileMask[f] = BB::FileBB[f];
        AdjacentFiles[f] = (f > 0 ? BB::FileBB[f - 1] : 0) | (f < 7 ? BB::FileBB[f + 1] : 0);
    }
    for (int s = 0; s < 64; ++s) {
        int f = file_of(Square(s)), r = rank_of(Square(s));
        U64 wForward = 0, bForward = 0;
        for (int rr = r + 1; rr <= 7; ++rr) wForward |= BB::RankBB[rr];
        for (int rr = r - 1; rr >= 0; --rr) bForward |= BB::RankBB[rr];
        ForwardFile[WHITE][s] = wForward & FileMask[f];
        ForwardFile[BLACK][s] = bForward & FileMask[f];
        U64 span = FileMask[f] | AdjacentFiles[f];
        PassedPawnMask[WHITE][s] = wForward & span;
        PassedPawnMask[BLACK][s] = bForward & span;
    }
}

namespace {

struct EvalData {
    U64 kingZone[COLOR_NB];
    int kingAttackers[COLOR_NB];
    int kingAttackScore[COLOR_NB];
};

template <Color Us>
void eval_pawns(const Position& pos, int& mg, int& eg) {
    constexpr Color Them = ~Us;
    U64 ourPawns = pos.pieces(Us, PAWN);
    U64 theirPawns = pos.pieces(Them, PAWN);
    U64 pawns = ourPawns;
    int sign = (Us == WHITE) ? 1 : -1;
    while (pawns) {
        Square s = pop_lsb(pawns);
        int f = file_of(s), r = rank_of(s);
        int relRank = (Us == WHITE) ? r : 7 - r;
        // Isolated
        if (!(ourPawns & AdjacentFiles[f])) { mg += sign * IsolatedMG; eg += sign * IsolatedEG; }
        // Doubled (another own pawn ahead on same file)
        if (ForwardFile[Us][s] & ourPawns) { mg += sign * DoubledMG; eg += sign * DoubledEG; }
        // Passed
        if (!(PassedPawnMask[Us][s] & theirPawns)) {
            mg += sign * PassedMG[relRank];
            eg += sign * PassedEG[relRank];
        }
    }
}

template <Color Us, PieceType Pt>
void eval_pieces(const Position& pos, int& mg, int& eg, EvalData& ed) {
    constexpr Color Them = ~Us;
    int sign = (Us == WHITE) ? 1 : -1;
    U64 bb = pos.pieces(Us, Pt);
    U64 occ = pos.pieces();
    U64 ourPieces = pos.pieces(Us);
    U64 ourPawns = pos.pieces(Us, PAWN);
    U64 theirPawns = pos.pieces(Them, PAWN);
    // squares attacked by enemy pawns (bad for our mobility)
    U64 enemyPawnAtt = 0;
    {
        U64 tp = theirPawns;
        if (Them == WHITE) enemyPawnAtt = shift<NORTH_EAST>(tp) | shift<NORTH_WEST>(tp);
        else               enemyPawnAtt = shift<SOUTH_EAST>(tp) | shift<SOUTH_WEST>(tp);
    }

    while (bb) {
        Square s = pop_lsb(bb);
        U64 att = BB::attacks<Pt>(s, occ);

        // Mobility (exclude own pieces and squares attacked by enemy pawns)
        U64 mobArea = att & ~ourPieces & ~enemyPawnAtt;
        int mobCount = popcount(mobArea);
        mg += sign * MobMG[Pt] * mobCount;
        eg += sign * MobEG[Pt] * mobCount;

        // King attack pressure
        U64 zoneHits = att & ed.kingZone[Them];
        if (zoneHits) {
            ed.kingAttackers[Us]++;
            ed.kingAttackScore[Us] += KingAttackWeight[Pt] * popcount(zoneHits);
        }

        if (Pt == ROOK) {
            int f = file_of(s);
            if (!(FileMask[f] & (ourPawns | theirPawns))) { mg += sign * RookOpenMG; eg += sign * RookOpenEG; }
            else if (!(FileMask[f] & ourPawns))           { mg += sign * RookSemiMG; eg += sign * RookSemiEG; }
        }
    }
}

template <Color Us>
void eval_king_safety(const Position& pos, int& mg, EvalData& ed) {
    int sign = (Us == WHITE) ? 1 : -1;
    // More/stronger attackers on our king zone → penalty for us
    int attackers = ed.kingAttackers[~Us];
    if (attackers >= 2) {
        int danger = ed.kingAttackScore[~Us];
        mg -= sign * (danger * (attackers - 1)) / 8;
    }
}

} // namespace

static int hce_evaluate(const Position& pos) {
    int mg = 0, eg = 0, phase = 0;

    // Material + PST (tapered) and phase
    for (Square s = A1; s <= H8; s = Square(s + 1)) {
        Piece pc = pos.piece_on(s);
        if (pc == NO_PIECE) continue;
        int sign = (color_of(pc) == WHITE) ? 1 : -1;
        mg += sign > 0 ? MgTable[pc][s] : -MgTable[pc][s];
        eg += sign > 0 ? EgTable[pc][s] : -EgTable[pc][s];
        phase += PhaseInc[type_of(pc)];
    }

    EvalData ed{};
    for (Color c : {WHITE, BLACK}) {
        Square ksq = pos.king_square(c);
        ed.kingZone[c] = KingAttacks[ksq] | square_bb(ksq);
    }

    eval_pawns<WHITE>(pos, mg, eg);
    eval_pawns<BLACK>(pos, mg, eg);
    eval_pieces<WHITE, KNIGHT>(pos, mg, eg, ed);
    eval_pieces<BLACK, KNIGHT>(pos, mg, eg, ed);
    eval_pieces<WHITE, BISHOP>(pos, mg, eg, ed);
    eval_pieces<BLACK, BISHOP>(pos, mg, eg, ed);
    eval_pieces<WHITE, ROOK>(pos, mg, eg, ed);
    eval_pieces<BLACK, ROOK>(pos, mg, eg, ed);
    eval_pieces<WHITE, QUEEN>(pos, mg, eg, ed);
    eval_pieces<BLACK, QUEEN>(pos, mg, eg, ed);

    eval_king_safety<WHITE>(pos, mg, ed);
    eval_king_safety<BLACK>(pos, mg, ed);

    // Bishop pair
    if (pos.count(WHITE, BISHOP) >= 2) { mg += BishopPairMG; eg += BishopPairEG; }
    if (pos.count(BLACK, BISHOP) >= 2) { mg -= BishopPairMG; eg -= BishopPairEG; }

    // Tempo (side to move gets a small bump)
    int tempoSign = (pos.side_to_move() == WHITE) ? 1 : -1;
    mg += tempoSign * TempoMG;
    eg += tempoSign * TempoEG;

    // Tapered interpolation
    int mgPhase = phase > 24 ? 24 : phase;
    int egPhase = 24 - mgPhase;
    int score = (mg * mgPhase + eg * egPhase) / 24;

    // Return relative to side to move
    return (pos.side_to_move() == WHITE) ? score : -score;
}

// ---- Interim material-gradient term (MATGRAD, default OFF) --------------------
// Our single-output NNUE saturates in clearly-won/lost positions: past ~a rook the
// per-move material gradient collapses (a 2nd rook adds ~0 cp), so the search can't
// tell "down a queen" from "down a queen + a rook" and shuffles material away. SF
// avoids this with a linear psqt head (~half its eval) that never saturates; we have
// no such head until the two-head retrain. This is the cheap hand-coded stand-in:
// once |net eval| enters the saturating zone, blend in a small explicit material term
// so more material always evaluates strictly higher. Inert in normal play (weight 0
// below T_LO) to avoid double-counting material the net already handles correctly.
// Constants hand-set; promote to UCI options for SPSA if the SPRT rewards it.
namespace {

static inline bool matgrad_enabled() {
    static const bool on = [] { const char* e = getenv("MATGRAD"); return e && e[0] == '1'; }();
    return on;
}

// Small per-piece weights (NOT full material values): just enough to order moves the
// saturated net scores identically (a knight = 24 cp >> the ~12 cp residual flat-noise),
// while staying negligible next to the net's ~300 cp/piece where the net is still live.
constexpr int MatGradVal[7] = {0, 8, 24, 24, 40, 72, 0}; // -,P,N,B,R,Q,K
constexpr int MatGradTLo = 800;   // below this |net|, term is off (net gradient is fine)
constexpr int MatGradTHi = 1600;  // at/above this |net|, term at full weight (net is flat)
constexpr int MatGradCap = 400;   // clamp the raw material delta (guards pathological
                                  // multi-queen imbalances; won't bind in normal decisive play)

// stm-relative gated material term to add onto the net eval.
int material_gradient(const Position& pos, int netEval) {
    int a = std::abs(netEval);
    if (a <= MatGradTLo) return 0;
    Color us = pos.side_to_move(), them = ~us;
    int diff = 0;
    for (int pt = PAWN; pt <= QUEEN; ++pt)
        diff += MatGradVal[pt] * (pos.count(us, PieceType(pt)) - pos.count(them, PieceType(pt)));
    if (diff >  MatGradCap) diff =  MatGradCap;
    if (diff < -MatGradCap) diff = -MatGradCap;
    const int span = MatGradTHi - MatGradTLo;
    int wnum = a - MatGradTLo;
    if (wnum > span) wnum = span;          // linear ramp weight = wnum/span in [0,1]
    return diff * wnum / span;
}

// ---- HCE-resolution blend (HCEBLEND, default OFF) -----------------------------
// MATGRAD only restores a *material* gradient, but the net loses ALL resolution when
// saturated — including positional (e.g. a knight on a2 (dying) vs a6 (passive) is
// equal material, yet HCE rates a2 ~41 cp worse via PST+mobility while the net calls
// them identical). So when the net saturates, blend in a fraction of the full
// hand-crafted eval (material + PST + mobility + king-safety) — which, being a linear
// sum, never saturates and keeps full resolution. This is the "route to HCE when the
// NNUE is in a known-weak regime" idea (cf. SF's smallnet routing on material
// imbalance), instance #1 = the clearly-won/lost regime. Same saturation ramp as
// MATGRAD; inert (byte-identical) in normal play. hce_evaluate needs Eval::init(),
// which runs unconditionally at startup, so it is safe to call with NNUE loaded.
static inline bool hceblend_enabled() {
    // Default ON (kill-switch, like LAZYACC/THREATDELTA). Root-gated: byte-identical in
    // normal play (SPRT +0.5 +/- 9 @1372g), engages HCE resistance only when the actual
    // position is lost. HCEBLEND=0 disables.
    static const bool on = [] { const char* e = getenv("HCEBLEND"); return !(e && e[0] == '0'); }();
    return on;
}

constexpr int HceTLo = 800;    // below this |net|, no blend (net resolution is fine)
constexpr int HceTHi = 1600;   // at/above, full blend weight
constexpr int HceNum = 1, HceDen = 3;  // blend ~1/3 of the HCE eval in the saturated zone
constexpr int HceCap = 300;    // clamp the blend contribution (bounds extreme HCE swings)
constexpr int HceRootLostThresh = 700; // root net below this (stm losing) arms the blend

// Root-gate flag (per-search, thread-local for Lazy-SMP). Set once at the root by
// Eval::begin_search: the blend engages ONLY when the ROOT is clearly losing — not at
// the many transiently-losing NODES a normal search tree contains. A non-lost search
// thus stays byte-identical to no-blend (that was the source of the standard-play dip:
// firing at internal losing nodes). Reset every search, so a stale value can't leak.
thread_local bool g_hceblend_active = false;

// stm-relative gated HCE-resolution term to add onto the net eval. LOSING-SIDE ONLY:
// the net is strong and trustworthy when clearly WINNING (it converts fine), so we
// leave winning-side play to the pure net and blend HCE resolution in only when the
// side to move is clearly LOSING — that's the sole regime where the net flails and
// gives material away. (Blending on the winning side just injected weaker-HCE noise;
// that was the small standard-play regression.)
int hce_blend(const Position& pos, int netEval) {
    if (!g_hceblend_active) return 0;                    // root not lost → never blend (byte-identical)
    if (netEval >= -HceTLo) return 0;                    // not clearly losing → pure net
    int a = -netEval;                                    // depth into the losing zone
    int contrib = hce_evaluate(pos) * HceNum / HceDen;   // full-resolution hand eval, scaled
    if (contrib >  HceCap) contrib =  HceCap;
    if (contrib < -HceCap) contrib = -HceCap;
    const int span = HceTHi - HceTLo;
    int wnum = a - HceTLo;
    if (wnum > span) wnum = span;
    return contrib * wnum / span;
}

// ---- SATFIX: rail-collapse detection + HCE substitution (SATFIX=1) ------------
// MEASURED root cause of the "hangs everything when the game is decided" bug, and the
// reason MATGRAD/HCEBLEND above cannot fix it.
//
// The tail's L1 layer is only D2=16 wide and its activation is SCReLU
// (clamp(x,0,1)^2). In a balanced position 14 of those 16 lanes are already pinned at
// a rail, i.e. the entire eval rides on ~2 live lanes. Once either side is up about a
// queen, ALL 16 rail: l1[] becomes a fixed 0/1 vector, so the L2 GEMV and the output
// GEMV are applied to a constant input, and the eval degenerates into a table lookup
// keyed only by (output bucket, rail pattern). Five structurally unrelated
// down-a-queen positions — different openings, different pawn structures, one with an
// extra black rook and bishop — all evaluate to EXACTLY -887. Not compressed: constant.
// With zero eval gradient the search cannot distinguish "keep the queen" from "hang
// the queen too", so move choice among losing moves is arbitrary. Symmetric: the
// winning side rails just as hard (constant +1086), which is why play is also sloppy
// when far ahead.
//
// MATGRAD/HCEBLEND both ramp their correction on |net eval| over [800,1600]. But the
// railed constant IS the net eval (-887 in bucket 7), so (a) the ramp weight is pinned
// near 11% and the correction is worth ~30-40 cp against a 900 cp blunder, and (b) the
// gate variable is itself a constant, so it carries no information about how lost the
// position is. Correcting an eval by a fraction that is keyed to that same dead eval
// cannot work at any constant setting.
//
// SATFIX gates on the actual information loss instead: `l1live`, the number of L1 lanes
// still off their rails (maintained on every eval in nnue_eval.cpp). live > 0 means the
// net is still saying something about this position, so it is used untouched — normal
// play is byte-identical. live == 0 means the net's output is a constant, so it is
// replaced outright by the hand-crafted eval, which is a linear sum and therefore
// monotone in material at full piece values and never saturates. The substitution is
// close to continuous at the boundary by construction (railing sets in around a queen,
// where the HCE reads about -900 and the railed constant is -887), so neighbouring
// netted and substituted nodes stay on the same scale for RFP/futility/razoring.
// SATFIX=1 substitutes the HCE outright. That restores the gradient but also moves the
// SCALE: the railed constant is inflated relative to the hand eval (up one bishop rails
// to +1086 while the HCE reads +443), so a railed node and a still-live neighbour end up
// on different scales, which the eval-margin heuristics (RFP, razoring, futility, time
// management) do read. SATFIX=2 keeps the net's constant as the ANCHOR and adds only the
// HCE's deviation from the value it typically shows at rail onset — so the eval stays on
// the net's scale where the rails begin, and every further material change moves it by a
// full piece value. Continuity check: up a bishop -> 1086 + (443 - 450) = 1079.
// SatHceRef is the onset baseline, overridable for tuning (SPSA candidate).
static inline int satfix_mode() {
    static const int mode = [] { const char* e = getenv("SATFIX"); return e ? atoi(e) : 0; }();
    return mode;
}
static inline int sat_hce_ref() {
    static const int r = [] { const char* e = getenv("SATHCEREF"); return e ? atoi(e) : 450; }();
    return r;
}

// stm-relative replacement eval for a node whose net output has railed to a constant.
int sat_substitute(const Position& pos, int raw, int mode) {
    const int hce = hce_evaluate(pos);
    if (mode == 1) return hce;                                  // pure HCE
    const int ref = raw >= 0 ? sat_hce_ref() : -sat_hce_ref();  // mode 2: anchored
    return raw + (hce - ref);
}

} // namespace

// NNUE dispatch: route the static eval through the loaded net when present,
// else fall back to the hand-crafted eval. Both return stm-relative centipawns.
int Eval::evaluate(const Position& pos) {
    if (!NNUE::loaded()) return hce_evaluate(pos);
    // In-search: read the incremental accumulator the search maintains on the position.
    // Outside search (no stack attached): the from-scratch net eval.
    NNUE::AccStack* a = pos.nnue_acc();
    int v = a ? a->eval(pos) : NNUE::evaluate(pos);
    const int raw = v;   // gate both correction terms on the raw net eval
    // SATFIX (see above): every L1 lane railed => the net output is a constant with no
    // gradient, so hand this node to the never-saturating hand eval.
    const int satMode = satfix_mode();
    if (satMode != 0 && NNUE::g_satdiag.l1live == 0)
        return sat_substitute(pos, raw, satMode);
    if (matgrad_enabled())  v += material_gradient(pos, raw);
    if (hceblend_enabled()) v += hce_blend(pos, raw);
    return v;
}

// HCEBLEND root-gate (see eval.h): arm the blend for this search iff the ROOT is clearly
// losing. Uses the RAW root eval (no blend). Thread-local, so each Lazy-SMP worker gates
// independently from its own root copy; disarms when HCEBLEND is off.
void Eval::begin_search(const Position& rootPos) {
    if (!hceblend_enabled()) { g_hceblend_active = false; return; }
    int raw;
    if (!NNUE::loaded())                              raw = hce_evaluate(rootPos);
    else if (NNUE::AccStack* a = rootPos.nnue_acc())  raw = a->eval(rootPos);
    else                                              raw = NNUE::evaluate(rootPos);
    g_hceblend_active = (raw < -HceRootLostThresh);
}
