#include "secretqueen_bot.h"
#include "move.h"
#include "position.h"
#include "rating.h"
#include "rules.h"
#include "search.h"

#include <cstdlib>

namespace {

// The board as `viewer` knows it: their own hidden queen swapped to a real
// queen, the opponent's left as the pawn it appears to be. This IS the
// information set — see the file doc in secretqueen_bot.h.
//
// boardFen() omits the secret field entirely, so the result is an ordinary chess
// FEN with nothing hidden in it.
std::string information_set_fen(const SecretQueenState& s, Color viewer) {
    SecretQueenState sub = s;
    Square sq = sub.secret[viewer];
    if (sq != SQ_NONE) {
        sub.board[sq] = make_piece(viewer, QUEEN);
        sub.secret[viewer] = SQ_NONE;
    }
    return sub.boardFen();
}

// Signed mate-in-N (moves) from a search score, or 0 if it is not a mate score.
int mate_moves(int score) {
    if (!is_mate_score(score)) return 0;
    int plies = VALUE_MATE - std::abs(score);
    int moves = (plies + 1) / 2;
    return score > 0 ? moves : -moves;
}

// Does `m` unmask the mover's own hidden queen?
bool reveals(const SecretQueenState& s, const SecretQueenMove& m) {
    if (m.from != s.secret[s.side]) return false;
    return m.promo != NO_PIECE_TYPE || !secretqueen_is_pawn_shaped(s, m);
}

// How much the engine has to WIN by before unmasking the queen is worth it. The
// evaluation cannot see concealment at all — to the net a queen on e2 is just a
// queen — so without this the bot cashes its disguise in for any advantage at
// all, however small, and self-play showed it doing exactly that as early as
// ply 1. A pawn and a half is a deliberate bar: enough that winning material or
// forcing something keeps the reveal, low enough that "this square looks nicer"
// does not.
constexpr int SQ_REVEAL_MARGIN_CP = 150;

// Cost bounds for the veto's ranking pass. It only runs on the ply the bot
// actually wants to reveal — once per side per game — so it can afford a real
// look without touching the movetime budget of every other move.
constexpr int SQ_VETO_DEPTH = 8;
constexpr int SQ_VETO_MOVETIME_MS = 250;

SecretQueenResult make_result(const SecretQueenState& s, const SecretQueenMove& m, int score, int mate) {
    SecretQueenResult r;
    r.move = m;
    r.score = score;
    r.mate = mate;
    r.hasMove = true;
    r.reveals = reveals(s, m);
    return r;
}

// Finds the best move that keeps the queen hidden, and reports whether it is
// close enough to `revealScore` to be worth playing instead of unmasking.
//
// Ranks every root move once (shared depth, so the centipawn comparison between
// them is meaningful — that invariant is why this uses the ladder's own ranking
// pass rather than N separate searches), splits them by whether they reveal, and
// compares the two bests. Returns false when concealment genuinely costs too
// much, when nothing conceals, or when the ranking came back empty — in every
// one of those cases the caller keeps the ladder's original choice.
//
// Scores here are mover-relative and come from the SUBSTITUTED position, the
// same board `revealScore` was measured on, so the two are directly comparable.
bool best_concealing_move(Search::SearchGroup& group, Position& pos, const SecretQueenState& s,
                          const SecretQueenLimits& lim, int revealScore, SecretQueenMove& out) {
    Rating::LevelConfig cfg = Rating::config_for_rating(lim.rating > 0 ? lim.rating : Rating::RatingMax);
    int rankDepth = cfg.clean || cfg.rankDepth <= 0 ? SQ_VETO_DEPTH : cfg.rankDepth;
    int capMs = lim.movetimeMs > 0 ? lim.movetimeMs : SQ_VETO_MOVETIME_MS;

    int64_t nodes = 0;
    std::vector<Rating::RootMove> roots =
        Rating::rank_root_moves(Search::primary_context(group), pos, rankDepth, capMs, nodes);
    if (roots.empty()) return false;

    bool found = false;
    int bestHidden = 0;
    SecretQueenMove bestMove;
    for (const Rating::RootMove& rm : roots) {
        SecretQueenMove parsed, mapped;
        if (!secretqueen_parse_uci(move_to_uci(rm.move), parsed)) continue;
        if (!secretqueen_find_legal(s, parsed, mapped)) continue;
        if (reveals(s, mapped)) continue;
        if (!found || rm.score > bestHidden) {
            found = true;
            bestHidden = rm.score;
            bestMove = mapped;
        }
    }
    if (!found) return false;
    if (revealScore - bestHidden > SQ_REVEAL_MARGIN_CP) return false;

    out = bestMove;
    return true;
}

} // namespace

SecretQueenResult secretqueen_best_move(const SecretQueenState& s, const SecretQueenLimits& lim) {
    SecretQueenResult none;

    std::vector<SecretQueenMove> moves = secretqueen_legal_moves_struct(s);
    if (moves.empty()) return none;

    // 1. Take the king if it is there. This is the win condition, so nothing the
    //    search could return would be better — and ruling it out is also what
    //    guarantees the substituted position below is a legal standard one (the
    //    side not to move is not in check), which parse-and-validate requires.
    for (const SecretQueenMove& m : moves) {
        if (secretqueen_captures_enemy_king(s, m)) return make_result(s, m, VALUE_MATE, 1);
    }

    // 2. Hand the information set to the real engine.
    std::string fen = information_set_fen(s, s.side);
    if (Rules::valid_fen_structure(fen)) {
        Position pos;
        pos.set(fen);
        if (Rules::position_legal(pos)) {
            Search::GroupLease lease;
            Search::SearchGroup& group = lease.group();

            // rating 0 (unset) means "no weakening asked for" — search at the
            // engine's full strength, the same thing an omitted rating means on
            // the standard /bestmove path.
            int rating = lim.rating > 0 ? lim.rating : Rating::RatingMax;
            Rating::WeakResult res = Rating::best_move_for_rating(
                group, pos, rating, lim.depth, lim.movetimeMs, static_cast<int64_t>(lim.nodes), {});

            if (res.move != MOVE_NONE) {
                // Map the engine's move back onto the variant's own list. Every
                // standard-legal move is in it (ours is a superset — no
                // self-check filter), and a queen move from the hidden queen's
                // square is there too, so this normally succeeds; the fallback
                // below exists so a surprise can never crash a live game.
                SecretQueenMove parsed, found;
                if (secretqueen_parse_uci(move_to_uci(res.move), parsed) &&
                    secretqueen_find_legal(s, parsed, found)) {
                    // 2b. The concealment veto: if the ladder's choice would
                    //     unmask the queen, check whether staying hidden costs
                    //     anything real. See SQ_REVEAL_MARGIN_CP.
                    if (reveals(s, found)) {
                        SecretQueenMove hidden;
                        if (best_concealing_move(group, pos, s, lim, res.score, hidden)) {
                            return make_result(s, hidden, res.score, mate_moves(res.score));
                        }
                    }
                    return make_result(s, found, res.score, mate_moves(res.score));
                }
            }
        }
    }

    // 3. Fallback: a capture if one is going, else the first legal move. Reached
    //    only if the substituted position was somehow unusable — this keeps a
    //    live game moving instead of stalling on a bot that cannot answer.
    for (const SecretQueenMove& m : moves) {
        if (s.board[m.to] != NO_PIECE) return make_result(s, m, 0, 0);
    }
    return make_result(s, moves.front(), 0, 0);
}
