#include "zug_tb.h"
#include "bitboard.h"
#include "movegen.h"
#include "syzygy/tbprobe.h"  // Fathom (C, C++-compatible via its own __cplusplus guards)

#include <algorithm>
#include <mutex>

namespace TB {

static bool loaded_ = false;

bool init(const char* path) {
    loaded_ = false;
    if (!path || !*path) return false;
    if (!tb_init(path)) return false;
    if (TB_LARGEST == 0) return false;  // path resolved but no tables found
    loaded_ = true;
    return true;
}

bool     loaded()     { return loaded_; }
unsigned max_pieces() { return TB_LARGEST; }

static inline unsigned ep_for_fathom(const Position& pos) {
    // Fathom wants the ep TARGET square (0 = none). a1(0) is never a legal ep square,
    // so 0 is an unambiguous "none" sentinel; zug uses SQ_NONE(64).
    Square e = pos.ep_square();
    return (e == SQ_NONE) ? 0u : (unsigned) e;
}

bool probe_wdl(const Position& pos, int& result) {
    unsigned res = tb_probe_wdl_impl(
        pos.pieces(WHITE), pos.pieces(BLACK), pos.pieces(KING),
        pos.pieces(QUEEN), pos.pieces(ROOK), pos.pieces(BISHOP),
        pos.pieces(KNIGHT), pos.pieces(PAWN),
        ep_for_fathom(pos), pos.side_to_move() == WHITE);
    if (res == TB_RESULT_FAILED) return false;
    // Hand the caller all FIVE verdicts, on SF's WDLScore scale (~sf18-arm/src/syzygy/
    // tbprobe.h:34: WDLLoss=-2, WDLBlessedLoss=-1, WDLDraw=0, WDLCursedWin=+1,
    // WDLWin=+2), which is exactly Fathom's own internal scale: tb_probe_wdl_impl
    // returns `v + 2` off probe_wdl()'s -2..+2 (src/syzygy/tbprobe.cpp:556), so the
    // conversion is the single subtraction below and nothing is inferred.
    //
    // This used to normalize to +1/0/-1 with cursed/blessed FOLDED INTO DRAW. That fold
    // is what the search has to make, not what the probe has to make: SF scores a cursed
    // win `VALUE_DRAW + 2 * wdl * drawScore` = +2cp (search.cpp:823-828), strictly
    // better than a dead draw because the opponent still has 50 moves in which to err —
    // and it is a different BOUND (EXACT, not LOWER), which is what stops the search
    // treating a spent win like a live one. Folding here threw both away before the
    // caller could see them.
    result = static_cast<int>(res) - 2;
    return true;
}

// ---- Root DTZ ranking ------------------------------------------------------------

// Fathom's DTZ path is NOT thread-safe (probe_dtz lazily maps and initializes shared
// per-table state, and tbprobe.h says so). SF avoids the question entirely: it ranks the
// root once on the main thread in Thread::search's setup (~sf18-arm/src/thread.cpp:313)
// before any worker exists. zug cannot copy that placement — run_lazy_smp fans N workers
// straight into Search::start(), and start() is the ONE point every entry path (UCI,
// serve /bestmove, /candidates, /analyze, /analyze-game, bot games, engine-vs-engine)
// crosses exactly once, so that is where the ranking has to live. This mutex is what
// makes that safe.
//
// The N-1 duplicated probes are wasted work, not a correctness problem, and the cost is
// negligible by construction: it is ONE probe per search, only in a <=TB_LARGEST-man
// position, and after the first worker the DTZ tables are warm — tens of microseconds
// against a search budget measured in milliseconds. Computing it once in the driver and
// threading it down through Limits was the alternative; it would have left the plain
// start()/UCI path (run_lazy_smp delegates straight to start() at threads<=1) needing its
// own second call site for the same thing, which is exactly the split that produced this
// bug in the first place.
static std::mutex& dtz_mutex() {
    static std::mutex m;
    return m;
}

// Fathom's promotion code → zug PieceType (NO_PIECE_TYPE when the move is not a promotion).
static PieceType promo_type(unsigned code) {
    switch (code) {
        case TB_PROMOTES_QUEEN:  return QUEEN;
        case TB_PROMOTES_ROOK:   return ROOK;
        case TB_PROMOTES_BISHOP: return BISHOP;
        case TB_PROMOTES_KNIGHT: return KNIGHT;
        default:                 return NO_PIECE_TYPE;
    }
}

// Match one Fathom result against a list of zug legal moves, returning the index or -1.
// Fathom emits moves in its own generator's order with illegal ones dropped, and encodes
// only (from, to, promotion) — so the match is on those three. That is unambiguous among
// legal moves: no two legal moves share a (from,to,promotion) triple (an en-passant
// capture and a quiet move can never share a destination, and castling — which zug encodes
// as king-takes-rook — cannot occur here, since rank_root_moves refuses a position with
// castling rights at all). `used` skips already-matched entries so a duplicate encoding
// could never consume the same move twice.
static int match_legal(const std::vector<Move>& legals, const std::vector<char>& used,
                       Square from, Square to, PieceType promoPt) {
    for (size_t i = 0; i < legals.size(); ++i) {
        if (used[i]) continue;
        Move m = legals[i];
        if (from_sq(m) != from || to_sq(m) != to) continue;
        if (promoPt != NO_PIECE_TYPE) {
            if (type_of_move(m) != PROMOTION || promotion_type(m) != promoPt) continue;
        } else if (type_of_move(m) == PROMOTION) {
            continue;  // Fathom said no promo → skip the promo encodings of this from/to
        }
        return (int) i;
    }
    return -1;
}

bool rank_root_moves(Position& pos, bool useRule50, bool rankDTZ, std::vector<RootRank>& out) {
    out.clear();
    if (!loaded()) return false;
    // Fathom's Pos has no castling state, so a castling-capable position would be probed
    // as a different position entirely. Same gate probe_wdl's callers apply, and the same
    // one SF applies (`!pos.can_castle(ANY_CASTLING)`, tbprobe.cpp:1739).
    if (pos.castling_rights() != 0) return false;
    if ((unsigned) BB::popcount(pos.pieces()) > max_pieces()) return false;

    std::vector<Move> legals;
    {
        MoveList list;
        generate<ALL>(pos, list);
        for (const ExtMove* it = list.begin(); it != list.end(); ++it)
            if (pos.legal(it->move)) legals.push_back(it->move);
    }
    if (legals.empty()) return false;  // terminal root — nothing to rank

    // ONE Fathom call yields per-move DTZ for the whole root. tb_probe_root_impl's
    // `results` array (src/syzygy/tbprobe.cpp:2545 probe_root) is filled with one packed
    // TB_RESULT per LEGAL move, terminated by TB_RESULT_FAILED, and each entry already
    // carries exactly what SF's root_probe computes by hand one do_move at a time:
    //   * TB_GET_WDL = dtz_to_wdl(root rule50, v)  (tbprobe.cpp:2596/559) — the 50-move
    //     budget is ALREADY folded in, off the ROOT's clock, so a win that no longer fits
    //     inside the halfmove counter reads CURSED_WIN here and nowhere else.
    //   * TB_GET_DTZ = |v|, where v is DTZ counted FROM THE ROOT: Fathom applies both the
    //     ±1 ply correction (tbprobe.cpp:2570-2574) and the zeroing-move ±1/±101 mapping
    //     (wdl_to_dtz, :2540) itself, which is SF's dtz_before_zeroing.
    // So SF's probe_dtz/dtz_before_zeroing do NOT need porting — only the sign does, since
    // TB_SET_DTZ stores the magnitude (:2585). It is recovered from that entry's own WDL,
    // which is exactly where dtz_to_wdl put it: dtz>0 ⇒ WIN|CURSED_WIN, dtz<0 ⇒
    // LOSS|BLESSED_LOSS, dtz==0 ⇒ DRAW.
    unsigned results[TB_MAX_MOVES];
    unsigned res;
    {
        std::lock_guard<std::mutex> lock(dtz_mutex());
        res = tb_probe_root_impl(
            pos.pieces(WHITE), pos.pieces(BLACK), pos.pieces(KING),
            pos.pieces(QUEEN), pos.pieces(ROOK), pos.pieces(BISHOP),
            pos.pieces(KNIGHT), pos.pieces(PAWN),
            pos.rule50_count(), ep_for_fathom(pos), pos.side_to_move() == WHITE, results);
    }
    // On ANY failure Fathom returns before writing the terminator, so `results` is garbage
    // and must not be walked. TB_RESULT_CHECKMATE/STALEMATE mean there was no move to rank.
    if (res == TB_RESULT_FAILED || res == TB_RESULT_CHECKMATE || res == TB_RESULT_STALEMATE)
        return false;

    const int  cnt50 = pos.rule50_count();
    // SF tbprobe.cpp:1617: has any position repeated since the last zeroing move? If so the
    // opponent can steer into a threefold and CLAIM the draw, so no win is "certain" any
    // more — every move drops into the dtz+cnt50-minimizing band and the engine keeps
    // pressing instead of coasting. zug's has_repeated() is the same scan SF's is (both
    // walk back min(rule50, pliesFromNull) plies of key history), so this is not a
    // rewrite, it is the same predicate.
    const bool rep   = pos.has_repeated();
    const int  bound = useRule50 ? (MAX_DTZ / 2 - 100) : 1;

    // SF's root_probe zeroes dtz for a child that is ALREADY a draw by repetition or by
    // the 50-move rule (tbprobe.cpp:1633-1639). Fathom cannot see either — it is handed
    // bitboards and a halfmove count, with no game history at all — so this is the one
    // piece of root_probe that genuinely has to be re-done on zug's own Position. Detach
    // the NNUE accumulator across the walk: do_move/undo_move would otherwise push/pop a
    // full accumulator update per root move for a probe that never evaluates anything.
    auto* savedAcc = pos.nnue_acc();
    pos.set_nnue_acc(nullptr);

    std::vector<char> used(legals.size(), 0);
    bool ok = true;
    // Bound the walk by the array itself as well as by Fathom's terminator: the terminator
    // is written at index (legal move count), which is < TB_MAX_MOVES for anything Fathom
    // can generate, but reading results[TB_MAX_MOVES] to discover that would already be
    // the overrun. The size check therefore lives in the loop CONDITION, not the body.
    for (unsigned i = 0; ok && i < TB_MAX_MOVES && results[i] != TB_RESULT_FAILED; ++i) {
        unsigned r = results[i];
        int idx = match_legal(legals, used, (Square) TB_GET_FROM(r), (Square) TB_GET_TO(r),
                              promo_type(TB_GET_PROMOTES(r)));
        if (idx < 0) { ok = false; break; }  // unmatched → distrust the whole ranking
        used[idx] = 1;
        Move m = legals[idx];

        unsigned wdl = TB_GET_WDL(r);
        int dtz = (int) TB_GET_DTZ(r);
        if (wdl == TB_LOSS || wdl == TB_BLESSED_LOSS) dtz = -dtz;
        else if (wdl == TB_DRAW)                      dtz = 0;

        {
            StateInfo st;
            pos.do_move(m, st);
            // is_draw(1) covers both of SF's clauses at once (zug folds rule50>99 and
            // repetition into one predicate). One ply from the root, its repetition arm
            // can only fire on a TRUE threefold inside the real game history — exactly
            // SF's own note at tbprobe.cpp:1635.
            if (useRule50 && pos.is_draw(1)) dtz = 0;
            pos.undo_move(m);
        }

        // SF tbprobe.cpp:1659-1663, verbatim. Three separate things live in this one
        // expression and all three matter:
        //   * a CERTAIN win (fits the halfmove clock, `dtz + cnt50 <= 99`) outranks a
        //     cursed one by a whole band (±MAX_DTZ vs ±MAX_DTZ/2), so the engine can never
        //     prefer a move that spends the win;
        //   * among cursed wins it still minimizes `dtz + cnt50`, i.e. it keeps trying —
        //     a 50-move draw that the OPPONENT then misplays is still winnable;
        //   * `rep` voids the "certain" claim entirely (see above).
        // rankDTZ decides whether DTZ also orders moves INSIDE the certain band.
        int rank = dtz > 0 ? (dtz + cnt50 <= 99 && !rep ? MAX_DTZ - (rankDTZ ? dtz : 0)
                                                        : MAX_DTZ / 2 - (dtz + cnt50))
                 : dtz < 0 ? (-dtz * 2 + cnt50 < 100 ? -MAX_DTZ - (rankDTZ ? dtz : 0)
                                                     : -MAX_DTZ / 2 + (-dtz + cnt50))
                           : 0;

        // SF tbprobe.cpp:1669-1677, remapped onto zug's value scale (this is NOT a
        // copy-paste of SF's magnitudes — porting those raw has regressed this engine
        // before). Two substitutions, both checked against types.h:
        //   * SF's `VALUE_MATE - MAX_PLY - 1` is SF's VALUE_TB, the top of its tablebase
        //     band, sitting immediately under its mate band. zug's equivalent top-of-band
        //     is VALUE_TB_WIN (types.h:76) — and it is already the value zug's own
        //     WDL-in-search returns at ply 0, so a certain win scores identically whether
        //     it came from here or from the in-search probe.
        //   * SF's PawnValue is 208; zug's pawn is 100 (weakening.h:81). It appears only
        //     as `* PawnValue / 200`, whose job is to squeeze cursed wins into a
        //     sub-half-pawn band — at 100 that band is 1..50cp, i.e. the same "at least
        //     1cp, growing toward half a pawn as a real win comes into view" SF documents.
        int score = rank >= bound  ? VALUE_TB_WIN
                  : rank > 0       ? (std::max(3, rank - (MAX_DTZ / 2 - 200)) * 100) / 200
                  : rank == 0      ? VALUE_DRAW
                  : rank > -bound  ? (std::min(-3, rank + (MAX_DTZ / 2 - 200)) * 100) / 200
                                   : -VALUE_TB_WIN;

        // Which BRANCH of the expression above produced `score`? The two middle ones —
        // 0 < |rank| < bound — are the cursed-win / blessed-loss band, whose value is a
        // deliberate fiction: SF's own comment calls it "assign at least 1 cp to cursed
        // wins and let it grow to 49 cp as the position gets closer to a real win", i.e.
        // an incentive to keep pressing, not the position's value — under the 50-move rule
        // a cursed win IS a draw. The outer branches are different in kind: ±VALUE_TB_WIN
        // and VALUE_DRAW are what the tablebase says the position is actually worth.
        // reported_score() (search.cpp) reports the outer branches as they are and reports
        // this one as VALUE_DRAW, and this flag is how it tells them apart — derived from
        // the band, not from the magnitude of `score` (at rank == bound the certain branch
        // fires with dtz + cnt50 == 100, so magnitude alone would misclassify it).
        const bool cursed = rank != 0 && rank < bound && rank > -bound;

        RootRank rr;
        rr.move   = m;
        rr.rank   = rank;
        rr.score  = score;
        rr.dtz    = dtz;
        rr.cursed = cursed;
        out.push_back(rr);
    }

    pos.set_nnue_acc(savedAcc);

    // Every legal move must have been ranked. A short list means Fathom and zug disagree
    // about legality somewhere, which would leave unranked moves sitting at rank 0 (the
    // DRAW band) among ranked ones — worse than not ranking at all.
    if (!ok || out.size() != legals.size()) {
        out.clear();
        return false;
    }
    return true;
}

}  // namespace TB
