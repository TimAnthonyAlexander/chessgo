#pragma once
// The Secret Queen bot. Kept OUT of src/secretqueen.cpp on purpose: that file is
// a pure rules module with no Position/Search/NNUE dependency (which is what
// lets test/secretqueen_test.cpp gate the rules without a net). This file is
// where the engine gets involved.
//
// ---- Why this variant reuses the real engine, unlike Duck/Crazyhouse ----
//
// Duck and Crazyhouse each carry a hand eval because the NNUE net cannot
// describe their boards (a duck-occupied square, a pocket). Secret Queen's board
// is an ORDINARY chess board — the hidden queen is a pawn on it, and every other
// piece is where it looks. So the whole NNUE + search stack applies directly, and
// the bot is as strong as the engine rather than as strong as a hand eval.
//
// The trick is one substitution: search the position with the BOT'S OWN hidden
// queen swapped to a real queen, and the opponent's left as the pawn it appears
// to be. That board is the bot's information set, exactly. It is also a legal
// standard chess position once a king capture has been ruled out first (see
// secretqueen_best_move), which is what makes handing it to the standard search
// sound.
//
// Standard chess search turns out to model this variant almost exactly, because
// "in check" here means "the opponent may capture my king next move" — genuinely
// lethal — and chess's mate/stalemate scoring lines up with the variant's own
// (a captured king loses; no legal move draws). The two places chess is merely
// more cautious than the rules require — it will not castle through an attacked
// square, and it will not leave its own king capturable — are both fine: doing
// either loses the king outright here.
//
// The bot is blind to the OPPONENT'S hidden queen, which is correct and
// deliberate: it gets ambushed the same way a human does. There is no belief
// model and no peeking at the real position.
//
// ---- Concealment ----
//
// The evaluation cannot see that being hidden is worth anything — to the net a
// queen on e2 is just a queen — so left alone the bot cashes its disguise in for
// any advantage at all. Self-play had it revealing as early as ply 1, which
// throws the whole variant away before the human has felt it.
//
// So the ladder's chosen move gets one extra test: if it would unmask the queen,
// rank the root moves and compare the best move that keeps the disguise. Unless
// revealing wins by more than SQ_REVEAL_MARGIN_CP, play the quiet one. That pass
// runs only on the ply the bot wants to reveal — once per side per game — so it
// costs nothing on a normal move. Measured effect: earliest reveal moved from
// ply 1 to ply 7, typical reveal from ~ply 15 to ply 26, and games now regularly
// finish with a side still hidden.
//
// The bot also gets some concealment for free, because a queen's moves are a
// superset of a pawn's: whenever the engine's best move from that square happens
// to be pawn-shaped, the disguise survives without the veto doing anything.
#include "secretqueen.h"
#include <cstdint>
#include <vector>

struct SecretQueenLimits {
    int rating = 0;     // 0 = unset -> full strength
    int depth = 0;      // 0 = unset
    int movetimeMs = 0; // 0 = unset
    uint64_t nodes = 0; // 0 = unset
};

inline SecretQueenLimits secretqueen_default_limits() { return SecretQueenLimits{}; }

struct SecretQueenResult {
    SecretQueenMove move;
    int score = 0;      // centipawns, from the side-to-move's perspective
    int mate = 0;       // signed mate-in-N (moves); 0 if not a forced mate
    bool hasMove = false;
    bool reveals = false; // this move would unmask the bot's own hidden queen
};

// Picks the bot's move.
//
// Order of business: win on the spot if the enemy king is capturable (that is
// the win condition, and ruling it out first is also what makes the substituted
// position a legal standard one for the search), otherwise search the
// substituted board and map the engine's move back onto the variant's own move
// list.
//
// Takes no game history, mirroring /duck/bestmove and /antichess/bestmove: a
// single-shot stateless call has none to thread through. It could not use ours
// anyway — SecretQueenState::key() and Position's Zobrist are different key
// spaces, so handing one to the other would silently never match.
SecretQueenResult secretqueen_best_move(const SecretQueenState& s, const SecretQueenLimits& lim);
