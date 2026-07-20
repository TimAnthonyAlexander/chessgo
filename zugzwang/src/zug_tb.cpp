#include "zug_tb.h"
#include "movegen.h"
#include "syzygy/tbprobe.h"  // Fathom (C, C++-compatible via its own __cplusplus guards)

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
    result = (res == TB_WIN) ? 1 : (res == TB_LOSS) ? -1 : 0;  // blessed/cursed → draw
    return true;
}

Move probe_root(const Position& pos) {
    unsigned res = tb_probe_root_impl(
        pos.pieces(WHITE), pos.pieces(BLACK), pos.pieces(KING),
        pos.pieces(QUEEN), pos.pieces(ROOK), pos.pieces(BISHOP),
        pos.pieces(KNIGHT), pos.pieces(PAWN),
        pos.rule50_count(), ep_for_fathom(pos), pos.side_to_move() == WHITE, nullptr);
    if (res == TB_RESULT_FAILED) return MOVE_NONE;

    Square   from  = (Square) TB_GET_FROM(res);
    Square   to    = (Square) TB_GET_TO(res);
    unsigned promo = TB_GET_PROMOTES(res);
    PieceType promoPt = NO_PIECE_TYPE;
    switch (promo) {
        case TB_PROMOTES_QUEEN:  promoPt = QUEEN;  break;
        case TB_PROMOTES_ROOK:   promoPt = ROOK;   break;
        case TB_PROMOTES_BISHOP: promoPt = BISHOP; break;
        case TB_PROMOTES_KNIGHT: promoPt = KNIGHT; break;
        default: break;
    }

    // Match Fathom's (from,to,promo) against a generated legal move so the returned Move
    // carries zug's correct type flags (PROMOTION/EN_PASSANT/CASTLING). Fathom never
    // emits castling in a TB position (kings-only-ish endgames), but ep/promo can occur.
    MoveList list;
    generate<ALL>(pos, list);
    for (const ExtMove* it = list.begin(); it != list.end(); ++it) {
        Move m = it->move;
        if (!pos.legal(m)) continue;
        if (from_sq(m) != from || to_sq(m) != to) continue;
        if (promoPt != NO_PIECE_TYPE) {
            if (type_of_move(m) != PROMOTION || promotion_type(m) != promoPt) continue;
        } else if (type_of_move(m) == PROMOTION) {
            continue;  // Fathom said no promo → skip promo encodings of this from/to
        }
        return m;
    }
    return MOVE_NONE;  // shouldn't happen on a valid hit; caller falls back to search
}

}  // namespace TB
