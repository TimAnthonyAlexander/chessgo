#pragma once
// Secret Queen (a.k.a. "Hidden Queen Chess"): a self-contained variant module,
// following the SAME structural template as duck.h/antichess.h (see duck.h's
// file doc for the full rationale). Before the first move each side secretly
// designates one of its own pawns; that pawn may ALSO move as a queen, and any
// non-pawn move reveals it permanently.
//
// We implement the phantomchess.in ruleset (see ../docs/tasks/open/secret-queen.md
// for sources and the full rule list). The three rules that shape this file:
//
//   1. There is NO check, no checkmate, no pins. You win by CAPTURING the enemy
//      king, exactly like Duck Chess — so king captures are generated, no move
//      is filtered for self-check, and castling has no through-check condition.
//   2. There is NO en passant, for anyone. Double pushes still happen; they just
//      cannot be answered en passant. (The FEN's ep field is parsed and
//      discarded, then always serialized as "-" — the same tolerance
//      antichess.h applies to the castling field it doesn't have.)
//   3. Any non-pawn move by a hidden queen reveals it: the pawn on the board
//      becomes a real QUEEN and the hidden state is gone.
//
// Rule 1 is why this does NOT embed Position (unlike crazyhouse.h): with no
// check, no pins and no legality filter, Position's checkers/blockersForKing/
// pinners machinery would be fighting the type rather than saving work — the
// same conclusion duck.h and antichess.h reached. It is a plain mailbox
// board[64] value type with its own FEN parse/serialize, movegen, apply and
// status, reusing only zugzwang's read-only board PRIMITIVES (Square/Piece/
// Color from types.h, BB::attacks<...>/BB::pawn_attacks) and the shared
// Zobrist tables for the repetition key.
//
// ---- The information-set rule (the heart of this variant) ----
//
// Move generation ALWAYS runs in the information set of the side to move: YOUR
// hidden queen is a queen, THEIR hidden queen is just a pawn. That single rule
// produces every hidden-information behaviour on its own:
//
//   * your secret queen generates queen moves, so it plays and threatens like
//     a queen;
//   * their secret queen never does, so your king may walk onto a square it
//     attacks — you could not see it — and be captured there next move. That
//     ambush IS the variant;
//   * and because nobody's move list is ever trimmed by a piece they cannot
//     see, no legality artefact can leak the secret. The hidden state is hidden
//     by construction, not by remembering to hide it.
//
// The board itself carries a plain PAWN on a hidden queen's square; the
// queen-ness lives only in SecretQueenState::secret. So redacting the position
// for another viewer is SUBTRACTIVE — clear a field — and cannot leak by
// someone forgetting to swap a piece back. Only the FEN's trailing "[e2|h7]"
// field ever names a secret, and BoardFEN-style consumers strip it.
#include "types.h"
#include "bitboard.h"
#include <cstdint>
#include <string>
#include <vector>

// ---- Move ----

// A single move. Special flags are derived by the generator; the applier trusts
// them, so a hand-built SecretQueenMove must set them. There is no `ep` flag —
// the variant has no en passant (rule 2).
struct SecretQueenMove {
    Square from = SQ_NONE;
    Square to = SQ_NONE;
    PieceType promo = NO_PIECE_TYPE; // NO_PIECE_TYPE when not a promotion
    bool castle = false;             // castling (to is the king's destination file g/c)

    std::string uci() const;
    bool operator==(const SecretQueenMove& o) const {
        return from == o.from && to == o.to && promo == o.promo && castle == o.castle;
    }
};

// Parses "e2e4" / "e7e8q" into origin/destination/promo. The castle flag is NOT
// set here (resolved by matching against a generated legal move — the same
// split as duck_parse_piece_uci / antichess_parse_uci).
bool secretqueen_parse_uci(const std::string& s, SecretQueenMove& out);

// ---- State ----

// Castling-right bits — independent of the core engine's CastlingRight
// (types.h), though numerically identical (K=1,Q=2,k=4,q=8) by convention,
// mirroring duck.h's own choice.
constexpr uint8_t SQ_CASTLE_WK = 1;
constexpr uint8_t SQ_CASTLE_WQ = 2;
constexpr uint8_t SQ_CASTLE_BK = 4;
constexpr uint8_t SQ_CASTLE_BQ = 8;

// A complete Secret Queen position. A value type — every mutating operation
// returns a NEW state (immutable style, matching DuckState/AntichessState).
//
// `secret[c]` is the square of color c's STILL-HIDDEN queen, or SQ_NONE once it
// has been revealed, captured, or promoted. The board always holds an ordinary
// PAWN on that square — see the file doc.
//
// There is no en-passant field: the variant has no en passant (rule 2).
struct SecretQueenState {
    Piece board[64] = {};
    Color side = WHITE;
    uint8_t castling = 0;
    Square secret[COLOR_NB] = {SQ_NONE, SQ_NONE};
    int halfmove = 0;
    int fullmove = 1;

    // Serializes to the CANONICAL, self-describing FEN: six standard fields
    // (the ep field always "-") plus a trailing "[<w>|<b>]" naming the still-
    // hidden queens, e.g. "... 0 1 [e2|h7]", "[-|h7]", "[-|-]".
    std::string fen() const;

    // The same FEN with the trailing secret field omitted — an ordinary chess
    // FEN. This is what a board renderer wants, and it is also the redacted
    // form: it names no secret at all. Mirrors crazyhouse's pocket-stripped
    // board FEN.
    std::string boardFen() const;

    // The FEN as `viewer` is entitled to see it: the viewer's own secret is
    // kept, the opponent's is stripped. This is the ONLY function that should
    // ever produce a wire payload for a specific player — see the redaction
    // table in ../docs/tasks/open/secret-queen.md.
    std::string fenFor(Color viewer) const;

    // Zobrist-style repetition key over board + side + the hidden-queen squares
    // (two positions with identical boards but different secret assignments are
    // genuinely different positions). Built from the shared Zobrist tables, so
    // Zobrist::init() must have run — the same requirement AntichessState::key()
    // carries. NOT a full history: callers own the list of prior keys.
    uint64_t key() const;
};

// Builds a state from a FEN. Accepts a plain chess FEN (no trailing secret
// field → no hidden queens, which is what perft and tests want) as well as the
// canonical form with "[e2|h7]". The ep field is accepted and discarded.
//
// Like duck_parse, positions that classic chess would call illegal are ACCEPTED
// — a king "in check", or even a king already captured (a terminal Secret Queen
// position, normal to see mid-replay). Rejected: structurally malformed input,
// and a secret square that does not actually hold a pawn of that color (the one
// invariant this module relies on everywhere).
bool secretqueen_parse(const std::string& fen, SecretQueenState& out, std::string& err);

constexpr char SECRETQUEEN_START_FEN[] = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

// Designates `sq` as `c`'s secret queen on a fresh state. Fails if the square
// does not hold an unmoved pawn of that color, or if that side already has one.
bool secretqueen_designate(SecretQueenState& s, Color c, Square sq, std::string& err);

// ---- Move generation ----

// Every legal move for the side to move, in ITS OWN information set: its hidden
// queen generates queen moves as well as pawn moves, the enemy's hidden queen is
// treated as the pawn it appears to be. "Legal" == "pseudo-legal": there is NO
// self-check filter and king captures ARE included (capturing the enemy king
// wins). No en passant. Castling has no through-check condition.
std::vector<SecretQueenMove> secretqueen_legal_moves_struct(const SecretQueenState& s);

// The same list as UCI strings — the shape the HTTP layer returns.
std::vector<std::string> secretqueen_legal_moves(const SecretQueenState& s);

// Reports whether m lands on the enemy king's square.
bool secretqueen_captures_enemy_king(const SecretQueenState& s, const SecretQueenMove& m);

// Reports whether `m` is a move an ordinary PAWN on m.from could have made in
// this position — i.e. whether it keeps a hidden queen hidden. This is the
// reveal test (rule 3): a hidden queen's move reveals it exactly when this is
// false. Note a queen's moves are otherwise a superset of a pawn's, so the only
// pawn-shaped moves are the pushes, the diagonal captures and the promotions.
bool secretqueen_is_pawn_shaped(const SecretQueenState& s, const SecretQueenMove& m);

// Matches a parsed origin/destination/promo against the generated legal moves,
// recovering the castle flag. Mirrors duck_find_legal / antichess_find_legal.
bool secretqueen_find_legal(const SecretQueenState& s, const SecretQueenMove& want, SecretQueenMove& out);

// ---- Apply ----

// What a move revealed, so callers can narrate it (the wire tells a player when
// their capture took a disguised queen, and both players when one is unmasked).
struct SecretQueenReveal {
    bool moved = false;    // the mover's own hidden queen revealed itself by moving
    bool captured = false; // the move captured the opponent's still-hidden queen
    bool promoted = false; // the mover's hidden queen reached the last rank
    Square square = SQ_NONE; // where the reveal happened (the destination / capture square)
};

// Applies a TRUSTED move (validate via secretqueen_find_legal first), returning
// the next state. Flips the side, bumps the move number, updates castling
// rights and the halfmove clock, resolves reveals, and reports whether the
// enemy king was captured.
SecretQueenState secretqueen_do_move(const SecretQueenState& s, const SecretQueenMove& m, bool& capturedKing,
                                     SecretQueenReveal& reveal);

// ---- Status ----

enum class SecretQueenStatus { Ongoing, WhiteWin, BlackWin, Draw };

std::string secretqueen_status_result(SecretQueenStatus st); // "1-0"/"0-1"/"1/2-1/2"/""
std::string secretqueen_status_name(SecretQueenStatus st);   // "ongoing"/"white_win"/"black_win"/"draw"

// Adjudicates the CURRENT position (the side to move has not yet moved).
// `history` is the list of prior position keys for threefold detection; pass {}
// when unavailable (perft/tests never need it).
//
// Terminal conditions, in order: a king already captured (the other side won),
// the side to move having no legal move at all (a draw — see the task doc; it is
// close to unreachable when king capture is legal), the fifty-move rule, and
// threefold repetition.
SecretQueenStatus secretqueen_status(const SecretQueenState& s, const std::vector<uint64_t>& history = {});

// Reports whether either king is missing from the board (i.e. captured) — used
// to distinguish a decisive king capture from the other terminal states.
bool secretqueen_king_captured(const SecretQueenState& s);

// ---- SAN ----

// Display-only human string. `s` is the PRE-move state. There is no check or
// mate suffix (the variant has neither). A revealing move is written with the
// queen letter it just proved itself to be ("Qe2a6"), a still-hidden move as the
// pawn it still looks like ("e4") — so a game record reads the way the players
// experienced it.
std::string secretqueen_san(const SecretQueenState& s, const SecretQueenMove& m);

// ---- Perft ----

// Node count at `depth` over secretqueen_legal_moves_struct — the movegen gate.
uint64_t secretqueen_perft(const SecretQueenState& s, int depth);
