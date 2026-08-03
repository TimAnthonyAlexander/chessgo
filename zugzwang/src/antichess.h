#pragma once
// Antichess (a.k.a. Losing/Suicide Chess, "Räuberschach"): a self-contained
// variant module, following the SAME structural template as duck.h/duck.cpp
// (see that file's doc comment for the full rationale). Antichess conflicts
// with Position/movegen the same way Duck does, just for a different reason:
// there is no check/pin/castling concept at all (the king is an ORDINARY
// piece — it can be captured, walk next to the enemy king, anything), and the
// side to move must capture whenever a capture is available (the compulsory-
// capture rule). Both of those are baked deep into Rules::generate_legal /
// Position::legal (checkers/pinners/castling machinery), so reusing them here
// would fight the type, not save work — this file is a plain mailbox
// board[64] (an AntichessState value type) with its own FEN parse/format, its
// own pseudo-legal-and-forced-capture-aware movegen, its own eval, and its own
// REAL iterative-deepening negamax search (TT + killers/history + a
// quiescence pass over forced-capture chains) — see the file doc in
// antichess.cpp's search section for why this variant needs deep search, not
// a shallow hand-eval like Duck/Crazyhouse.
//
// It DOES reuse zugzwang's board PRIMITIVES read-only: Square/Piece/Color/
// PieceType from types.h and BB::attacks<...>/BB::pawn_attacks for pseudo-
// attack generation (occupancy bitboards rebuilt from the mailbox per call —
// mirrors duck.h's own choice, and for the same reason: antichess positions
// are tiny and this is never a standard-search hot path).
//
// Win condition is INVERTED versus every other variant in this codebase: the
// side to move WINS the instant it has no legal move (this subsumes "no
// pieces left" — a side with zero pieces on the board trivially has zero
// legal moves, so a single check covers both conditions the spec calls out
// separately). Threefold repetition and the 50-move rule still draw exactly
// like standard chess.
#include "types.h"
#include "bitboard.h"
#include <cstdint>
#include <string>
#include <vector>

// ---- Move ----

// A single antichess move. Promotion includes KING (`promo == KING`) — legal
// and required to support here, unlike every other variant in this codebase.
// The EP flag is resolved by the generator; a hand-built AntichessMove used to
// probe legality (antichess_find_legal) need not set it correctly.
struct AntichessMove {
    Square from = SQ_NONE;
    Square to = SQ_NONE;
    PieceType promo = NO_PIECE_TYPE; // NO_PIECE_TYPE, or KNIGHT/BISHOP/ROOK/QUEEN/KING
    bool ep = false;                 // en-passant capture

    std::string uci() const; // "e2e4" / "e7e8q" / "e7e8k" (king promotion)
    bool operator==(const AntichessMove& o) const {
        return from == o.from && to == o.to && promo == o.promo && ep == o.ep;
    }
};

// Parses "e2e4" / "e7e8q" / "e7e8k" into origin/destination/promo. The EP
// flag is NOT set here (resolved by matching against a generated legal move,
// same split as duck_parse_piece_uci / Rules::parse_uci_move).
bool antichess_parse_uci(const std::string& s, AntichessMove& out);

// ---- State ----

// A complete antichess position: the board (mailbox), side to move, the
// en-passant target, and the halfmove/fullmove counters. A value type — every
// mutating operation returns a NEW AntichessState (immutable style, matches
// DuckState/the codebase's immutability convention). There is no castling
// field: antichess has no castling at all (confirmed against python-chess's
// AntichessBoard, whose FEN never carries castling rights either), so a
// parsed FEN's castling field is accepted syntactically and discarded.
struct AntichessState {
    Piece board[64] = {};
    Color side = WHITE;
    Square ep = SQ_NONE; // raw en-passant target, or SQ_NONE
    int halfmove = 0;    // half-moves since the last capture or pawn move (50-move rule)
    int fullmove = 1;

    // Serializes back to a FEN. The castling field is always "-" (antichess
    // has none) — see the struct doc above.
    std::string fen() const;

    // Zobrist-style repetition key over board + side + en-passant file, built
    // from the shared Zobrist::psq/enpassant/side tables (Zobrist::init()
    // must have run — the same requirement every other consumer of those
    // tables already has). NOT a full history: callers own the game's list
    // of prior keys (see antichess_status) — mirrors how rating.cpp/Position
    // callers pass `history` in externally rather than a state embedding it.
    uint64_t key() const;
};

// Builds an AntichessState from a FEN. Accepts a normal chess FEN (board,
// side, castling [ignored], en-passant, [halfmove [fullmove]]); halfmove/
// fullmove default to 0/1 when absent (mirrors duck_parse's tolerance).
// Rejects only structurally malformed input (bad board/side/en-passant
// syntax) — a position where a side already has zero pieces or is mid-forced-
// capture is a perfectly normal (possibly terminal) antichess position and is
// ACCEPTED, same as duck_parse accepts a captured king.
bool antichess_parse(const std::string& fen, AntichessState& out, std::string& err);

constexpr char ANTICHESS_START_FEN[] = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

// ---- Move generation ----

// Every LEGAL move for the side to move: pseudo-legal generation (no
// self-check filter exists — there is no check concept; king moves/captures
// are generated exactly like any other piece) filtered by the compulsory-
// capture rule — if ANY pseudo-legal move captures (including en passant),
// ONLY capturing moves are legal; otherwise every pseudo-legal move is legal.
// Every pseudo-legal move is therefore legal modulo that one filter — this is
// why this variant does not need Position's legality machinery at all.
// Includes king-promotions.
std::vector<AntichessMove> antichess_legal_moves_struct(const AntichessState& s);

// UCI-string convenience wrapper (what the HTTP layer will want).
std::vector<std::string> antichess_legal_moves(const AntichessState& s);

// Matches a parsed origin/destination/promo against the generated legal
// moves, recovering the ep flag. Mirrors duck_find_legal / ZH's analogous
// helper.
bool antichess_find_legal(const AntichessState& s, const AntichessMove& want, AntichessMove& out);

// Reports whether m captures a piece (a normal capture or an en-passant
// capture) — the compulsory-capture predicate for a single move.
bool antichess_is_capture(const AntichessState& s, const AntichessMove& m);

// ---- Apply ----

// Applies a move already known to be legal (see antichess_find_legal /
// antichess_legal_moves_struct). Trusted — does not re-validate.
AntichessState antichess_do_move(const AntichessState& s, const AntichessMove& m);

// Parses + validates + applies a UCI move string against `s`. Throws
// ApiError{400,...} (src/serve_json.h) on any malformed or illegal move —
// the header does not need serve_json.h's include since the exception type
// only needs to be visible where it's caught (serve_handlers.cpp already
// includes it); this mirrors the aspirational "throws ApiError" contract
// duck.h/crazyhouse.h document for their own composite-move appliers.
AntichessState antichess_apply(const AntichessState& s, const std::string& uciMove);

// ---- Status ----

enum class AntichessStatus { Ongoing, WhiteWin, BlackWin, Draw };

std::string antichess_status_result(AntichessStatus st); // "1-0"/"0-1"/"1/2-1/2"/""
std::string antichess_status_name(AntichessStatus st);   // "white_win"/"black_win"/"draw"/"ongoing"

// Classifies the CURRENT position (side to move has not yet moved). The win
// condition is INVERTED vs every other variant here: the side to move WINS
// the instant it has no legal move (antichess_legal_moves_struct empty) —
// this single check subsumes BOTH spec conditions ("no pieces left" implies
// zero legal moves trivially, so it never needs a separate check). Otherwise
// threefold repetition (via `history`, prior position keys — see
// AntichessState::key's doc; `s.key()` itself is counted too, so a total of
// 3 occurrences is a draw) or the 50-move rule (halfmove >= 100) draws, same
// as standard chess. `history` defaults empty for callers (e.g. perft) that
// don't need repetition detection.
AntichessStatus antichess_status(const AntichessState& s, const std::vector<uint64_t>& history = {});

// ---- SAN ----

// Display-only SAN for a legal move: "<PIECE>[x]<square>" ("Nf3", "Bxa3"), a
// pawn move uses "<file>x<square>" only when capturing ("e4", "exd5"), and a
// promotion appends "=<PIECE>" (KING included: "=K", unique to this variant).
// No check/mate suffix (antichess has neither concept). `s` is the PRE-move
// state. Mirrors duck_san/zh_san's role — the "san" field of the future
// serve-layer's result JSON (see antichess.h's file doc: the {legal, san,
// newFen, sideToMove, status, result} shape those helpers build for Duck/
// Crazyhouse is assembled by serve_handlers.cpp in the NEXT wave from these
// same primitives — fen()/antichess_status_name()/antichess_status_result()/
// this function — not from anything JSON-shaped defined in this module).
std::string antichess_san(const AntichessState& s, const AntichessMove& m);

// ---- Eval ----

// Centipawns from the SIDE-TO-MOVE's perspective: INVERTED material (having
// fewer of your own pieces, and more of the opponent's, remaining on the
// board is good — see antichess.cpp's file doc for the exact reasoning) plus
// a light forced-capture/mobility term (your pieces hanging to the opponent
// is good — it obligates them to shed YOUR material for you; the opponent's
// pieces hanging to you is bad — it obligates you to eat them, shedding
// THEIR material instead of yours). Kept modest and fast; depth is the real
// strength lever for this variant (see antichess_best_move).
int antichess_evaluate(const AntichessState& s);

// ---- Search ----

struct AntichessLimits {
    int rating = 0;       // 0 = unset
    int level = -1;       // -1 = unset
    int depth = 0;         // 0 = unset
    int movetimeMs = 0;    // 0 = unset
    uint64_t nodes = 0;    // 0 = unset
};
inline AntichessLimits antichess_default_limits() { return AntichessLimits{}; }

struct AntichessResult {
    AntichessMove move;
    int score = 0;
    int mate = 0;      // signed mate-in-N (moves to a forced no-legal-move win); 0 if none
    bool hasMove = false;
    int depth = 0;     // deepest COMPLETED iterative-deepening depth (clean branch only); 0 for a book move
    uint64_t nodes = 0;
    bool fromBook = false; // true when the move came from antichess_book_lookup, not search
};

// Searches for the best move. `history` (prior position keys, see
// AntichessState::key) lets the weakened root-ranking branch's own internal
// negamax detect repetition; pass {} if unavailable (perft/tests never need
// it). Two branches, mirroring Rating::best_move_for_rating's clean/weakened
// split:
//   - FULL STRENGTH (rating >= 3500, or no rating/level given — matching
//     /candidates' "no rating means full strength" convention): a single
//     iterative-deepening negamax/alpha-beta search with a transposition
//     table, killers + history move ordering, and a forced-capture-chain
//     quiescence pass, driven by movetimeMs/nodes/depth (depth capped at a
//     generous safety ceiling, NOT a small fixed depth — antichess's forced,
//     narrow tree means 12-25 ply is realistic on real hardware).
//   - WEAKENED (700 <= rating < 3500): every root move is ranked at a
//     rating-scaled shallow depth (the SAME search machinery, just capped),
//     then Weakening::pick chooses among them by centipawn loss under an
//     absolute severity cap. The window/cap/exponent come from the ONE shared
//     ladder, Weakening::curve_for_rating — this module used to clone that
//     formula verbatim, which is precisely how a defect in it survived in four
//     engines at once (see weakening.h).
AntichessResult antichess_best_move(const AntichessState& s, const AntichessLimits& lim,
                                     const std::vector<uint64_t>& history = {});

// ---- Perft (validation only — not used by serve) ----

uint64_t antichess_perft(const AntichessState& s, int depth);

// ---- Self-play / measurement only (perft_test's antichess-selfplay /
// antichess-bench harness; NEVER called by serve) ----
//
// The live search (antichess_best_move above) always runs the CANDIDATE code
// path (opening book + improved eval + quiet-node LMR). These entry points
// additionally expose the pre-improvement CODE, byte-for-byte (same material/
// forcedness formulas, same plain full-window negamax, same weak tie-break-
// only opening nudge, no book), so a self-play harness can A/B gate every
// improvement in-process — see antichess.cpp's search-section doc comment for
// the full rationale and antichess.cpp's antichess_evaluate_legacy /
// antichess_best_move_ex for the implementation.

// The pre-improvement eval (material + the original, unfixed forcedness term).
// Kept only as the "legacy"/baseline profile below and as a fixed, unchanging
// reference opponent ("greedy" static-eval baseline) for the self-play
// harness — never used by the live search.
int antichess_evaluate_legacy(const AntichessState& s);

// Same contract as antichess_best_move, plus an explicit profile switch:
// candidateMode=true is exactly antichess_best_move's behavior; false runs
// the legacy/baseline profile (legacy eval, no book, no LMR).
AntichessResult antichess_best_move_ex(const AntichessState& s, const AntichessLimits& lim,
                                        const std::vector<uint64_t>& history, bool candidateMode);

struct AntichessRootScore {
    AntichessMove move;
    int score = 0;
};

// Full-strength root-move scores (deepest COMPLETED iteration only, sorted
// best-first) after searching for up to movetimeMs — measurement-only, powers
// the antichess-bench harness's "top root moves" printout.
std::vector<AntichessRootScore> antichess_root_scores_for_test(const AntichessState& s, int movetimeMs,
                                                                 bool candidateMode);

// True iff `s` is the exact standard start position with White to move (the
// only book-keyed position today) — exposed so the harness can assert the
// book covers the position it claims to.
bool antichess_is_standard_start_for_test(const AntichessState& s);

// The opening book lookup itself (see antichess.cpp's file doc for the
// book's contents and sourcing). Returns false (no entry) outside of book
// coverage; `out` is unset in that case.
bool antichess_book_lookup(const AntichessState& s, AntichessMove& out);
